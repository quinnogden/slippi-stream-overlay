/**
 * side-panel.js
 *
 * Right-side OBS overlay panel (611 × 1080 px).
 *
 * Implements TSH layout hooks:
 *   Start()  — called on initial load
 *   Update() — called when program_state.json changes
 *
 * Rotation order is PANEL_ORDER below; a slot is skipped while it has no data.
 * Timing and data-source constants follow.
 */

// ── Debug: lock to a single panel (set null to re-enable rotation) ────────────
const DEBUG_PANEL = null; // "logos"|"player-1"|"player-2"|"recent-sets"|"completed-sets"|"queue"|null


const PANEL_INTERVAL      = 20000;  // ms — every slot, logos included

// The tournament and sponsor logos are NOT configured here. They come from the
// active theme pack (layout/themes/<pack>/theme.css) via the --logo-url /
// --sponsor-url tokens, applied in side-panel.css. Keeping them in CSS is what
// lets the pack use paths relative to itself.

// ── Animation timing constants ────────────────────────────────────────────────
const ANIM_TRANSITION_DURATION = 0.7;   // panel fade in/out
const ANIM_PILL_DURATION       = 0.55;  // pill stagger enter duration
const ANIM_PILL_DELAY          = 0.15;  // delay before pills start entering
const ANIM_PILL_STAGGER        = 0.10;  // per-pill stagger gap
const ANIM_PILL_Y_OFFSET       = 40;    // px drop on pill enter
// Which TSH scoreboard to read — ?scoreboardNumber= on the source URL, same as
// the scoreboard layout (globals.js sets it before this file runs).
const SCOREBOARD_NUM      = String(window.scoreboardNumber ?? 1);
const COMPLETED_SETS_URL  = "http://localhost:5000/get-sets?getFinished=1";
// Each fetch is an uncached, paginated start.gg query on TSH's side, so this
// stays slow — the same 90s the control panel uses. A full rotation takes
// longer than that anyway.
const COMPLETED_SETS_POLL = 90000;
const TOURNAMENT_NAME_URL = "../../out/tournamentInfo/tournamentName.txt";
// Update() already sets the name from every TSH state push, so this fetch only
// really matters at cold start, before the first push arrives. Kept as a slow
// poll rather than a one-shot so a tournament switch can't strand a stale name
// on stream if the push is somehow missed.
const NAME_POLL_INTERVAL  = 30000;

// ── Animation toggle ──────────────────────────────────────────────────────────
(function applyAnimationParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("animate") === "false") {
    document.body.classList.add("no-animate");
  }
})();


// ── Rotation controller ───────────────────────────────────────────────────────

const PANEL_ORDER = [
  "logo-primary",
  "player-1", "player-2", "recent-sets",
  "logo-sponsor", "completed-sets", "queue"
];

let completedSets = [];  // cached from last poll
let tshData       = null; // last TSH program state

class Rotator {
  constructor() {
    this._slots   = ["logo-primary"];
    this._index   = 0;
    this._timer   = null;
    this._current = null;
    this._tl      = null;
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

    const next = active.length > 0 ? active : ["logo-primary"];

    const changed = next.length !== this._slots.length
      || next.some((id, i) => id !== this._slots[i]);

    this._slots = next;

    if (!changed || !this._current) return;

    // The visible panel survived the rebuild, so leave it alone: keep it on
    // screen for its full dwell and just re-aim the cursor at whatever now
    // follows it (_index points into the old list and is meaningless now).
    //
    // Restarting here instead is what caused the logo to flash repeatedly.
    // Loading a set is not one state push but many — TSH clears the names,
    // then answers last_sets.1, history_sets.1, last_sets.2, history_sets.2
    // and recent_sets as separate async replies, each its own write. Every one
    // that flips a slot predicate changes the list, and since restart() rotates
    // from the top and slot 0 is always logo-primary, each was a fresh logo.
    const pos = this._slots.indexOf(this._current);
    if (pos !== -1) {
      this._index = (pos + 1) % this._slots.length;
      return;
    }

    // The visible panel has dropped out of the rotation. It must not stay on
    // screen, and only a restart guarantees nothing is left stacked underneath:
    // a rebuild landing mid-transition would otherwise strand the fading panel.
    this.restart();
  }

  start() {
    this._advance();
  }

  /**
   * Hard reset: cancel the pending advance and any in-flight animation, force
   * every panel except the visible one back to hidden, and rotate from the top.
   * The current panel is kept so it still fades out rather than cutting.
   */
  restart() {
    clearTimeout(this._timer);
    if (this._tl) { this._tl.kill(); this._tl = null; }
    this._hideAllExcept([this._current]);
    this._index = 0;
    this._advance();
  }

