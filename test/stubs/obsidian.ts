/**
 * The `obsidian` module, as a test double with a real vault.
 *
 * `vitest.config.ts` aliases `obsidian` here, so this file is what `src/` imports under test. It is
 * still a double, not an emulator — nothing lays out or paints — but the parts the plugin actually
 * talks to now BEHAVE: the vault is a real in-memory filesystem, `TFile`/`TFolder` are real classes so
 * `instanceof` works, events can be triggered and unsubscribed, and registrations are honoured instead
 * of merely recorded. Roadmap row G11.
 *
 * ## What the previous version got wrong, which is why the mechanism below matters
 *
 * A test double encodes its author's beliefs about the platform, so tests against it can be green and
 * wrong in exactly the way the double is wrong. Three such defects shipped here undetected:
 *
 *  - `TFile` was a type ALIAS, so it erased to `undefined` at runtime. `src/sync/obsidian-vault.ts`
 *    imports it as a VALUE and branches on `instanceof TFile`, so the adapter would have thrown
 *    `TypeError: Right-hand side of 'instanceof' is not an object` on its first call. It never did,
 *    only because every path reaching it sat behind an `onLayoutReady` this file never fired.
 *  - `Platform` exported `{ isMobile: false }` while `src/ui/external-link.ts` reads
 *    `Platform.isDesktop` — `undefined`, so a test would have silently taken the MOBILE branch and
 *    passed while proving the opposite.
 *  - `FakeEvents` had no `off`/`offref`, so "listeners get removed" was unprovable.
 *
 * ## The guard
 *
 * ⛔ `tsc` resolves `obsidian` to the REAL package (there is no `paths` alias, and `test/` is in
 * `tsconfig.json`'s `include`), while vitest resolves it here. So the classes below declare
 * `implements` against the real 1.7.2 declarations: a member that does not exist upstream, or whose
 * signature drifts, is a COMPILE ERROR rather than a passing test.
 *
 * ⚠️ Three limits of that guard, stated because they are invisible otherwise:
 *   1. It fires in `pnpm typecheck`, NOT in `vitest run`. CI runs both; a local `pnpm test` does not.
 *   2. `implements` cannot detect its own deletion — removing the clause removes the check and both
 *      commands stay green. `scripts/assert-stub-conformance.mjs` is what catches that.
 *   3. Method parameters are compared BIVARIANTLY, so the double is allowed to be sloppier than the
 *      real API (a widened parameter type conforms). Returns are checked strictly.
 *
 * ⚠️ This file may import from `"obsidian"` with `import type` ONLY. A value import is a runtime
 * self-import through the alias, i.e. a circular module with TDZ hazards on these class declarations.
 *
 * ⚠️ Nothing here may touch `document` at module scope: ~45 test files import this module under the
 * default `node` environment. DOM-backed classes build their elements in the constructor and call
 * `requireDom()` first, which fails with an instruction rather than `document is not defined`.
 */
import type {
	App as RealApp,
	DataAdapter,
	DataWriteOptions,
	EventRef as RealEventRef,
	Events as RealEvents,
	FileStats,
	ListedFiles,
	SecretStorage as RealSecretStorage,
	Stat,
	TAbstractFile as RealTAbstractFile,
	TFile as RealTFile,
	TFolder as RealTFolder,
	Vault as RealVault,
} from "obsidian";

/** A DOM-backed stub class was constructed under the `node` environment. Say what to do about it. */
function requireDom(what: string): void {
	if (typeof document === "undefined") {
		throw new Error(
			`obsidian stub: ${what} needs a DOM. Add \`// @vitest-environment jsdom\` to the top of this test file.`,
		);
	}
}

/** `export interface EventRef {}` upstream — empty, so any object satisfies it. */
export interface EventRef extends RealEventRef {}

class Subscription implements EventRef {
	constructor(
		readonly owner: Events,
		readonly name: string,
		readonly fn: (...data: never[]) => unknown,
		readonly ctx?: unknown,
	) {}
}

/**
 * Obsidian's `Events`. `off`/`offref` genuinely remove — the previous double could only ever grow its
 * handler list, which made listener teardown unprovable.
 */
export class Events implements RealEvents {
	private readonly subs = new Map<string, Subscription[]>();

	on(name: string, callback: (...data: never[]) => unknown, ctx?: unknown): EventRef {
		const sub = new Subscription(this, name, callback, ctx);
		const list = this.subs.get(name);
		if (list === undefined) this.subs.set(name, [sub]);
		else list.push(sub);
		return sub;
	}

