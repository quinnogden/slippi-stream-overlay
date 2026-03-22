/**
 * side-panel.js
 *
 * Right-side OBS overlay panel (611 × 1080 px).
 *
 * Implements TSH layout hooks:
 *   Start()  — called on initial load
 *   Update() — called when program_state.json changes
 *
 * Rotation order (slots skipped when no data):
 *   logos → player-1 → player-2 → recent-sets → completed-sets → queue
 *
 * Config constants (edit here):
 */

const LOGO_PATH           = "../logo.png";
const SPONSOR_PATH        = "../ThePark.png";
const LOGO_INTERVAL       = 20000;  // ms — logo slot duration
const PANEL_INTERVAL      = 10000;  // ms — info panel slot duration
const SCOREBOARD_NUM      = "1";    // which TSH scoreboard to read
const COMPLETED_SETS_URL  = "http://localhost:5000/get-sets?getFinished=1";
const COMPLETED_SETS_POLL = 30000;  // ms between completed-sets fetches
const TOURNAMENT_NAME_URL = "../../out/tournamentInfo/tournamentName.txt";
const NAME_POLL_INTERVAL  = 5000;

// ── Animation toggle ──────────────────────────────────────────────────────────
// Runs before LoadEverything — no library deps needed
(function applyAnimationParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("animate") === "false") {
    document.body.classList.add("no-animate");
  }
})();


// ── Rotation controller ───────────────────────────────────────────────────────

const PANEL_ORDER = ["logos", "player-1", "player-2", "recent-sets", "completed-sets", "queue"];

let completedSets = [];  // cached from last poll
let tshData       = null; // last TSH program state

class Rotator {
  constructor() {
    this._slots   = ["logos"];  // active slots (subset of PANEL_ORDER)
    this._index   = 0;
    this._timer   = null;
    this._current = null;  // id of currently visible slot
  }

  // Rebuild active slot list from current data; if current slot was removed, advance.
  buildSlots(data) {
    if (data) tshData = data;
    const d = tshData;

    const active = PANEL_ORDER.filter(id => {
      switch (id) {
        case "logos":          return true;
        case "player-1":
        case "player-2":       return hasPlayerData(d);
        case "recent-sets":    return hasRecentSets(d);
        case "completed-sets": return completedSets.length > 0;
        case "queue":          return hasQueue(d);
        default:               return false;
      }
    });

    this._slots = active.length > 0 ? active : ["logos"];

    // If current slot was removed, advance immediately
    if (this._current && !this._slots.includes(this._current)) {
      this._index = 0;
      this._advance();
    }
  }

  start() {
    this._advance();
  }

  jumpTo(id) {
    const idx = this._slots.indexOf(id);
    if (idx === -1) return;
    clearTimeout(this._timer);
    this._index = idx;
    this._advance();
  }

  _advance() {
    const slots = this._slots;
    const id    = slots[this._index % slots.length];
    this._index = (this._index % slots.length) + 1;
    if (this._index >= slots.length) this._index = 0;

    const duration = id === "logos" ? LOGO_INTERVAL : PANEL_INTERVAL;

    this._transitionTo(id, () => {
      this._timer = setTimeout(() => this._advance(), duration);
    });
  }

  _transitionTo(id, onDone) {
    const incoming = id === "logos"
      ? document.querySelector(".slot-logo")
      : document.getElementById("panel-" + id);

    if (!incoming) { onDone(); return; }

    // Outgoing element
    const outgoing = this._current === "logos"
      ? document.querySelector(".slot-logo")
      : (this._current ? document.getElementById("panel-" + this._current) : null);

    this._current = id;

    const tl = gsap.timeline({ onComplete: onDone });

    if (outgoing && outgoing !== incoming) {
      tl.to(outgoing, { opacity: 0, scale: 0.97, duration: 0.4, ease: "power2.in" });
    }

    tl.fromTo(
      incoming,
      { opacity: 0, scale: 0.97 },
      { opacity: 1, scale: 1, duration: 0.4, ease: "power2.out" },
      outgoing ? "-=0.1" : 0
    );
  }
}

const rotator = new Rotator();


// ── Skip conditions ───────────────────────────────────────────────────────────

function hasPlayerData(data) {
  try {
    return !!(data.score[SCOREBOARD_NUM].team["1"].player["1"].name);
  } catch (_) { return false; }
}

function hasRecentSets(data) {
  try {
    const rs = data.score[SCOREBOARD_NUM].recent_sets;
    return rs.state === "done" && rs.sets && rs.sets.length > 0;
  } catch (_) { return false; }
}

function hasQueue(data) {
  try {
    const sq = data.streamQueue;
    if (!sq) return false;
    const keys = Object.keys(sq);
    if (keys.length === 0) return false;
    const first = sq[keys[0]];
    return first && first.sets && first.sets.length > 0;
  } catch (_) { return false; }
}


// ── Render helpers ────────────────────────────────────────────────────────────

