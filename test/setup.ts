/**
 * Per-file setup. Runs in whatever environment the file declares.
 *
 * ⚠️ The plugin suite runs under `node` by DEFAULT and opts into jsdom per file with a
 * `// @vitest-environment jsdom` docblock. That is deliberate, not laziness: vitest's jsdom
 * environment creates a SEPARATE JavaScript realm, so `instanceof ArrayBuffer` and
 * `instanceof Uint8Array` are false for values made by Node's own globals. Measured in this repo:
 *
 *   new TextEncoder().encode("ab").buffer instanceof ArrayBuffer   →  false
 *   structuredClone(new Uint8Array([1,2,3])) instanceof Uint8Array →  false
 *
 * `src/crdt/y-sync.ts`'s byte coercion branches on exactly that, and lib0's encoder decides
 * bytes-vs-object the same way, so making jsdom the default would silently change what the CRDT
 * suite means. It also costs ~410ms of environment setup per file against a 3ms baseline. Only the
 * files that genuinely render get the docblock.
 *
 * `crypto.subtle` needs no help here: vitest does not override `crypto`, so Node's WebCrypto
 * survives into the jsdom files (verified) — which matches Obsidian, where WebCrypto is real.
 */
import { installObsidianDom } from "./stubs/obsidian-dom";

// No-op under `node`; installs Obsidian's augmented DOM helpers wherever there is a document.
installObsidianDom();