	off(name: string, callback: (...data: never[]) => unknown): void {
		const list = this.subs.get(name);
		if (list === undefined) return;
		const i = list.findIndex((s) => s.fn === callback);
		if (i >= 0) list.splice(i, 1);
	}

	offref(ref: EventRef): void {
		if (!(ref instanceof Subscription)) return;
		const list = this.subs.get(ref.name);
		if (list === undefined) return;
		const i = list.indexOf(ref);
		if (i >= 0) list.splice(i, 1);
	}

	/** Obsidian's name for firing an event. Iterates a COPY so a handler may unsubscribe mid-dispatch. */
	trigger(name: string, ...data: unknown[]): void {
		// The copy is load-bearing: a handler may unsubscribe during dispatch, and splicing the array
		// being iterated would skip whichever handler followed it.
		// oxlint-disable-next-line unicorn/no-useless-spread -- iterating a copy is deliberate here
		for (const sub of [...(this.subs.get(name) ?? [])]) {
			(sub.fn as (...a: unknown[]) => unknown).apply(sub.ctx, data);
		}
	}

	tryTrigger(evt: EventRef, args: unknown[]): void {
		if (!(evt instanceof Subscription)) return;
		try {
			(evt.fn as (...a: unknown[]) => unknown).apply(evt.ctx, args);
		} catch (err) {
			console.error(err);
		}
	}

	/** Test helper: how many handlers are live for an event. Proves registration AND teardown. */
	listenerCount(name: string): number {
		return (this.subs.get(name) ?? []).length;
	}
}

// ── The file tree ───────────────────────────────────────────────────────────────────────────────────
// Real classes, so `instanceof TFile` works. Identity is stable per path, as it is in Obsidian: the
// same object comes back from repeated lookups, which code may rely on.

export abstract class TAbstractFile implements RealTAbstractFile {
	vault!: RealVault;
	path: string;
	name: string;
	parent: RealTFolder | null = null;

	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
	}
}

export class TFile extends TAbstractFile implements RealTFile {
	stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
	basename: string;
	extension: string;

	constructor(path: string) {
		super(path);
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
	}
}

export class TFolder extends TAbstractFile implements RealTFolder {
	children: RealTAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/" || this.path === "";
	}
}

/** Bytes or text, plus the stat Obsidian would keep. */
interface Entry {
	text?: string;
	bytes?: ArrayBuffer;
	stat: FileStats;
}

function unimplemented(member: string): never {
	throw new Error(
		`obsidian stub: ${member} is not implemented. Implement it here rather than working around it — ` +
			`a silent no-op is how a double starts disagreeing with Obsidian.`,
	);
}

/**
 * `DataAdapter` over the same in-memory tree as the Vault.
 *
 * All 19 members are declared so `implements DataAdapter` holds: a property is checked strictly (no
 * bivariance), so a partial adapter would force a cast and lose the drift detection. The ones the
 * plugin does not use throw rather than returning something plausible.
 */
class Adapter implements DataAdapter {
	constructor(private readonly vault: Vault) {}

	getName(): string {
		return this.vault.getName();
	}
	exists(normalizedPath: string): Promise<boolean> {
		return Promise.resolve(this.vault.__entries().has(normalizedPath));
	}
	stat(normalizedPath: string): Promise<Stat | null> {
		const e = this.vault.__entries().get(normalizedPath);
		if (e === undefined) {
			return Promise.resolve(
				this.vault.__folders().has(normalizedPath)
					? { type: "folder", ctime: 0, mtime: 0, size: 0 }
					: null,
			);
		}
		return Promise.resolve({ type: "file", ...e.stat });
	}
	read(normalizedPath: string): Promise<string> {
		return Promise.resolve(this.vault.__readText(normalizedPath));
	}
	readBinary(normalizedPath: string): Promise<ArrayBuffer> {
		return Promise.resolve(this.vault.__readBytes(normalizedPath));
	}
	write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
		this.vault.__put(normalizedPath, { text: data }, options);
		return Promise.resolve();
	}
	writeBinary(
		normalizedPath: string,
		data: ArrayBuffer,
		options?: DataWriteOptions,
	): Promise<void> {
		this.vault.__put(normalizedPath, { bytes: data }, options);
		return Promise.resolve();
	}
	mkdir(normalizedPath: string): Promise<void> {
		this.vault.__mkdirp(normalizedPath);
		return Promise.resolve();
	}
	remove(normalizedPath: string): Promise<void> {
		this.vault.__entries().delete(normalizedPath);
		return Promise.resolve();
	}
	list(_normalizedPath: string): Promise<ListedFiles> {
		return unimplemented("DataAdapter.list");
	}
	append(): Promise<void> {
		return unimplemented("DataAdapter.append");
	}
	process(): Promise<string> {
		return unimplemented("DataAdapter.process");
	}
	getResourcePath(): string {
		return unimplemented("DataAdapter.getResourcePath");
	}
	trashSystem(): Promise<boolean> {
		return unimplemented("DataAdapter.trashSystem");
	}
	trashLocal(): Promise<void> {
		return unimplemented("DataAdapter.trashLocal");
	}
	rmdir(): Promise<void> {
		return unimplemented("DataAdapter.rmdir");
	}
	rename(): Promise<void> {
		return unimplemented("DataAdapter.rename");
	}
	copy(): Promise<void> {
		return unimplemented("DataAdapter.copy");
	}
}

