/**
 * PortMap — which scoreboard side (0 = left, 1 = right) each Slippi port is
 * playing for, and in doubles which player of that side.
 *
 * The store says when the scoreboard changes under it (`set-loaded`,
 * `sides-switched` — handled in modes/index.js), so what's here is one chain,
 * run at each game start:
 *
 *   1. **Continuity.** The same ports as the last game of this set: keep the
 *      mapping (and the method that chose it). This is what makes a manual port
 *      swap stick for the rest of the set.
 *   2. **Characters.** Match each port's character against a reference per side
 *      — the last recorded game's characters when the ports moved mid-set (a
 *      controller change), the players' DB mains at the start of a set or on a
 *      re-detect. Costume only breaks a tie between identical characters, and
 *      in doubles the assignment with more total hits across both sides wins.
 *   3. **Positional.** Lower port (doubles: the group holding the lowest port)
 *      on the left. Flagged as low confidence in the dock.
 *
 * Pure apart from logging: no I/O, nothing read from the store — the caller
 * passes the reference characters in. Side numbers are 0/1 throughout; the
 * payloads' `teamNum` (1/2) only exists at the Socket.io edge.
 */

/**
 * @typedef {{ playerIndex: number, characterId: number, characterColor?: number, teamId?: number }} RawPlayer
 * @typedef {{ name: string, skin?: number }} CharRef   — display name, as char_map/the DB use
 * @typedef {{ port: number, name: string|null, skin: number }} PortChar
 */

