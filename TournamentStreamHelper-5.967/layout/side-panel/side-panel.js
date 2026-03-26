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

// ── Debug: lock to a single panel (set null to re-enable rotation) ────────────
const DEBUG_PANEL = null; // "logos"|"player-1"|"player-2"|"recent-sets"|"completed-sets"|"queue"|null

const LOGO_PATH           = "../logo.png";
const SPONSOR_PATH        = "../ThePark.png";
const LOGO_INTERVAL       = 20000;  // ms — logo slot duration
const PANEL_INTERVAL      = 20000;  // ms — all panel slot duration

// ── Animation timing constants ────────────────────────────────────────────────
const ANIM_TRANSITION_DURATION = 0.7;   // panel fade in/out
const ANIM_PILL_DURATION       = 0.55;  // pill stagger enter duration
const ANIM_PILL_DELAY          = 0.15;  // delay before pills start entering
const ANIM_PILL_STAGGER        = 0.10;  // per-pill stagger gap
const ANIM_PILL_Y_OFFSET       = 40;    // px drop on pill enter
const SCOREBOARD_NUM      = "1";    // which TSH scoreboard to read
const COMPLETED_SETS_URL  = "http://localhost:5000/get-sets?getFinished=1";
const COMPLETED_SETS_POLL = 30000;  // ms between completed-sets fetches
const TOURNAMENT_NAME_URL = "../../out/tournamentInfo/tournamentName.txt";
const NAME_POLL_INTERVAL  = 5000;

// ── Animation toggle ──────────────────────────────────────────────────────────
(function applyAnimationParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("animate") === "false") {
    document.body.classList.add("no-animate");
  }
})();


// ── Rotation controller ───────────────────────────────────────────────────────

const PANEL_ORDER = ["logo-primary", "player-1", "player-2", "recent-sets", "logo-sponsor", "completed-sets", "queue"];

let completedSets = [];  // cached from last poll
let tshData       = null; // last TSH program state

class Rotator {
  constructor() {
    this._slots   = ["logo-primary"];
    this._index   = 0;
    this._timer   = null;
    this._current = null;
  }

  buildSlots(data) {
    if (data) tshData = data;
    const d = tshData;

    const doubles = isDoubles(d);
    const active = PANEL_ORDER.filter(id => {
      switch (id) {
        case "logo-primary":   return true;
        case "logo-sponsor":   return true;
        case "player-1":       return !doubles && hasPlayerCardContent(d, 1);
        case "player-2":       return !doubles && hasPlayerCardContent(d, 2);
        case "recent-sets":    return !doubles && hasRecentSets(d);
        case "completed-sets": return completedSets.length > 0;
        case "queue":          return hasQueue(d);
        default:               return false;
      }
    });

    this._slots = active.length > 0 ? active : ["logo-primary"];

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
    // Debug mode: lock to a single panel, no auto-advance
    if (DEBUG_PANEL) {
      this._transitionTo(DEBUG_PANEL, () => {});
      return;
    }

    const slots = this._slots;
    const id    = slots[this._index];
    this._index = (this._index + 1) % slots.length;

    const duration = PANEL_INTERVAL;

    this._transitionTo(id, () => {
      this._timer = setTimeout(() => this._advance(), duration);
    });
  }

  _resolveEl(id) {
    if (id === "logo-primary") return document.querySelector(".logo-primary");
    if (id === "logo-sponsor") return document.querySelector(".logo-sponsor");
    return document.getElementById("panel-" + id);
  }

