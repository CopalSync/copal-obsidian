# Copal

Real-time sync for your notes and attachments, with a hosted vault your AI agents can read and write
through MCP. Notes merge rather than clobber, conflicts keep both copies, and a search pane finds notes
by meaning rather than by exact words.

- **Notes sync live.** Two devices editing the same paragraph merge; neither overwrites the other.
- **Attachments sync too**, on a separate channel, with a keep-both copy if two devices change one.
- **Search by meaning.** The pane in the sidebar queries a server-side index, so "what did I decide
  about pricing" finds the note even when it never uses those words.
- **Your Markdown stays Markdown.** Files on disk are ordinary notes. Disconnecting leaves every one
  of them where it is.

## Requires an account, a subscription, and a network connection

Copal is a hosted service, and this plugin is the client for it. Please read this before installing.

- **An account is required.** Sign-in is a one-time link opened in your browser. There is no token to
  paste. You can create an account at [copal.uk](https://copal.uk).
- **A paid subscription is required** to sync a vault (Solo or Pro). Pricing is at
  [copal.uk](https://copal.uk). Payment is taken in your browser by Stripe; the plugin never sees a
  card number and cannot subscribe on your behalf.
- **It sends your note content over the network**, to `api.copal.uk`, which is where your vault is
  stored. That is the purpose of the plugin. Nothing is sent anywhere else, and nothing is sent at all
  until you sign in and link a folder.
- **Nothing is downloaded or executed.** The plugin ships as a single `main.js` and fetches no code at
  runtime.
- **No analytics or telemetry.** Errors are logged to your own developer console, not collected.

[Privacy policy](https://copal.uk/privacy) · [Terms](https://copal.uk/terms) ·
[Sub-processors](https://copal.uk/subprocessors)

## Where your sign-in is stored

**Your Copal sign-in is kept in Obsidian's secure storage on this device, never in the vault folder.**
On desktop, Obsidian encrypts it with your operating system's keychain; on iOS and Android it is in the
system keychain. (On Linux without a keyring, Obsidian keeps it unencrypted and tells you so.) It is
listed under Settings → Keychain.

So a copy of this vault (iCloud, Obsidian Sync, Dropbox, git) carries no sign-in, and each device signs
in on its own.

Versions before 1.1.0 kept the sign-in in this vault's plugin data (`.obsidian/plugins/copal/data.json`),
where it travelled with any copy of the vault. From 1.1.0 the plugin revokes a sign-in it finds in that
file, so no copy of it can be used, and asks you to sign in once more on each device. **Update every
device that syncs this vault:** an older version keeps writing its sign-in into that file, and the
newer one revokes it.

Signing out asks Copal to revoke the sign-in, and tells you if it could not reach Copal to do so. Access
already granted can take up to an hour to lapse. The same disclosure appears in the plugin's own
settings pane.

## Installing

**From the community directory** (once approved): Settings → Community plugins → Browse → "Copal".

**Before then, with [BRAT](https://github.com/TfTHacker/obsidian42-brat):** install BRAT, then
_Add a beta plugin_ and give it `CopalSync/copal-obsidian`. Enable Copal in Community plugins.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from a
[release](https://github.com/CopalSync/copal-obsidian/releases) into
`<vault>/.obsidian/plugins/copal/`, then reload Obsidian.

Then open Settings → Copal and choose **Log in**. Your browser opens, you sign in, and you come back.

## Getting started

Signing in links this folder to a Copal vault. What happens next depends on what you already have:

- **No vaults yet** → this folder is uploaded as your first one. Nothing is deleted.
- **You already have a vault** → you are asked to choose. **Upload** makes a new Copal vault from this
  folder, keeping everything. **Adopt** replaces this folder's notes with an existing vault's, and says
  how many local files will move to Obsidian's trash before it does anything.

To pull an existing Copal vault down for the first time, make a new empty Obsidian vault and adopt into
that, which avoids any question of displacing notes you already have.

**Sign out** pauses sync and keeps the link, so signing back in resumes exactly where you were.
**Disconnect** unlinks the folder entirely and clears Copal's local sync state. Either way your
Markdown files stay.

## Mobile

Fully supported on iOS and Android, including the search pane (reachable from the ribbon icon, since
mobile has no status bar). Requires Obsidian 1.11.4 or later.

## Support

[copal.uk](https://copal.uk) ·
[Report an issue](https://github.com/CopalSync/copal-obsidian/issues)

For a bug report, turn on verbose logging first: run `localStorage['copal-debug'] = '1'` in the
developer console, reproduce the problem, and include what the console prints.

## Development

The source of truth is a private monorepo. This repository is the published build, and releases are cut
from it by a script. The architecture notes, the incident history behind each guard, and the testing
approach live in [`docs/plugin-notes.md`](docs/plugin-notes.md).

`pnpm dev` · `build` · `test` · `typecheck` · `lint` · `format`.

## Licence

See [LICENSE](LICENSE).
