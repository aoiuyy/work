# Work (`@local/work-v2` — v2.0.1)

Minimalist collaboration plugin for **DeepSeek Harness (DSH)**: Multi-Repo Git Vault sharing, E2EE Chats & Channels, Saul YouTube Audio Player, Live Intel Reader, and a Studio Floating Bubble HUD — with zero paid cloud backend.

---

## Quick Install (Windows / DSH Desktop)

1. Download or clone this repository:
   ```powershell
   git clone https://github.com/aoiuyy/work.git
   cd work
   ```
   *(Or download `work-v2.0.1-install.zip` from [Releases](https://github.com/aoiuyy/work/releases) and extract it.)*

2. Run the 1-click installer:
   ```cmd
   install.cmd
   ```
   - Installs runtime dependencies (`npm install --omit=dev`).
   - Copies `@local/work-v2` into your DSH profile (`profiles/desktop` or `profiles/web`) — safe to delete the extracted download folder afterward.
   - Registers `@local/work-v2` cleanly in your DSH profile `package.json` (`dependencies` + `dsh.profile.bundles`).
   - Optional developer flag: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -LinkMode junction -TargetProfileDir <path>`

3. Restart **DSH Desktop** and open **Work** from the sidebar or floating Bubble (`Alt+W`).

4. Open **Settings** inside Work and sign in with GitHub (Device OAuth or PAT).

---

## Core Features

- **Multi-Repo Git Mesh**: Manage multiple independent local Git repositories concurrently. Stage/unstage individual files, inspect colored diffs, switch branches, publish to GitHub, or click **Commit & Share** to push namespaced collaboration branches (`collab/<repoId>/<user>`) with 1-click **Clone**, **Inspect Diff**, and **Pull & Merge**.
- **Chats, Channels & Notes**: Direct messages, project channels, voice notes, file sharing, pinned items, replies, and Markdown code blocks synced via real-time E2EE WSS relays + Private GitHub Vault persistence.
- **Floating Studio Bubble**: Compact draggable Bubble (`Alt+W`, toggleable in Settings) synced 1:1 with the DSH Sidebar view.
- **Saul Player & Intel Browser**: Persistent 42px YouTube audio strip (via Brave CDP) and distraction-free Live Browser reader with Save-to-Note.

---

## Architecture: Public Updates vs. Private Vault

- **Official Updates (`aoiuyy/work`)**: Work checks GitHub Releases on `aoiuyy/work` (`work-v<version>` / `work-v<version>.zip`), verifies the release author and SHA-256 digest before extracting atomically, and updates via **Restart to Update** in Settings.
- **Private Collaboration Vault (`Settings -> Vault repo`)**:
  - Code shared via **Commit & Share**, chat history, and voice notes are stored strictly inside a **private** GitHub repository (never in this public repo).
  - Invited collaborators automatically join their host's private vault; standalone users automatically use their own private `<username>/dsh-work-vault` (configurable in **Settings -> Vault repo**).
- **Security**:
  - Credentials are encrypted locally using Windows DPAPI (`*.dpapi`, never committed).
  - Built-in Security Shield blocks `.env`, private keys, tokens, path traversal, symlinks, and Git hooks from being shared or extracted.

---

## Development

```powershell
npm install
npm run build   # Builds client.js from ui/styles/*.css and ui/features/*
npm run verify  # Verifies package manifest, syntax, and UI guardrails
npm test        # Runs the full unit & integration test suite
```

> **Note**: Never edit `client.js` directly — edit source files under `ui/` and run `npm run build`.
