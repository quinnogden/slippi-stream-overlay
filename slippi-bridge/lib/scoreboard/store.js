/**
 * ScoreboardStore — the one owner of live state: the set on the scoreboard,
 * the loaded tournament, the casters, and the overlays' shared view settings.
 *
 * Replaces TSH's scoreboard. Every change goes through a command method, which
 * bumps `rev` and emits `change` with the top-level sections it touched — the
 * overlay channel turns that into patches, persist.js into a save. Nothing
 * outside this file mutates the state.
 *
 * Two decisions that remove whole classes of TSH-era bugs:
 *
 *   - **A side carries its start.gg entrant id.** sides[0] is the left column,
 *     sides[1] the right; switchSides() reverses the array, so the entrant id
 *     travels with the name. Reporting reads `sides[w].entrantId` — there is no
 *     longer a "which start.gg slot is column 1 while swapped" question
 *     (TSH's entrantSlot inversion), and nothing to poll.
 *
 *   - **The score is derived from the game list.** Each side's score is the
 *     number of games it has won; a Slippi game end appends a game, a manual
 *     ± appends or removes one. So the per-game list sent with a report can
 *     never disagree with the scoreboard, and a switch of sides flips both at
 *     once by construction.
 *
 * Events (beyond `change`), for the modules that react to the scoreboard:
 *   `set-loaded`     a different set (or a cleared one) is now on the scoreboard
 *   `sides-switched` the two sides traded columns
 */

const { EventEmitter } = require("events");
const { bestOfLabel, losersMarks } = require("./set-text");

const STATE_VERSION = 1;

const emptyPlayer = () => ({ playerId: null, tag: "", prefix: "", pronoun: "", main: null, character: null });
const emptySide = () => ({ entrantId: null, seed: null, teamName: "", color: null, fromLosers: false, players: [emptyPlayer()] });

function emptySet() {
  return {
    setId: null,
    phaseGroupId: null,
    roundName: "",
    identifier: "",
    lPlacement: null,
    isGrandFinal: false,
    isReset: false,
    isPreview: false,
    overrides: { round: null, bestOf: null, losers: [null, null] },
    sides: [emptySide(), emptySide()],
    // { winnerSide: 0|1, characters: [[char…], [char…]] | null, manual: boolean }
    games: [],
  };
}

