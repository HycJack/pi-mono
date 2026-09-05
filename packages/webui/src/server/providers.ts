import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Api, Model, Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
	ModelInfo,
	ProviderConfig,
	ProviderDetail,
	ProviderModelConfig,
	ProviderSummary,
	ProviderTestResult,
} from "../shared/protocol.ts";

/**
 * User-configured providers: one OpenAI-compatible endpoint per entry, stored
 * per user in a JSON file next to their sessions. Configured providers are
 * layered onto the builtin catalog, so env-configured builtins still work.
 */

const DEFAULT_CONTEXT_WINDOW = 32_000;
const DEFAULT_MAX_TOKENS = 4_096;
const PROBE_TIMEOUT_MS = 10_000;
const STORE_MODE = 0o600;

export interface ProviderStoreOptions {
	readonly path: string;
}

export interface ProviderStore {
	ready(): Promise<void>;
	list(): readonly ProviderDetail[];
	get(id: string): ProviderDetail | undefined;
	upsert(entry: ProviderDetail): Promise<ProviderDetail>;
	remove(id: string): Promise<void>;
}

/** JSON-file-backed provider store; entries are unique by id. */
export class FileProviderStore implements ProviderStore {
	#path: string;
	#entries = new Map<string, ProviderDetail>();
	#loaded: Promise<void>;

	constructor(options: ProviderStoreOptions) {
		this.#path = options.path;
		this.#loaded = this.#load();
	}

	async #load(): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
		let raw: string;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(`Invalid provider store in ${this.#path}: ${message(error)}`);
		}
		if (!Array.isArray(parsed)) throw new Error(`Invalid provider store in ${this.#path}`);
		for (const [index, entry] of parsed.entries()) {
			const detail = parseProviderEntry(entry, `providers[${index}]`);
			this.#entries.set(detail.id, detail);
		}
	}

	async #persist(): Promise<void> {
		await writeFile(this.#path, JSON.stringify([...this.#entries.values()], null, "\t"), {
			encoding: "utf8",
			mode: STORE_MODE,
		});
	}

	async ready(): Promise<void> {
		await this.#loaded;
	}

	list(): readonly ProviderDetail[] {
		return [...this.#entries.values()];
	}

	get(id: string): ProviderDetail | undefined {
		return this.#entries.get(id);
	}

	async upsert(entry: ProviderDetail): Promise<ProviderDetail> {
		await this.ready();
		if (this.#entries.has(entry.id)) this.#entries.delete(entry.id);
		this.#entries.set(entry.id, entry);
		await this.#persist();
		return entry;
	}

	async remove(id: string): Promise<void> {
		await this.ready();
		if (!this.#entries.has(id)) throw new Error(`Unknown provider: ${id}`);
		this.#entries.delete(id);
		await this.#persist();
	}
}

// --- Config validation --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as { code: unknown }).code === "ENOENT";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`Invalid provider config in ${where}: missing "${key}"`);
	return value;
}

/** Normalize a persisted provider record. */
function parseProviderEntry(value: unknown, where: string): ProviderDetail {
	if (!isRecord(value)) throw new Error(`Invalid provider config in ${where}`);
	const id = requireString(value, "id", where).trim();
	const name = requireString(value, "name", where).trim();
	const baseUrl = requireString(value, "baseUrl", where).trim();
	const apiKey = requireString(value, "apiKey", where).trim();
	const createdAt = numberField(value, "createdAt", where, Date.now());
	const updatedAt = numberField(value, "updatedAt", where, createdAt);
	return {
		id,
		name,
		baseUrl: trimTrailingSlash(baseUrl),
		apiKey,
		models: parseProviderModels(value.models, where),
		createdAt,
		updatedAt,
	};
}

function numberField(record: Record<string, unknown>, key: string, where: string, fallback: number): number {
	const value = record[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Invalid provider config in ${where}: "${key}" must be a number`);
	}
	return value;
}

function parseProviderModels(value: unknown, where: string): ProviderModelConfig[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Invalid provider config in ${where}: "models" must be a list`);
	return value.map((entry, index) => normalizeModelConfig(entry, `${where}.models[${index}]`));
}

/** Normalize and validate one model entry; duplicate ids are rejected by the caller. */
function normalizeModelConfig(value: unknown, where: string): ProviderModelConfig {
	if (!isRecord(value)) throw new Error(`Invalid provider config in ${where}`);
	const id = requireString(value, "id", where).trim();
	if (id.length === 0) throw new Error(`Invalid provider config in ${where}: model id must not be empty`);
	const config: { -readonly [K in keyof ProviderModelConfig]?: ProviderModelConfig[K] } = { id };
	if (value.name !== undefined) {
		if (typeof value.name !== "string") {
			throw new Error(`Invalid provider config in ${where}: "name" must be a string`);
		}
		const name = value.name.trim();
		if (name.length > 0) config.name = name;
	}
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
			throw new Error(`Invalid provider config in ${where}: "${key}" must be a positive number`);
		}
		config[key] = Math.round(raw);
	}
	for (const key of ["image", "reasoning"] as const) {
		if (value[key] === undefined) continue;
		if (typeof value[key] !== "boolean") {
			throw new Error(`Invalid provider config in ${where}: "${key}" must be a boolean`);
		}
		config[key] = value[key];
	}
	return { id, ...config };
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function uniqueProviderId(name: string, taken: ReadonlySet<string>): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	const base = slug.length > 0 ? slug : "provider";
	if (!taken.has(base)) return base;
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Trim and validate the endpoint fields a probe or save needs. */
export function normalizeEndpoint(
	baseUrl: string,
	apiKey: string,
): { readonly baseUrl: string; readonly apiKey: string } {
	const normalized = trimTrailingSlash(baseUrl.trim());
	if (!/^https?:\/\/[^\s]+$/.test(normalized)) {
		throw new Error("Base URL must start with http:// or https://");
	}
	const key = apiKey.trim();
	if (key.length === 0) {
		throw new Error('API key must not be empty (use a placeholder such as "ollama" for keyless local endpoints)');
	}
	return { baseUrl: normalized, apiKey: key };
}

