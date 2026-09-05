import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers, Client } from "@earendil-works/pi-client";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** Create an isolated temp root; every created directory is cleaned after the test. */
export async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "webui-test-"));
	dirs.push(dir);
	return dir;
}

/** Register a test models collection backed by one faux (deterministic) provider.
 * The model is text-only unless `multimodal` is set. */
export function createTestModels(): { models: Models; model: Model<Api> } {
	const models = createModels();
	const faux = fauxProvider({
		provider: `test-${Math.random().toString(36).slice(2, 8)}`,
		models: [{ id: "model-1", reasoning: false, contextWindow: 200000, maxTokens: 8192, input: ["text"] }],
	});
	models.setProvider(faux.provider);
	return { models, model: faux.getModel() as Model<Api> };
}

/** Like createTestModels, but the model advertises image input (multimodal). */
export function createMultimodalTestModels(): { models: Models; model: Model<Api> } {
	const models = createModels();
	const faux = fauxProvider({
		provider: `test-image-${Math.random().toString(36).slice(2, 8)}`,
		models: [{ id: "model-img", reasoning: false, contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] }],
	});
	models.setProvider(faux.provider);
	return { models, model: faux.getModel() as Model<Api> };
}

export interface ByteConnectionLike {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): void | Promise<void>;
}

export interface ByteConnectionHandlerLike {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

/**
 * In-memory duplex between a pi-client ByteTransport and the pi-server accept()
 * side, so tests exercise the whole protocol stack without sockets.
 */
export function createLoopbackTransportFactory(
	accept: (connection: ByteConnectionLike) => ByteConnectionHandlerLike,
): ByteTransportFactory {
	return (handlers: ByteTransportHandlers): ByteTransport => {
		let serverHandler: ByteConnectionHandlerLike | undefined;
		let closed = false;
		const connection: ByteConnectionLike = {
			closed: false,
			async send(chunk: Uint8Array): Promise<void> {
				handlers.onData(chunk);
			},
			close(): void {
				if (closed) return;
				closed = true;
				handlers.onClose();
			},
		};
		serverHandler = accept(connection);
		return {
			async send(chunk: Uint8Array): Promise<void> {
				serverHandler?.onData(chunk);
			},
			close(): void {
				if (closed) return;
				closed = true;
				serverHandler?.onClose();
			},
		};
	};
}

/** Wait until the client attachment matches the target session. */
export async function waitForAttachment(client: Client, sessionId: string): Promise<void> {
	if (client.attachment?.sessionId === sessionId) return;
	await new Promise<void>((resolve, reject) => {
		const remove = client.onAttachmentChange((attachment) => {
			if (attachment?.sessionId === sessionId) {
				remove();
				resolve();
			}
		});
		setTimeout(() => {
			remove();
			reject(new Error(`Timed out waiting for attachment to ${sessionId}`));
		}, 5_000);
	});
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export type { Api, Model, Models };
