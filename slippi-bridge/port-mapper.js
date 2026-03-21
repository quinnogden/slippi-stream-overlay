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
   * At 0-0: try to infer mapping from TSH's preloaded character history.
   *
   * @param {Array<{ playerIndex: number, characterId: number, characterColor: number }>} sorted
   *   Players sorted ascending by playerIndex (first + last used as P1/P2).
   * @param {{ t1: { name: string, skin: number }, t2: { name: string, skin: number } }} charHistory
   *   Preloaded character info per team from TshClient.getPreloadedChars().
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

    const { t1, t2 } = charHistory;
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
   * Record a win for a port after a game ends. Used for score-based swap detection.
   * @param {number} winnerPort
   */
  recordWin(winnerPort) {
    this._portScore[winnerPort] = (this._portScore[winnerPort] ?? 0) + 1;
    console.log("[bridge] Port-score map:", JSON.stringify(this._portScore));
  }

  /**
   * After game start assigns ports→teams, populate portToName from TSH.
   * Also initialises portScore tracking for any new port.
   *
   * @param {Object} players  — { p1: { playerIndex, teamNum }, p2: { ... } }
   * @param {{ 1: { name }, 2: { name } }} teamInfo  — from TshClient.getTeamInfo()
   */
  syncNames(players, teamInfo) {
    for (const pData of Object.values(players)) {
      this._portToName[pData.playerIndex] = teamInfo[pData.teamNum]?.name ?? "";
      if (!(pData.playerIndex in this._portScore)) {
        this._portScore[pData.playerIndex] = 0;
      }
    }
    console.log("[bridge] Port-name map:", JSON.stringify(this._portToName));
    console.log("[bridge] Port-score map:", JSON.stringify(this._portScore));
  }

  /**
   * Flip the port→team assignment (manual Ctrl+Shift+S swap).
   * Swaps portToName too so future name-based detection stays consistent.
   *
   * @param {Object|null} currentPlayers  — currentGameState.players (may be null)
   * @returns {{ portA: number, portB: number } | null}
   *   The two ports that were swapped, or null if fewer than 2 ports are known.
   */
  swap(currentPlayers) {
    // Collect ports from all tracking sources + active game
    const knownPorts = [
      ...Object.keys(this._portToName),
      ...Object.keys(this._portScore),
      ...(this._portToTeam ? Object.keys(this._portToTeam) : []),
      ...(currentPlayers ? Object.values(currentPlayers).map((p) => String(p.playerIndex)) : []),
    ];
    const ports = [...new Set(knownPorts)].map(Number).sort((a, b) => a - b);

    if (ports.length < 2) return null;

    const [portA, portB] = [ports[0], ports[ports.length - 1]];

    // Flip portToTeam (initialise from positional default if null)
    const teamA = this._portToTeam?.[portA] ?? 1;
    const teamB = this._portToTeam?.[portB] ?? 2;
    this._portToTeam = { [portA]: teamB, [portB]: teamA };

    // Swap portToName so future name-based detection stays consistent
    const nameA = this._portToName[portA] ?? "";
    const nameB = this._portToName[portB] ?? "";
    this._portToName[portA] = nameB;
    this._portToName[portB] = nameA;

    console.log("[bridge] [S] Manual swap → port→team:", JSON.stringify(this._portToTeam));
    return { portA, portB };
  }
}

module.exports = PortMapper;
