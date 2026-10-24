import "fake-indexeddb/auto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, refresh } from "../../src/connect/oauth";
import { CrdtSync } from "../../src/crdt/crdt-sync";
import { asVaultId, LocalDocStore } from "../../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../../src/crdt/local-note-registry";
import { SyncApi } from "../../src/sync/api";
import { InMemoryVault } from "../sync/fake-vault";

/**
 * Live two-replica verification against the DEPLOYED gateway (`api.copal.uk`).
 *
 * The sync engine is deliberately Obsidian-free — `CrdtSync` takes a `VaultWriter`, `SyncApi` takes a
 * `fetch` — so two independent replicas can be driven from Node against the real server, real Durable
 * Objects, real R2 and the real change journal. That covers the substance of what "device verification"
 * was standing in for: convergence between two replicas, the lost-edit fix, and eviction with a restart.
 *
 * ⚠️ **What this does NOT cover, and what still needs a real device:** WebKit's IndexedDB (this runs on
 * `fake-indexeddb`), Obsidian's REAL `Vault` adapter and file watcher on real hardware, `obsidian://` deep
 * links, and `data.json` propagating between machines via iCloud or Obsidian Sync — which is the actual
 * trigger for `onExternalSettingsChange`. Those are genuinely device-only.
 *
 * Since G11 the adapter and the UI are no longer untested — `ObsidianVault`, `ObsidianBinaryVault`, the
 * settings tab, the search pane and the modals all run against a double whose conformance to the real
 * `obsidian` typings `tsc` enforces. That narrows what a device adds to the things above: real WebKit, a
 * real file watcher, and real inter-machine settings propagation.
 *
 * ⛔ Runs against a THROWAWAY vault it creates and deletes. Opt-in: `LIVE_VERIFY=1`.
 */
const LIVE = process.env.LIVE_VERIFY === "1";
const TOKEN_FILE = "/Users/zbimson/CopalTest/.obsidian/plugins/copal/data.json";
const API_BASE = "https://api.copal.uk";

interface StoredTokens {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	scope?: string;
}

const readData = (): { tokens?: StoredTokens; clientId?: string } =>
	JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as { tokens?: StoredTokens; clientId?: string };

let cached: string | undefined;

/**
 * The live access token, refreshed through the plugin's OWN `discover` + `refresh` when it has expired.
 *
 * ⚠️ Reading `data.json` and using the token verbatim is not enough: it is short-lived, so a harness that
 * only reads it works until it silently does not, and then reports the product as broken when the only
 * thing wrong is the credential. Going through the real refresh path also means this exercises the same
 * code the plugin uses, and the rotated pair is written back so the next run starts valid.
 */
const token = async (): Promise<string> => {
	if (cached) return cached;
	const data = readData();
	const stored = data.tokens;
	if (!stored?.access_token) throw new Error("no tokens in the test vault's data.json");
	// A minute of headroom, matching the plugin's own refresh skew.
	if (stored.expires_at > Date.now() + 60_000) {
		cached = stored.access_token;
		return cached;
	}
	if (!stored.refresh_token || !data.clientId) {
		throw new Error("the test vault's token has expired and there is nothing to refresh it with");
	}
	const d = await discover(globalThis.fetch);
	const fresh = await refresh(
		globalThis.fetch,
		d.token_endpoint,
		data.clientId,
		stored.refresh_token,
	);
	const merged = { ...readData(), tokens: fresh };
	writeFileSync(TOKEN_FILE, `${JSON.stringify(merged, null, 2)}\n`);
	cached = fresh.access_token;
	return cached;
};

let vaultId = "";

/** One replica: its own local store, its own files, pointed at the shared server vault. */
function device(name: string) {
	const vault = new InMemoryVault({});
	// Distinct local store names model two machines' separate IndexedDB; the SERVER vault is shared,
	// which is the whole point of the exercise.
	const store = new LocalDocStore(() => Promise.resolve(asVaultId(`live-${name}-${vaultId}`)));
	const registry = new LocalNoteRegistry(store, vault);
	const api = new SyncApi({
		f: (input, init) => globalThis.fetch(input as string, init),
		getToken: () => token(),
		getVaultId: () => vaultId,
	});
	const crdt = new CrdtSync({ api, registry, vault, debounceMs: 0, deviceId: () => name });
	return { crdt, registry, vault, store, api, name };
}

