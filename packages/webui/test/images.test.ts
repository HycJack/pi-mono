import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { Client } from "@earendil-works/pi-client";
import { Server as PiServer } from "@earendil-works/pi-server";
import { describe, expect, it } from "vitest";
import { ServerServiceSource, SessionServiceSource } from "../src/client/service-source.ts";
import { createWebuiHost } from "../src/server/host.ts";
import { AgentController, SessionDirectory, SessionManagement, Transcript } from "../src/shared/protocol.ts";
import { API_FAKE_IMAGE } from "./test-constants.ts";
import {
	createLoopbackTransportFactory,
	createMultimodalTestModels,
	createTestModels,
	tempDir,
	waitForAttachment,
} from "./test-helpers.ts";

function fakeImage(): { type: "image"; data: string; mimeType: string } {
	return { type: "image", data: API_FAKE_IMAGE, mimeType: "image/png" };
}

/** The seed model must live in the collection it is seeded from. */
async function openHostClient(seeds: { readonly models: Models; readonly model: Model<Api> }) {
	const dir = await tempDir();
	const webui = await createWebuiHost({
		sessionsRoot: join(dir, "sessions"),
		username: "alice",
		models: seeds.models,
		model: seeds.model,
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
		services: [SessionDirectory, SessionManagement],
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
	await serverServices.ready(BACKGROUND_CONTEXT);
	return {
		webui,
		piServer,
		client,
		sessionServices,
		serverServices,
		management,
		async close() {
			await sessionServices.dispose(BACKGROUND_CONTEXT);
			await serverServices.dispose(BACKGROUND_CONTEXT);
			client.disconnect("test complete");
			await piServer.close();
			await webui.close();
		},
	};
}

describe("webui image (multimodal) support", () => {
	it("reports image capability only for multimodal models", async () => {
		const hostText = await openHostClient(createTestModels());
		try {
			const created = await hostText.management.create({}, BACKGROUND_CONTEXT);
			await hostText.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(hostText.client, created.sessionId);
			await hostText.sessionServices.ready(BACKGROUND_CONTEXT);
			const controller = hostText.sessionServices.use(AgentController);
			const caps = await controller.capabilities(BACKGROUND_CONTEXT);
			expect(caps.image).toBe(false);
		} finally {
			await hostText.close();
		}
	});

	it("reports image capability true on a multimodal model", async () => {
		const host = await openHostClient(createMultimodalTestModels());
		try {
			const created = await host.management.create({}, BACKGROUND_CONTEXT);
			await host.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(host.client, created.sessionId);
			await host.sessionServices.ready(BACKGROUND_CONTEXT);
			const controller = host.sessionServices.use(AgentController);
			const caps = await controller.capabilities(BACKGROUND_CONTEXT);
			expect(caps.image).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("rejects images on a text-only model", async () => {
		const host = await openHostClient(createTestModels());
		try {
			const created = await host.management.create({}, BACKGROUND_CONTEXT);
			await host.management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(host.client, created.sessionId);
			await host.sessionServices.ready(BACKGROUND_CONTEXT);
			const controller = host.sessionServices.use(AgentController);
			const result = await controller.prompt(
				{ message: "what is this?", images: [fakeImage()] },
				BACKGROUND_CONTEXT,
			);
			expect(result.accepted).toBe(false);
			if (!result.accepted) expect(result.error).toMatch(/does not support image/i);
		} finally {
			await host.close();
		}
	});
});

void SessionDirectory;
