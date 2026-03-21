/**
 * PortMapper — owns all port→team tracking state.
 *
 * Encapsulates portToTeam, portToName, and portScore so that the mapping
 * logic has a single owner with a clear API. All external data (TSH state,
 * player info) is passed in — the class never reads files or makes HTTP calls.
 */

class PortMapper {
  constructor() {
    this._portToTeam = null; // { [playerIndex]: teamNum } | null  (null = use positional default)
    this._portToName = {};   // { [playerIndex]: "PlayerName" }
    this._portScore  = {};   // { [playerIndex]: wins }
  }

  // ── Public query ────────────────────────────────────────────────────────────

  /** Returns true when an explicit mapping exists (non-null). */
  hasMapping() {
    return this._portToTeam !== null;
  }

  /**
   * Returns the team number for a port. Falls back to positionalDefault (1 or 2)
   * when no explicit mapping has been set.
   */
  getTeam(playerIndex, positionalDefault) {
    return this._portToTeam?.[playerIndex] ?? positionalDefault;
  }

  /** Returns all known port indices in ascending order. */
  getKnownPorts() {
    const all = [
      ...Object.keys(this._portToName),
      ...Object.keys(this._portScore),
      ...(this._portToTeam ? Object.keys(this._portToTeam) : []),
    ];
    return [...new Set(all)].map(Number).sort((a, b) => a - b);
  }

  // ── State updates ───────────────────────────────────────────────────────────

  /**
   * Called before each game start. Uses TSH team info to update the mapping.
   *
   * @param {{ name: string, score: number }} t1  — team 1 info from TshClient
   * @param {{ name: string, score: number }} t2  — team 2 info from TshClient
   */
  resolve(t1, t2) {
    // ── Reset on 0-0 (new set) ──────────────────────────────────────────────
    if (t1.score === 0 && t2.score === 0) {
      if (this._portToTeam !== null || Object.keys(this._portToName).length > 0) {
        console.log("[bridge] Scores are 0-0; resetting port-team mapping");
        this._portToTeam = null;
        this._portToName = {};
        this._portScore  = {};
      }
      return;
    }

    const ports = Object.keys(this._portToName).map(Number);
    if (ports.length === 0) return; // First game — positional default applies

    let newMapping = {};

    // ── Primary: name-based matching ─────────────────────────────────────────
    const storedNames  = Object.values(this._portToName);
    const currentNames = [t1.name, t2.name].filter((n) => n);
    const anyNameMatch = storedNames.some((n) => n && currentNames.includes(n));

    if (storedNames.some((n) => n) && currentNames.length > 0 && !anyNameMatch) {
      console.log("[bridge] Player names completely changed; resetting port-team mapping");
      this._portToTeam = null;
      this._portToName = {};
      this._portScore  = {};
      return;
    }

    if (anyNameMatch) {
      for (const [portStr, name] of Object.entries(this._portToName)) {
        if (!name) continue;
        const port = Number(portStr);
        if (name === t1.name) newMapping[port] = 1;
        if (name === t2.name) newMapping[port] = 2;
      }
    }

    // ── Fallback: score-based matching ────────────────────────────────────────
    if (Object.keys(newMapping).length < ports.length && ports.length === 2) {
      const [portA, portB] = ports;
      const scoreA = this._portScore[portA] ?? 0;
      const scoreB = this._portScore[portB] ?? 0;
      const assignAto1 = scoreA === t1.score && scoreB === t2.score;
      const assignAto2 = scoreA === t2.score && scoreB === t1.score;
      if (assignAto1 && !assignAto2) {
        newMapping = { [portA]: 1, [portB]: 2 };
        console.log("[bridge] Score-based mapping: port", portA, "→ team 1, port", portB, "→ team 2");
      } else if (assignAto2 && !assignAto1) {
        newMapping = { [portA]: 2, [portB]: 1 };
        console.log("[bridge] Score-based mapping: port", portA, "→ team 2, port", portB, "→ team 1");
      }
    }

    // ── Infer missing port when only one resolved ─────────────────────────────
    if (ports.length === 2 && Object.keys(newMapping).length === 1) {
      const resolvedPort = Number(Object.keys(newMapping)[0]);
      const otherPort    = ports.find((p) => p !== resolvedPort);
      newMapping[otherPort] = newMapping[resolvedPort] === 1 ? 2 : 1;
    }

    // ── Validate and apply ────────────────────────────────────────────────────
    const teams = Object.values(newMapping);
    if (teams.length === 2 && new Set(teams).size === 2) {
      const changed = JSON.stringify(this._portToTeam) !== JSON.stringify(newMapping);
      this._portToTeam = newMapping;
      if (changed) {
        console.log("[bridge] Resolved port→team:", JSON.stringify(this._portToTeam));
      }
    }
  }

