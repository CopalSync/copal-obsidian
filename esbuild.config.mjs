import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Obsidian's own module + Electron + CodeMirror + node builtins are provided by the host at runtime.
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
	format: "cjs",
	// ⚠️ Matches `tsconfig.json`'s ES2022, which it did not: the compiler was checking against ES2022
	// while esbuild down-levelled to ES2018, so every modern construct shipped as a polyfilled
	// transform nobody asked for. `minAppVersion` 1.7.2 is Electron 29 / iOS 15+, all of which run
	// ES2022 natively. ROADMAP G10.
	target: "es2022",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	// ⛔ `keepNames` with minification. Obsidian's console is the only debugger a user can give you from
	// their own vault, and a minified stack of `t`/`e`/`n` makes a bug report unusable. ROADMAP G10/P9.
	minify: production,
	keepNames: production,
	outfile: "main.js",
	platform: "browser",
});

if (production) {
	await ctx.rebuild();
	await ctx.dispose();
} else {
	await ctx.watch();
}
