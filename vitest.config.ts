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
	test: {
		// ⚠️ `node` is the default on purpose. vitest's jsdom environment is a SEPARATE JS realm, so
		// `instanceof ArrayBuffer`/`Uint8Array` is false for Node-made values — which is exactly what
		// `src/crdt/y-sync.ts` and lib0's encoder branch on. Making jsdom global would silently change
		// what the CRDT suite means, and costs ~410ms/file against a 3ms baseline. Files that render
		// opt in with a `// @vitest-environment jsdom` docblock. See test/setup.ts.
		environment: "node",
		include: ["test/**/*.test.ts"],
		setupFiles: ["./test/setup.ts"],
	},
});
