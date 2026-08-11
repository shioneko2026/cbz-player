# CLAUDE.md — CBZ Player v5

Project rules for AI assistants working in this repo. This file is loaded automatically every session, so keep it short and keep it to facts that are true across all sessions. Session state does not belong here.

Full developer reference: `README4DEVS.md`. Long-form design docs, decision history and session continuity live in an Obsidian vault outside this repo (path is in the user's global config) — read those before changing architecture, not after.

## What this is

Windows desktop app for reading, sorting, comparing and repacking CBZ comic archives. Electron 41 · React 19 · Tailwind 4 · TypeScript 6 · Vite 8. Main process in `src/main/`, renderer in `src/renderer/`, packaged with electron-builder (NSIS, per-user install, no UAC).

## Verify before claiming done

There is **no test framework**. Verification means both typechecks exit 0. Both have been clean since session 10 — a new error is a regression, never "pre-existing":

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --ignoreDeprecations 6.0   # renderer
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit                        # main
```

**Do not use `npx tsc` here.** In this environment it resolves to a placeholder package that prints *"This is not the tsc command you are looking for"* and exits 1 — it never runs the project compiler, and a green-looking run means nothing.

A typecheck proves nothing about UI or lifecycle behaviour. Anything touching the viewer, the playlist, or app startup/exit needs a real run before it can be called done. Say so plainly when that run has not happened.

## Run it

Launchers live in the project root: `[000-Run CBZ Player Main].bat` (dev), `[001-Build Installer.bat` (NSIS installer), `install dependencies.bat` (one-time `npm install`).

Building the installer **requires Windows Developer Mode = On** (Settings → Privacy & security → For developers). Without it, electron-builder fails extracting symlinks from its signing toolchain.

## Environment traps

- **This repo's path contains `[` and `]`.** PowerShell treats them as wildcards, so plain `cd` fails — use `Set-Location -LiteralPath`. For assistants: prefer the Bash tool (its working directory is already the project root) and `cd` into the repo before running `git`; `git -C "<bracketed path>"` fails with exit 128.
- **Running `reg` from Git Bash mangles flags** like `/s` and `/ve` into paths — set `MSYS2_ARG_CONV_EXCL="*"` first, or a query silently returns nothing and looks like missing data.
- **Vite runs on port 5210, not 5173** (Windows reserves the 5103–5202 range). Three files must stay in sync if it changes: `vite.config.ts`, the `dev` script in `package.json`, and `src/main/window-manager.ts`.

## Do not "clean up" these

Each looks wrong and is load-bearing. The reasoning is in the vault's gotchas section — check there before touching any of them.

- The `dev` script's `tsc --watch` and its inline `wait-on … && electron .` chain. Both have been tried the "clean" way; both broke the dev launcher.
- `src/renderer/hooks/useNavigation.ts` → `pickNextIndex()` is the single source of truth for Shuffle and Skip-Viewed, with three callers. Do not fork a second copy — that bug has been fixed twice.
- Never compute a random value inside a React `setState` updater callback. Strict Mode is on and double-invokes them.
- Persisted settings reach disk by three different routes depending on the setting. Before adding one, read which route it needs — the wrong choice silently loses the value on exit.

## Privacy

`HANDOFF.md` and the vault notes must **never** be committed to this repo. They contain personal information; an earlier leak forced deleting and recreating the GitHub repo. They live outside any git repo so this cannot recur — do not copy them in, and do not add personal details to this file either.
