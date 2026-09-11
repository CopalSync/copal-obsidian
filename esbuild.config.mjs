import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Obsidian's own module + Electron + CodeMirror + node builtins are provided by the host at runtime.
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	platform: "browser",
});

if (production) {
	await ctx.rebuild();
	await ctx.dispose();
} else {
	await ctx.watch();
}
