import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { Server as PiServer } from "@earendil-works/pi-server";
import { describe, expect, it } from "vitest";
import { ServerServiceSource, SessionServiceSource } from "../src/client/service-source.ts";
import { createWebuiHost } from "../src/server/host.ts";
import {
	AgentController,
	ProviderSettings,
	SessionDirectory,
	SessionManagement,
	Transcript,
} from "../src/shared/protocol.ts";
import { createLoopbackTransportFactory, createTestModels, tempDir, waitForAttachment } from "./test-helpers.ts";

interface HostClient {
	readonly dir: string;
	readonly webui: Awaited<ReturnType<typeof createWebuiHost>>;
	readonly piServer: PiServer;
	readonly client: Client;
	readonly serverServices: ReturnType<ServerServiceSource["open"]>;
	readonly sessionServices: ReturnType<SessionServiceSource["open"]>;
	readonly management: SessionManagement;
	/** The remote SessionDirectory service proxy; reads go through `.state.value`. */
	readonly directory: SessionDirectory;
	readonly providers: ProviderSettings;
	close(): Promise<void>;
}

/** `withCatalog` false starts the host with no baseline provider and no seed model. */
async function openHostClient(username: string, existingDir?: string, withCatalog = true): Promise<HostClient> {
	const dir = existingDir ?? (await tempDir());
	const { models, model } = withCatalog ? createTestModels() : { models: undefined, model: undefined };
	const webui = await createWebuiHost({
		sessionsRoot: join(dir, "sessions"),
		username,
		models,
		model,
	});
	const serverId = "11111111-1111-4111-8111-111111111111";
	const piServer = new PiServer(webui.host, { serverId, listeners: [] });
	const client = await Client.connect({
		serverId,
		transportFactory: createLoopbackTransportFactory((connection) => piServer.accept(connection)),
	});
	const server = new ServerServiceSource(client);
	const session = new SessionServiceSource(client);
	const serverServices = server.open({
		services: [SessionDirectory, SessionManagement, ProviderSettings],
		assertAccess() {},
		onError: (error) => {
			throw error;
		},
	});
	const sessionServices = session.open({
		services: [AgentController, Transcript],
		assertAccess() {},
		onError: (error) => {
			throw error;
		},
	});
	const management = serverServices.use(SessionManagement);
	const directory = serverServices.use(SessionDirectory);
	const providers = serverServices.use(ProviderSettings);
	await serverServices.ready(BACKGROUND_CONTEXT);
	return {
		dir,
		webui,
		piServer,
		client,
		serverServices,
		sessionServices,
		management,
		directory,
		providers,
		async close() {
			await sessionServices.dispose(BACKGROUND_CONTEXT);
			await serverServices.dispose(BACKGROUND_CONTEXT);
			client.disconnect("test complete");
			await piServer.close();
			await webui.close();
		},
	};
}