/**
 * Obsidian's `Vault`, over an in-memory tree.
 *
 * ⚠️ Three fidelity decisions are encoded here deliberately, because a comment in `src/` cannot be
 * tested and a lenient double makes the production code's precautions unfalsifiable:
 *
 *  1. **`create()` throws when the path exists**, as Obsidian's does. `ObsidianVault.write` checks
 *     first and calls `process()` instead; without this throw, deleting that check stays green.
 *  2. **`modify()` throws**, pointing at `process()`. `src/sync/obsidian-vault.ts` documents why the
 *     remote→local write must be an atomic read-modify-write; `modify` and `process` are
 *     content-indistinguishable, so only a refusal here can hold that decision in place.
 *  3. **`getMarkdownFiles()` is markdown-only**, which sounds trivial but is load-bearing:
 *     `src/crdt/crdt-sync.ts` derives `toRemove` from `vault.list()` and sends it to Obsidian's
 *     TRASH. If attachments appeared in that set, an adopt reconcile would bin every local
 *     attachment.
 */
export class Vault extends Events implements RealVault {
	readonly adapter: DataAdapter = new Adapter(this);
	configDir = ".obsidian";

	private readonly entries = new Map<string, Entry>();
	private readonly folders = new Set<string>([""]);
	private readonly nodes = new Map<string, TFile | TFolder>();
	/** Monotonic mtime source: every write is strictly newer than the one before it. */
	private clock = 1;
	/** Ledger of what `trash()` took, so a test can prove `remove()` trashes rather than deletes. */
	readonly trashed: string[] = [];
	/** Ledger of hard `delete()` calls — must stay empty for the sync paths. */
	readonly hardDeleted: string[] = [];

	constructor(
		initial: Record<string, string> = {},
		private readonly name = "stub-vault",
	) {
		super();
		for (const [path, text] of Object.entries(initial)) this.__put(path, { text });
	}