  _transitionTo(id, onDone) {
    const incoming = this._resolveEl(id);
    if (!incoming) { onDone(); return; }

    const outgoing = this._current ? this._resolveEl(this._current) : null;

    this._current = id;

    const tl = gsap.timeline({ onComplete: onDone });

    if (outgoing && outgoing !== incoming) {
      tl.to(outgoing, { opacity: 0, scale: 0.97, duration: ANIM_TRANSITION_DURATION, ease: "power2.in" });
    }

    tl.fromTo(
      incoming,
      { opacity: 0, scale: 0.97 },
      { opacity: 1, scale: 1, duration: ANIM_TRANSITION_DURATION, ease: "power2.out" },
      outgoing ? "-=0.1" : 0
    );

    // James Bond stagger: pills fall in top-to-bottom on panel entrance
    if (id !== "logo-primary" && id !== "logo-sponsor") {
      const pills = incoming.querySelectorAll(".panel-pill");
      if (pills.length > 0) {
        gsap.fromTo(
          pills,
          { y: -ANIM_PILL_Y_OFFSET, opacity: 0 },
          { y: 0, opacity: 1, duration: ANIM_PILL_DURATION, ease: "power2.out", stagger: ANIM_PILL_STAGGER, delay: ANIM_PILL_DELAY }
        );
      }
    }
  }
}

const rotator = new Rotator();


// ── Skip conditions ───────────────────────────────────────────────────────────

function isDoubles(data) {
  try {
    return Object.keys(data.score[SCOREBOARD_NUM].team["1"].player).length > 1;
  } catch (_) { return false; }
}

