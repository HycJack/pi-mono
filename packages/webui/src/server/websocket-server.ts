import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { DEFAULT_MAX_FRAME_LENGTH, type ServerId } from "@earendil-works/pi-protocol";
import type { Server as PiServer } from "@earendil-works/pi-server";
import { type WebSocket, WebSocketServer } from "ws";
import type { FileAccountStore } from "./accounts.ts";

/** Structural match of `ByteConnection` in @earendil-works/pi-server (not exported from the package index). */
interface ByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): void | Promise<void>;
}

interface ByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

export interface WebuiServerOptions {
	readonly serverId: ServerId;
	/** Per-user pi-server instance; each user has an isolated session host. */
	readonly serverForUser: (username: string) => PiServer;
	/** Provision a newly registered account before the register response returns. */
	readonly onUserRegistered?: (username: string) => Promise<void>;
	readonly accounts: FileAccountStore;
	readonly staticDir?: string;
	readonly port?: number;
	readonly hostname?: string;
	readonly maxFrameLength?: number;
}

export interface WebuiServer {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

/**
 * Multi-user web server: one HTTP server serving the static client and a
 * WebSocket endpoint. Every browser connection authenticates with a bearer
 * token (query parameter `token`) resolved against the account store; the
 * resulting authenticated byte connection is handed to the authenticated
 * user's isolated pi-server `Server` instance. Each user has their own host,
 * session repository, and in-process harnesses, so sessions are never shared
 * between accounts.
 */
export async function createWebuiServer(options: WebuiServerOptions): Promise<WebuiServer> {
	const httpServer = createHttpServer();
	const staticDir = options.staticDir;
	const wsServer = new WebSocketServer({
		noServer: true,
		maxPayload: options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH,
	});

	httpServer.on("upgrade", (request, socket, head) => {
		const token = readToken(request);
		if (token === undefined) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const username = options.accounts.resolveToken(token);
		if (username === undefined) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		// The pi-server normally starts listeners; here the per-user WebSocket
		// endpoint supplies connections directly through accept(). The accept
		// handler must be installed before any frame arrives, so create it
		// right after the upgrade is accepted.
		const server = options.serverForUser(username);
		wsServer.handleUpgrade(request, socket, head, (webSocket) => {
			wsServer.emit("connection", webSocket, username, server);
		});
	});

	wsServer.on("connection", (webSocket: WebSocket, username: string, server: PiServer) => {
		const accept = (connection: ByteConnection): ByteConnectionHandler => server.accept(connection);
		bridgeSocket(webSocket, accept, username);
	});

	httpServer.on("request", async (request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://localhost");
		if (requestUrl.pathname === "/api/login" && request.method === "POST") {
			await handleLogin(request, response, options.accounts, options.serverId);
			return;
		}
		if (requestUrl.pathname === "/api/register" && request.method === "POST") {
			await handleRegister(request, response, options.accounts, options.serverId, options.onUserRegistered);
			return;
		}
		if (request.method !== "GET") {
			response.writeHead(405, { "content-type": "text/plain" });
			response.end("Method not allowed");
			return;
		}
		if (staticDir === undefined) {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("Not found");
			return;
		}
		let path = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
		path = normalize(path).replace(/^([/\\])+/, "");
		const filePath = join(staticDir, path);
		if (!filePath.startsWith(staticDir)) {
			response.writeHead(403, { "content-type": "text/plain" });
			response.end("Forbidden");
			return;
		}
		try {
			const content = await readFile(filePath);
			response.writeHead(200, { "content-type": contentType(filePath) });
			response.end(content);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("Not found");
				return;
			}
			response.writeHead(500, { "content-type": "text/plain" });
			response.end("Internal server error");
		}
	});

	await new Promise<void>((resolve) => {
		httpServer.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", resolve);
	});
	const address = httpServer.address() as AddressInfo;
	const port = address.port;
	const url = `http://${options.hostname ?? "127.0.0.1"}:${port}`;

	return {
		port,
		url,
		async close() {
			await new Promise<void>((resolve) => {
				for (const client of wsServer.clients) client.close(1000, "Server stopped");
				wsServer.close(() => resolve());
			});
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

function readToken(request: IncomingMessage): string | undefined {
	const url = new URL(request.url ?? "/", "http://localhost");
	const token = url.searchParams.get("token");
	return token !== null && token.length > 0 ? token : undefined;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

async function handleLogin(
	request: IncomingMessage,
	response: import("node:http").ServerResponse,
	accounts: FileAccountStore,
	serverId: ServerId,
): Promise<void> {
	try {
		const body = await readJsonBody(request);
		const username = typeof body.username === "string" ? body.username : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (!(await accounts.verifyPassword(username, password))) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "Invalid username or password" }));
			return;
		}
		const token = accounts.issueToken(username);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ token: token.token, serverId }));
	} catch (error) {
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	}
}

async function handleRegister(
	request: IncomingMessage,
	response: import("node:http").ServerResponse,
	accounts: FileAccountStore,
	serverId: ServerId,
	onUserRegistered: ((username: string) => Promise<void>) | undefined,
): Promise<void> {
	try {
		const body = await readJsonBody(request);
		const username = typeof body.username === "string" ? body.username : "";
		const password = typeof body.password === "string" ? body.password : "";
		await accounts.createUser(username, password);
		if (onUserRegistered !== undefined) await onUserRegistered(username);
		const token = accounts.issueToken(username);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ token: token.token, serverId }));
	} catch (error) {
		response.writeHead(400, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	}
}

function bridgeSocket(
	webSocket: WebSocket,
	accept: (connection: ByteConnection) => ByteConnectionHandler,
	_username: string,
): void {
	let closed = false;
	let handler: ByteConnectionHandler | undefined;
	const connection: ByteConnection = {
		closed: false,
		async send(chunk) {
			if (webSocket.readyState === webSocket.OPEN) {
				webSocket.send(toNodeBuffer(chunk));
			}
		},
		close() {
			if (closed) return;
			closed = true;
			webSocket.close(1000, "Closed");
		},
	};
	handler = accept(connection);
	webSocket.on("message", (data, isBinary) => {
		if (!isBinary || closed) return;
		const chunk = toUint8Array(data);
		try {
			handler?.onData(chunk);
		} catch (error) {
			handler?.onError(error instanceof Error ? error : new Error(String(error)));
			connection.close();
		}
	});
	webSocket.on("close", () => {
		closed = true;
		handler?.onClose();
	});
	webSocket.on("error", (error) => {
		if (!closed) handler?.onError(error);
	});
}

/** Frame bytes travel verbatim over the WebSocket; only the buffer wrapper differs. */
function toUint8Array(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Array.isArray(data)) {
		const total = data.reduce((sum, part) => sum + part.length, 0);
		const combined = new Uint8Array(total);
		let offset = 0;
		for (const part of data) {
			combined.set(part, offset);
			offset += part.length;
		}
		return combined;
	}
	throw new TypeError(`Unexpected WebSocket message payload: ${typeof data}`);
}

function toNodeBuffer(chunk: Uint8Array): Buffer {
	return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function contentType(filePath: string): string {
	switch (extname(filePath)) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		default:
			return "application/octet-stream";
	}
}

export type { HttpServer };
