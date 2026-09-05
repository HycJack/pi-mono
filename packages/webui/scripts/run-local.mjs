/**
 * Local smoke runner: starts the webui against a local Ollama instance using
 * its OpenAI-compatible endpoint, with no API key required.
 *
 * Usage: node scripts/run-local.mjs [--port 3000] [--hostname 0.0.0.0]
 *   --create-user --username admin --password secret  (bootstrap account)
 *
 * Env: OLLAMA_BASE_URL (default http://127.0.0.1:11434/v1),
 *      OLLAMA_MODEL (default "openbmb/minicpm-v4.6:latest").
 */

import { createProvider, createModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { startWebui } from "../src/server/index.ts";

const args = process.argv.slice(2);
const value = (flag) => {
	const index = args.indexOf(flag);
	return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : undefined;
};
const has = (flag) => args.includes(flag);

const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
// Default to a model that accepts tool definitions; translate-only models
// reject the harness tool schema with a 400.
const modelId = process.env.OLLAMA_MODEL ?? "gemma4:e4b-mlx";
const staticDir = new URL("../static/", import.meta.url).pathname;

const provider = createProvider({
	id: "ollama",
	name: "Ollama (local)",
	baseUrl,
	auth: {
		apiKey: {
			name: "Ollama local endpoint",
			resolve: async () => ({
				auth: { apiKey: "ollama", baseUrl },
				source: "ollama-local",
			}),
		},
	},
	models: [
		{
			id: modelId,
			name: modelId,
			provider: "ollama",
			api: "openai-completions",
			baseUrl,
			contextWindow: 32000,
			maxTokens: 4096,
			reasoning: false,
			// Multimodal models advertise image input; enable with OLLAMA_IMAGE=1
			// (e.g. for vision models like llava / minicpm-v).
			input: has("--image") || process.env.OLLAMA_IMAGE === "1" ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	],
	api: openAICompletionsApi(),
});
const models = createModels();
models.setProvider(provider);

const running = await startWebui({
	port: Number(value("--port") ?? "3000"),
	hostname: value("--hostname") ?? "127.0.0.1",
	username: value("--username"),
	password: value("--password"),
	createUser: has("--create-user"),
	dataRoot: value("--data"),
	staticDir,
	models,
	model: provider.getModels()[0],
	skillsDir: value("--skills-dir"),
});

console.log(`webui listening on ${running.server.url}`);
console.log(`server id: ${running.serverId}`);
console.log(`model: ${modelId} via ${baseUrl}`);

const stop = async () => {
	await running.close();
	process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());