	// ── internals the Adapter and tests share ─────────────────────────────────────────────────────
	__entries(): Map<string, Entry> {
		return this.entries;
	}
	__folders(): Set<string> {
		return this.folders;
	}
	__put(
		path: string,
		data: { text?: string; bytes?: ArrayBuffer },
		options?: DataWriteOptions,
	): TFile {
		const size = data.text !== undefined ? data.text.length : (data.bytes?.byteLength ?? 0);
		// A monotonic clock, so a rewrite always has a later mtime than the write before it — which is
		// what P4's stat gate compares. Leaving everything at 0 would make that gate untestable.
		const now = options?.mtime ?? this.clock++;
		const stat: FileStats = { ctime: options?.ctime ?? now, mtime: now, size };
		this.entries.set(path, { ...data, stat });
		this.__mkdirp(path.split("/").slice(0, -1).join("/"));
		const node = this.__node(path, "file") as TFile;
		// ⚠️ Nodes are CACHED for identity, so the stat has to be refreshed here. Left at the constructor
		// default, `TFile.stat` stayed `{0,0,0}` for ever — stale in exactly the way reaching through
		// `vault.adapter` leaves it stale in Obsidian, which is what G2 moved away from.
		node.stat = stat;
		return node;
	}
	__mkdirp(dir: string): void {
		if (dir === "") return;
		const parts = dir.split("/");
		for (let i = 1; i <= parts.length; i += 1) {
			const sub = parts.slice(0, i).join("/");
			if (sub !== "") this.folders.add(sub);
		}
	}
	__readText(path: string): string {
		const e = this.entries.get(path);
		if (e?.text === undefined) throw new Error(`obsidian stub: no text file at ${path}`);
		return e.text;
	}
	__readBytes(path: string): ArrayBuffer {
		const e = this.entries.get(path);
		if (e?.bytes === undefined) throw new Error(`obsidian stub: no binary file at ${path}`);
		return e.bytes;
	}
	/** Stable identity per path, as Obsidian gives. */
	private __node(path: string, kind: "file" | "folder"): TFile | TFolder {
		const existing = this.nodes.get(path);
		if (existing !== undefined) return existing;
		const node = kind === "file" ? new TFile(path) : new TFolder(path);
		node.vault = this as unknown as RealVault;
		this.nodes.set(path, node);
		return node;
	}
	/** Test helper: the whole text tree as a plain object. */
	snapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [p, e] of this.entries) if (e.text !== undefined) out[p] = e.text;
		return out;
	}

	// ── the real surface ──────────────────────────────────────────────────────────────────────────
	getName(): string {
		return this.name;
	}
	getRoot(): RealTFolder {
		return this.__node("", "folder") as unknown as RealTFolder;
	}
	getFileByPath(path: string): RealTFile | null {
		return this.entries.has(path) ? (this.__node(path, "file") as unknown as RealTFile) : null;
	}
	getFolderByPath(path: string): RealTFolder | null {
		return this.folders.has(path) ? (this.__node(path, "folder") as unknown as RealTFolder) : null;
	}
	getAbstractFileByPath(path: string): RealTAbstractFile | null {
		if (this.entries.has(path)) return this.__node(path, "file") as unknown as RealTAbstractFile;
		if (this.folders.has(path) && path !== "") {
			return this.__node(path, "folder") as unknown as RealTAbstractFile;
		}
		return null;
	}
	create(path: string, data: string, options?: DataWriteOptions): Promise<RealTFile> {
		// Obsidian throws here. See fidelity decision 1 above. A FOLDER at the path occupies it too.
		if (this.entries.has(path) || this.folders.has(path)) {
			return Promise.reject(new Error(`File already exists: ${path}`));
		}
		return Promise.resolve(this.__put(path, { text: data }, options) as unknown as RealTFile);
	}
	createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<RealTFile> {
		if (this.entries.has(path) || this.folders.has(path)) {
			return Promise.reject(new Error(`File already exists: ${path}`));
		}
		return Promise.resolve(this.__put(path, { bytes: data }, options) as unknown as RealTFile);
	}
	createFolder(path: string): Promise<RealTFolder> {
		if (this.folders.has(path)) return Promise.reject(new Error(`Folder already exists: ${path}`));
		this.__mkdirp(path);
		return Promise.resolve(this.__node(path, "folder") as unknown as RealTFolder);
	}
	read(file: RealTFile): Promise<string> {
		return Promise.resolve(this.__readText(file.path));
	}
	cachedRead(file: RealTFile): Promise<string> {
		return Promise.resolve(this.__readText(file.path));
	}
	readBinary(file: RealTFile): Promise<ArrayBuffer> {
		return Promise.resolve(this.__readBytes(file.path));
	}
	modify(_file: RealTFile, _data: string, _options?: DataWriteOptions): Promise<void> {
		// See fidelity decision 2 above.
		return Promise.reject(
			new Error(
				"obsidian stub: use vault.process(), not vault.modify() — see src/sync/obsidian-vault.ts " +
					"on why the remote→local write must be an atomic read-modify-write.",
			),
		);
	}
	modifyBinary(file: RealTFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		this.__put(file.path, { bytes: data }, options);
		return Promise.resolve();
	}
	process(
		file: RealTFile,
		fn: (data: string) => string,
		options?: DataWriteOptions,
	): Promise<string> {
		const next = fn(this.__readText(file.path));
		this.__put(file.path, { text: next }, options);
		return Promise.resolve(next);
	}
	trash(file: RealTAbstractFile, _system: boolean): Promise<void> {
		this.trashed.push(file.path);
		this.entries.delete(file.path);
		this.folders.delete(file.path);
		this.nodes.delete(file.path);
		return Promise.resolve();
	}
	delete(file: RealTAbstractFile, _force?: boolean): Promise<void> {
		this.hardDeleted.push(file.path);
		this.entries.delete(file.path);
		this.nodes.delete(file.path);
		return Promise.resolve();
	}
	rename(file: RealTAbstractFile, newPath: string): Promise<void> {
		const e = this.entries.get(file.path);
		if (e === undefined) return Promise.reject(new Error(`not found: ${file.path}`));
		this.entries.delete(file.path);
		this.nodes.delete(file.path);
		this.entries.set(newPath, e);
		this.__mkdirp(newPath.split("/").slice(0, -1).join("/"));
		return Promise.resolve();
	}
	getAllLoadedFiles(): RealTAbstractFile[] {
		return [...this.getFiles(), ...this.getAllFolders()];
	}
	getAllFolders(includeRoot?: boolean): RealTFolder[] {
		return [...this.folders]
			.filter((p) => p !== "" || includeRoot === true)
			.map((p) => this.__node(p, "folder") as unknown as RealTFolder);
	}
	getFiles(): RealTFile[] {
		return this.__files();
	}
	/** Markdown only. See fidelity decision 3 above — this one guards against trashing attachments. */
	getMarkdownFiles(): RealTFile[] {
		// ⚠️ Deliberately NOT `this.getFiles().filter(...)`. Obsidian's two methods are independent, and
		// routing one through the other makes a test that spies on `getFiles` observe this double's
		// plumbing instead of what the code under test actually asked for.
		return this.__files().filter((f) => f.extension === "md");
	}
	private __files(): RealTFile[] {
		return [...this.entries.keys()].map((p) => this.__node(p, "file") as unknown as RealTFile);
	}
	getResourcePath(): string {
		return unimplemented("Vault.getResourcePath");
	}
	append(): Promise<void> {
		return unimplemented("Vault.append");
	}
	copy<T extends RealTAbstractFile>(): Promise<T> {
		return unimplemented("Vault.copy");
	}
	static recurseChildren(root: RealTFolder, cb: (file: RealTAbstractFile) => unknown): void {
		const walk = (folder: RealTFolder): void => {
			cb(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child as unknown as RealTFolder);
				else cb(child);
			}
		};
		walk(root);
	}
}

