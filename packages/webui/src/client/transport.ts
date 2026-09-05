import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";

/**
 * Browser WebSocket transport. The token is carried as a query parameter
 * (`?token=...`) because browsers cannot set request headers on WebSocket
 * connections; the server authenticates during the HTTP upgrade.
 *
 * `baseUrl` is optional and only used outside the browser (Node smoke tests),
 * where relative WebSocket URLs are invalid.
 */
export function createWebSocketTransportFactory(options: {
	readonly token: string;
	readonly baseUrl?: string;
}): ByteTransportFactory {
	return (handlers: ByteTransportHandlers): ByteTransport => {
		const url = `${options.baseUrl ?? ""}/ws?token=${encodeURIComponent(options.token)}`;
		const socket = new WebSocket(url);
		let closed = false;
		let opened = false;
		// The pi-client sends its hello immediately after the transport factory
		// returns, while the browser socket is still CONNECTING. Buffer frames
		// until `open` instead of dropping them, or the server handshake times
		// out and closes the connection.
		const pending: Uint8Array[] = [];
		socket.binaryType = "arraybuffer";

		socket.addEventListener("open", () => {
			opened = true;
			for (const chunk of pending.splice(0)) {
				socket.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
			}
		});
		socket.addEventListener("message", (event) => {
			if (closed) return;
			const data = event.data;
			if (data instanceof ArrayBuffer) {
				handlers.onData(new Uint8Array(data));
			} else if (ArrayBuffer.isView(data)) {
				const view = data;
				handlers.onData(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
			} else {
				// Blob: read asynchronously.
				const blob = data as Blob;
				void blob
					.arrayBuffer()
					.then((buffer: ArrayBuffer) => {
						if (!closed) handlers.onData(new Uint8Array(buffer));
					})
					.catch((error: unknown) => {
						if (!closed) handlers.onError(toError(error));
					});
			}
		});
		socket.addEventListener("close", () => {
			if (closed) return;
			closed = true;
			handlers.onClose();
		});
		socket.addEventListener("error", () => {
			if (!closed) {
				closed = true;
				handlers.onError(new Error("WebSocket transport error"));
			}
		});

		return {
			async send(chunk) {
				if (closed) return;
				const frame = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
				if (!opened) {
					pending.push(chunk);
					return;
				}
				if (socket.readyState === WebSocket.OPEN) socket.send(frame);
			},
			close() {
				if (closed) return;
				closed = true;
				pending.length = 0;
				try {
					socket.close(1000, "Client closed");
				} catch {
					// Socket already closed.
				}
			},
		};
	};
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
