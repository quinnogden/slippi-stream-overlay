# Docs

| Document | Read it when |
|---|---|
| [FRESH-INSTALL.md](FRESH-INSTALL.md) | Setting up on a new machine or a fresh OBS profile, or moving a machine over from TSH. Phase-by-phase, marking which steps Claude Code can do and which need you, with the OBS url table. |
| [TESTING.md](TESTING.md) | Verifying a change without a live tournament — replaying `.slp` files faithfully, booting the app against a past event, looking at the overlays, and the regression checklist for the parts that only fail on stream. |
| [BRIDGE-API.md](BRIDGE-API.md) | Touching anything a browser consumes — the state sections, the event payloads and the `/api/*` routes, with the traps in each. |

Elsewhere in the repo:

- [../README.md](../README.md) — what the app does, feature by feature; the operator-facing manual.
- [../CLAUDE.md](../CLAUDE.md) — architecture, module boundaries, and the non-obvious constraints behind the code. The map to read before changing anything.
- [../tests/README.md](../tests/README.md) — what each automated check protects, and the sandbox's gotchas.
- `slippi-bridge/scripts/preflight.js` — `node scripts/preflight.js` (add `--offline` to skip network probes) automates the mechanical parts of the fresh-install checklist.

## Conventions these docs assume

- **`slippi-bridge/index.js` is a composition root.** Behaviour goes in `lib/`; `index.js` only builds services and wires them together.
- **The scoreboard store is the one owner of live state.** Every change is a store command; the overlays, the dock and the save file all follow from its `change` event.
- **Client modules return `{ ok, error?, … }` rather than throwing.** Every caller is either an Express handler or a fire-and-forget game event, and neither should be able to take the app down because start.gg or OBS is unreachable.
- **Nothing may block scoring.** Clip saving, stats, bracket reads and status refreshes are all best-effort and isolated from the path that awards a point.

The path and secrets rules these docs rely on are in
[CLAUDE.md → Known Gotchas](../CLAUDE.md#known-gotchas) — kept in one place rather than restated
here, because a copy is a copy that goes stale.
