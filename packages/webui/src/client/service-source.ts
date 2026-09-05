import {
	type Context,
	createRemoteServiceBinding,
	type MutableReplicatedState,
	type RemoteServiceBinding,
	type RemoteServices,
	type RemoteServiceTransport,
	replicatedState,
	type Service,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Client, createClientServiceTransport } from "@earendil-works/pi-client";

/**
 * Minimal browser-side service source over a pi-client connection.
 *
 * One server source provides the server-scoped services; the session source
 * follows the client's current attachment (set by SessionManagement.attach)
 * and routes session-scoped service calls to the attached session.
 */

export interface ServiceSourceOptions {
	readonly onError?: (error: Error) => void;
}

class RoutedServiceBinding implements RemoteServices {
	readonly #services: RemoteServiceBinding;
	readonly #getBound: () => boolean;
	readonly #remove: () => void;
	#activated = false;

	constructor(options: {
		readonly services: readonly { readonly id: string }[];
		readonly transport: RemoteServiceTransport;
		readonly getBound: () => boolean;
		readonly assertAccess: () => void;
		readonly onError: (error: Error) => void;
		readonly remove: () => void;
	}) {
		this.#services = createRemoteServiceBinding({
			services: options.services,
			transport: options.transport,
			bound: false,
			assertAccess: options.assertAccess,
			onError: options.onError,
		});
		this.#getBound = options.getBound;
		this.#remove = options.remove;
	}

	use<T>(service: Service<T>): T {
		return this.#services.use(service);
	}

	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void {
		return this.#services.observe(service, handler);
	}

	async ready(context: Context): Promise<void> {
		if (!this.#activated) {
			this.#activated = true;
			await this.#services.rebind(this.#getBound(), context);
		}
		await this.#services.ready(context);
	}

	async updateBound(bound: boolean, context: Context): Promise<void> {
		if (this.#activated) await this.#services.rebind(bound, context);
	}

	async dispose(context: Context): Promise<void> {
		this.#remove();
		await this.#services.dispose(context);
	}
}

function publishReplacement<T extends object>(state: MutableReplicatedState<T>, value: T, context: Context): void {
	const target = state.state as Record<string, unknown>;
	const replacement = value as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		if (!Object.hasOwn(replacement, key)) delete target[key];
	}
	Object.assign(target, replacement);
	state.publish(context);
}

export interface ConnectionStateValue {
	readonly status: "connecting" | "connected" | "disconnected";
	readonly reason?: string;
}

export class ServerServiceSource {
	readonly connection = replicatedState<ConnectionStateValue>({ status: "connecting" });
	readonly #client: Client;
	readonly #transport: RemoteServiceTransport;
	readonly #bindings = new Set<RoutedServiceBinding>();
	readonly #removeConnectionListener: () => void;
	readonly #onError: (error: Error) => void;
	#disposed = false;

	constructor(client: Client, options: ServiceSourceOptions = {}) {
		this.#client = client;
		this.#transport = createClientServiceTransport(client, () => ({ serverId: client.serverId }));
		this.#onError = options.onError ?? (() => {});
		this.#removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
			publishReplacement(
				this.connection,
				state === "connected"
					? { status: "connected" }
					: { status: "disconnected", reason: error?.message ?? String(state) },
				BACKGROUND_CONTEXT,
			);
			void Promise.allSettled(
				[...this.#bindings].map((binding) => binding.updateBound(state === "connected", BACKGROUND_CONTEXT)),
			).catch((reason: unknown) => this.#onError(toError(reason)));
		});
	}

	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices {
		if (this.#disposed) throw new Error("Server service source is disposed");
		let binding!: RoutedServiceBinding;
		binding = new RoutedServiceBinding({
			services: options.services,
			transport: this.#transport,
			getBound: () => this.#client.connected,
			assertAccess: options.assertAccess,
			onError: options.onError,
			remove: () => this.#bindings.delete(binding),
		});
		this.#bindings.add(binding);
		return binding;
	}

	dispose(_context: Context): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#disposed = true;
		this.#removeConnectionListener();
		return Promise.all(this.#bindings).then(() => undefined);
	}
}

export class SessionServiceSource {
	readonly attachment = replicatedState<{ status: "detached" } | { status: "attached"; sessionId: string }>({
		status: "detached",
	});
	readonly #client: Client;
	readonly #transport: RemoteServiceTransport;
	readonly #bindings = new Set<RoutedServiceBinding>();
	readonly #removeAttachmentListener: () => void;
	readonly #onError: (error: Error) => void;
	#disposed = false;

	constructor(client: Client, options: ServiceSourceOptions = {}) {
		this.#client = client;
		this.#transport = createClientServiceTransport(client, () => this.#client.attachment);
		this.#onError = options.onError ?? (() => {});
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			publishReplacement(
				this.attachment,
				attachment === undefined ? { status: "detached" } : { status: "attached", sessionId: attachment.sessionId },
				BACKGROUND_CONTEXT,
			);
			void Promise.allSettled(
				[...this.#bindings].map((binding) => binding.updateBound(attachment !== undefined, BACKGROUND_CONTEXT)),
			).catch((reason: unknown) => this.#onError(toError(reason)));
		});
	}

	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices {
		if (this.#disposed) throw new Error("Session service source is disposed");
		let binding!: RoutedServiceBinding;
		binding = new RoutedServiceBinding({
			services: options.services,
			transport: this.#transport,
			getBound: () => this.#client.attachment !== undefined,
			assertAccess: options.assertAccess,
			onError: options.onError,
			remove: () => this.#bindings.delete(binding),
		});
		this.#bindings.add(binding);
		return binding;
	}

	/** Wait until the client is attached to the given session. */
	whenAttached(sessionId: string, context: Context): Promise<void> {
		if (this.#client.attachment?.sessionId === sessionId) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const remove = this.#client.onAttachmentChange((attachment) => {
				if (attachment?.sessionId === sessionId) {
					remove();
					resolve();
				}
			});
			context.abortSignal?.addEventListener(
				"abort",
				() => {
					remove();
					reject(new Error("Aborted while waiting for session attachment"));
				},
				{ once: true },
			);
		});
	}

	dispose(_context: Context): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#disposed = true;
		this.#removeAttachmentListener();
		return Promise.all(this.#bindings).then(() => undefined);
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
