# Docs

The [main README](../README.md) covers what the app does and how to run a stream with it. This folder holds the longer guides.

## Pick a guide

| | Guide | Read it when you're… |
|:-:|---|---|
| 🛠️ | [**FRESH-INSTALL.md**](FRESH-INSTALL.md) | **Setting up** a new machine or a fresh OBS profile, or moving over from TSH. It works phase by phase, marks which steps you do and which Claude Code can do, and ends with a verification pass. |
| 🧪 | [**TESTING.md**](TESTING.md) | **Checking a change** without a live tournament: replaying `.slp` files faithfully, running the app against a past event, screenshotting the overlays, and the regression checklist. |
| 🔌 | [**BRIDGE-API.md**](BRIDGE-API.md) | **Changing anything a browser reads**: the state sections, event payloads and `/api/*` routes, with the traps in each. |

## Elsewhere in the repo

| Where | What it's for |
|---|---|
| [`../README.md`](../README.md) | The operator's manual: every feature, how to set it up, and troubleshooting. |
| [`../CLAUDE.md`](../CLAUDE.md) | Architecture, module boundaries, and the non-obvious rules behind the code. **Read it before changing anything.** |
| [`../tests/README.md`](../tests/README.md) | What each automated check protects, and the test sandbox's gotchas. |
| `app/scripts/preflight.js` | Automates the mechanical half of the install checklist. Run `node scripts/preflight.js` from `app/`, and add `--offline` to skip the network checks. |

## Rules these docs assume

> [!NOTE]
> These four rules hold across the codebase. The guides lean on them without repeating them.

1. **`app/index.js` only wires things together.** Behaviour lives in `lib/`; `index.js` just builds the services and connects them.
2. **The scoreboard store owns all live state.** Every change is a store command. The overlays, the dock and the save file all follow the store's `change` event.
3. **Client modules return `{ ok, error?, … }` instead of throwing.** Every caller is either an Express handler or a fire-and-forget game event, and an unreachable start.gg or OBS must never take the app down.
4. **Nothing may block scoring.** Clip saving, stats, bracket reads and status refreshes are all best-effort and kept apart from the code that awards a point.

The rules about file paths and secrets are in [CLAUDE.md → Known Gotchas](../CLAUDE.md#known-gotchas). They're kept in one place on purpose, because a copy is a copy that goes stale.