function ordinal(n) {
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}


// ── renderPlayerCard(teamNum, data) ───────────────────────────────────────────

function renderPlayerCard(teamNum, data) {
  const panel = document.getElementById("panel-player-" + teamNum);
  if (!panel) return;

  try {
    const team   = data.score[SCOREBOARD_NUM].team[String(teamNum)];
    const player = team.player["1"];
    const char   = player.character && player.character["1"];

    // Character name
    panel.querySelector(".player-char-name").textContent =
      (char && char.name) ? char.name.toUpperCase() : "";

    // Sponsor + tag
    const tagEl   = panel.querySelector(".player-tag");
    tagEl.innerHTML = "";
    if (player.team) {
      const sp = el("span", "player-sponsor", player.team + " ");
      tagEl.appendChild(sp);
    }
    tagEl.appendChild(document.createTextNode(player.name || ""));

    // Recent results (history_sets)
    const histList = panel.querySelector(".history-list");
    histList.innerHTML = "";
    const history = data.score[SCOREBOARD_NUM].history_sets
      ? Object.values(data.score[SCOREBOARD_NUM].history_sets[String(teamNum)] || {}).slice(0, 3)
      : [];
    history.forEach(h => {
      const row = el("div", "history-row");
      const nameEl = el("span", "history-tournament", h.tournament_name || h.event_name || "");
      const placeEl = el("span", "history-placement",
        h.placement ? ordinal(h.placement) + (h.entrants ? "/" + h.entrants : "") : "");
      row.appendChild(nameEl);
      row.appendChild(placeEl);
      histList.appendChild(row);
    });

    // Current run (last_sets)
    const runList = panel.querySelector(".run-list");
    runList.innerHTML = "";
    const lastSetsRaw = data.score[SCOREBOARD_NUM].last_sets
      ? data.score[SCOREBOARD_NUM].last_sets[String(teamNum)]
      : null;
    const lastSets = lastSetsRaw
      ? Object.values(lastSetsRaw).slice().reverse().slice(0, 3)
      : [];
    lastSets.forEach(s => {
      const win = (s.player_score || 0) > (s.oponent_score || 0);
      const row = el("div", "run-row");
      const badge = el("span", "result-badge " + (win ? "win" : "loss"), win ? "W" : "L");
      const round = el("span", "run-round", s.round_name || s.phase_name || "");
      const opp   = el("span", "run-opponent", s.player_name || "");
      const score = el("span", "run-score",
        (s.player_score || 0) + "-" + (s.oponent_score || 0));
      row.append(badge, round, opp, score);
      runList.appendChild(row);
    });
  } catch (_) {}
}


// ── renderRecentSets(data) ────────────────────────────────────────────────────

function renderRecentSets(data) {
  const panel = document.getElementById("panel-recent-sets");
  if (!panel) return;

  try {
    const list = panel.querySelector(".sets-list");
    list.innerHTML = "";
    const sets = data.score[SCOREBOARD_NUM].recent_sets.sets || [];
    sets.slice(0, 5).forEach(s => {
      const win   = s.winner === 0;
      const score = (s.score || [0, 0]);
      const row   = el("div", "set-row");
      const badge = el("span", "result-badge " + (win ? "win" : "loss"), win ? "W" : "L");
      const p1    = el("span", "set-p1", s.p1_name || "P1");
      const sc    = el("span", "set-score", score[0] + "-" + score[1]);
      const p2    = el("span", "set-p2", s.p2_name || "P2");
      row.append(badge, p1, sc, p2);
      list.appendChild(row);
    });
  } catch (_) {}
}


// ── renderCompletedSets() ─────────────────────────────────────────────────────

function renderCompletedSets() {
  const panel = document.getElementById("panel-completed-sets");
  if (!panel) return;

  const list = panel.querySelector(".completed-list");
  list.innerHTML = "";

  completedSets.forEach(s => {
    try {
      const e1     = s.slots[0].entrant;
      const e2     = s.slots[1].entrant;
      const winId  = s.winnerId;
      const winner = winId === e1.id ? e1 : e2;
      const loser  = winId === e1.id ? e2 : e1;
      const sc1    = winId === e1.id ? s.entrant1Score : s.entrant2Score;
      const sc2    = winId === e1.id ? s.entrant2Score : s.entrant1Score;

      const row      = el("div", "completed-row");
      const matchDiv = el("div", "completed-match");
      const wEl      = el("span", "completed-winner", winner.name || "");
      const scEl     = el("span", "set-score", sc1 + "-" + sc2);
      const lEl      = el("span", "completed-loser", loser.name || "");
      matchDiv.append(wEl, scEl, lEl);

      const roundEl = el("div", "completed-round",
        s.fullRoundText || "");

      row.append(matchDiv, roundEl);
      list.appendChild(row);
    } catch (_) {}
  });
}


// ── renderQueue(data) ─────────────────────────────────────────────────────────

