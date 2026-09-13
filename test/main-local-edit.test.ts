import "fake-indexeddb/auto";
import { App } from "obsidian";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CrdtNote, type YTransport } from "../src/crdt/crdt-note";
import { CrdtSync } from "../src/crdt/crdt-sync";
import { asVaultId, LocalDocStore } from "../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../src/crdt/local-note-registry";
import type { SyncApi } from "../src/sync/api";
import CopalPlugin from "../src/main";
import { InMemoryVault } from "./sync/fake-vault";

/**
 * ⛔ **THE BURST, DRIVEN FROM THE PLUGIN'S OWN WATCHER HANDLER.**
 *
 * `crdt-sync.test.ts` proves the queue from `onLocalChange` inwards. That is one layer BELOW the entry
 * point: what Obsidian actually calls is `onVaultChange`, and everything the lost-edit bug depended on
 * — the `syncActive` gate, the `isSyncable` extension check, the active-note skip, and `pushLocalChange`
 * no longer reading the file itself — lives in `main.ts`, which for a long time nothing could even load.
 * F2 and C14 both survived a green suite for exactly that reason.
 *
 * It does NOT emulate Obsidian: the stub's `App` has no event emitter, so this calls the handler
 * Obsidian's `vault.on("modify", …)` registration calls, with the same argument shape.
 */
function pairedTransports(): { a: YTransport; b: YTransport } {
	const s: {
		aRecv?: (d: ArrayBuffer) => void;
		bRecv?: (d: ArrayBuffer) => void;
		aBuf: ArrayBuffer[];
		bBuf: ArrayBuffer[];
	} = { aBuf: [], bBuf: [] };
	const mk = (self: "a" | "b"): YTransport => ({
		send: (d) =>
			queueMicrotask(() => {
				const to = self === "a" ? "b" : "a";
				const recv = to === "a" ? s.aRecv : s.bRecv;
				if (recv) recv(d);
				else (to === "a" ? s.aBuf : s.bBuf).push(d);
			}),
		onMessage: (cb) => {
			if (self === "a") {
				s.aRecv = cb as (d: ArrayBuffer) => void;
				for (const d of s.aBuf.splice(0)) queueMicrotask(() => s.aRecv?.(d));
			} else {
				s.bRecv = cb as (d: ArrayBuffer) => void;
				for (const d of s.bBuf.splice(0)) queueMicrotask(() => s.bRecv?.(d));
			}
		},
		onOpen: (cb) => cb(),
		close: () => undefined,
	});
	return { a: mk("a"), b: mk("b") };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

let tenant = 0;

function makePlugin(files: Record<string, string>, gate?: () => Promise<void>) {
	const vault = new InMemoryVault(files);
	const registry = new LocalNoteRegistry(
		new LocalDocStore(() => Promise.resolve(asVaultId(`main-t${++tenant}`))),
		vault,
	);
	const serverDocs = new Map<string, Y.Doc>();
	let connects = 0;
	const crdt = new CrdtSync({
		api: {
			manifest: () => Promise.resolve({ head: 0, manifest: [] }),
			deleteNote: () => Promise.resolve(),
			moveNote: () => Promise.resolve(),
		} as unknown as SyncApi,
		registry,
		vault,
		settleMs: 0,
		transportFor: async (path: string) => {
			connects += 1;
			await gate?.();
			const { a, b } = pairedTransports();
			let doc = serverDocs.get(path);
			if (!doc) {
				doc = new Y.Doc();
				serverDocs.set(path, doc);
			}
			new CrdtNote(b, doc);
			return a;
		},
	});

	const plugin = new CopalPlugin(new App() as never, {} as never);
	const internals = plugin as unknown as { crdt: CrdtSync; syncActive: boolean };
	internals.crdt = crdt;
	internals.syncActive = true; // the watcher gate `onload` flips once the layout is ready

	// What Obsidian's `vault.on("modify", (f) => this.onVaultChange(f))` registration calls.
	const modify = (path: string) =>
		(plugin as unknown as { onVaultChange: (f: { path: string }) => void }).onVaultChange({ path });

	const serverText = (path: string) => serverDocs.get(path)?.getText("content").toString() ?? "";
	return { plugin, vault, modify, serverText, connects: () => connects };
}

describe("the plugin's own vault watcher", () => {
	it("keeps the newest edit when modify fires repeatedly during one sync", async () => {
		let open!: () => void;
		let gate: Promise<void> | undefined;
		const h = makePlugin({ "n.md": "first" }, () => gate ?? Promise.resolve());

		h.modify("n.md"); // establish shared history
		await waitFor(() => h.serverText("n.md") === "first");

		gate = new Promise<void>((r) => (open = r));
		h.modify("n.md"); // this one parks on the gate, mid-sync
		await waitFor(() => h.connects() > 1);

		// Obsidian autosaves twice more while that sync is still in flight.
		await h.vault.write("n.md", "first, then more");
		h.modify("n.md");
		await h.vault.write("n.md", "first, then more, then the last word");
		h.modify("n.md");

		open();
		await waitFor(() => h.serverText("n.md") === "first, then more, then the last word");
		expect(h.serverText("n.md")).toBe("first, then more, then the last word");
		expect(h.vault.snapshot()["n.md"], "the .md was rewritten behind the user's back").toBe(
			"first, then more, then the last word",
		);
	});

	it("ignores a modify for a non-markdown file", async () => {
		const h = makePlugin({ "pic.png": "binary" });
		h.modify("pic.png");
		await new Promise((r) => setTimeout(r, 20));
		expect(h.connects(), "an attachment reached the text CRDT").toBe(0);
	});

	it("ignores a modify while sync is switched off", async () => {
		const h = makePlugin({ "n.md": "text" });
		(h.plugin as unknown as { syncActive: boolean }).syncActive = false;
		h.modify("n.md");
		await new Promise((r) => setTimeout(r, 20));
		expect(h.connects(), "the watcher ran with sync disabled").toBe(0);
	});
});