// ── Workspace ───────────────────────────────────────────────────────────────────────────────────────

export interface WorkspaceLeaf {
	view?: unknown;
	setViewState?: (state: unknown) => Promise<void>;
}

export class MarkdownView {}

/**
 * Enough `Workspace` to run `onload()` AND to fire layout-ready, which the previous double recorded
 * and never fired — so everything inside that callback (the startup reconcile, the reauth notice, the
 * connect decision) was dead code under test.
 */
export class Workspace extends Events {
	layoutReadyCb: (() => void) | undefined;
	/** Leaves a test has arranged; `getLeavesOfType` filters on the recorded view type. */
	readonly leaves: { type: string; leaf: WorkspaceLeaf }[] = [];
	activeFile: TFile | null = null;
	activeView: unknown = null;
	readonly revealed: WorkspaceLeaf[] = [];
	readonly opened: string[] = [];

	onLayoutReady(cb: () => void): void {
		this.layoutReadyCb = cb;
	}
	/** Fire it. The whole point of G11: this path had never executed. */
	async fireLayoutReady(): Promise<void> {
		const cb = this.layoutReadyCb;
		if (cb === undefined) throw new Error("obsidian stub: onLayoutReady was never registered");
		// Obsidian types the callback `() => any`, and `main.ts` returns void while starting async work
		// inside. `Promise.resolve` covers both without claiming the callback is thenable.
		await Promise.resolve(cb());
	}
	getActiveViewOfType(): unknown {
		return this.activeView;
	}
	getActiveFile(): TFile | null {
		return this.activeFile;
	}
	openLinkText(path: string): Promise<void> {
		this.opened.push(path);
		return Promise.resolve();
	}
	getLeavesOfType(viewType: string): WorkspaceLeaf[] {
		return this.leaves.filter((l) => l.type === viewType).map((l) => l.leaf);
	}
	getRightLeaf(_split: boolean): WorkspaceLeaf | null {
		const leaf: WorkspaceLeaf = { setViewState: () => Promise.resolve() };
		return leaf;
	}
	/** @since 1.7.2 this returns a promise — `main.ts` awaits it. */
	revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
		this.revealed.push(leaf);
		return Promise.resolve();
	}
}

/**
 * Obsidian's secret store (`app.secretStorage`, since 1.11.4), as Obsidian 1.14.5 implements it: one
 * map, ids that must be lowercase alphanumeric with dashes and at most 64 long (`setSecret` throws
 * otherwise), `null` for an id never set. The real class declares a private member, which no other
 * class can implement, so this conforms to its public surface.
 *
 * Pass one instance to two apps to model mobile, where the store is one namespace for the whole app.
 */
type PublicSecretStorage = Pick<RealSecretStorage, "setSecret" | "getSecret" | "listSecrets">;
export class SecretStorage extends Events implements PublicSecretStorage {
	readonly secrets = new Map<string, string>();