  /**
   * At 0-0: try to infer mapping from TSH's preloaded character history (singles).
   *
   * @param {Array<{ playerIndex: number, characterId: number, characterColor: number }>} sorted
   *   Players sorted ascending by playerIndex (first + last used as P1/P2).
   * @param {{ t1: Array<{name:string,skin:number}>, t2: Array<{name:string,skin:number}> }} charHistory
   *   Preloaded chars per team — each is an array (index 0 = player 1).
   * @param {Function} resolveCharFn  — resolveCharacter(charId, costume, tshRoot) from char_map
   * @param {string} tshRoot
   */
  tryCharacterBased(sorted, charHistory, resolveCharFn, tshRoot) {
    const [rawA, rawB] = [sorted[0], sorted[sorted.length - 1]];

    const charA    = resolveCharFn(rawA.characterId, rawA.characterColor ?? 0, tshRoot)?.display;
    const charB    = resolveCharFn(rawB.characterId, rawB.characterColor ?? 0, tshRoot)?.display;
    const costumeA = rawA.characterColor ?? 0;
    const costumeB = rawB.characterColor ?? 0;

    if (!charA || !charB) return;

    const sameChar = charA === charB;
    if (sameChar && costumeA === costumeB) return; // identical — can't distinguish

    // Use first preloaded char entry per team for singles
    const t1 = charHistory.t1?.[0] ?? { name: "", skin: -1 };
    const t2 = charHistory.t2?.[0] ?? { name: "", skin: -1 };
    if (!t1.name && !t2.name) return;

    const matches = (portChar, portCostume, preloaded) => {
      if (!preloaded.name || portChar !== preloaded.name) return false;
      if (!sameChar) return true;
      return preloaded.skin >= 0 && portCostume === preloaded.skin;
    };

    const aMatchesT1 = matches(charA, costumeA, t1);
    const aMatchesT2 = matches(charA, costumeA, t2);
    const bMatchesT1 = matches(charB, costumeB, t1);
    const bMatchesT2 = matches(charB, costumeB, t2);

    let portATeam = aMatchesT1 && !aMatchesT2 ? 1 : aMatchesT2 && !aMatchesT1 ? 2 : null;
    let portBTeam = bMatchesT1 && !bMatchesT2 ? 1 : bMatchesT2 && !bMatchesT1 ? 2 : null;

    if (portATeam !== null && portBTeam === null) portBTeam = portATeam === 1 ? 2 : 1;
    if (portBTeam !== null && portATeam === null) portATeam = portBTeam === 1 ? 2 : 1;

    if (portATeam !== null && portBTeam !== null && portATeam !== portBTeam) {
      this._portToTeam = { [rawA.playerIndex]: portATeam, [rawB.playerIndex]: portBTeam };
      console.log(
        `[bridge] Character history match → port ${rawA.playerIndex}→team ${portATeam},`,
        `port ${rawB.playerIndex}→team ${portBTeam}`
      );
    } else {
      console.log("[bridge] Character history inconclusive — using positional default");
    }
  }