describe("webui host over the pi-server protocol", () => {
	it("creates a session, lists it, attaches, and removes it", async () => {
		const host = await openHostClient("alice");
		try {
			// Initial directory is empty (no persisted sessions).
			expect(host.directory.state.value?.sessions).toEqual([]);

			const created = await host.management.create({}, BACKGROUND_CONTEXT);
			expect(created.sessionId).toBeTruthy();
			// The created session becomes visible in the directory automatically.
			expect(host.directory.state.value?.sessions).toHaveLength(1);
			expect(host.directory.state.value?.sessions[0]?.sessionId).toBe(created.sessionId);
			expect(host.directory.state.value?.sessions[0]?.createdAt).toEqual(expect.any(Number));

			const attachment = host.client.attachment;
			expect(attachment).toBeUndefined();
			await host.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(host.client, created.sessionId);
			expect(host.client.attachment?.sessionId).toBe(created.sessionId);

			await host.management.remove(created.sessionId, BACKGROUND_CONTEXT);
			expect(host.directory.state.value?.sessions).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("persists sessions across host restarts on the same directory", async () => {
		const host = await openHostClient("alice");
		const created = await host.management.create({}, BACKGROUND_CONTEXT);
		const dir = host.dir;
		await host.close();

		// A new host over the same sessions root must list the persisted session.
		const restarted = await openHostClient("alice", dir);
		try {
			await expect.poll(() => restarted.directory.state.value?.sessions, { timeout: 5_000 }).toHaveLength(1);
			expect(restarted.directory.state.value?.sessions[0]?.sessionId).toBe(created.sessionId);
		} finally {
			await restarted.close();
		}
	});

	it("attaches and drives the main lane: prompt accepted and transcript updates", async () => {
		const host = await openHostClient("alice");
		try {
			const created = await host.management.create({}, BACKGROUND_CONTEXT);
			await host.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(host.client, created.sessionId);
			await host.sessionServices.ready(BACKGROUND_CONTEXT);

			const controller = host.sessionServices.use(AgentController);
			const transcript = host.sessionServices.use(Transcript);

			// A prompt against the faux model must be accepted with an operation id.
			const result = await controller.prompt({ message: "Say exactly: ping" }, BACKGROUND_CONTEXT);
			expect(result.accepted).toBe(true);
			if (result.accepted) expect(result.operationId).toBeTruthy();

			// Transcript state eventually reflects an assistant entry.
			await expect
				.poll(
					() => {
						const state = transcript.state.value;
						if (state === undefined || state.snapshot === null || typeof state.snapshot !== "object") {
							return null;
						}
						const snapshot = state.snapshot as unknown as { transcript: readonly unknown[] };
						const entries = snapshot.transcript.filter((entry) => {
							const e = entry as { type?: string; message?: { role?: string } };
							return e.type === "message" && e.message?.role === "assistant";
						});
						return entries.length;
					},
					{ timeout: 10_000 },
				)
				.toBeGreaterThan(0);
		} finally {
			await host.close();
		}
	});

	it("lists lanes and acquires sub-agent lanes", async () => {
		const host = await openHostClient("alice");
		try {
			const created = await host.management.create({}, BACKGROUND_CONTEXT);
			await host.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(host.client, created.sessionId);
			await host.sessionServices.ready(BACKGROUND_CONTEXT);

			const controller = host.sessionServices.use(AgentController);
			const lanes = await controller.listLanes(BACKGROUND_CONTEXT);
			expect(lanes).toContain("main");

			const sub = await controller.acquireSubLane("explorer", BACKGROUND_CONTEXT);
			expect(sub.lane).toBe("explorer");
			const after = await controller.listLanes(BACKGROUND_CONTEXT);
			expect(after).toContain("explorer");
		} finally {
			await host.close();
		}
	});
});

describe("webui host session isolation", () => {
	it("keeps separate session directories per user", async () => {
		const alice = await openHostClient("alice");
		const bob = await openHostClient("bob");
		try {
			// Alice creates a session; Bob must not see it.
			const created = await alice.management.create({}, BACKGROUND_CONTEXT);
			expect(alice.directory.state.value?.sessions).toHaveLength(1);
			expect(bob.directory.state.value?.sessions).toEqual([]);

			// Bob creates his own; Alice still only sees hers.
			const bobCreated = await bob.management.create({}, BACKGROUND_CONTEXT);
			expect(bob.directory.state.value?.sessions).toHaveLength(1);
			expect(bob.directory.state.value?.sessions[0]?.sessionId).toBe(bobCreated.sessionId);
			expect(alice.directory.state.value?.sessions).toHaveLength(1);
			expect(alice.directory.state.value?.sessions[0]?.sessionId).toBe(created.sessionId);

			// Bob cannot attach Alice's session: the per-user repository does
			// not contain it, so routing fails server-side.
			await expect(bob.management.attach(created.sessionId, BACKGROUND_CONTEXT)).rejects.toThrow();
		} finally {
			await alice.close();
			await bob.close();
		}
	});

	it("survives a restart for each user independently", async () => {
		const host = await openHostClient("alice");
		const created = await host.management.create({}, BACKGROUND_CONTEXT);
		const dir = host.dir;
		await host.close();

		const restarted = await openHostClient("alice", dir);
		const bob = await openHostClient("bob");
		try {
			await expect.poll(() => restarted.directory.state.value?.sessions, { timeout: 5_000 }).toHaveLength(1);
			expect(restarted.directory.state.value?.sessions[0]?.sessionId).toBe(created.sessionId);
			// Bob's fresh repository has no sessions, even after Alice restarted.
			expect(bob.directory.state.value?.sessions).toEqual([]);
		} finally {
			await restarted.close();
			await bob.close();
		}
	});
});

describe("webui host provider settings", () => {
	it("refuses to create sessions until a provider is configured", async () => {
		const host = await openHostClient("alice", undefined, false);
		try {
			expect(await host.providers.listProviders(BACKGROUND_CONTEXT)).toEqual([]);
			expect(await host.providers.listModels(BACKGROUND_CONTEXT)).toEqual([]);
			await expect(host.management.create({}, BACKGROUND_CONTEXT)).rejects.toThrow(/No model available/);

			// Model discovery is callable before any provider exists; failures
			// stay in-band and validation failures keep their message.
			const unreachable = await host.providers.discoverModels(
				{ name: "Local", baseUrl: "http://127.0.0.1:9/v1", apiKey: "ollama", models: [] },
				BACKGROUND_CONTEXT,
			);
			expect(unreachable.ok).toBe(false);
			expect(unreachable.modelIds).toEqual([]);
			expect(unreachable.error).toBeTruthy();
			await expect(
				host.providers.discoverModels(
					{ name: "Local", baseUrl: "not-a-url", apiKey: "ollama", models: [] },
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/Base URL/);
			await expect(
				host.providers.upsertProvider(
					{ name: "Local", baseUrl: "https://api.example.com/v1", apiKey: "k", models: [] },
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/at least one model/);
			// Neither call saved anything.
			expect(await host.providers.listProviders(BACKGROUND_CONTEXT)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("saves a provider, seeds a session with it, and switches models", { timeout: 30_000 }, async () => {
		const host = await openHostClient("alice", undefined, false);
		try {
			const saved = await host.providers.upsertProvider(
				{
					name: "Local",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "ollama",
					models: [{ id: "local-model" }],
				},
				BACKGROUND_CONTEXT,
			);
			expect(saved).toMatchObject({ id: "local", modelCount: 1, custom: true });
			const models = await host.providers.listModels(BACKGROUND_CONTEXT);
			expect(models).toHaveLength(1);
			expect(models[0]).toMatchObject({ provider: "local", modelId: "local-model", custom: true });

			// The saved provider becomes the session seed model.
			const created = await host.management.create({}, BACKGROUND_CONTEXT);
			await host.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(host.client, created.sessionId);
			await host.sessionServices.ready(BACKGROUND_CONTEXT);

			const controller = host.sessionServices.use(AgentController);
			const transcript = host.sessionServices.use(Transcript);
			await expect(
				controller.setModel({ provider: "local", modelId: "missing" }, BACKGROUND_CONTEXT),
			).rejects.toThrow(/Unknown model/);

			// The transcript snapshot reports the session's configured model.
			await expect
				.poll(
					() => {
						const state = transcript.state.value;
						if (state === undefined || state.snapshot === null || typeof state.snapshot !== "object") return null;
						const snapshot = state.snapshot as unknown as {
							configuration?: { model?: { provider?: string; modelId?: string } };
						};
						return snapshot.configuration?.model;
					},
					{ timeout: 5_000 },
				)
				.toMatchObject({ provider: "local", modelId: "local-model" });

			// The prompt is accepted; the dead endpoint only fails the stream later.
			const result = await controller.prompt({ message: "ping" }, BACKGROUND_CONTEXT);
			expect(result.accepted).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("keeps providers per user", async () => {
		const alice = await openHostClient("alice", undefined, false);
		const bob = await openHostClient("bob", undefined, false);
		try {
			await alice.providers.upsertProvider(
				{ name: "Alice Local", baseUrl: "http://127.0.0.1:9/v1", apiKey: "ollama", models: [{ id: "m" }] },
				BACKGROUND_CONTEXT,
			);
			expect(await alice.providers.listProviders(BACKGROUND_CONTEXT)).toHaveLength(1);
			expect(await bob.providers.listProviders(BACKGROUND_CONTEXT)).toEqual([]);
		} finally {
			await alice.close();
			await bob.close();
		}
	});
});