function hasPlayerCardContent(data, teamNum) {
  try {
    if (!data.score[SCOREBOARD_NUM].team[String(teamNum)].player["1"].name) return false;
    const history = data.score[SCOREBOARD_NUM].history_sets
      ? Object.values(data.score[SCOREBOARD_NUM].history_sets[String(teamNum)] || {})
          .filter(h => (h.event_name || "").toLowerCase().includes("single"))
      : [];
    const lastSets = data.score[SCOREBOARD_NUM].last_sets
      ? Object.values(data.score[SCOREBOARD_NUM].last_sets[String(teamNum)] || {})
      : [];
    return history.length > 0 || lastSets.length > 0;
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


// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ordinalSuffix(n) {
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
function ordinal(n) { return n + ordinalSuffix(n); }

function makePlacementEl(placement, entrants) {
  const suffix = ordinalSuffix(placement);
  const span = document.createElement("span");
  span.className = "pill-placement";
  span.appendChild(document.createTextNode(String(placement)));
  const sup = document.createElement("sup");
  sup.className = "ordinal-sup";
  sup.textContent = suffix;
  span.appendChild(sup);
  if (entrants) span.appendChild(document.createTextNode("/" + entrants));
  return span;
}

function formatDate(timestampSeconds) {
  try {
    const d = new Date(timestampSeconds * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return mm + "/" + dd + "/" + yy;
  } catch (_) { return ""; }
}

// Auto-shrink text to fit its container (single line, no ellipsis)
function fitText(el, minPx = 13) {
  requestAnimationFrame(() => {
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth && size > minPx) {
      size -= 0.5;
      el.style.fontSize = size + "px";
    }
  });
}

// Create a standard panel-pill div
function makePill(extraClass) {
  const d = document.createElement("div");
  d.className = "panel-pill" + (extraClass ? " " + extraClass : "");
  return d;
}

// Create a two-line pill with line1 and line2 content elements
// line1El and line2El are already-built DOM elements or strings
function makeTwoLinePill(line1El, line2Text, extraClass) {
  const p = makePill("pill-two-line" + (extraClass ? " " + extraClass : ""));
  const l1 = el("div", "pill-line-1");
  if (typeof line1El === "string") {
    l1.textContent = line1El;
  } else if (line1El) {
    l1.appendChild(line1El);
  }
  p.appendChild(l1);
  if (line2Text) {
    p.appendChild(el("div", "pill-line-2", line2Text));
  }
  return p;
}


// ── renderPlayerCard(teamNum, data) ───────────────────────────────────────────

function renderPlayerCard(teamNum, data) {
  const panel = document.getElementById("panel-player-" + teamNum);
  if (!panel) return;

  try {
    const team   = data.score[SCOREBOARD_NUM].team[String(teamNum)];
    const player = team.player["1"];
    const char   = player.character && player.character["1"];

    // Identity block
    const identity = panel.querySelector(".player-identity");
    const tagEl    = identity.querySelector(".player-tag");
    const charEl   = identity.querySelector(".player-char-name");

    tagEl.innerHTML = "";
    if (player.team) {
      tagEl.appendChild(el("span", "player-sponsor", player.team + " "));
    }
    tagEl.appendChild(document.createTextNode(player.name || ""));

    charEl.textContent = (char && char.name) ? char.name.toUpperCase() : "";

    // Recent Results pills
    const histList   = panel.querySelector(".history-list");
    const histHeader = histList.previousElementSibling;
    histList.innerHTML = "";
    const filteredHistory = (data.score[SCOREBOARD_NUM].history_sets
      ? Object.values(data.score[SCOREBOARD_NUM].history_sets[String(teamNum)] || {}).slice(0, 10)
      : []).filter(h => (h.event_name || "").toLowerCase().includes("single")).slice(0, 5);

    const showHist = filteredHistory.length > 0;
    histHeader.style.display = showHist ? "" : "none";
    histList.style.display   = showHist ? "" : "none";

    filteredHistory.forEach(h => {
      const pill  = makePill();
      const name  = el("span", "pill-name", h.tournament_name || h.event_name || "");
      const place = h.placement ? makePlacementEl(h.placement, h.entrants) : el("span", "pill-placement");
      pill.append(name, place);
      histList.appendChild(pill);
    });

    // Current Run pills
    const runList   = panel.querySelector(".run-list");
    const runHeader = runList.previousElementSibling;
    runList.innerHTML = "";
    const lastSetsRaw = data.score[SCOREBOARD_NUM].last_sets
      ? data.score[SCOREBOARD_NUM].last_sets[String(teamNum)]
      : null;
    const lastSets = lastSetsRaw
      ? Object.values(lastSetsRaw).slice(0, 5)
      : [];

    const showRun = lastSets.length > 0;
    runHeader.style.display = showRun ? "" : "none";
    runList.style.display   = showRun ? "" : "none";

    lastSets.forEach(s => {
      const win   = (s.player_score || 0) > (s.oponent_score || 0);
      const pill  = makePill(win ? "win" : "loss");
      const round = el("span", "pill-round", s.round_name || s.phase_name || "");
      const opp   = el("span", "pill-name", s.oponent_name || "");
      const score = el("span", "pill-run-score",
        (s.player_score || 0) + "–" + (s.oponent_score || 0));
      pill.append(opp, round, score);
      runList.appendChild(pill);
      fitText(opp);
    });

  } catch (_) {}
}


// ── renderRecentSets(data) ────────────────────────────────────────────────────

function renderRecentSets(data) {
  const panel = document.getElementById("panel-recent-sets");
  if (!panel) return;

  try {
    const container = panel.querySelector(".sets-list");
    container.innerHTML = "";

    const sets = data.score[SCOREBOARD_NUM].recent_sets.sets || [];

    // H2H pill
    const p1Name = data.score[SCOREBOARD_NUM].team["1"].player["1"].name || "P1";
    const p2Name = data.score[SCOREBOARD_NUM].team["2"].player["1"].name || "P2";
    const p1Wins = sets.filter(s => s.winner === 0).length;
    const p2Wins = sets.filter(s => s.winner === 1).length;

    const h2hHeader = el("div", "h2h-header");
    const h2hRow    = el("div", "h2h-row");
    const p1El = el("div", "h2h-name", p1Name);
    const p2El = el("div", "h2h-name right", p2Name);
    h2hRow.appendChild(p1El);
    const h2hMid    = el("div", "h2h-mid");
    h2hMid.appendChild(el("div", "h2h-subtitle", "Head to Head"));
    h2hMid.appendChild(el("span", "h2h-score", p1Wins + " – " + p2Wins));
    h2hRow.appendChild(h2hMid);
    h2hRow.appendChild(p2El);
    h2hHeader.appendChild(h2hRow);
    container.appendChild(h2hHeader);
    fitText(p1El, 18);
    fitText(p2El, 18);

    // Result pills (up to 5)
    sets.slice(0, 5).forEach(s => {
      const sc  = s.score || [0, 0];
      const sub = (s.tournament || "") + (s.timestamp ? " · " + formatDate(s.timestamp) : "");

      const line1 = document.createDocumentFragment();
      line1.appendChild(el("span", "pill-score-val", String(sc[0])));
      line1.appendChild(el("span", "pill-round", s.round || ""));
      line1.appendChild(el("span", "pill-score-val", String(sc[1])));

      const p1Win = s.winner === 0;
      const pill = makePill("recent-set-pill " + (p1Win ? "win" : "loss"));
      pill.appendChild(el("span", "pill-score-val", String(sc[0])));
      const info = el("div", "recent-set-info");
      if (sub) info.appendChild(el("div", "pill-line-2", sub));
      if (s.round) info.appendChild(el("div", "pill-round recent-set-round", s.round));
      pill.appendChild(info);
      pill.appendChild(el("span", "pill-score-val recent-score-right", String(sc[1])));
      container.appendChild(pill);
    });

  } catch (_) {}
}


// ── renderCompletedSets() ─────────────────────────────────────────────────────

function renderCompletedSets() {
  const panel = document.getElementById("panel-completed-sets");
  if (!panel) return;

  const container = panel.querySelector(".completed-list");
  container.innerHTML = "";

  completedSets.forEach(s => {
    try {
      const p1wins = (s.team1score || 0) > (s.team2score || 0);

      const pill = makePill("completed-set-pill " + (p1wins ? "p1win" : "p2win"));
      pill.appendChild(el("span", "pill-name", s.p1_name || ""));
      const info = el("div", "completed-set-info");
      if (s.round_name) info.appendChild(el("div", "pill-line-2", s.round_name));
      info.appendChild(el("span", "set-score", s.team1score + "–" + s.team2score));
      pill.appendChild(info);
      pill.appendChild(el("span", "pill-name right", s.p2_name || ""));
      container.appendChild(pill);
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
    const container = panel.querySelector(".queue-list");
    container.innerHTML = "";

    sets.slice(0, 5).forEach(s => {
      const teams = s.teams || [];
      const t1    = (teams[0] && teams[0].players && teams[0].players[0]) || {};
      const t2    = (teams[1] && teams[1].players && teams[1].players[0]) || {};

      const p1Name = (t1.team ? t1.team + " " : "") + (t1.name || "");
      const p2Name = (t2.team ? t2.team + " " : "") + (t2.name || "");

      const pill = makePill("queue-pill");
      pill.appendChild(el("span", "pill-name", p1Name));
      if (s.match) pill.appendChild(el("span", "pill-round queue-round", s.match));
      pill.appendChild(el("span", "pill-name right", p2Name));
      container.appendChild(pill);
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
      completedSets = Array.isArray(raw) ? raw.filter(s => s.team1score != null && s.team2score != null).slice(0, 8) : [];
      renderCompletedSets();
      rotator.buildSlots(null);
    }
  } catch (_) {}
}


// ── Bootstrap ─────────────────────────────────────────────────────────────────

LoadEverything().then(() => {
  gsap.config({ nullTargetWarn: false });

  // ── Logo setup ────────────────────────────────────────────────────────────
  (function initLogos() {
    const primary = document.querySelector(".logo-primary");
    const sponsor = document.querySelector(".logo-sponsor");
    if (primary) primary.src = LOGO_PATH;
    if (sponsor) sponsor.src = SPONSOR_PATH;
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

      socket.on("disconnect", () => {
        console.log("[side-panel] Bridge disconnected — waiting to reconnect");
      });
    }

    tryConnect(10);
  })();

}); // end LoadEverything().then()
