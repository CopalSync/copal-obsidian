import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^obsidian$/,
				replacement: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)),
			},
		],
	},
	test: { environment: "node", include: ["test/**/*.test.ts"] },
});