const rest = async (path: string, init: RequestInit = {}, useVault = true) => {
	const res = await globalThis.fetch(`${API_BASE}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${await token()}`,
			...(useVault && vaultId ? { "X-Copal-Vault": vaultId } : {}),
			...(init.body ? { "content-type": "application/json" } : {}),
		},
	});
	const text = await res.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json: (json ?? {}) as Record<string, unknown> };
};

/** R2 is written by a debounced alarm ~1s after the exchange, so reads are polled, not assumed. */
const eventually = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000) => {
	const started = Date.now();
	let last = await read();
	while (!ok(last)) {
		if (Date.now() - started > ms) return last;
		await new Promise((r) => setTimeout(r, 500));
		last = await read();
	}
	return last;
};

const serverText = async (path: string): Promise<string> => {
	const r = await rest(`/vault/${path.split("/").map(encodeURIComponent).join("/")}`);
	return r.status === 200 ? String((r.json as { content?: string }).content ?? "") : "";
};

beforeAll(async () => {
	if (!LIVE) return;
	const made = await rest(
		"/vaults",
		{ method: "POST", body: JSON.stringify({ name: `live-verify-${Date.now()}` }) },
		false,
	);
	vaultId = String(made.json.vaultId ?? "");
	expect(vaultId, `vault create failed: ${made.status}`).toMatch(/^vlt_/);
}, 60_000);

afterAll(async () => {
	if (!LIVE || !vaultId) return;
	await rest(`/vaults/${vaultId}`, { method: "DELETE" }, false);
}, 60_000);