  /**
   * At 0-0 in doubles: try to infer which Slippi group maps to which TSH team
   * using TSH's preloaded character history (2 chars per team).
   *
   * @param {{ [teamId: number]: Array<{playerIndex,characterId,characterColor}> }} groups
   *   Slippi players grouped by teamId.
   * @param {{ t1: Array<{name,skin}>, t2: Array<{name,skin}> }} charHistory
   *   Preloaded chars per TSH team (up to 2 per team).
   * @param {Function} resolveCharFn
   * @param {string} tshRoot
   */
  tryCharacterBasedDoubles(groups, charHistory, resolveCharFn, tshRoot) {
    const teamIds = Object.keys(groups).map(Number);
    if (teamIds.length !== 2) return;

    const scoreGroup = (players, tshChars) => {
      let hits = 0;
      for (const raw of players) {
        const display = resolveCharFn(raw.characterId, raw.characterColor ?? 0, tshRoot)?.display;
        if (!display) continue;
        for (const pre of tshChars) {
          if (pre.name && display === pre.name) { hits++; break; }
        }
      }
      return hits;
    };

    const [tidA, tidB] = teamIds;
    const hitsAvsT1 = scoreGroup(groups[tidA], charHistory.t1 ?? []);
    const hitsBvsT1 = scoreGroup(groups[tidB], charHistory.t1 ?? []);
    const hitsAvsT2 = scoreGroup(groups[tidA], charHistory.t2 ?? []);
    const hitsBvsT2 = scoreGroup(groups[tidB], charHistory.t2 ?? []);

    // Compare the two possible assignments by total evidence across both teams.
    // "A→1, B→2" earns hitsAvsT1 + hitsBvsT2; "A→2, B→1" earns hitsAvsT2 + hitsBvsT1.
    // Scoring against both directions breaks ties where only one team has a unique char
    // (e.g. both groups share Fox, but only one has Marth matching t2).
    const scoreAis1 = hitsAvsT1 + hitsBvsT2;
    const scoreAis2 = hitsAvsT2 + hitsBvsT1;

    if (scoreAis1 === scoreAis2) {
      console.log("[bridge] Doubles character history inconclusive — using positional default");
      return;
    }

    const groupATeam = scoreAis1 > scoreAis2 ? 1 : 2;
    const groupBTeam = groupATeam === 1 ? 2 : 1;
    this._applyGroupMapping(groups, tidA, groupATeam, tidB, groupBTeam);
    console.log(`[bridge] Doubles character history → slippi team ${tidA}→TSH team ${groupATeam},`,
      `slippi team ${tidB}→TSH team ${groupBTeam}`);
  }