/** Validate a UI-submitted config into a persisted entry. */
export function normalizeProviderConfig(
	input: ProviderConfig,
	options: { readonly taken: ReadonlySet<string>; readonly existing?: ProviderDetail },
): ProviderDetail {
	const name = input.name.trim();
	if (name.length === 0) throw new Error("Provider name must not be empty");
	const { baseUrl, apiKey } = normalizeEndpoint(input.baseUrl, input.apiKey);
	const models = normalizeProviderModels(input.models);
	if (models.length === 0) throw new Error("Provider must have at least one model");
	const now = Date.now();
	return {
		id: options.existing?.id ?? uniqueProviderId(name, options.taken),
		name,
		baseUrl,
		apiKey,
		models,
		createdAt: options.existing?.createdAt ?? now,
		updatedAt: now,
	};
}

function normalizeProviderModels(models: readonly ProviderModelConfig[]): ProviderModelConfig[] {
	const seen = new Set<string>();
	const result: ProviderModelConfig[] = [];
	for (const entry of models) {
		const config = normalizeModelConfig(entry, `models["${entry.id ?? ""}"]`);
		if (seen.has(config.id)) throw new Error(`Duplicate model id: ${config.id}`);
		seen.add(config.id);
		result.push(config);
	}
	return result;
}

// --- pi-ai provider construction ----------------------------------------------

/** One user-configured endpoint becomes one static openai-completions provider. */
export function buildProvider(entry: ProviderDetail): Provider<Api> {
	const models = entry.models.map((config) => toModel(entry, config));
	return createProvider({
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		auth: {
			apiKey: {
				name: `${entry.name} API key`,
				resolve: () => Promise.resolve({ auth: { apiKey: entry.apiKey, baseUrl: entry.baseUrl }, source: "webui" }),
			},
		},
		models,
		api: openAICompletionsApi(),
	});
}

