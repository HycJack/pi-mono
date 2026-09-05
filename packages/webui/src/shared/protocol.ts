import { type Context, defineService, type JsonValue, type ReplicatedState } from "@earendil-works/chord";

/**
 * Shared service contracts between the webui server (provider) and the browser
 * client (consumer). Mirrors the coding-agent experimental service slices:
 * a server-scoped SessionDirectory/SessionManagement pair and a session-scoped
 * AgentController/Transcript/Lanes set exposed per attached lane.
 */

export interface SessionSummary {
	readonly sessionId: string;
	readonly createdAt: number;
}

export interface SessionDirectoryState {
	readonly revision: number;
	readonly sessions: readonly SessionSummary[];
}

/** Server-scoped: replicated list of Sessions visible to the authenticated user. */
export interface SessionDirectory {
	readonly state: ReplicatedState<SessionDirectoryState>;
}

export const SessionDirectory = defineService<SessionDirectory>("pi.webui.session-directory");

export interface SessionCreateOptions {
	readonly id?: string;
}

export interface SessionManagement {
	create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineService<SessionManagement>("pi.webui.session-management");

export interface AgentPromptImage {
	readonly type: "image";
	/** Base64-encoded image data. */
	readonly data: string;
	/** MIME type, e.g. "image/jpeg", "image/png". */
	readonly mimeType: string;
}

export interface AgentPromptRequest {
	readonly message: string;
	/** Image attachments for multimodal models; absent for text-only runs. */
	readonly images?: readonly AgentPromptImage[] | null;
}

export interface AgentCapabilities {
	/** Whether the session's model can accept image input. */
	readonly image: boolean;
}

/** Stable identity of one model inside a provider catalog. */
export interface ModelIdentity {
	readonly provider: string;
	readonly modelId: string;
}

/** Non-secret model description for pickers and status lines. */
export interface ModelInfo {
	readonly provider: string;
	readonly providerName: string;
	readonly modelId: string;
	readonly name: string;
	readonly image: boolean;
	/** True for user-configured (OpenAI-compatible) providers, false for the builtin catalog. */
	readonly custom: boolean;
}

export type AgentOperationResponse =
	| { readonly accepted: true; readonly operationId: string }
	| { readonly accepted: false; readonly operationId: string | null; readonly error: string };

export interface LaneStateSnapshot {
	readonly lane: string;
	readonly sessionId: string;
	/** JSON representation of the harness lane snapshot (LaneTranscriptSnapshot). */
	readonly snapshot: JsonValue;
	readonly event: unknown | null;
}

/** Session-scoped: drive one named lane (default "main") of the shared harness. */
export interface AgentController {
	prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	requestAbort(operationId: string, context: Context): Promise<void>;
	resume(context: Context): Promise<AgentOperationResponse>;
	/** Capabilities of the session's model (e.g. image input). */
	capabilities(context: Context): Promise<AgentCapabilities>;
	/** Create or acquire a sub-agent lane; idle lanes are just named branches. */
	acquireSubLane(name: string, context: Context): Promise<{ readonly lane: string }>;
	listLanes(context: Context): Promise<readonly string[]>;
	/** Switch this session's model in place; the next turn uses the new identity. */
	setModel(model: ModelIdentity, context: Context): Promise<void>;
}

export const AgentController = defineService<AgentController>("pi.webui.agent-controller");

/** Session-scoped: replicated latest snapshot plus the source event of the main lane. */
export interface Transcript {
	readonly state: ReplicatedState<LaneStateSnapshot>;
}

export const Transcript = defineService<Transcript>("pi.webui.transcript");

// --- Provider configuration ---------------------------------------------------

/** User-supplied model entry inside a provider config. */
export interface ProviderModelConfig {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	/** Advertise image input so the composer can attach images to this model. */
	readonly image?: boolean;
	readonly reasoning?: boolean;
}

/** Provider config submitted by the UI: one OpenAI-compatible endpoint. */
export interface ProviderConfig {
	/** Existing provider id when editing; omitted for new providers. */
	readonly id?: string;
	readonly name: string;
	readonly baseUrl: string;
	/** Required. Keyless local endpoints use a placeholder such as `ollama`. */
	readonly apiKey: string;
	readonly models: readonly ProviderModelConfig[];
}

/** Provider as listed for the UI; never includes the API key. */
export interface ProviderSummary {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly modelCount: number;
	/** False for builtin catalog providers, which cannot be edited or removed. */
	readonly custom: boolean;
}

/** Persisted provider entry, including the stored API key. */
export interface ProviderDetail extends ProviderConfig {
	readonly id: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Result of probing a configured provider's OpenAI-compatible `/models` endpoint. */
export interface ProviderTestResult {
	readonly ok: boolean;
	readonly modelIds: readonly string[];
	readonly error?: string;
}

/** Server-scoped: this user's provider catalog plus the model picker data. */
export interface ProviderSettings {
	listProviders(context: Context): Promise<readonly ProviderSummary[]>;
	getProvider(id: string, context: Context): Promise<ProviderDetail | null>;
	listModels(context: Context): Promise<readonly ModelInfo[]>;
	upsertProvider(config: ProviderConfig, context: Context): Promise<ProviderSummary>;
	deleteProvider(id: string, context: Context): Promise<void>;
	testProvider(id: string, context: Context): Promise<ProviderTestResult>;
	/** Probe an unsaved endpoint and return its `/models` ids, for the add-provider form. */
	discoverModels(config: ProviderConfig, context: Context): Promise<ProviderTestResult>;
}

export const ProviderSettings = defineService<ProviderSettings>("pi.webui.provider-settings");