function renderQueue(data) {
  const panel = document.getElementById("panel-queue");
  if (!panel) return;

  try {
    const sq   = data.streamQueue;
    const key  = Object.keys(sq)[0];
    const sets = sq[key].sets || [];
    const list = panel.querySelector(".queue-list");
    list.innerHTML = "";

    sets.slice(0, 5).forEach(s => {
      const teams = s.teams || [];
      const t1    = (teams[0] && teams[0].players && teams[0].players[0]) || {};
      const t2    = (teams[1] && teams[1].players && teams[1].players[0]) || {};

      const row      = el("div", "queue-row");
      const matchDiv = el("div", "queue-match");
      const p1El     = el("span", "", (t1.team ? t1.team + " " : "") + (t1.name || ""));
      const vsEl     = el("span", "queue-vs", "vs");
      const p2El     = el("span", "", (t2.team ? t2.team + " " : "") + (t2.name || ""));
      matchDiv.append(p1El, vsEl, p2El);

      const ctx = [s.phase, s.match].filter(Boolean).join(" · ");
      const ctxEl = el("div", "queue-context", ctx);

      row.append(matchDiv, ctxEl);
      list.appendChild(row);
    });
  } catch (_) {}
}


// ── Tournament name helpers ───────────────────────────────────────────────────

function setTournamentName(name) {
  const el = document.querySelector(".tournament-name");
  if (el && name) el.textContent = name.trim();
}

async function fetchTournamentName() {
  try {
    const res = await fetch(TOURNAMENT_NAME_URL, { cache: "no-store" });
    if (res.ok) setTournamentName(await res.text());
  } catch (_) {}
}


// ── Completed sets polling ────────────────────────────────────────────────────

async function fetchCompletedSets() {
  try {
    const res = await fetch(COMPLETED_SETS_URL, { cache: "no-store" });
    if (res.ok) {
      const raw = await res.json();
      completedSets = Array.isArray(raw) ? raw.slice(0, 5) : [];
      renderCompletedSets();
      rotator.buildSlots(null);
    }
  } catch (_) {}
}


// ── Bootstrap — requires libraries loaded by LoadEverything ───────────────────

LoadEverything().then(() => {
  gsap.config({ nullTargetWarn: false });

  // ── Logo cycle ────────────────────────────────────────────────────────────
  (function initLogos() {
    const primary = document.querySelector(".logo-primary");
    const sponsor = document.querySelector(".logo-sponsor");
    if (!primary || !sponsor) return;

    primary.src = LOGO_PATH;
    sponsor.src = SPONSOR_PATH;

    // Crossfade between primary and sponsor every half the logo slot duration
    const crossfadeInterval = LOGO_INTERVAL / 2;
    primary.onload = () => {
      gsap.set(primary, { opacity: 1 });
      let showPrimary = true;
      setInterval(() => {
        showPrimary = !showPrimary;
        gsap.to(primary, { opacity: showPrimary ? 1 : 0, duration: 1.2, ease: "power2.inOut" });
        gsap.to(sponsor,  { opacity: showPrimary ? 0 : 1, duration: 1.2, ease: "power2.inOut" });
      }, crossfadeInterval);
    };
  })();

  // ── Tournament name polling ───────────────────────────────────────────────
  fetchTournamentName();
  setInterval(fetchTournamentName, NAME_POLL_INTERVAL);

  // ── Completed sets polling ────────────────────────────────────────────────
  fetchCompletedSets();
  setInterval(fetchCompletedSets, COMPLETED_SETS_POLL);

  // ── TSH hooks ─────────────────────────────────────────────────────────────

  Start = async function () {
    rotator.buildSlots(null);
    rotator.start();
  };

  Update = async function (event) {
    const data = event && event.data;
    if (!data) return;

    rotator.buildSlots(data);
    renderPlayerCard(1, data);
    renderPlayerCard(2, data);
    renderRecentSets(data);
    renderQueue(data);

    const name = data.tournamentInfo && data.tournamentInfo.tournamentName;
    if (name) setTournamentName(name);
  };


  // ── Slippi Bridge ──────────────────────────────────────────────────────────

  (function initSlippiBridge() {
    function tryConnect(attemptsLeft) {
      if (typeof io === "undefined") {
        if (attemptsLeft > 0) setTimeout(() => tryConnect(attemptsLeft - 1), 300);
        return;
      }

      const socket = io("http://localhost:5001", {
        reconnectionDelay:    5000,
        reconnectionDelayMax: 30000,
      });

      socket.on("connect", () => {
        console.log("[side-panel] Bridge connected");
      });

      socket.on("slippi_game_start", () => {
        rotator.jumpTo("player-1");
      });

      socket.on("slippi_game_end", () => {});

      socket.on("disconnect", () => {
        console.log("[side-panel] Bridge disconnected — waiting to reconnect");
      });

      socket.on("connect_error", () => {});
    }

    tryConnect(10);
  })();

}); // end LoadEverything().then()