	setSecret(id: string, secret: string): void {
		if (!/^[a-z0-9-]+$/.test(id) || id.length > 64) {
			throw new Error("Secret ID must be lowercase alphanumeric with optional dashes");
		}
		this.secrets.set(id, secret);
		this.trigger("changed");
	}

	getSecret(id: string): string | null {
		return this.secrets.get(id) ?? null;
	}

	listSecrets(): string[] {
		return [...this.secrets.keys()];
	}
}

/**
 * The fields the plugin reads: `vault`, `workspace`, `secretStorage`, and the per-vault localStorage
 * (`loadLocalStorage` / `saveLocalStorage`, which Obsidian keys by the vault's id and JSON-encodes).
 */
class AppStub {
	private readonly local = new Map<string, string>();

	constructor(
		readonly vault: Vault,
		readonly workspace: Workspace = new Workspace(),
		readonly secretStorage: SecretStorage = new SecretStorage(),
	) {}

	loadLocalStorage(key: string): unknown {
		const raw = this.local.get(key);
		return raw === undefined ? null : (JSON.parse(raw) as unknown);
	}

	saveLocalStorage(key: string, data: unknown): void {
		if (data === null || data === undefined) this.local.delete(key);
		else this.local.set(key, JSON.stringify(data));
	}
}

/**
 * ⛔ **THE SEAM.** The one cast in this file.
 *
 * Real `App` carries nine fields — `keymap`, `scope`, `metadataCache`, `fileManager`, `lastEvent`,
 * `renderContext` and more — none of which the plugin touches, and `Workspace` alone is 100+ members.
 * Modelling them to satisfy `implements App` would be noise, so the cast is here, named, once.
 *
 * Everything reachable through `.vault` below this line IS compiler-checked against the real
 * declarations: `Vault implements RealVault` and `Adapter implements DataAdapter` hold without casts,
 * which is what makes that subtree trustworthy. Widening this cast, or adding another, gives that up.
 */
export function stubApp(
	files: Record<string, string> = {},
	vaultName?: string,
	secretStorage: SecretStorage = new SecretStorage(),
): RealApp {
	const vault = vaultName === undefined ? new Vault(files) : new Vault(files, vaultName);
	return new AppStub(vault, new Workspace(), secretStorage) as unknown as RealApp;
}

/** The stub secret store behind a `stubApp()`. */
export function secretsOf(app: RealApp): SecretStorage {
	return app.secretStorage as unknown as SecretStorage;
}

/** The stub vault behind a `stubApp()`, for arranging and asserting. */
export function vaultOf(app: RealApp): Vault {
	return app.vault as unknown as Vault;
}

/** The stub workspace behind a `stubApp()`. */
export function workspaceOf(app: RealApp): Workspace {
	return app.workspace as unknown as Workspace;
}

/** Kept for the `new App()` call sites that only need a constructor argument. */
export class App extends AppStub {
	constructor() {
		super(new Vault());
	}
}

// ── Plugin ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Enough `Plugin` for `onload()` to run. `loadData`/`saveData` are a real in-memory `data.json`, which
 * is the point: they are what proves `main.ts` hands ITS OWN pair to the single writer.
 *
 * Registrations are now HONOURED, not merely counted: `registerEvent` keeps the ref so `unload()` can
 * release it, and `registerDomEvent` attaches a real listener. That is what makes teardown provable.
 */
export class Plugin {
	private stored: unknown = null;
	readonly commands: {
		id: string;
		name?: string;
		checkCallback?: (checking: boolean) => boolean;
	}[] = [];
	readonly views = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
	readonly protocolHandlers = new Map<string, (p: Record<string, string>) => unknown>();
	readonly settingTabs: unknown[] = [];
	readonly eventRefs: EventRef[] = [];
	readonly domEvents: { el: unknown; type: string; cb: EventListener }[] = [];
	readonly editorExtensions: unknown[] = [];
	readonly ribbonIcons: { icon: string; title: string; el: HTMLElement }[] = [];

