import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CrdtSync } from "../../src/crdt/crdt-sync";
import { asVaultId, LocalDocStore } from "../../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../../src/crdt/local-note-registry";
import type { SyncApi, YSyncRequest, YSyncResult } from "../../src/sync/api";
import { base64ToBytes, bytesToBase64 } from "../../src/sync/base64";
import { InMemoryVault } from "../sync/fake-vault";

/** Six pages, and nearly five times the resident bound — enough for the bound to bite. */
const NOTES = 600;

describe("P2 at scale", () => {
	it("holds a bounded set of docs however large the vault is", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < NOTES; i++) files[`n${i}.md`] = `body ${i}`;
		const vault = new InMemoryVault(files);
		const store = new LocalDocStore(() => Promise.resolve(asVaultId("scale1")));
		const registry = new LocalNoteRegistry(store, vault);
		const serverDocs = new Map<string, Y.Doc>();
		let peak = 0;

		const ycrdtSync = (body: YSyncRequest): Promise<YSyncResult[]> => {
			peak = Math.max(peak, registry.residentCount());
			return Promise.resolve(
				body.items.map((item) => {
					let doc = serverDocs.get(item.path);
					if (!doc) {
						doc = new Y.Doc();
						serverDocs.set(item.path, doc);
					}
					if (item.update !== undefined) Y.applyUpdate(doc, base64ToBytes(item.update), "b");
					return {
						path: item.path,
						ok: true,
						update: bytesToBase64(Y.encodeStateAsUpdate(doc, base64ToBytes(item.sv))),
						sv: bytesToBase64(Y.encodeStateVector(doc)),
					};
				}),
			);
		};
		const crdt = new CrdtSync({
			api: {
				manifest: () => Promise.resolve({ head: 0, manifest: [] }),
				deleteNote: () => Promise.resolve(),
				moveNote: () => Promise.resolve(),
				ycrdtSync,
			} as unknown as SyncApi,
			registry,
			vault,
			debounceMs: 0,
		});

		await crdt.reconcile([], "merge");
		peak = Math.max(peak, registry.residentCount());

		// ⛔ The number P2 exists for. The old scheme held every note it touched, so this figure WAS the
		// vault size — 2,000 docs and 2,000 IndexedDB connections for a 2,000-note vault, which is what
		// made a large vault unusable on a phone. Measured at 2,000 notes: peak 128, final 128, all
		// 2,000 persisted. Kept at 600 here so the suite stays quick; 600 is still six pages and nearly
		// five times the resident bound, which is what the assertion needs.
		expect(peak, "the resident set grew with the vault").toBeLessThanOrEqual(160);
		expect(registry.residentCount()).toBeLessThanOrEqual(160);
		expect((await registry.listPersisted()).length).toBe(NOTES);
		expect(serverDocs.size).toBe(NOTES);
		await registry.destroyAll();
	}, 120_000);
});
