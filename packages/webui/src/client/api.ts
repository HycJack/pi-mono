import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ByteTransportFactory, Client } from "@earendil-works/pi-client";
import {
	type AgentCapabilities,
	AgentController,
	type AgentOperationResponse,
	type AgentPromptImage,
	type ModelIdentity,
	type ModelInfo,
	type ProviderConfig,
	type ProviderDetail,
	ProviderSettings,
	type ProviderSummary,
	type ProviderTestResult,
	SessionDirectory,
	SessionManagement,
	type SessionSummary,
	Transcript,
} from "../shared/protocol.ts";
import { ServerServiceSource, SessionServiceSource } from "./service-source.ts";
import { createWebSocketTransportFactory } from "./transport.ts";

export interface LoginResult {
	readonly token: string;
	readonly serverId: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
	const response = await fetch("/api/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `Login failed (${response.status})`);
	}
	return (await response.json()) as LoginResult;
}

export async function register(username: string, password: string): Promise<LoginResult> {
	const response = await fetch("/api/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `Register failed (${response.status})`);
	}
	return (await response.json()) as LoginResult;
}

export interface WebuiClient {
	readonly client: Client;
	readonly serverId: string;
	readonly username: string;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
	readonly serverServices: ReturnType<ServerServiceSource["open"]>;
	readonly sessionServices: ReturnType<SessionServiceSource["open"]>;
	listSessions(): readonly SessionSummary[];
	/** Subscribe to session directory changes (creation, removal, hydration). */
	onSessionsChange(handler: () => void): () => void;
	createSession(): Promise<SessionSummary>;
	attach(sessionId: string): Promise<void>;
	detach(): Promise<void>;
	removeSession(sessionId: string): Promise<void>;
	prompt(message: string, images?: readonly AgentPromptImage[] | null): Promise<AgentOperationResponse>;
	/** Whether the current model supports image input (multimodal). */
	capabilities(): Promise<AgentCapabilities>;
	abort(operationId: string): Promise<void>;
	resume(): Promise<AgentOperationResponse>;
	acquireSubLane(name: string): Promise<string>;
	listLanes(): Promise<readonly string[]>;
	/** Switch the attached session's model; the next turn uses it. */
	setModel(model: ModelIdentity): Promise<void>;
	listProviders(): Promise<readonly ProviderSummary[]>;
	provider(id: string): Promise<ProviderDetail | null>;
	listModels(): Promise<readonly ModelInfo[]>;
	saveProvider(config: ProviderConfig): Promise<ProviderSummary>;
	deleteProvider(id: string): Promise<void>;
	testProvider(id: string): Promise<ProviderTestResult>;
	/** Probe an unsaved endpoint and return its model ids, for the add-provider form. */
	discoverModels(config: ProviderConfig): Promise<ProviderTestResult>;
	dispose(): Promise<void>;
}

export async function connectWebui(
	serverId: string,
	token: string,
	username: string,
	options: { readonly baseUrl?: string; readonly transportFactory?: ByteTransportFactory } = {},
): Promise<WebuiClient> {
	const client = await Client.connect({
		serverId,
		transportFactory:
			options.transportFactory ?? createWebSocketTransportFactory({ token, baseUrl: options.baseUrl }),
	});
	const server = new ServerServiceSource(client);
	const session = new SessionServiceSource(client);
	const serverServices = server.open({
		services: [SessionDirectory, SessionManagement, ProviderSettings],
		assertAccess() {},
		onError: (error) => console.error("server service error", error),
	});
	const sessionServices = session.open({
		services: [AgentController, Transcript],
		assertAccess() {},
		onError: (error) => console.error("session service error", error),
	});
	await serverServices.ready(BACKGROUND_CONTEXT);

	const directory = serverServices.use(SessionDirectory);
	const management = serverServices.use(SessionManagement);
	const settings = serverServices.use(ProviderSettings);
	const controller = sessionServices.use(AgentController);

	return {
		client,
		serverId,
		username,
		server,
		session,
		serverServices,
		sessionServices,
		listSessions: () => directory.state.value?.sessions ?? [],
		onSessionsChange: (handler) => directory.state.subscribe(handler),
		async createSession() {
			return management.create({}, BACKGROUND_CONTEXT);
		},
		async attach(sessionId) {
			await management.attach(sessionId, BACKGROUND_CONTEXT);
			await session.whenAttached(sessionId, BACKGROUND_CONTEXT);
			await sessionServices.ready(BACKGROUND_CONTEXT);
		},
		async detach() {
			await management.detach(BACKGROUND_CONTEXT);
			await sessionServices.ready(BACKGROUND_CONTEXT);
		},
		async removeSession(sessionId) {
			// The server dismisses the attachment when removing a session;
			// refresh the session bindings to reflect the detach.
			await management.remove(sessionId, BACKGROUND_CONTEXT);
			await sessionServices.ready(BACKGROUND_CONTEXT);
		},
		prompt: (message, images) => controller.prompt({ message, images: images ?? null }, BACKGROUND_CONTEXT),
		capabilities: () => controller.capabilities(BACKGROUND_CONTEXT),
		abort: (operationId) => controller.requestAbort(operationId, BACKGROUND_CONTEXT),
		resume: () => controller.resume(BACKGROUND_CONTEXT),
		acquireSubLane: async (name) => (await controller.acquireSubLane(name, BACKGROUND_CONTEXT)).lane,
		listLanes: () => controller.listLanes(BACKGROUND_CONTEXT),
		setModel: (model) => controller.setModel(model, BACKGROUND_CONTEXT),
		listProviders: () => settings.listProviders(BACKGROUND_CONTEXT),
		provider: (id) => settings.getProvider(id, BACKGROUND_CONTEXT),
		listModels: () => settings.listModels(BACKGROUND_CONTEXT),
		saveProvider: (config) => settings.upsertProvider(config, BACKGROUND_CONTEXT),
		deleteProvider: (id) => settings.deleteProvider(id, BACKGROUND_CONTEXT),
		testProvider: (id) => settings.testProvider(id, BACKGROUND_CONTEXT),
		discoverModels: (config) => settings.discoverModels(config, BACKGROUND_CONTEXT),
		async dispose() {
			await sessionServices.dispose(BACKGROUND_CONTEXT);
			await serverServices.dispose(BACKGROUND_CONTEXT);
			client.disconnect("Webui client disposed");
		},
	};
}

export { Transcript, BACKGROUND_CONTEXT };
