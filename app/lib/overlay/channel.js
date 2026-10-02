/**
 * The overlays' and the dock's live feed — Socket.io namespaces `/overlay` and
 * `/dock`. Replaces TSH's globals.js polling program_state.json.
 *
 * State is the scoreboard store's snapshot (`{ v, rev, tournament, scoreboard,
 * casters, view, bracket }`), sent as:
 *
 *   state:full   { v, rev, …sections }       on connect, and on request
 *   state:patch  { from, rev, ops }          after every change
 *                ops: [{ path: "scoreboard", value }] — whole sections
 *   state:resync (client → server)           "I missed one; send everything"
 *
 * A patch carries the rev it was diffed **from**, so a client can tell a gap
 * (from > its rev: it missed a patch, and must ask for state:full rather than
 * keep drawing a scoreboard that has stopped changing) from a patch it already
 * has (rev ≤ its rev: it connected mid-burst and its state:full was newer).
 * Changes in one tick are coalesced into one patch — setScore() is several
 * store commands, and an overlay should animate the score once.
 *
 * Events that aren't state are relayed too. The feature modules still emit
 * their original names through `emit()` (ctx.io); RELAY maps each to this
 * channel's name per namespace, and an event with no entry goes nowhere.
 * Nothing listens on the default namespace any more — the dock replaced the
 * control panel, the last client there.
 */

/**
 * Original event name → this channel's name, per namespace. `sticky` events
 * are replayed to a socket that connects later (a game in progress, the last
 * stats); `clears` drops another event's sticky copy.
 */
const RELAY = {
  slippi_game_start: { overlay: "game:start", dock: "game:start", sticky: true },
  slippi_game_end:   { overlay: "game:end",   dock: "game:end",   clears: "slippi_game_start" },
  slippi_clip_saved: { overlay: "clip:saved", dock: "clip:saved" },
  slippi_clip_error: {                        dock: "clip:error" },
  player_stats:      { overlay: "stats",                          sticky: true },
  control_status:    {                        dock: "status",     sticky: true },
  theme_changed:     { overlay: "theme",      dock: "theme" },
};

const NAMESPACES = ["overlay", "dock"];

/**
 * @param {{ io: import("socket.io").Server, store: import("../scoreboard/store").ScoreboardStore }} deps
 * @returns {{ emit: (event: string, payload: any) => void, namespaces: object }}
 */
function createOverlayChannel({ io, store }) {
  const nsps = Object.fromEntries(NAMESPACES.map((n) => [n, io.of(`/${n}`)]));
  const sticky = new Map(); // original event name → last payload

  let sentRev = store.rev;  // the rev every connected client has, once the next patch lands
  let pending = null;       // section keys changed since sentRev

  function flush() {
    const keys = [...pending];
    pending = null;
    const snap = store.snapshot();
    if (snap.rev === sentRev) return;
    const msg = { from: sentRev, rev: snap.rev, ops: keys.map((k) => ({ path: k, value: snap[k] })) };
    sentRev = snap.rev;
    for (const nsp of Object.values(nsps)) nsp.emit("state:patch", msg);
  }

  store.on("change", ({ keys }) => {
    if (!pending) {
      pending = new Set();
      setImmediate(flush);
    }
    for (const k of keys) pending.add(k);
  });

  for (const [name, nsp] of Object.entries(nsps)) {
    nsp.on("connection", (socket) => {
      socket.emit("state:full", store.snapshot());
      for (const [event, payload] of sticky) {
        const target = RELAY[event][name];
        if (target) socket.emit(target, payload);
      }
      socket.on("state:resync", () => socket.emit("state:full", store.snapshot()));
    });
  }

  /** Relay an event, by its original name, to the namespaces that take it. */
  function emit(event, payload) {
    const relay = RELAY[event];
    if (!relay) return;
    if (relay.sticky) sticky.set(event, payload);
    if (relay.clears) sticky.delete(relay.clears);
    for (const name of NAMESPACES) {
      if (relay[name]) nsps[name].emit(relay[name], payload);
    }
  }

  return { emit, namespaces: nsps };
}

module.exports = { createOverlayChannel, RELAY };