	constructor(
		readonly app: RealApp,
		readonly manifest: unknown,
	) {}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.stored);
	}
	saveData(data: unknown): Promise<void> {
		// Serialised, as Obsidian does: the bytes are frozen at write time, so a later mutation of the
		// caller's object cannot retroactively change what an earlier write is recorded as having saved.
		this.stored = JSON.parse(JSON.stringify(data));
		return Promise.resolve();
	}
	registerEvent(ref: EventRef): void {
		this.eventRefs.push(ref);
	}
	registerDomEvent(el: unknown, type: string, cb: EventListener): void {
		this.domEvents.push({ el, type, cb });
		(el as EventTarget | undefined)?.addEventListener?.(type, cb);
	}
	registerEditorExtension(ext: unknown): void {
		this.editorExtensions.push(ext);
	}
	registerObsidianProtocolHandler(name: string, cb: (p: Record<string, string>) => unknown): void {
		this.protocolHandlers.set(name, cb);
	}
	registerView(type: string, factory: (leaf: WorkspaceLeaf) => unknown): void {
		this.views.set(type, factory);
	}
	addCommand(cmd: {
		id: string;
		name?: string;
		checkCallback?: (checking: boolean) => boolean;
	}): typeof cmd {
		this.commands.push(cmd);
		return cmd;
	}
	addStatusBarItem(): HTMLElement {
		requireDom("Plugin.addStatusBarItem");
		return document.createElement("div");
	}
	addRibbonIcon(icon: string, title: string, _cb: unknown): HTMLElement {
		requireDom("Plugin.addRibbonIcon");
		const el = document.createElement("div");
		this.ribbonIcons.push({ icon, title, el });
		return el;
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
	/** Release every registration, as Obsidian's Component teardown does. */
	unload(): void {
		for (const ref of this.eventRefs) {
			if (ref instanceof Subscription) ref.owner.offref(ref);
		}
		this.eventRefs.length = 0;
		for (const { el, type, cb } of this.domEvents) {
			(el as EventTarget | undefined)?.removeEventListener?.(type, cb);
		}
		this.domEvents.length = 0;
	}
}

export class PluginSettingTab {
	/** Real `PluginSettingTab` has one and `display()`/`refresh()` empty it, so the stub must too. */
	readonly containerEl: HTMLElement;
	constructor(
		public app?: unknown,
		public plugin?: unknown,
	) {
		requireDom("PluginSettingTab");
		this.containerEl = document.createElement("div");
	}
}

/**
 * Real `ItemView.containerEl` has two children — the view header and the view content — and
 * `contentEl` IS `children[1]`. `src/ui/search-view.ts` reads `containerEl.children[1]` directly, so
 * the double has to build that shape or the view renders into nothing.
 */
export class ItemView {
	readonly containerEl: HTMLElement;
	readonly contentEl: HTMLElement;
	readonly domEvents: { type: string; cb: EventListener }[] = [];

	constructor(readonly leaf?: WorkspaceLeaf) {
		requireDom("ItemView");
		this.containerEl = document.createElement("div");
		this.containerEl.createDiv({ cls: "view-header" });
		this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
	}
	registerDomEvent(el: unknown, type: string, cb: EventListener): void {
		this.domEvents.push({ type, cb });
		(el as EventTarget | undefined)?.addEventListener?.(type, cb);
	}
	registerInterval(id: number): number {
		return id;
	}
	addAction(_icon: string, _title: string, _cb: unknown): HTMLElement {
		return document.createElement("a");
	}
}

export class Menu {
	readonly items: { title?: string; icon?: string; onClick?: () => void }[] = [];
	addItem(cb: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		cb(item);
		this.items.push(item.spec);
		return this;
	}
	showAtMouseEvent(): void {}
	/** Test helper: invoke a recorded item by its title. */
	click(title: string): void {
		const item = this.items.find((i) => i.title === title);
		if (item === undefined) throw new Error(`obsidian stub: no menu item titled ${title}`);
		item.onClick?.();
	}
}

export class MenuItem {
	readonly spec: { title?: string; icon?: string; onClick?: () => void } = {};
	setTitle(t: string): this {
		this.spec.title = t;
		return this;
	}
	setIcon(i: string): this {
		this.spec.icon = i;
		return this;
	}
	onClick(cb: () => void): this {
		this.spec.onClick = cb;
		return this;
	}
	setDisabled(): this {
		return this;
	}
}

/**
 * ⚠️ `isDesktop` as well as `isMobile`. The previous double exported only `isMobile`, while
 * `src/ui/external-link.ts` branches on `Platform.isDesktop` — `undefined` under test, so a test
 * would have taken the MOBILE arm and passed while proving the opposite of its name.
 */
export const Platform = {
	isDesktop: true,
	isMobile: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	/** Flip both flags together; returns a restore function. */
	__setMobile(mobile: boolean): () => void {
		const before = {
			isDesktop: Platform.isDesktop,
			isMobile: Platform.isMobile,
			isMobileApp: Platform.isMobileApp,
		};
		Platform.isDesktop = !mobile;
		Platform.isMobile = mobile;
		Platform.isMobileApp = mobile;
		return () => Object.assign(Platform, before);
	},
};