describe.skipIf(!LIVE)("two replicas against the live gateway", () => {
	it("device A's note reaches device B, and B's reply reaches A", async () => {
		const a = device("alpha");
		const b = device("bravo");

		await a.vault.write("shared.md", "written on alpha");
		await a.crdt.onLocalChange("shared.md");
		await a.crdt.idle();
		expect(
			await eventually(
				() => serverText("shared.md"),
				(t) => t === "written on alpha",
			),
		).toBe("written on alpha");

		// B has never seen this vault: a full reconcile is how a second machine joins.
		await b.crdt.reconcile([], "merge");
		expect(b.vault.snapshot()["shared.md"]).toBe("written on alpha");

		// B edits; A picks it up on its next exchange.
		await b.vault.write("shared.md", "written on alpha, appended on bravo");
		await b.crdt.onLocalChange("shared.md");
		await b.crdt.idle();
		await a.crdt.onRemoteChange({ path: "shared.md", op: "put" });
		await a.crdt.idle();
		expect(a.vault.snapshot()["shared.md"]).toContain("bravo");

		await a.registry.destroyAll();
		await b.registry.destroyAll();
	}, 120_000);

	/**
	 * Bring-existing divergence, live. A local file that differs from the server at first import is the
	 * one place two independent texts meet, so neither may be discarded: the server's content lands at
	 * the path and the local text is kept beside it, stamped with the time and device so a second
	 * conflict cannot overwrite the first (S8).
	 */
	it("keeps a diverged local file as a conflict copy at first import", async () => {
		const seeder = device("seeder");
		for (let i = 0; i < 5; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await seeder.vault.write(`import/n${i}.md`, `seeded import/n${i}.md`);
		}
		await seeder.crdt.reconcile([], "merge");
		await seeder.crdt.idle();
		await seeder.registry.destroyAll();

		const joiner = device("joiner");
		await joiner.vault.write("import/n3.md", "WRITTEN LOCALLY BEFORE THIS DEVICE EVER SYNCED");
		await joiner.crdt.reconcile([], "merge");
		joiner.crdt.notify("import/n3.md", "live", true);
		await joiner.crdt.idle();

		const snap = joiner.vault.snapshot();
		expect(snap["import/n3.md"]).toBe("seeded import/n3.md");
		const copies = Object.entries(snap).filter(([k]) => k.includes("conflicted copy"));
		expect(copies, "the diverged local text was dropped rather than kept").toHaveLength(1);
		expect(copies[0]?.[1]).toBe("WRITTEN LOCALLY BEFORE THIS DEVICE EVER SYNCED");
		expect(copies[0]?.[0], "the copy is not attributable to a device").toContain("joiner");
		await joiner.registry.destroyAll();
	}, 180_000);

	/**
	 * ⛔ P1's actual fix, against the real server. `syncActive` used to flip only AFTER the initial
	 * reconcile, and the four vault watchers returned early while it was false with nothing queued to
	 * replay — so an edit made while an import was running was discarded outright. With shared history
	 * already established there is no divergence to arbitrate, so the edit must reach the server at its
	 * own path.
	 */
	it("an edit made while a reconcile is running reaches the server", async () => {
		const dev = device("editor");
		for (let i = 0; i < 12; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await dev.vault.write(`live/n${i}.md`, `body ${i}`);
		}
		// First reconcile: establishes shared history for every note.
		await dev.crdt.reconcile([], "merge");
		await dev.crdt.idle();
		await eventually(
			() => serverText("live/n5.md"),
			(t) => t === "body 5",
		);

		// Now edit DURING a reconcile, the way the watcher does.
		const reconciling = dev.crdt.reconcile([], "merge");
		await dev.vault.write("live/n5.md", "edited while the reconcile was running");
		dev.crdt.notify("live/n5.md", "live", true);
		await reconciling;
		await dev.crdt.idle();

		const landed = await eventually(
			() => serverText("live/n5.md"),
			(t) => t.includes("edited while"),
		);
		expect(landed, "an edit made during a reconcile never reached the server").toContain(
			"edited while the reconcile was running",
		);
		expect(
			Object.keys(dev.vault.snapshot()).filter((k) => k.includes("conflicted copy")),
			"a converged note should not produce a conflict copy",
		).toHaveLength(0);
		await dev.registry.destroyAll();
	}, 180_000);

	/**
	 * P2: the resident set stays bounded, and a "restart" (a new store over the same local database)
	 * comes back with content, the file hash and the server's state vector — the three things that make
	 * eviction safe rather than a data-loss event.
	 */
	it("bounds resident docs and survives a restart with its metadata", async () => {
		const first = device("persist");
		for (let i = 0; i < 20; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await first.vault.write(`keep/n${i}.md`, `body keep/n${i}.md`);
		}
		await first.crdt.reconcile([], "merge");
		await first.crdt.idle();
		expect(first.registry.residentCount()).toBeLessThanOrEqual(128);

		const before = await first.store.record("keep/n3.md");
		expect(before.serverSv, "no server state vector was recorded").not.toBeNull();
		expect(before.fileHash).not.toBe("");
		await first.store.closeAll();

		// The "restart": a new store over the same local database name.
		const again = new LocalDocStore(() => Promise.resolve(asVaultId(`live-persist-${vaultId}`)));
		const after = await again.record("keep/n3.md");
		expect(after.fileHash, "the file hash did not survive a restart").toBe(before.fileHash);
		expect(new Uint8Array(after.serverSv ?? new ArrayBuffer(0))).toEqual(
			new Uint8Array(before.serverSv ?? new ArrayBuffer(1)),
		);
		const reopened = again.open("keep/n3.md");
		await reopened.whenLoaded;
		expect(reopened.doc.getText("content").toJSON()).toBe("body keep/n3.md");
		await again.destroyAll();
	}, 180_000);

	/** A note deleted on one replica must be trashed on the other, not resurrected. */
	it("propagates a delete rather than resurrecting the note", async () => {
		const a = device("del-a");
		await a.vault.write("doomed.md", "delete me");
		await a.crdt.onLocalChange("doomed.md");
		await a.crdt.idle();
		await eventually(
			() => serverText("doomed.md"),
			(t) => t === "delete me",
		);

		const b = device("del-b");
		await b.crdt.reconcile([], "merge");
		expect(b.vault.snapshot()["doomed.md"]).toBe("delete me");

		await a.crdt.deleteLocal("doomed.md");
		await eventually(
			() => serverText("doomed.md"),
			(t) => t === "",
		);

		// B hears about it and must trash its copy, not push it back up.
		await b.crdt.onRemoteChange({ path: "doomed.md", op: "delete" });
		await b.crdt.idle();
		expect(b.vault.snapshot()["doomed.md"]).toBeUndefined();
		await b.crdt.reconcile(["doomed.md"], "merge");
		expect(await serverText("doomed.md"), "the delete was undone by a reconcile").toBe("");

		await a.registry.destroyAll();
		await b.registry.destroyAll();
	}, 180_000);
});