  /**
   * Called before each doubles game start.
   *
   * @param {{ [teamId: number]: Array<{playerIndex}> }} groups  — keyed by Slippi teamId
   * @param {{ name: string, score: number }} t1  — TSH team 1 info
   * @param {{ name: string, score: number }} t2  — TSH team 2 info
   * @param {string[]} t1Names  — all player names on TSH team 1
   * @param {string[]} t2Names  — all player names on TSH team 2
   */
  resolveDoubles(groups, t1, t2, t1Names, t2Names) {
    // ── Reset on 0-0 ────────────────────────────────────────────────────────
    if (t1.score === 0 && t2.score === 0) {
      if (this._portToTeam !== null || Object.keys(this._portToName).length > 0) {
        console.log("[bridge] Scores are 0-0; resetting port-team mapping (doubles)");
        this._portToTeam = null;
        this._portToName = {};
        this._portScore  = {};
      }
      return;
    }

    const teamIds = Object.keys(groups).map(Number);
    if (teamIds.length !== 2) return;
    const [tidA, tidB] = teamIds;

    // ── Name-based: any stored port name appears in TSH team player names ───
    const allT1Names = new Set(t1Names.map((n) => n.toLowerCase()));
    const allT2Names = new Set(t2Names.map((n) => n.toLowerCase()));

    let groupATeam = null;
    outer:
    for (const tid of [tidA, tidB]) {
      for (const raw of groups[tid]) {
        const stored = (this._portToName[raw.playerIndex] ?? "").toLowerCase();
        if (!stored) continue;
        if (allT1Names.has(stored)) { groupATeam = (tid === tidA) ? 1 : 2; break outer; }
        if (allT2Names.has(stored)) { groupATeam = (tid === tidA) ? 2 : 1; break outer; }
      }
    }

    if (groupATeam !== null) {
      const groupBTeam = groupATeam === 1 ? 2 : 1;
      this._applyGroupMapping(groups, tidA, groupATeam, tidB, groupBTeam);
      console.log(`[bridge] Doubles name match → slippi team ${tidA}→TSH team ${groupATeam}`);
      return;
    }

    // ── Score-based: sum of port wins matches TSH score ──────────────────────
    const sumWins = (tid) =>
      groups[tid].reduce((s, raw) => s + (this._portScore[raw.playerIndex] ?? 0), 0);
    const winsA = sumWins(tidA);
    const winsB = sumWins(tidB);
    const aIs1 = winsA === t1.score && winsB === t2.score;
    const aIs2 = winsA === t2.score && winsB === t1.score;
    if (aIs1 && !aIs2) {
      this._applyGroupMapping(groups, tidA, 1, tidB, 2);
      console.log(`[bridge] Doubles score match → slippi team ${tidA}→TSH team 1`);
      return;
    }
    if (aIs2 && !aIs1) {
      this._applyGroupMapping(groups, tidA, 2, tidB, 1);
      console.log(`[bridge] Doubles score match → slippi team ${tidA}→TSH team 2`);
      return;
    }

    // ── Positional default: lower min-port group → team 1 ───────────────────
    this.applyDoublesPositional(groups);
  }

  /**
   * Apply the group-based positional default: the Slippi group whose players
   * hold the lowest port number → TSH team 1. Called as a last resort when
   * neither name/score matching nor character history can determine the mapping.
   *
   * This is also called in resolveDoubles() as its final fallback. It exists as
   * a standalone method so onGameStartDoubles can call it at 0-0 (where
   * resolveDoubles returns early after resetting) when tryCharacterBasedDoubles
   * is inconclusive. Without this, buildPlayersDoubles falls back to an
   * index-based positional (first 2 sorted ports = team 1) which is wrong when
   * Slippi groups are non-consecutive (e.g. ports {0,3} vs {1,2}).
   *
   * @param {{ [teamId: number]: Array<{playerIndex}> }} groups
   */
  applyDoublesPositional(groups) {
    const teamIds = Object.keys(groups).map(Number);
    if (teamIds.length !== 2) return;
    const [tidA, tidB] = teamIds;
    const minA = Math.min(...groups[tidA].map((r) => r.playerIndex));
    const minB = Math.min(...groups[tidB].map((r) => r.playerIndex));
    const lowerTid = minA < minB ? tidA : tidB;
    const higherTid = lowerTid === tidA ? tidB : tidA;
    this._applyGroupMapping(groups, lowerTid, 1, higherTid, 2);
    console.log(`[bridge] Doubles positional default → slippi team ${lowerTid}→TSH team 1`);
  }

  /** Internal: write group team assignments into _portToTeam. */
  _applyGroupMapping(groups, tidA, teamA, tidB, teamB) {
    const mapping = {};
    for (const raw of groups[tidA]) mapping[raw.playerIndex] = teamA;
    for (const raw of groups[tidB]) mapping[raw.playerIndex] = teamB;
    const changed = JSON.stringify(this._portToTeam) !== JSON.stringify(mapping);
    this._portToTeam = mapping;
    if (changed) console.log("[bridge] Resolved port→team (doubles):", JSON.stringify(this._portToTeam));
  }

