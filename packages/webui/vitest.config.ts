import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
		alias: {
			"@earendil-works/pi-agent-core/node": fileURLToPath(new URL("../agent/src/node.ts", import.meta.url)),
			"@earendil-works/pi-agent-core": fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
			"@earendil-works/pi-telemetry": fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url)),
			"@earendil-works/pi-ai/api/openai-completions.lazy": fileURLToPath(
				new URL("../ai/src/api/openai-completions.lazy.ts", import.meta.url),
			),
			"@earendil-works/pi-ai/utils/uuid": fileURLToPath(new URL("../ai/src/utils/uuid.ts", import.meta.url)),
			"@earendil-works/pi-ai/providers/all": fileURLToPath(new URL("../ai/src/providers/all.ts", import.meta.url)),
			"@earendil-works/pi-ai": fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			"@earendil-works/pi-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			"@earendil-works/pi-client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
			"@earendil-works/pi-server": fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
			"@earendil-works/chord/context": fileURLToPath(new URL("../chord/src/context/index.ts", import.meta.url)),
			"@earendil-works/chord": fileURLToPath(new URL("../chord/src/index.ts", import.meta.url)),
		},
	},
	ssr: { resolve: { conditions: ["source"] } },
});