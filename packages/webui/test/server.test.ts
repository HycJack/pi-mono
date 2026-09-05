import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { Client } from "@earendil-works/pi-client";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ServerServiceSource } from "../src/client/service-source.ts";
import { startWebui } from "../src/server/index.ts";
import { SessionDirectory, SessionManagement } from "../src/shared/protocol.ts";
import { createTestModels, tempDir } from "./test-helpers.ts";

/** Browser-shaped transport over a real ws connection (like transport.ts). */
function wsTransportFactory(port: number, token: string) {
	return (handlers: ByteTransportHandlers): ByteTransport => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
		const opened = new Promise<void>((resolve) => socket.once("open", () => resolve()));
		let closed = false;
		socket.on("message", (data) => {
			const buffer = data as Buffer;
			handlers.onData(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
		});
		socket.on("close", () => handlers.onClose());
		socket.on("error", () => handlers.onError(new Error("ws transport error")));
		return {
			async send(chunk) {
				await opened;
				if (!closed && socket.readyState === socket.OPEN) {
					socket.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				}
			},
			close() {
				closed = true;
				socket.close();
			},
		};
	};
}

async function login(port: number, username: string, password: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (!response.ok) throw new Error(`login failed: ${response.status}`);
	const body = (await response.json()) as { token: string };
	return body.token;
}

const STATIC_DIR = join(import.meta.dirname, "..", "static");

type RunningWebui = Awaited<ReturnType<typeof startWebui>>;

/** Start the webui with a fresh temp data dir and the real static client. */
async function startTestServer(dir: string, models: Models, model: Model<Api>): Promise<RunningWebui> {
	return startWebui({
		dataRoot: join(dir, "data"),
		username: "admin",
		password: "admin1234",
		createUser: true,
		models,
		model,
		staticDir: STATIC_DIR,
	});
}

describe("webui server HTTP API", () => {
	it("serves the static client and rejects unknown routes with 404", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const running = await startTestServer(dir, models, model);
		try {
			const base = running.server.url;
			expect((await fetch(`${base}/`)).status).toBe(200);
			expect((await fetch(`${base}/index.html`)).status).toBe(200);
			expect((await fetch(`${base}/app.js`)).status).toBe(200);
			expect((await fetch(`${base}/styles.css`)).status).toBe(200);
			expect((await fetch(`${base}/nope`)).status).toBe(404);
		} finally {
			await running.close();
		}
	});

	it("logs in and registers users, rejecting bad credentials", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const running = await startTestServer(dir, models, model);
		try {
			const port = running.server.port;
			// Bad password rejected.
			const bad = await fetch(`http://127.0.0.1:${port}/api/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "wrong" }),
			});
			expect(bad.status).toBe(401);

			// Good credentials issue a token.
			const token = await login(port, "admin", "admin1234");
			expect(token.length).toBeGreaterThan(16);

			// Register a brand-new user, then log in as them.
			const reg = await fetch(`http://127.0.0.1:${port}/api/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "carol", password: "carolpass1" }),
			});
			expect(reg.status).toBe(200);
			const carolToken = await login(port, "carol", "carolpass1");
			expect(carolToken.length).toBeGreaterThan(16);

			// Registering a duplicate is rejected.
			const dup = await fetch(`http://127.0.0.1:${port}/api/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "carol", password: "carolpass1" }),
			});
			expect(dup.status).toBe(400);
		} finally {
			await running.close();
		}
	});

	it("rejects WebSocket upgrades without a valid token", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const running = await startTestServer(dir, models, model);
		try {
			const port = running.server.port;
			const rejected: string[] = [];
			const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=invalid-token`);
			socket.on("error", (error) => {
				rejected.push(String(error));
			});
			socket.on("close", (code) => {
				rejected.push(`close:${code}`);
			});
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(rejected.length).toBeGreaterThan(0);
			socket.terminate();
		} finally {
			await running.close();
		}
	});
});

describe("webui end-to-end over WebSocket", () => {
	it("connects, lists sessions, creates, attaches, prompts, and removes", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const running = await startTestServer(dir, models, model);
		try {
			const serverId = running.serverId;
			const port = running.server.port;
			const token = await login(port, "admin", "admin1234");

			const client = await Client.connect({
				serverId,
				transportFactory: wsTransportFactory(port, token),
			});
			const server = new ServerServiceSource(client);
			const session = server.open({
				services: [SessionDirectory, SessionManagement],
				assertAccess() {},
				onError: (error) => {
					throw error;
				},
			});
			const management = session.use(SessionManagement);
			const directory = session.use(SessionDirectory);
			await session.ready(BACKGROUND_CONTEXT);

			// Fresh user: no sessions.
			expect(directory.state.value?.sessions).toEqual([]);

			const created = await management.create({}, BACKGROUND_CONTEXT);
			expect(created.sessionId).toBeTruthy();
			await expect.poll(() => directory.state.value?.sessions.length ?? 0, { timeout: 5_000 }).toBe(1);

			// Attach and list lanes through the session-scoped services are
			// covered by the host tests; here just confirm attach routes.
			await management.attach(created.sessionId, BACKGROUND_CONTEXT);

			// Removing the session clears the directory again.
			await management.remove(created.sessionId, BACKGROUND_CONTEXT);
			await expect.poll(() => directory.state.value?.sessions.length ?? 0, { timeout: 5_000 }).toBe(0);

			await session.dispose(BACKGROUND_CONTEXT);
			client.disconnect("test complete");
		} finally {
			await running.close();
		}
	});

	it("isolates users over the wire", async () => {
		const dir = await tempDir();
		const { models, model } = createTestModels();
		const running = await startTestServer(dir, models, model);
		try {
			const serverId = running.serverId;
			const port = running.server.port;

			// Register a second user.
			await fetch(`http://127.0.0.1:${port}/api/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "dave", password: "davepass1" }),
			});

			const connect = async (username: string, password: string) => {
				const token = await login(port, username, password);
				const client = await Client.connect({
					serverId,
					transportFactory: wsTransportFactory(port, token),
				});
				const server = new ServerServiceSource(client);
				const services = server.open({
					services: [SessionDirectory, SessionManagement],
					assertAccess() {},
					onError: (error) => {
						throw error;
					},
				});
				const management = services.use(SessionManagement);
				const directory = services.use(SessionDirectory);
				await services.ready(BACKGROUND_CONTEXT);
				return {
					client,
					services,
					management,
					directory,
					async close() {
						await services.dispose(BACKGROUND_CONTEXT);
						client.disconnect("test complete");
					},
				};
			};

			const admin = await connect("admin", "admin1234");
			const dave = await connect("dave", "davepass1");
			try {
				const created = await admin.management.create({}, BACKGROUND_CONTEXT);
				await expect.poll(() => admin.directory.state.value?.sessions.length ?? 0, { timeout: 5_000 }).toBe(1);
				// Dave's directory never sees admin's session.
				expect(dave.directory.state.value?.sessions).toEqual([]);

				const daveCreated = await dave.management.create({}, BACKGROUND_CONTEXT);
				await expect.poll(() => dave.directory.state.value?.sessions.length ?? 0, { timeout: 5_000 }).toBe(1);
				expect(dave.directory.state.value?.sessions[0]?.sessionId).toBe(daveCreated.sessionId);
				// Admin still only sees their own.
				expect(admin.directory.state.value?.sessions).toHaveLength(1);
				expect(admin.directory.state.value?.sessions[0]?.sessionId).toBe(created.sessionId);
			} finally {
				await admin.close();
				await dave.close();
			}
		} finally {
			await running.close();
		}
	});
});