  /**
   * Record a win for a port after a game ends. Used for score-based swap detection.
   * @param {number} winnerPort
   */
  recordWin(winnerPort) {
    this._portScore[winnerPort] = (this._portScore[winnerPort] ?? 0) + 1;
    console.log("[bridge] Port-score map:", JSON.stringify(this._portScore));
  }

  /**
   * After game start assigns ports→teams, populate portToName and portScore.
   *
   * For singles: teamPlayerNames = { 1: ["Alice"], 2: ["Bob"] }
   * For doubles: teamPlayerNames = { 1: ["Alice", "Carol"], 2: ["Bob", "Dave"] }
   * Players are matched to their TSH team's name list by port assignment order.
   *
   * @param {Object} players
   *   Singles: { p1: { playerIndex, teamNum }, p2: { ... } }
   *   Doubles: { [port]: { playerIndex, teamNum }, ... } for all 4 ports
   * @param {{ 1: string[], 2: string[] }} teamPlayerNames
   *   Array of player names per TSH team, in slot order.
   */
  syncNames(players, teamPlayerNames) {
    // Group players by team, sorted by port ascending (preserves slot order)
    const byTeam = {};
    for (const pData of Object.values(players)) {
      (byTeam[pData.teamNum] = byTeam[pData.teamNum] ?? []).push(pData);
    }
    for (const [teamStr, entries] of Object.entries(byTeam)) {
      const teamNum = Number(teamStr);
      const names   = teamPlayerNames[teamNum] ?? [];
      entries.sort((a, b) => a.playerIndex - b.playerIndex);
      for (let i = 0; i < entries.length; i++) {
        const port = entries[i].playerIndex;
        this._portToName[port] = names[i] ?? "";
        if (!(port in this._portScore)) this._portScore[port] = 0;
      }
    }
    console.log("[bridge] Port-name map:", JSON.stringify(this._portToName));
    console.log("[bridge] Port-score map:", JSON.stringify(this._portScore));
  }

  /**
   * Flip the port→team assignment (manual Ctrl+Shift+S swap).
   * For singles: swaps the two known ports.
   * For doubles: swaps both team-1 ports with both team-2 ports atomically.
   * Also swaps portToName so future name-based detection stays consistent.
   *
   * @param {Object|null} currentPlayers  — currentGameState.players (may be null)
   * @returns {true | null}  true on success, null if fewer than 2 ports are known.
   */
  swap(currentPlayers) {
    // Collect all known ports
    const knownPorts = [
      ...Object.keys(this._portToName),
      ...Object.keys(this._portScore),
      ...(this._portToTeam ? Object.keys(this._portToTeam) : []),
      ...(currentPlayers ? Object.values(currentPlayers).map((p) => String(p.playerIndex)) : []),
    ];
    const ports = [...new Set(knownPorts)].map(Number).sort((a, b) => a - b);

    if (ports.length < 2) return null;

    // Build current team→port[] map
    const byTeam = { 1: [], 2: [] };
    for (const port of ports) {
      const team = this._portToTeam?.[port] ?? (port === ports[0] ? 1 : 2);
      (byTeam[team] = byTeam[team] ?? []).push(port);
    }

    // Flip: every team-1 port → 2, every team-2 port → 1
    const newMapping = {};
    for (const port of byTeam[1] ?? []) newMapping[port] = 2;
    for (const port of byTeam[2] ?? []) newMapping[port] = 1;
    this._portToTeam = newMapping;

    // Swap portToName between groups so name-based detection stays consistent
    const names1 = (byTeam[1] ?? []).map((p) => this._portToName[p] ?? "");
    const names2 = (byTeam[2] ?? []).map((p) => this._portToName[p] ?? "");
    (byTeam[1] ?? []).forEach((p, i) => { this._portToName[p] = names2[i] ?? ""; });
    (byTeam[2] ?? []).forEach((p, i) => { this._portToName[p] = names1[i] ?? ""; });

    console.log("[bridge] [S] Manual swap → port→team:", JSON.stringify(this._portToTeam));
    return true;
  }
}

module.exports = PortMapper;
