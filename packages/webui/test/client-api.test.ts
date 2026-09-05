import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Server as PiServer } from "@earendil-works/pi-server";
import { describe, expect, it } from "vitest";
import { connectWebui } from "../src/client/api.ts";
import { createWebuiHost } from "../src/server/host.ts";
import { createLoopbackTransportFactory, createTestModels, tempDir } from "./test-helpers.ts";

describe("webui client API", () => {
	it("creates sessions and the directory hydrates via subscription", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const webui = await createWebuiHost({
			sessionsRoot: join(dir, "sessions"),
			username: "alice",
			models,
			model,
		});
		const serverId = "11111111-1111-4111-8111-111111111111";
		const piServer = new PiServer(webui.host as never, { serverId, listeners: [] });
		const transportFactory = createLoopbackTransportFactory((connection) => piServer.accept(connection));
		const client = await connectWebui(serverId, "token", "alice", { transportFactory });
		try {
			// The directory snapshot may hydrate asynchronously; the change
			// subscription must fire once it does.
			let latest = client.listSessions().length;
			const unsubscribe = client.onSessionsChange(() => {
				latest = client.listSessions().length;
			});
			await expect.poll(() => latest, { timeout: 5_000 }).toBe(0);

			const created = await client.createSession();
			expect(created.sessionId).toBeTruthy();
			// The subscription updates the list without manual refresh.
			await expect.poll(() => client.listSessions().length, { timeout: 5_000 }).toBe(1);

			await client.attach(created.sessionId);
			expect(client.client.attachment?.sessionId).toBe(created.sessionId);

			await client.removeSession(created.sessionId);
			await expect.poll(() => client.listSessions().length, { timeout: 5_000 }).toBe(0);

			unsubscribe();
		} finally {
			await client.dispose();
			await piServer.close();
			await webui.close();
		}
	});

	it("detach clears the attachment and releases session bindings", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const webui = await createWebuiHost({
			sessionsRoot: join(dir, "sessions"),
			username: "alice",
			models,
			model,
		});
		const serverId = "11111111-1111-4111-8111-111111111111";
		const piServer = new PiServer(webui.host as never, { serverId, listeners: [] });
		const client = await connectWebui(serverId, "token", "alice", {
			transportFactory: createLoopbackTransportFactory((connection) => piServer.accept(connection)),
		});
		try {
			const created = await client.createSession();
			await client.attach(created.sessionId);
			expect(client.client.attachment?.sessionId).toBe(created.sessionId);

			// Prompt while attached must not throw and returns an operation id.
			const result = await client.prompt("Say exactly: hi");
			expect(result.accepted).toBe(true);

			await client.detach();
			expect(client.client.attachment).toBeUndefined();
		} finally {
			await client.dispose();
			await piServer.close();
			await webui.close();
		}
	});
});

void BACKGROUND_CONTEXT;
