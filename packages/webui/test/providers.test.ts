import { stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildProvider,
	createProviderRegistry,
	FileProviderStore,
	normalizeProviderConfig,
	type ProviderRegistry,
	type ProviderStore,
} from "../src/server/providers.ts";
import type { ProviderConfig, ProviderDetail } from "../src/shared/protocol.ts";
import { createTestModels, tempDir } from "./test-helpers.ts";

const config = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
	name: "My Provider",
	baseUrl: "https://api.example.com/v1",
	apiKey: "sk-test",
	models: [{ id: "model-a" }],
	...overrides,
});

const detail = (overrides: Partial<ProviderDetail> = {}): ProviderDetail => ({
	id: "my-provider",
	name: "My Provider",
	baseUrl: "https://api.example.com/v1",
	apiKey: "sk-test",
	models: [{ id: "model-a" }],
	createdAt: 1,
	updatedAt: 2,
	...overrides,
});

async function freshStore(): Promise<ProviderStore> {
	return new FileProviderStore({ path: join(await tempDir(), "providers.json") });
}

async function freshRegistry(baseline?: Models): Promise<ProviderRegistry> {
	return createProviderRegistry({ store: await freshStore(), baseline });
}

/** Serve `payload` on every request at a loopback address; returns its base URL. */
async function withModelsServer(
	payload: unknown,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
	const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(payload));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			),
	};
}