  /**
   * Force-hide every panel not named in `keep`.
   *
   * Panels are absolutely stacked and only GSAP's opacity separates them, so a
   * panel abandoned part-way through a fade stays visible under the next one.
   * This hard-sets opacity instead of trusting an animation to have completed.
   */
  _hideAllExcept(keep = []) {
    for (const id of PANEL_ORDER) {
      if (keep.includes(id)) continue;
      const el = this._resolveEl(id);
      if (!el) continue;
      gsap.killTweensOf(el);
      const pills = el.querySelectorAll(".panel-pill");
      if (pills.length) gsap.killTweensOf(pills);
      gsap.set(el, { opacity: 0, scale: 0.97 });
    }
  }

  _advance() {
    clearTimeout(this._timer);
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

    // Anything other than these two must not be on screen. Cheap insurance so a
    // stray panel can never survive more than one transition.
    this._hideAllExcept([id, this._current]);

    this._current = id;

    if (this._tl) this._tl.kill();
    this._tl = gsap.timeline({ onComplete: onDone });

    if (outgoing && outgoing !== incoming) {
      this._tl.to(outgoing, { opacity: 0, scale: 0.97, duration: ANIM_TRANSITION_DURATION, ease: "power2.in" });
    }

    this._tl.fromTo(
      incoming,
      { opacity: 0, scale: 0.97 },
      { opacity: 1, scale: 1, duration: ANIM_TRANSITION_DURATION, ease: "power2.out" },
      outgoing ? "-=0.1" : 0
    );

    // James Bond stagger: pills fall in top-to-bottom on panel entrance
    if (id !== "logo-primary" && id !== "logo-sponsor") {
      const pills = incoming.querySelectorAll(".panel-pill");
      if (pills.length > 0) {
        gsap.fromTo(pills, { y: -ANIM_PILL_Y_OFFSET, opacity: 0 }, {
          y: 0, opacity: 1,
          duration: ANIM_PILL_DURATION, ease: "power2.out",
          stagger: ANIM_PILL_STAGGER, delay: ANIM_PILL_DELAY,
        });
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

// Both the player card's tournament history and the head-to-head card pull sets
// across every event the players entered, doubles included — start.gg's recent-
// sets query filters on player ids, and TSH only compares participants[0] of each
// entrant, so a doubles set the two happened to be listed first in comes through
// looking exactly like a singles one. Judged on the event name, which is the only
// format signal in either payload. Requiring "single" is the strict reading: an
// event named "Melee Bracket" is dropped too. That is the right trade for a
// broadcast — a short H2H record is invisible, a doubles set on the singles card
// is wrong on screen. Loosen it to the exclusion test alone if a venue's naming
// starts emptying the card.
const DOUBLES_EVENT_RE = /doubles|dubs|teams|2v2|2 v 2|crew/i;

function isSinglesEvent(name) {
  const n = String(name || "").toLowerCase();
  if (DOUBLES_EVENT_RE.test(n)) return false;
  return n.includes("single");
}

// The singles subset of the head-to-head sets. hasRecentSets() and
// renderRecentSets() must agree on this list or the panel shows with nothing in
// it — hence one helper rather than a filter at each call site.
function recentSinglesSets(data) {
  try {
    const rs = data.score[SCOREBOARD_NUM].recent_sets;
    if (rs.state !== "done" || !rs.sets) return [];
    return rs.sets.filter(s => isSinglesEvent(s.event));
  } catch (_) { return []; }
}

// A player's past singles placements, for the player card. Same contract as
// recentSinglesSets(): hasPlayerCardContent() and renderPlayerCard() both read
// this, so the slot can't rotate in with an empty history list.
function playerSinglesHistory(data, teamNum) {
  try {
    const hs = data.score[SCOREBOARD_NUM].history_sets;
    return Object.values((hs && hs[String(teamNum)]) || {})
      .filter(h => isSinglesEvent(h.event_name));
  } catch (_) { return []; }
}

function hasPlayerCardContent(data, teamNum) {
  try {
    if (!data.score[SCOREBOARD_NUM].team[String(teamNum)].player["1"].name) return false;
    const history = playerSinglesHistory(data, teamNum);
    const lastSets = data.score[SCOREBOARD_NUM].last_sets
      ? Object.values(data.score[SCOREBOARD_NUM].last_sets[String(teamNum)] || {})
      : [];
    return history.length > 0 || lastSets.length > 0;
  } catch (_) { return false; }
}

function hasRecentSets(data) {
  return recentSinglesSets(data).length > 0;
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
  const d = new Date(timestampSeconds * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return mm + "/" + dd + "/" + yy;
}

// Shrink single-line text until it fits its box instead of truncating it.
//
// Every text element that would otherwise ellipsize goes through here. The
// CSS text-overflow: ellipsis stays on those rules, but only as the fallback
// once minPx is reached — below that the text stops being legible on stream.
//
// The element remembers its floor in data-fit-min so refitAllText() can redo
// the lot when the brand font finishes loading: measured against the fallback
// font, the fitted size is wrong for the real one.
//
// Synchronous on purpose, so call it only once the node is in the document —
// reading scrollWidth forces the layout it needs. It used to defer to
// requestAnimationFrame, which never fires in a source that isn't painting.
function fitText(node, minPx = 13) {
  node.dataset.fitMin = String(minPx);
  fitTextNow(node);
}

function fitTextNow(node) {
  const minPx = parseFloat(node.dataset.fitMin) || 13;
  // Start from the stylesheet size, so a re-fit can grow back as well as shrink
  // (and a clamp()/cqh size keeps tracking its pill).
  node.style.fontSize = "";
  const width = node.clientWidth;
  if (!width || node.scrollWidth <= width) return;

  // Width scales ~linearly with font-size (letter-spacing is in em), so jump
  // straight to the ratio and only nudge for padding/rounding. The old
  // 0.5px-per-step loop forced a reflow per step — dozens for a long name.
  const base = parseFloat(getComputedStyle(node).fontSize);
  let size = Math.max(minPx, Math.floor(base * width / node.scrollWidth * 2) / 2);
  node.style.fontSize = size + "px";
  while (node.scrollWidth > width && size > minPx) {
    size = Math.max(minPx, size - 0.5);
    node.style.fontSize = size + "px";
  }
}

function refitAllText() {
  document.querySelectorAll("[data-fit-min]").forEach(fitTextNow);
}

// Text fitted before the brand font arrived was measured against the fallback;
// redo it once the real glyph widths are known. Registered here rather than in
// the bootstrap, which can resolve after the font has already landed.
if (document.fonts) {
  document.fonts.addEventListener("loadingdone", refitAllText);
  document.fonts.ready.then(refitAllText);
}

// Create a standard panel-pill div
function makePill(extraClass) {
  const d = document.createElement("div");
  d.className = "panel-pill" + (extraClass ? " " + extraClass : "");
  return d;
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
    fitText(tagEl, 24);

    charEl.textContent = (char && char.name) ? char.name.toUpperCase() : "";

    // Recent Results pills
    const histList   = panel.querySelector(".history-list");
    const histHeader = histList.previousElementSibling;
    histList.innerHTML = "";
    const filteredHistory = playerSinglesHistory(data, teamNum).slice(0, 5);

    const showHist = filteredHistory.length > 0;
    histHeader.style.display = showHist ? "" : "none";
    histList.style.display   = showHist ? "" : "none";

    filteredHistory.forEach(h => {
      const pill  = makePill();
      const name  = el("span", "pill-name", h.tournament_name || h.event_name || "");
      const place = h.placement ? makePlacementEl(h.placement, h.entrants) : el("span", "pill-placement");
      pill.append(name, place);
      histList.appendChild(pill);
      fitText(name);
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
      fitText(round, 11);
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

    const sets = recentSinglesSets(data);

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

      const p1Win = s.winner === 0;
      const pill = makePill("recent-set-pill " + (p1Win ? "win" : "loss"));
      pill.appendChild(el("span", "pill-score-val", String(sc[0])));
      const info = el("div", "recent-set-info");
      const subEl   = sub     ? info.appendChild(el("div", "pill-line-2", sub)) : null;
      const roundEl = s.round ? info.appendChild(el("div", "pill-round recent-set-round", s.round)) : null;
      pill.appendChild(info);
      pill.appendChild(el("span", "pill-score-val recent-score-right", String(sc[1])));
      container.appendChild(pill);
      if (subEl)   fitText(subEl, 11);
      if (roundEl) fitText(roundEl, 11);
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
      const p1El = pill.appendChild(el("span", "pill-name", s.p1_name || ""));
      const info = el("div", "completed-set-info");
      if (s.round_name) info.appendChild(el("div", "pill-line-2", s.round_name));
      info.appendChild(el("span", "set-score", s.team1score + "–" + s.team2score));
      pill.appendChild(info);
      const p2El = pill.appendChild(el("span", "pill-name right", s.p2_name || ""));
      container.appendChild(pill);
      fitText(p1El);
      fitText(p2El);
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
      const p1El = pill.appendChild(el("span", "pill-name", p1Name));
      if (s.match) pill.appendChild(el("span", "pill-round queue-round", s.match));
      const p2El = pill.appendChild(el("span", "pill-name right", p2Name));
      container.appendChild(pill);
      fitText(p1El);
      fitText(p2El);
    });
  } catch (_) {}
}


// ── Tournament name helpers ───────────────────────────────────────────────────

function setTournamentName(name) {
  const target = document.querySelector(".tournament-name");
  if (!target || !name) return;
  // Called on every TSH push and every 30s poll — only re-measure on a change.
  const text = name.trim();
  if (target.textContent === text) return;
  target.textContent = text;
  fitText(target, 18);
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


// ── Render only what changed ──────────────────────────────────────────────────

// Loading a set arrives as six-plus separate TSH pushes (see Rotator.buildSlots),
// and a score change is one more. Rebuilding every panel on each of them re-runs
// fitText's layout loop and swaps the pills of the panel on screen with no
// entrance animation. Each panel instead remembers the slice of state it last
// drew and skips the rebuild when that slice is unchanged.
const lastRendered = {};

function renderIfChanged(key, slice, render) {
  const json = JSON.stringify(slice === undefined ? null : slice);
  if (lastRendered[key] === json) return;
  lastRendered[key] = json;
  render();
}

function renderPanels(data) {
  const sb = (data.score && data.score[SCOREBOARD_NUM]) || {};
  const team = (n) => sb.team && sb.team[n];
  const player1 = (n) => team(n) && team(n).player && team(n).player["1"];
  const side = (tree, n) => tree && tree[n];

  renderIfChanged("player-1", [player1("1"), side(sb.history_sets, "1"), side(sb.last_sets, "1")],
                  () => renderPlayerCard(1, data));
  renderIfChanged("player-2", [player1("2"), side(sb.history_sets, "2"), side(sb.last_sets, "2")],
                  () => renderPlayerCard(2, data));
  renderIfChanged("recent-sets",
                  [sb.recent_sets, player1("1") && player1("1").name, player1("2") && player1("2").name],
                  () => renderRecentSets(data));
  renderIfChanged("queue", data.streamQueue, () => renderQueue(data));
}


// ── Bootstrap ─────────────────────────────────────────────────────────────────

LoadEverything().then(() => {
  gsap.config({ nullTargetWarn: false });

  // Logos need no setup — side-panel.css paints them from the theme pack.

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

    // Render before rebuilding: buildSlots can restart the rotation, and the
    // panel it fades in should already hold the new content.
    renderPanels(data);
    rotator.buildSlots(data);

    const name = data.tournamentInfo && data.tournamentInfo.tournamentName;
    if (name) setTournamentName(name);
  };


  // ── Slippi Bridge ──────────────────────────────────────────────────────────

  // Socket plumbing lives in ../shared/slippi-bridge-client.js; no-ops when the
  // bridge isn't running.
  SlippiBridge.connectBridge({
    // A clip was banked mid-match. Only successful saves reach here — clip
    // errors go to the operator's control panel, not the broadcast.
    slippi_clip_saved: (clip) => showClipToast(clip),
  }, { tag: "sidePanel" });


  // ── Clip-saved toast ───────────────────────────────────────────────────────

  /**
   * Slide a "Clip Saved" pill in over the bottom card's bottom edge, hold, and
   * slide it back out.
   *
   * Queued rather than concurrent: back-to-back clips would otherwise restart
   * the tween on a visible pill, which reads as a flicker on stream. A queued
   * clip waits for the current one to leave.
   */
  const clipToast = {
    el:      null,
    tl:      null,
    pending: null,
    busy:    false,
  };

  function showClipToast(clip) {
    if (!clipToast.el) clipToast.el = document.querySelector(".clip-toast");
    if (!clipToast.el) return;

    if (clipToast.busy) {
      // Keep only the newest — a backlog of stale pills is worse than a gap.
      clipToast.pending = clip;
      return;
    }
    clipToast.busy = true;

    const detailEl = clipToast.el.querySelector(".clip-toast-detail");
    detailEl.textContent = clipToastDetail(clip);
    fitText(detailEl, 14);

    // Kill any timeline still finishing so its onComplete can't fight this one
    // (same discipline as Rotator._transitionTo).
    if (clipToast.tl) clipToast.tl.kill();

    clipToast.tl = gsap.timeline({
      onComplete: () => {
        clipToast.busy = false;
        const next = clipToast.pending;
        clipToast.pending = null;
        if (next) showClipToast(next);
      },
    });

    clipToast.tl
      .set(clipToast.el, { y: "160%", opacity: 0 })
      .to(clipToast.el, { y: "0%", opacity: 1, duration: 0.45, ease: "back.out(1.4)" })
      .to(clipToast.el, { y: "160%", opacity: 0, duration: 0.4, ease: "power2.in" }, "+=3.2");
  }

  /** "jiggles · 5 moves, 41%" — empty when the bridge sent no detail. */
  function clipToastDetail(clip) {
    const bits = [];
    if (clip?.playerName) bits.push(clip.playerName);
    if (clip?.moveCount)  bits.push(`${clip.moveCount} moves, ${Math.round(clip.damage ?? 0)}%`);
    return bits.join(" · ");
  }

}); // end LoadEverything().then()