const emptyTournament = () => ({ name: "", slug: "", eventName: "", eventSlug: "", kind: null });

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class ScoreboardStore extends EventEmitter {
  /**
   * @param {{ setText?: object }} [opts] — config.SET_TEXT (topN, topLabel, defaultLabel)
   */
  constructor(opts = {}) {
    super();
    this._setText = opts.setText ?? {};
    this._rev = 0;
    this._set = emptySet();
    this._tournament = emptyTournament();
    this._casters = [];
    this._view = { bracketView: "top8" };
  }

  get rev() { return this._rev; }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /** The overlay-facing scoreboard, with every derived field filled in. */
  scoreboard() {
    const s = this._set;
    const scores = [0, 1].map((i) => s.games.filter((g) => g.winnerSide === i).length);
    const losers = losersMarks(s, s.overrides.losers);
    return {
      setId: s.setId,
      phaseGroupId: s.phaseGroupId,
      round: s.overrides.round ?? s.roundName,
      identifier: s.identifier,
      bestOfLabel: bestOfLabel(s, { ...this._setText, override: s.overrides.bestOf }),
      isGrandFinal: s.isGrandFinal,
      isReset: s.isReset,
      isPreview: s.isPreview,
      isDoubles: s.sides.some((x) => x.players.length > 1),
      sides: s.sides.map((side, i) => ({ ...clone(side), score: scores[i], losers: losers[i] })),
      games: clone(s.games),
      overrides: clone(s.overrides),
    };
  }

  /** The loaded start.gg event: { name, slug, eventName, eventSlug, kind }. */
  tournament() { return clone(this._tournament); }
  casters() { return clone(this._casters); }
  view() { return clone(this._view); }

  /** Everything the overlays get, keyed by section. */
  snapshot() {
    return {
      v: STATE_VERSION, rev: this._rev,
      tournament: this.tournament(), scoreboard: this.scoreboard(), casters: this.casters(), view: this.view(),
    };
  }

  /**
   * Whether the loaded set can be reported to start.gg, and with what.
   * Replaces the TSH-side score/swap reads; set-gate.js still holds the token check.
   * @returns {{ ok: true, setId: string, winnerSide: 0|1, winnerEntrantId: string, games: Array }
   *         | { ok: false, reason: string }}
   */
  reportable() {
    const sb = this.scoreboard();
    if (!sb.setId) return { ok: false, reason: "No start.gg set loaded" };
    if (sb.isPreview || String(sb.setId).startsWith("preview")) {
      return { ok: false, reason: "This set is a bracket preview — start the event on start.gg first" };
    }
    const [a, b] = sb.sides.map((x) => x.score);
    if (a === b) return { ok: false, reason: `Score is tied (${a}-${b})` };
    const winnerSide = a > b ? 0 : 1;
    const winnerEntrantId = sb.sides[winnerSide].entrantId;
    if (!winnerEntrantId) return { ok: false, reason: "The winning side has no start.gg entrant" };
    return { ok: true, setId: sb.setId, winnerSide, winnerEntrantId, sides: sb.sides, games: sb.games };
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  /**
   * Put a set on the scoreboard. `payload` is set-model.loadPayload()'s shape,
   * with each player optionally enriched by the caller (pronoun from the DB,
   * `main` = the character to show until Slippi says otherwise).
   *
   * A set loaded mid-way (score already on start.gg) keeps its score, as
   * manual games — the order of games already played isn't known.
   */
  loadSet(payload) {
    const next = emptySet();
    if (payload) {
      Object.assign(next, {
        setId: payload.setId ?? null,
        phaseGroupId: payload.phaseGroupId ?? null,
        roundName: payload.roundName ?? "",
        identifier: payload.identifier ?? "",
        lPlacement: payload.lPlacement ?? null,
        isGrandFinal: !!payload.isGrandFinal,
        isReset: !!payload.isReset,
        isPreview: !!payload.isPreview,
      });
      next.sides = [0, 1].map((i) => {
        const src = payload.sides?.[i] ?? {};
        const players = (src.players?.length ? src.players : [{}]).map((p) => ({
          ...emptyPlayer(),
          playerId: p.playerId ?? null,
          tag: p.tag ?? "",
          prefix: p.prefix ?? "",
          pronoun: p.pronoun ?? "",
          main: p.main ?? null,
          character: p.main ?? null,
        }));
        return {
          ...emptySide(),
          entrantId: src.entrantId ?? null,
          seed: src.seed ?? null,
          teamName: players.length > 1 ? (src.name ?? "") : "",
          fromLosers: !!src.fromLosers,
          players,
        };
      });
      for (const i of [0, 1]) {
        for (let n = 0; n < (payload.sides?.[i]?.score ?? 0); n++) {
          next.games.push({ winnerSide: i, characters: null, manual: true });
        }
      }
    }
    this._set = next;
    this._changed(["scoreboard"]);
    this.emit("set-loaded", { setId: next.setId });
  }

  /** Back to an empty scoreboard (a manual set, typed by hand). */
  clearSet() {
    this.loadSet(null);
  }

  /**
   * Edit a player's displayed fields (the dock's live strip / a typed name).
   * @param {0|1} side
   * @param {number} index — player within the side (doubles: 0 or 1)
   * @param {{ tag?: string, prefix?: string, pronoun?: string, playerId?: string|null, main?: object|null }} fields
   */
  setPlayer(side, index, fields) {
    const p = this._player(side, index, true);
    for (const k of ["tag", "prefix", "pronoun", "playerId", "main"]) {
      if (fields[k] !== undefined) p[k] = fields[k];
    }
    this._changed(["scoreboard"]);
  }

  /**
   * The character shown for a player. Slippi sets it at each game start; the
   * dock can set it by hand (no Slippi, or a pre-game preview).
   * @param {{ codename: string, name: string, skin: number } | null} character
   */
  setCharacter(side, index, character) {
    const p = this._player(side, index, true);
    if (sameChar(p.character, character)) return;
    p.character = character ? { codename: character.codename, name: character.name, skin: Number(character.skin) || 0 } : null;
    this._changed(["scoreboard"]);
  }

  /** Clear every displayed character (doubles: the overlay shows none). */
  clearCharacters() {
    let changed = false;
    for (const side of this._set.sides) for (const p of side.players) {
      if (p.character) { p.character = null; changed = true; }
    }
    if (changed) this._changed(["scoreboard"]);
  }

  /** A side's colour (doubles: Melee's in-game team colour), or null. */
  setSideColor(side, color) {
    this._side(side);
    if (this._set.sides[side].color === (color ?? null)) return;
    this._set.sides[side].color = color ?? null;
    this._changed(["scoreboard"]);
  }

  /**
   * A finished game, from Slippi.
   * @param {{ winnerSide: 0|1, characters?: Array<Array<object>>|null }} game
   */
  recordGame({ winnerSide, characters = null }) {
    this._side(winnerSide);
    this._set.games.push({ winnerSide, characters: clone(characters), manual: false });
    this._changed(["scoreboard"]);
  }

  /**
   * Manual score correction: +1 appends a game for that side; −1 removes the
   * side's most recent game (never below zero).
   * @param {0|1} side
   * @param {1|-1} delta
   */
  bump(side, delta) {
    this._side(side);
    if (delta > 0) {
      this._set.games.push({ winnerSide: side, characters: null, manual: true });
    } else {
      const games = this._set.games;
      let i = games.length - 1;
      while (i >= 0 && games[i].winnerSide !== side) i--;
      if (i < 0) return;
      games.splice(i, 1);
    }
    this._changed(["scoreboard"]);
  }

  /** Set a side's score outright (the dock's typed score), via bump. */
  setScore(side, score) {
    const target = Math.max(0, Math.floor(Number(score) || 0));
    let now = this._set.games.filter((g) => g.winnerSide === side).length;
    while (now < target) { this.bump(side, 1); now++; }
    while (now > target) { this.bump(side, -1); now--; }
  }

  /**
   * The two sides trade columns, and everything attached to a side goes with
   * it: entrant id, players, colour, [L] override, and each game's winner.
   */
  switchSides() {
    const s = this._set;
    s.sides.reverse();
    s.overrides.losers.reverse();
    for (const g of s.games) {
      g.winnerSide = 1 - g.winnerSide;
      if (g.characters) g.characters.reverse();
    }
    this._changed(["scoreboard"]);
    this.emit("sides-switched");
  }

  /**
   * Operator overrides for derived text. `undefined` leaves a field alone;
   * `null` clears the override (back to derived).
   * @param {{ round?: string|null, bestOf?: string|null, losers?: Array<boolean|null> }} o
   */
  setOverrides(o) {
    const ov = this._set.overrides;
    if (o.round !== undefined) ov.round = o.round || null;
    if (o.bestOf !== undefined) ov.bestOf = o.bestOf || null;
    if (Array.isArray(o.losers)) ov.losers = [0, 1].map((i) => (o.losers[i] === undefined ? ov.losers[i] : o.losers[i]));
    this._changed(["scoreboard"]);
  }

  /**
   * The start.gg event the dock is working from (event-service.js sets it).
   * Loading another event leaves the scoreboard alone: the set on air keeps its
   * names, score and set id, so a pending report still targets the right set.
   * @param {{ name?: string, slug?: string, eventName?: string, eventSlug?: string, kind?: string|null } | null} t
   */
  setTournament(t) {
    const next = { ...emptyTournament(), ...(t ?? {}) };
    for (const k of ["name", "slug", "eventName", "eventSlug"]) next[k] = String(next[k] ?? "");
    if (JSON.stringify(next) === JSON.stringify(this._tournament)) return;
    this._tournament = next;
    this._changed(["tournament"]);
  }

  /** @param {Array<{ tag?: string, prefix?: string, pronoun?: string, twitter?: string }>} list */
  setCasters(list) {
    this._casters = (list ?? []).map((c) => ({
      tag: String(c?.tag ?? ""), prefix: String(c?.prefix ?? ""),
      pronoun: String(c?.pronoun ?? ""), twitter: String(c?.twitter ?? ""),
    }));
    this._changed(["casters"]);
  }

  /** Which bracket view every (unpinned) bracket overlay shows. */
  setBracketView(view) {
    if (this._view.bracketView === view) return;
    this._view.bracketView = view;
    this._changed(["view"]);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** What persist.js saves — the raw (underived) state. */
  toJSON() {
    return {
      v: STATE_VERSION, set: clone(this._set), tournament: clone(this._tournament),
      casters: clone(this._casters), view: clone(this._view),
    };
  }

  /**
   * Restore a saved state. Returns false (and changes nothing) for a missing or
   * different-version save — a stale shape is worse than an empty scoreboard.
   */
  restore(saved) {
    if (!saved || saved.v !== STATE_VERSION || !saved.set) return false;
    this._set = { ...emptySet(), ...clone(saved.set) };
    this._tournament = { ...emptyTournament(), ...(saved.tournament ?? {}) };
    this._casters = Array.isArray(saved.casters) ? clone(saved.casters) : [];
    this._view = { ...this._view, ...(saved.view ?? {}) };
    this._changed(["tournament", "scoreboard", "casters", "view"]);
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _side(side) {
    if (side !== 0 && side !== 1) throw new Error(`side must be 0 or 1, got ${side}`);
  }

  _player(side, index, create) {
    this._side(side);
    const players = this._set.sides[side].players;
    if (!players[index] && create && index >= 0 && index < 4) {
      while (players.length <= index) players.push(emptyPlayer());
    }
    if (!players[index]) throw new Error(`no player ${index} on side ${side}`);
    return players[index];
  }

  _changed(keys) {
    this._rev++;
    this.emit("change", { rev: this._rev, keys });
  }
}

function sameChar(a, b) {
  if (!a || !b) return !a && !b;
  return a.codename === b.codename && Number(a.skin) === Number(b.skin);
}

module.exports = { ScoreboardStore, STATE_VERSION };