describe("FileProviderStore", () => {
	it("persists entries and reloads them from disk", async () => {
		const dir = await tempDir();
		const path = join(dir, "providers.json");
		const store = new FileProviderStore({ path });
		await store.upsert(detail());
		expect(store.get("my-provider")?.name).toBe("My Provider");
		expect(store.list()).toHaveLength(1);

		const reloaded = new FileProviderStore({ path });
		await reloaded.ready();
		expect(reloaded.list()).toEqual(store.list());

		await store.remove("my-provider");
		expect(store.list()).toEqual([]);
		const empty = new FileProviderStore({ path });
		await empty.ready();
		expect(empty.list()).toEqual([]);
	});

	it("writes the store file with owner-only permissions", async () => {
		const dir = await tempDir();
		const path = join(dir, "providers.json");
		const store = new FileProviderStore({ path });
		await store.upsert(detail());
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("rejects a corrupt store file", async () => {
		const path = join(await tempDir(), "providers.json");
		await writeFile(path, "{ not json", "utf8");
		await expect(new FileProviderStore({ path }).ready()).rejects.toThrow(/Invalid provider store/);
	});
});

describe("normalizeProviderConfig", () => {
	it("slugs the name into an id and disambiguates duplicates", () => {
		const first = normalizeProviderConfig(config({ name: "My Cloud! Provider" }), { taken: new Set() });
		expect(first.id).toBe("my-cloud-provider");
		const second = normalizeProviderConfig(config(), { taken: new Set(["my-provider"]) });
		expect(second.id).toBe("my-provider-2");
	});

	it("keeps the id and createdAt when editing an existing provider", () => {
		const edited = normalizeProviderConfig(config({ id: "my-provider", name: "Renamed" }), {
			taken: new Set(),
			existing: detail({ id: "my-provider", name: "My Provider", createdAt: 7, updatedAt: 8 }),
		});
		expect(edited.id).toBe("my-provider");
		expect(edited.createdAt).toBe(7);
		expect(edited.name).toBe("Renamed");
		expect(edited.updatedAt).toBeGreaterThan(8);
	});

	it("trims trailing slashes from the base URL", () => {
		const normalized = normalizeProviderConfig(config({ baseUrl: "https://api.example.com/v1///" }), {
			taken: new Set(),
		});
		expect(normalized.baseUrl).toBe("https://api.example.com/v1");
	});

	it("rejects invalid configs", () => {
		expect(() => normalizeProviderConfig(config({ name: "  " }), { taken: new Set() })).toThrow(
			/name must not be empty/,
		);
		expect(() => normalizeProviderConfig(config({ baseUrl: "api.example.com" }), { taken: new Set() })).toThrow(
			/Base URL/,
		);
		expect(() => normalizeProviderConfig(config({ apiKey: "  " }), { taken: new Set() })).toThrow(/API key/);
		expect(() => normalizeProviderConfig(config({ models: [] }), { taken: new Set() })).toThrow(/at least one model/);
		expect(() =>
			normalizeProviderConfig(config({ models: [{ id: "a" }, { id: "a" }] }), { taken: new Set() }),
		).toThrow(/Duplicate model id/);
	});
});

describe("buildProvider", () => {
	it("builds a static openai-completions provider with defaults", () => {
		const provider = buildProvider(
			detail({
				models: [
					{ id: "text-only" },
					{ id: "vision", name: "Vision", image: true, reasoning: true, contextWindow: 12000, maxTokens: 500 },
				],
			}),
		);
		const models = provider.getModels();
		expect(models).toHaveLength(2);
		expect(models[0]?.api).toBe("openai-completions");
		expect(models[0]?.provider).toBe("my-provider");
		expect(models[0]?.input).toEqual(["text"]);
		expect(models[0]?.contextWindow).toBe(32_000);
		expect(models[0]?.maxTokens).toBe(4_096);
		expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(models[1]?.name).toBe("Vision");
		expect(models[1]?.input).toEqual(["text", "image"]);
		expect(models[1]?.reasoning).toBe(true);
		expect(models[1]?.contextWindow).toBe(12_000);
		expect(models[1]?.maxTokens).toBe(500);
	});
});

describe("createProviderRegistry", () => {
	it("lists configured providers first and exposes only usable models", async () => {
		const { models: baseline, model: baselineModel } = createTestModels();
		const registry = await freshRegistry(baseline);
		expect(await registry.defaultModel()).toMatchObject({ id: baselineModel.id });

		const saved = await registry.save(config());
		expect(saved).toMatchObject({ id: "my-provider", modelCount: 1, custom: true });

		const providers = await registry.listProviders();
		expect(providers[0]).toMatchObject({ id: "my-provider", custom: true, name: "My Provider" });
		expect(providers).toHaveLength(2);

		const models = await registry.listModels();
		expect(models[0]).toMatchObject({ provider: "my-provider", modelId: "model-a", custom: true });
		expect(models.map((model) => model.modelId)).toContain(baselineModel.id);

		// Configured providers win default-model selection over the baseline.
		expect(await registry.defaultModel()).toMatchObject({ provider: "my-provider", id: "model-a" });

		await registry.delete("my-provider");
		expect((await registry.listProviders()).filter((provider) => provider.custom)).toEqual([]);
		expect((await registry.listModels()).map((model) => model.modelId)).not.toContain("model-a");
	});

	it("returns only auth-configured providers in the model list", async () => {
		const registry = await freshRegistry(createModels());
		expect(await registry.listModels()).toEqual([]);
		expect(await registry.listProviders()).toEqual([]);

		const saved = await registry.save(config());
		const models = await registry.listModels();
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ provider: saved.id, modelId: "model-a" });
	});

	it("validates saves and rejects unknown edits", async () => {
		const registry = await freshRegistry();
		await expect(registry.save(config({ baseUrl: "not-a-url" }))).rejects.toThrow(/Base URL/);
		await expect(registry.save(config({ id: "missing" }))).rejects.toThrow(/Unknown provider/);
		await expect(registry.delete("missing")).rejects.toThrow(/Unknown provider/);
		await expect(registry.test("missing")).rejects.toThrow(/Unknown provider/);
	});

	it("probes an OpenAI-compatible /models endpoint", async () => {
		const target = await withModelsServer({ data: [{ id: "server-model" }, "noise", { noId: true }] });
		try {
			const registry = await freshRegistry();
			const saved = await registry.save(config({ baseUrl: target.baseUrl, models: [{ id: "server-model" }] }));
			expect(await registry.test(saved.id)).toEqual({ ok: true, modelIds: ["server-model"] });
		} finally {
			await target.close();
		}
	});

	it("probes an unsaved endpoint for the add-provider form", async () => {
		const target = await withModelsServer({ data: [{ id: "server-model" }] });
		try {
			const registry = await freshRegistry();
			expect(await registry.probe(config({ baseUrl: target.baseUrl }))).toEqual({
				ok: true,
				modelIds: ["server-model"],
			});
			// The probe does not persist anything.
			expect(await registry.listProviders()).toEqual([]);
			expect(registry.getProvider("my-provider")).toBeUndefined();
		} finally {
			await target.close();
		}
	});

	it("validates the endpoint before probing", async () => {
		const registry = await freshRegistry();
		await expect(registry.probe(config({ baseUrl: "api.example.com/v1" }))).rejects.toThrow(/Base URL/);
		await expect(registry.probe(config({ apiKey: "   " }))).rejects.toThrow(/API key/);
		await expect(registry.probe(config({ baseUrl: "http://127.0.0.1:9" }))).resolves.toMatchObject({
			ok: false,
		});
	});

	it("reports an unreachable endpoint in-band", async () => {
		const registry = await freshRegistry();
		const saved = await registry.save(config({ baseUrl: "http://127.0.0.1:9", models: [{ id: "model-a" }] }));
		const result = await registry.test(saved.id);
		expect(result.ok).toBe(false);
		expect(result.modelIds).toEqual([]);
		expect(result.error).toBeTruthy();
	});
});