class PortMap {
  constructor() {
    this._side   = null; // { [port]: 0|1 } | null
    this._slot   = {};   // { [port]: player index within its side }
    this._method = null; // "continuity" never appears here — continuity keeps the old method
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /** How the current mapping was decided: character | positional | manual | null. */
  get method() { return this._side ? this._method : null; }

  /** @returns {0|1|null} */
  sideOf(port) { return this._side?.[port] ?? null; }

  /** Player index within the port's side (0 in singles). */
  slotOf(port) { return this._slot[port] ?? 0; }

  /** For the dock's confidence display: every mapped port, ascending. */
  info() {
    const ports = Object.keys(this._side ?? {}).map(Number).sort((a, b) => a - b);
    return {
      method: this.method,
      ports: ports.map((port) => ({ port, side: this._side[port], slot: this.slotOf(port) })),
    };
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /** Forget everything (a new set was loaded, or the operator asked to re-detect). */
  reset(reason) {
    if (this._side) console.log(`[ports] ${reason}; clearing the port map`);
    this._side = null;
    this._slot = {};
    this._method = null;
  }

  /**
   * Decide the mapping for a game that is starting.
   *
   * @param {object} p
   * @param {RawPlayer[]} p.players — active players, ascending by port
   * @param {boolean} p.doubles
   * @param {Array<CharRef[]>} p.refs — reference characters per side, in player order
   * @param {Function} p.resolveChar — char_map.resolveCharacter
   * @returns {{ method: string, kept: boolean }}
   */
  resolve({ players, doubles, refs, resolveChar }) {
    const inPlay = doubles ? players : outerPorts(players);
    const chars = inPlay.map((r) => ({
      port: r.playerIndex,
      name: resolveChar(r.characterId, r.characterColor ?? 0)?.display ?? null,
      skin: r.characterColor ?? 0,
      teamId: r.teamId ?? 0,
    }));

    if (this._continues(chars, doubles)) return { method: this._method, kept: true };

    let sides = null;
    let method = "character";
    if (doubles) {
      sides = matchDoubles(groupBy(chars), refs);
    } else {
      sides = matchSingles(chars[0], chars[1], [refs[0]?.[0], refs[1]?.[0]]);
    }
    if (!sides) {
      method = "positional";
      sides = doubles ? positionalDoubles(groupBy(chars)) : { [chars[0].port]: 0, [chars[1].port]: 1 };
    }

    this._apply(sides, assignSlots(chars, sides, refs), method);
    return { method, kept: false };
  }

  /**
   * The two sides traded places. `method` given = the operator corrected the
   * ports ("manual"); omitted = the scoreboard's sides moved, and the mapping
   * is exactly as trustworthy as it was, so its method is kept.
   * @returns {boolean} false when there was nothing to flip
   */
  flip(method) {
    if (!this._side) return false;
    const next = {};
    for (const [port, side] of Object.entries(this._side)) next[port] = 1 - side;
    this._apply(next, this._slot, method ?? this._method);
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Same ports as the mapped ones, and in doubles each Slippi team still lands
   * on one side — a regrouping on the same four ports is a new arrangement.
   */
  _continues(chars, doubles) {
    if (!this._side) return false;
    const mapped = Object.keys(this._side).map(Number).sort((a, b) => a - b);
    const now = chars.map((c) => c.port).sort((a, b) => a - b);
    if (mapped.length !== now.length || mapped.some((p, i) => p !== now[i])) return false;
    if (!doubles) return true;
    return Object.values(groupBy(chars)).every((g) => new Set(g.map((c) => this._side[c.port])).size === 1);
  }

  _apply(sides, slots, method) {
    const before = JSON.stringify(this._side);
    this._side = { ...sides };
    this._slot = { ...slots };
    this._method = method;
    if (JSON.stringify(this._side) !== before) {
      console.log(`[ports] Port map (${method}): ${describe(this._side)}`);
    }
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Singles uses the outermost two ports. */
function outerPorts(players) {
  return players.length <= 2 ? players : [players[0], players[players.length - 1]];
}

function groupBy(chars) {
  const groups = {};
  for (const c of chars) (groups[c.teamId] = groups[c.teamId] ?? []).push(c);
  return groups;
}

/**
 * Singles: which side each of two ports is, from one reference character per
 * side. Null when it can't tell. A port matching exactly one side decides both.
 * @param {PortChar} a
 * @param {PortChar} b
 * @param {Array<CharRef|undefined>} refs
 * @returns {{ [port: number]: 0|1 } | null}
 */
function matchSingles(a, b, refs) {
  if (!a?.name || !b?.name) return null;
  const sameChar = a.name === b.name;
  if (sameChar && a.skin === b.skin) return null; // indistinguishable
  if (!refs[0]?.name && !refs[1]?.name) return null;

  const matches = (pc, ref) => {
    if (!ref?.name || pc.name !== ref.name) return false;
    if (!sameChar) return true;
    // Both on the same character: only the costume tells them apart.
    return ref.skin != null && Number(ref.skin) === pc.skin;
  };
  const sideFor = (pc) => {
    const m0 = matches(pc, refs[0]);
    const m1 = matches(pc, refs[1]);
    return m0 && !m1 ? 0 : m1 && !m0 ? 1 : null;
  };

  let sa = sideFor(a);
  let sb = sideFor(b);
  if (sa !== null && sb === null) sb = 1 - sa;
  if (sb !== null && sa === null) sa = 1 - sb;
  if (sa === null || sa === sb) return null;
  return { [a.port]: sa, [b.port]: sb };
}

/**
 * Doubles: which side each Slippi team is. Compares the two possible
 * assignments by total character hits across both sides, which breaks the
 * case where only one side has a distinguishing character.
 * @param {{ [teamId]: PortChar[] }} groups
 * @param {Array<CharRef[]>} refs
 * @returns {{ [port: number]: 0|1 } | null}
 */
function matchDoubles(groups, refs) {
  const tids = Object.keys(groups);
  if (tids.length !== 2) return null;
  const hits = (group, side) => {
    const names = (refs[side] ?? []).map((r) => r?.name).filter(Boolean);
    return group.filter((c) => c.name && names.includes(c.name)).length;
  };
  const [A, B] = tids.map((t) => groups[t]);
  const aLeft = hits(A, 0) + hits(B, 1);
  const aRight = hits(A, 1) + hits(B, 0);
  if (aLeft === aRight) return null;
  return groupSides(A, B, aLeft > aRight ? 0 : 1);
}

/** Doubles fallback: the team holding the lowest port goes on the left. */
function positionalDoubles(groups) {
  const tids = Object.keys(groups);
  if (tids.length !== 2) {
    // Not a 2v2 Slippi recognises — treat as singles-style halves by port.
    const all = Object.values(groups).flat().sort((x, y) => x.port - y.port);
    const half = Math.ceil(all.length / 2);
    return Object.fromEntries(all.map((c, i) => [c.port, i < half ? 0 : 1]));
  }
  const [A, B] = tids.map((t) => groups[t]);
  const minA = Math.min(...A.map((c) => c.port));
  const minB = Math.min(...B.map((c) => c.port));
  return groupSides(A, B, minA < minB ? 0 : 1);
}

function groupSides(A, B, sideOfA) {
  const out = {};
  for (const c of A) out[c.port] = sideOfA;
  for (const c of B) out[c.port] = 1 - sideOfA;
  return out;
}

/**
 * Which player of its side each port is. Singles: always 0. Doubles: the
 * pairing of a side's two ports to its two players with more character hits
 * against that side's references, else ascending port order.
 */
function assignSlots(chars, sides, refs) {
  const slots = {};
  for (const side of [0, 1]) {
    const ports = chars.filter((c) => sides[c.port] === side).sort((x, y) => x.port - y.port);
    if (ports.length === 2) {
      const r = refs[side] ?? [];
      const hit = (c, i) => (c.name && r[i]?.name === c.name ? 1 : 0);
      const straight = hit(ports[0], 0) + hit(ports[1], 1);
      const crossed = hit(ports[0], 1) + hit(ports[1], 0);
      const order = crossed > straight ? [ports[1], ports[0]] : ports;
      order.forEach((c, i) => { slots[c.port] = i; });
    } else {
      ports.forEach((c, i) => { slots[c.port] = i; });
    }
  }
  return slots;
}

function describe(sides) {
  return Object.entries(sides)
    .sort(([a], [b]) => a - b)
    .map(([port, side]) => `P${Number(port) + 1}→${side === 0 ? "L" : "R"}`)
    .join(" ");
}

module.exports = { PortMap, matchSingles, outerPorts };
