# Docs

| Document | Read it when |
|---|---|
| [FRESH-INSTALL.md](FRESH-INSTALL.md) | Setting up on a new machine, a fresh TSH extract, or a fresh OBS profile. Phase-by-phase, marking which steps Claude Code can do and which need you. |
| [TESTING.md](TESTING.md) | Verifying a change without a live tournament — replaying `.slp` files, driving the layouts from a stub bridge, and the regression checklist for the parts that only fail on stream. |
| [BRIDGE-API.md](BRIDGE-API.md) | Touching anything a browser consumes — the Socket.io event payloads and the `/api/*` routes, with the traps in each. |

Elsewhere in the repo:

- [../README.md](../README.md) — what the overlay does, feature by feature; the operator-facing manual.
- [../CLAUDE.md](../CLAUDE.md) — architecture, module boundaries, and the non-obvious constraints behind the code. The map to read before changing anything.
- `slippi-bridge/preflight.js` — `node preflight.js` (add `--offline` to skip network probes) automates the mechanical parts of the fresh-install checklist.

## Conventions these docs assume

- **Only `layout/` is ours inside `TournamentStreamHelper-*/`.** Everything else there is a vendored third-party Python app: read it for reference, never edit it.
- **Never hardcode the TSH folder name** — it carries the version. Use `resolveTshRoot()` from `tsh-root.js`.
- **`config.js` is committed; secrets go in `config.local.js`** (gitignored). Clipper tunables live in `clipper-settings.json` (also gitignored) — `config.CLIPPER` is only the default layer.
- **Client modules return `{ ok, error?, data? }` rather than throwing.** Every caller is either an Express handler or a fire-and-forget game event, and neither should be able to take the bridge down because TSH or OBS happens to be closed.
- **Nothing may block scoring.** Stage reporting, clip saving and status refreshes are all best-effort and isolated from the path that awards a point.
