# Plugin notes

Developer-facing notes for `copal-plugin`. The README is written for the person installing the
plugin; this is the part that was in it before, kept because the incident history behind each guard
is the reason the guard is shaped the way it is.

## How sync works

**Notes are CRDT.** One Yjs `Y.Doc` per note, persisted locally, synced over a per-note WebSocket to
that note's `YNoteDO`. Local-first: edits apply immediately and converge, so two devices editing the
same paragraph merge rather than one clobbering the other. This replaced an earlier file-level
push/pull engine outright — there is no fallback path, deliberately.

**Attachments are not.** Binaries cannot CRDT-merge, so non-`.md` files go through `BinarySync`:
file-level last-writer-wins keyed on the **R2 etag** — never `mtime`, which is a server clock — with
an echo-suppressing etag+hash cursor, a keep-both `(conflicted copy)` on a 412, and a durable delete
queue so an offline delete is not lost.

The two are kept apart by three quarantine seams in `crdt-sync.ts`; `vault.list()` is markdown-only,
so a binary provably cannot reach `syncOnce`, and a mixed-manifest test asserts it.

## Things that bit, and the guards that came out of them

- ⚠️ **A control character in a filename breaks everything.** A note whose name contained a newline
  (from sharing a social post into Obsidian) could not be routed over HTTP, so its `/ycrdt` socket
  404'd and the client reconnect-looped — killing sync for the whole vault, not just that file. The
  `safePath` guard now applies to _local_ paths at the sync entry points; an unsyncable name is
  skipped with a one-time notice.
- ⚠️ **Vaults over 200 files never fully reconciled**, because the server manifest was capped. The
  manifest is now paged and the client loops pages.
- The `requestUrl` adapter (`sync/request-url-fetch.ts`) exists because Obsidian's mobile webview is
  not a browser: binary bodies, `ETag` and `Content-Type` passthrough all had to be handled by hand.
- Search is deliberately case-insensitive — iOS auto-capitalise was dropping borderline matches.
- Mobile has no `window.confirm`; destructive actions use a `ConfirmModal`.

## Testing on mobile without publishing

`app.emulateMobile(true)` on desktop covers the UI and `Platform` branches. Real-device deep links,
IndexedDB and WebSocket behaviour need a side-load (iCloud/Obsidian Sync/BRAT, or adb).

## Release

`node scripts/release-plugin.mjs <version> [--beta] [--dry-run]` from the monorepo root. It refuses a
dirty tree, runs every gate, mirrors an allowlist into a fresh clone of the public repo, builds there and
byte-compares the two bundles, then pushes and creates the release.

⛔ **No AI attribution anywhere** — not in commits, releases, issues or code comments.

## Commands

`pnpm dev` · `build` · `test` · `typecheck` · `lint` · `format`.
