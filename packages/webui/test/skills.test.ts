import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { Server as PiServer } from "@earendil-works/pi-server";
import { describe, expect, it } from "vitest";
import { ServerServiceSource, SessionServiceSource } from "../src/client/service-source.ts";
import { createWebuiHost } from "../src/server/host.ts";
import { AgentController, SessionDirectory, SessionManagement, Transcript } from "../src/shared/protocol.ts";
import { createLoopbackTransportFactory, createTestModels, tempDir, waitForAttachment } from "./test-helpers.ts";

describe("webui skill and tool extensions", () => {
	it("loads SKILL.md files from a skills directory and runs with extra tools", async () => {
		const dir = await tempDir();
		const skillsDir = join(dir, "skills");
		await mkdir(join(skillsDir, "frontend"), { recursive: true });
		await writeFile(
			join(skillsDir, "frontend", "SKILL.md"),
			[
				"---",
				"name: frontend-style",
				"description: Frontend styling conventions for the webui",
				"---",
				"Use soft shadows and the accent palette when writing CSS.",
			].join("\n"),
			"utf8",
		);

		const { models, model } = createTestModels();
		const webui = await createWebuiHost({
			sessionsRoot: join(dir, "sessions"),
			username: "alice",
			models,
			model,
			skillsDir,
			// Extra tool extension on top of the built-in four: add `echo`.
			tools: [createEchoTool()],
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
		try {
			const created = await management.create({}, BACKGROUND_CONTEXT);
			await management.attach(created.sessionId, BACKGROUND_CONTEXT);
			await waitForAttachment(client, created.sessionId);
			await sessionServices.ready(BACKGROUND_CONTEXT);

			const controller = sessionServices.use(AgentController);
			const transcript = sessionServices.use(Transcript);

			const result = await controller.prompt(
				{ message: "Apply the frontend-style skill and call the echo tool." },
				BACKGROUND_CONTEXT,
			);
			expect(result.accepted).toBe(true);

			// The extended system prompt and tools must not break runs: an
			// assistant reply lands in the transcript.
			await expect
				.poll(
					() => {
						const state = transcript.state.value;
						if (state === undefined || state.snapshot === null || typeof state.snapshot !== "object") {
							return 0;
						}
						const snapshot = state.snapshot as unknown as { transcript: readonly unknown[] };
						return snapshot.transcript.filter((entry) => {
							const e = entry as { type?: string; message?: { role?: string } };
							return e.type === "message" && e.message?.role === "assistant";
						}).length;
					},
					{ timeout: 10_000 },
				)
				.toBeGreaterThan(0);
		} finally {
			await sessionServices.dispose(BACKGROUND_CONTEXT);
			await serverServices.dispose(BACKGROUND_CONTEXT);
			client.disconnect("test complete");
			await piServer.close();
			await webui.close();
		}
	});
});

/** Minimal tool extension: echoes its `text` parameter back as a result. */
function createEchoTool() {
	return {
		name: "echo",
		label: "echo",
		description: "Echo the provided text back verbatim.",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
			additionalProperties: false,
		},
		async execute(
			_toolCallId: string,
			params: { text: string },
			_onUpdate: unknown,
			_toolContext: { env: unknown },
			_invocation: unknown,
		) {
			return { content: [{ type: "text" as const, text: params.text }], details: undefined };
		},
	};
}
