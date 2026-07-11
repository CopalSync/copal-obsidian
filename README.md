# Copal for Obsidian

Connect [Obsidian](https://obsidian.md) to your [Copal](https://copal.uk) vault — real-time sync, keep-both conflict handling, and by-meaning search. Works on **desktop and mobile**.

Copal is agent-native: the same vault your agent reads and writes is the one you edit in Obsidian, kept in sync live.

> **Status: beta.** This plugin is in pre-release. It requires a Copal account ([copal.uk](https://copal.uk)).

## How it works

- Every note is a local-first [Yjs](https://github.com/yjs/yjs) CRDT document, persisted on-device, so edits — offline, closed, or live — merge without conflicts or data loss.
- Sign in once with a one-time magic link (OAuth 2.0 + PKCE, `obsidian://` redirect). No token to paste.
- Your Markdown files always stay as plain files on disk. Sign out or disconnect any time and they remain.

## Install (beta, via BRAT)

Until Copal is in the Community Plugins store, install the beta with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Community Plugins and enable it.
2. BRAT → **Add beta plugin** → enter `CopalSync/copal-obsidian`.
3. Enable **Copal** in Settings → Community plugins, then open its settings and **Log in**.

## Development

This is a [pnpm](https://pnpm.io) project.

```bash
pnpm install
pnpm build      # tsgo typecheck + esbuild → main.js
pnpm test       # vitest
pnpm typecheck
pnpm lint       # oxlint
```

`main.js` is built, not committed — it is attached to each GitHub release.

## Privacy

Your Copal sign-in is stored in this vault's plugin data (`.obsidian/plugins/copal/data.json`). If you sync this vault elsewhere (iCloud, Obsidian Sync, git…), your sign-in travels with it — sign out on devices you no longer use.