function toModel(entry: ProviderDetail, config: ProviderModelConfig): Model<Api> {
	return {
		id: config.id,
		name: config.name ?? config.id,
		api: "openai-completions",
		provider: entry.id,
		baseUrl: entry.baseUrl,
		reasoning: config.reasoning === true,
		input: config.image === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

// --- Registry: store + catalog + mutation -------------------------------------

export interface ProviderRegistryOptions {
	readonly store: ProviderStore;
	/** Baseline catalog (builtin providers) merged after user providers. */
	readonly baseline?: Models;
}

export interface ProviderRegistry {
	readonly models: MutableModels;
	listProviders(): Promise<readonly ProviderSummary[]>;
	getProvider(id: string): ProviderDetail | undefined;
	/** Models whose provider has configured credentials; that is what a user can pick. */
	listModels(): Promise<readonly ModelInfo[]>;
	/** First model with configured auth; user providers come before builtins. */
	defaultModel(): Promise<Model<Api> | undefined>;
	save(config: ProviderConfig): Promise<ProviderSummary>;
	delete(id: string): Promise<void>;
	test(id: string): Promise<ProviderTestResult>;
	/** Probe an unsaved endpoint, so the UI can pull its model list before saving. */
	probe(config: ProviderConfig): Promise<ProviderTestResult>;
}

export async function createProviderRegistry(options: ProviderRegistryOptions): Promise<ProviderRegistry> {
	const store = options.store;
	await store.ready();
	const models = createModels();
	// Configured providers first so they win default-model selection over builtins.
	const rebuild = (): void => {
		models.clearProviders();
		for (const entry of store.list()) models.setProvider(buildProvider(entry));
		for (const provider of options.baseline?.getProviders() ?? []) models.setProvider(provider);
	};
	rebuild();

	const summary = (entry: ProviderDetail): ProviderSummary => ({
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		modelCount: entry.models.length,
		custom: true,
	});

	const customIds = (): ReadonlySet<string> => new Set(store.list().map((entry) => entry.id));

	return {
		models,
		async listProviders() {
			const configured = store.list().map(summary);
			const builtin: ProviderSummary[] = [];
			for (const provider of options.baseline?.getProviders() ?? []) {
				if ((await models.checkAuth(provider.id)) === undefined) continue;
				builtin.push({
					id: provider.id,
					name: provider.name,
					baseUrl: provider.baseUrl ?? "",
					modelCount: provider.getModels().length,
					custom: false,
				});
			}
			return [...configured, ...builtin];
		},
		getProvider: (id) => store.get(id),
		async listModels() {
			const custom = customIds();
			return (await models.getAvailable()).map((model) => ({
				provider: model.provider,
				providerName: models.getProvider(model.provider)?.name ?? model.provider,
				modelId: model.id,
				name: model.name,
				image: model.input.includes("image"),
				custom: custom.has(model.provider),
			}));
		},
		defaultModel: () => models.getAvailable().then((available) => available[0]),
		async save(config) {
			const existing = config.id !== undefined ? store.get(config.id) : undefined;
			if (config.id !== undefined && existing === undefined) throw new Error(`Unknown provider: ${config.id}`);
			const entry = normalizeProviderConfig(config, {
				taken: new Set(store.list().map((item) => item.id)),
				existing,
			});
			await store.upsert(entry);
			rebuild();
			return summary(entry);
		},
		async delete(id) {
			await store.remove(id);
			rebuild();
		},
		async test(id) {
			const entry = store.get(id);
			if (entry === undefined) throw new Error(`Unknown provider: ${id}`);
			return probeEndpoint(entry.baseUrl, entry.apiKey);
		},
		async probe(config) {
			const endpoint = normalizeEndpoint(config.baseUrl, config.apiKey);
			return probeEndpoint(endpoint.baseUrl, endpoint.apiKey);
		},
	};
}

/** Probe an OpenAI-compatible `/models` endpoint; failures stay in-band. */
async function probeEndpoint(baseUrl: string, apiKey: string): Promise<ProviderTestResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, modelIds: [], error: `HTTP ${response.status}` };
		const body = (await response.json()) as { data?: readonly unknown[] };
		const ids = (body.data ?? []).flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
		return { ok: true, modelIds: ids };
	} catch (error) {
		const text = message(error);
		return {
			ok: false,
			modelIds: [],
			error: text === "The user aborted a request." ? `Timed out after ${PROBE_TIMEOUT_MS}ms` : text,
		};
	} finally {
		clearTimeout(timer);
	}
}