export function setIcon(el: unknown, icon: string): void {
	(el as HTMLElement | undefined)?.setAttribute?.("data-icon", icon);
}
export function setTooltip(el: unknown, text: string, _opts?: unknown): void {
	(el as HTMLElement | undefined)?.setAttribute?.("aria-label", text);
}
/**
 * Obsidian 1.14.5's `normalizePath`, transcribed from its app bundle:
 * `Fl(e){return xl(Rl(e)).normalize("NFC")}`.
 *
 * ⛔ Kept faithful, folds and all. The stub used to only collapse slashes, so no test could see that
 * the real one maps U+00A0/U+202F to a space and composes to NFC — which is how a distinct server
 * note was folded onto the user's own note on every device.
 */
export function normalizePath(p: string): string {
	let e = p.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
	if (e === "") e = "/";
	return e.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}
export class Notice {
	static readonly shown: string[] = [];
	constructor(message: string, _timeout?: number) {
		Notice.shown.push(message);
	}
	/** Test helper: forget everything recorded so far. */
	static __reset(): void {
		Notice.shown.length = 0;
	}
}

// A swappable `requestUrl` (Obsidian's CORS-free native request) so the fetch-adapter unit test can drive
// controlled responses. `__setRequestUrl` replaces the implementation the exported `requestUrl` delegates to.
export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}
export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
	json: unknown;
}
let requestUrlImpl: (p: RequestUrlParam) => Promise<RequestUrlResponse> = () =>
	Promise.reject(new Error("requestUrl not stubbed in this test"));
export function __setRequestUrl(fn: (p: RequestUrlParam) => Promise<RequestUrlResponse>): void {
	requestUrlImpl = fn;
}
export function requestUrl(p: RequestUrlParam): Promise<RequestUrlResponse> {
	return requestUrlImpl(p);
}

export class ButtonComponent {
	readonly buttonEl: HTMLElement;
	onClickCb: (() => void) | undefined;
	constructor(containerEl?: HTMLElement) {
		requireDom("ButtonComponent");
		this.buttonEl = containerEl?.createEl("button") ?? document.createElement("button");
	}
	setButtonText(t: string): this {
		this.buttonEl.setText(t);
		return this;
	}
	setCta(): this {
		this.buttonEl.addClass("mod-cta");
		return this;
	}
	setWarning(): this {
		this.buttonEl.addClass("mod-warning");
		return this;
	}
	setIcon(i: string): this {
		setIcon(this.buttonEl, i);
		return this;
	}
	onClick(cb: () => void): this {
		this.onClickCb = cb;
		this.buttonEl.addEventListener("click", () => cb());
		return this;
	}
}

/**
 * `Setting` builds into real DOM, and `addButton` now KEEPS its component — the previous double
 * constructed one, invoked the callback and threw it away, so a test could never click the button and
 * had to reach for an escape hatch on the production class instead.
 */
export class Setting {
	readonly settingEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	readonly buttons: ButtonComponent[] = [];

	constructor(containerEl?: HTMLElement) {
		requireDom("Setting");
		this.settingEl =
			containerEl?.createDiv({ cls: "setting-item" }) ?? document.createElement("div");
		const info = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = info.createDiv({ cls: "setting-item-name" });
		this.descEl = info.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}
	setName(n: string): this {
		this.nameEl.setText(n);
		return this;
	}
	setDesc(d: string | DocumentFragment): this {
		this.descEl.setText(d);
		return this;
	}
	setHeading(): this {
		this.settingEl.addClass("setting-item-heading");
		return this;
	}
	addButton(cb: (b: ButtonComponent) => void): this {
		const button = new ButtonComponent(this.controlEl);
		this.buttons.push(button);
		cb(button);
		return this;
	}
}

export class Modal {
	readonly containerEl: HTMLElement;
	readonly contentEl: HTMLElement;
	readonly titleEl: HTMLElement;
	/** Obsidian will not re-run `onOpen` on an already-open modal, nor `onClose` on a closed one. */
	private isOpen = false;

	constructor(public app: unknown) {
		requireDom("Modal");
		this.containerEl = document.createElement("div");
		this.titleEl = this.containerEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.containerEl.createDiv({ cls: "modal-content" });
	}
	setTitle(t: string): this {
		this.titleEl.setText(t);
		return this;
	}
	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		// Obsidian attaches the modal to the document when it opens, so `document.querySelector` finds
		// its contents. A detached container would make a test for rendered output silently see nothing.
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}
	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose();
		this.containerEl.detach();
	}
	onOpen(): void {}
	onClose(): void {}
}
