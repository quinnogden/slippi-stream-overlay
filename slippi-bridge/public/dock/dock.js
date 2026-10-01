/**
 * The dock — the operator's console, at /dock.
 *
 * Two feeds, both on the app's /dock namespace (overlay-client.js):
 *
 *   state   the same state the overlays draw: the scoreboard (the live strip),
 *           the tournament, the bracket view. Arrives as patches, so a score
 *           or a swap shows here the moment it lands on stream.
 *   status  control-status.js: health, the report/start buttons, the port map,
 *           the clipper. Sent when it changes, and every 5s regardless.
 *
 * Every write is a POST to /api/*; the answer that matters is the state patch
 * that follows, so nothing here updates the strip optimistically.
 *
 * Three rules this file keeps, each the fix for a way the old control panel
 * failed on stream:
 *
 *   - A render never throws out. Each one is guarded, and the mirror guards
 *     its selectors, so one bad field can't freeze the whole dock while it
 *     still looks fine.
 *   - Nothing the operator is typing is overwritten by a push. A field that
 *     has focus, or has unsent edits, is left alone until it's committed.
 *   - No innerHTML. Names come from start.gg and from whoever typed them.
 */
(function () {
  "use strict";

  const { h, icon } = window.Overlay;
  const $ = (id) => document.getElementById(id);

  const TABS = ["set", "bracket", "clips"];
  const TAB_KEY = "dock.tab";
  const HOLD_MS = 450;        // a long-press on a character opens its costumes
  const SETS_POLL_MS = 90000; // the app re-reads start.gg every 90s; this only picks that up
  const STALE_MS = 12000;     // no status for this long = the app has stopped talking

  // ── Plumbing ────────────────────────────────────────────────────────────────

  /** Wrap a renderer so an exception is logged, not thrown into the socket. */
  function guard(name, fn) {
    return function guarded(...args) {
      try {
        return fn.apply(this, args);
      } catch (err) {
        console.error(`[dock] ${name} failed`, err);
        return undefined;
      }
    };
  }

  /**
   * One request to the app. Never rejects: a failure comes back as
   * { ok: false, error }, which is what every caller shows.
   * @param {string} path
   * @param {object} [body] — given = POST
   */
  async function api(path, body) {
    try {
      const res = await fetch(path, body === undefined ? undefined : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function toast(msg, ok) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast " + (ok ? "ok" : "err");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = "toast"; }, ok ? 3000 : 6000);
  }

  /**
   * POST and toast the outcome — the shape every key here shares.
   * @param {string|((r: object) => string)} okMsg
   */
  async function act(path, body, okMsg, failLabel) {
    const r = await api(path, body);
    if (r.ok) toast(typeof okMsg === "function" ? okMsg(r) : okMsg, true);
    else toast(`${failLabel}: ${r.error || "no answer from the app"}`, false);
    return r;
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (_) { /* private mode: the choice lasts this session */ }
    return null;
  }

  /**
   * An inline "are you sure", rendered into `slot`.
   * @param {{ html: Node[], yes: string, onYes: Function, onNo?: Function }} o — html is nodes, not a string
   */
  function confirmIn(slot, o) {
    const box = h("div", "confirm");
    const msg = h("div", "confirm-msg");
    msg.append(...o.html);
    const row = h("div", "key-row");
    const yes = h("button", "key arm", o.yes);
    yes.type = "button";
    const no = h("button", "key", "Cancel");
    no.type = "button";
    yes.addEventListener("click", () => { slot.replaceChildren(); o.onYes(); });
    no.addEventListener("click", () => { slot.replaceChildren(); if (o.onNo) o.onNo(); });
    row.append(yes, no);
    box.append(msg, row);
    slot.replaceChildren(box);
  }

  /** Text, with <b> around the parts in `bold` — for confirm messages. */
  function rich(...parts) {
    return parts.map((p) => (typeof p === "string" ? document.createTextNode(p) : h("b", "", p.b)));
  }

  const playerName = (p) => [p.prefix, p.tag].filter(Boolean).join(" ");
  const sideName = (side) => side.teamName || side.players.map(playerName).filter(Boolean).join(" / ");

  // ── Live state ──────────────────────────────────────────────────────────────

  let sb = null;           // state.scoreboard
  let status = null;       // the last control status
  let statusAt = 0;
  let gameLive = false;
  let characters = [];     // /api/characters, Melee's select-screen order

  // ── The live strip ──────────────────────────────────────────────────────────

  /** Per side: the nodes the strip updates in place. Rebuilt only when the player count changes. */
  const sides = [null, null];

  /**
   * A text field bound to the scoreboard. Commits on change (Enter or leaving
   * the field); Escape puts the saved value back.
   * @param {(value: string) => Promise<object>} commit
   */
  function bindField(input, commit) {
    input.addEventListener("input", () => { input.dataset.dirty = "1"; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        delete input.dataset.dirty;
        input.value = input.dataset.saved || "";
        input.blur();
      }
    });
    input.addEventListener("change", async () => {
      if (!input.dataset.dirty) return;
      const r = await commit(input.value.trim());
      delete input.dataset.dirty;
      if (!r.ok) {
        toast(`Couldn't save that: ${r.error}`, false);
        input.value = input.dataset.saved || "";
      }
    });
    // Left without a change: show whatever the app has now.
    input.addEventListener("blur", () => {
      if (!input.dataset.dirty) input.value = input.dataset.saved || "";
    });
  }

  /** Show `value` unless the operator is busy with the field. */
  function setField(input, value) {
    input.dataset.saved = value;
    if (input.dataset.dirty || document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  function buildSide(i, count) {
    const root = $("side-" + i);
    const lChip = h("button", "l-chip", "L");
    lChip.type = "button";
    lChip.title = "[L] on stream — the side that came from losers. Set automatically in grand finals";
    lChip.addEventListener("click", () => toggleLosers(i));

    const who = h("div", "who");
    const players = [];
    for (let n = 0; n < count; n++) {
      const row = h("div", "player");
      const charWrap = h("div", "char-wrap");
      const charBtn = h("button", "char empty");
      charBtn.type = "button";
      charBtn.title = "Character";
      const img = h("img");
      img.alt = "";
      charBtn.append(img);
      charBtn.addEventListener("click", () => openPicker(i, n));
      const port = h("span", "port");
      const prefix = h("input", "prefix");
      prefix.type = "text";
      prefix.placeholder = "Team";
      prefix.spellcheck = false;
      const tag = h("input", "tag");
      tag.type = "text";
      tag.placeholder = count > 1 ? `Player ${n + 1}` : "Player";
      tag.spellcheck = false;
      bindField(prefix, (v) => api("/api/player", { side: i, index: n, prefix: v }));
      bindField(tag, (v) => api("/api/player", { side: i, index: n, tag: v }));
      const names = h("div", "names");
      names.append(prefix, tag);
      charWrap.append(charBtn, port);
      row.append(charWrap, names);
      who.append(row);
      players.push({ charBtn, img, port, prefix, tag });
    }
    const sub = h("div", "side-sub");
    who.append(sub);

    const box = h("div", "score-box");
    const dec = h("button", "key", "−");
    dec.type = "button";
    dec.title = "Take a game away";
    const score = h("output", "score", "0");
    const inc = h("button", "key", "+");
    inc.type = "button";
    inc.title = "Give this side a game";
    dec.addEventListener("click", () => bump(i, -1));
    inc.addEventListener("click", () => bump(i, 1));
    box.append(dec, score, inc);

    root.replaceChildren(lChip, who, box);
    sides[i] = { count, lChip, players, sub, score, dec };
  }

  const renderStrip = guard("strip", () => {
    if (!sb) return;
    const edited = sb.overrides || {};

    setField($("round"), sb.round || "");
    $("round").classList.toggle("edited", !!edited.round);

    const bo = $("best-of");
    bo.querySelector("option").textContent = edited.bestOf ? "Auto" : `Auto · ${sb.bestOfLabel}`;
    if (document.activeElement !== bo) bo.value = edited.bestOf || "";
    bo.classList.toggle("edited", !!edited.bestOf);

    const anyEdit = !!(edited.round || edited.bestOf || (edited.losers || []).some((l) => l != null));
    $("btn-text-auto").classList.toggle("show", anyEdit);

    const ref = [];
    if (!sb.setId) ref.push("Manual set");
    else if (sb.isPreview) ref.push("Preview set");
    else ref.push(`Set ${sb.identifier || sb.setId}`);
    if (sb.isReset) ref.push("Reset");
    else if (sb.isGrandFinal) ref.push("Grand final");
    if (sb.isDoubles) ref.push("Doubles");
    $("set-ref").textContent = ref.join(" · ");

    sb.sides.forEach((side, i) => {
      if (!sides[i] || sides[i].count !== side.players.length) buildSide(i, side.players.length);
      const s = sides[i];
      s.lChip.classList.toggle("on", !!side.losers);
      s.lChip.classList.toggle("pinned", (edited.losers || [])[i] != null);
      side.players.forEach((p, n) => {
        const ui = s.players[n];
        setField(ui.prefix, p.prefix || "");
        setField(ui.tag, p.tag || "");
        const url = icon(p.character);
        ui.charBtn.classList.toggle("empty", !url);
        if (url && ui.img.getAttribute("src") !== url) ui.img.src = url;
        ui.charBtn.title = p.character ? `${p.character.name} — change` : "Pick a character";
      });
      const sub = [];
      if (side.seed != null) sub.push(`Seed ${side.seed}`);
      if (side.teamName) sub.push(side.teamName);
      s.sub.textContent = sub.join(" · ");
      s.score.textContent = String(side.score);
      s.dec.disabled = side.score <= 0;
    });

    renderPorts();
    renderActions();
    renderSetsMarks();
  });

  function bump(side, delta) {
    api("/api/score", { side, delta }).then((r) => {
      if (!r.ok) toast(`Score change failed: ${r.error}`, false);
    });
  }

  function toggleLosers(i) {
    if (!sb) return;
    // Both sides are sent: an omitted entry would arrive as null and clear
    // the other side's override.
    const next = [...((sb.overrides && sb.overrides.losers) || [null, null])];
    next[i] = !sb.sides[i].losers;
    api("/api/set-text", { losers: next }).then((r) => {
      if (!r.ok) toast(`[L] change failed: ${r.error}`, false);
    });
  }

  bindField($("round"), (v) => api("/api/set-text", { round: v || null }));

  $("best-of").addEventListener("change", () => {
    const v = $("best-of").value;
    api("/api/set-text", { bestOf: v || null }).then((r) => {
      if (!r.ok) toast(`Best-of change failed: ${r.error}`, false);
    });
  });

  $("btn-text-auto").addEventListener("click", () =>
    act("/api/set-text", { round: null, bestOf: null, losers: [null, null] }, "Set text back to automatic", "Couldn't reset it"));

  // ── Ports (strip chips + the Set tab's card) ────────────────────────────────

  const renderPorts = guard("ports", () => {
    const pm = (status && status.portMapping) || { method: null, ports: [] };
    const mapped = !!(pm.ports && pm.ports.length);
    const guess = mapped && pm.method === "positional";

    sides.forEach((s, i) => {
      if (!s) return;
      s.players.forEach((ui, n) => {
        const p = (pm.ports || []).find((x) => x.side === i && x.slot === n);
        ui.port.textContent = p ? `P${p.port + 1}` : "";
        ui.port.className = "port" + (p ? (guess ? " guess" : " set") : "");
        ui.port.title = p ? (guess ? "Port guessed from position — check it" : `Port ${p.port + 1} (${pm.method})`) : "";
      });
    });

    const badge = $("method-badge");
    // The app reports "positional" before any game: there is no guess yet.
    badge.textContent = mapped ? pm.method || "—" : "—";
    badge.className = "badge" + (mapped && pm.method ? " " + pm.method : "");

    const list = $("ports-list");
    if (!pm.ports || !pm.ports.length) {
      list.replaceChildren(h("div", "empty-note", "No game yet — the ports are matched when one starts."));
      return;
    }
    list.replaceChildren(...pm.ports.map((p) => {
      const line = h("div", "port-line");
      const side = h("span", "p-side " + (p.side === 0 ? "l" : "r"), `${p.side === 0 ? "Left" : "Right"}${p.name ? " · " + p.name : ""}`);
      line.append(h("span", "p-port", `Port ${p.port + 1}`), side);
      return line;
    }));
  });

  // ── Strip actions: sides, ports, detect, start, report ──────────────────────

  let startBusy = false;

  const renderActions = guard("actions", () => {
    const cs = (status && status.currentSet) || {};
    const start = $("btn-start");
    if (!startBusy) {
      start.classList.toggle("gone", !cs.canStart);
      start.disabled = !cs.canStart;
    }
    start.parentElement.classList.toggle("no-start", !cs.canStart && !startBusy);
    $("btn-report").disabled = !cs.canReport;
    $("strip-hint").textContent = cs.canReport ? "" : (sb && sb.setId ? cs.reason || "" : "");
  });

  $("btn-sides").addEventListener("click", () => act("/api/swap-sides", {}, "Sides switched", "Switch sides failed"));
  $("btn-ports").addEventListener("click", () => act("/api/swap", {}, "Ports swapped", "Swap failed"));
  $("btn-redetect").addEventListener("click", () => act("/api/reresolve", {},
    (r) => `Detected (${r.method}): ${r.summary}` + (r.method === "positional" ? " — no character match, check it" : ""),
    "Detect failed"));

  // No confirm: it only moves the set from waiting to in progress, which is
  // what putting it on the scoreboard means anyway, and start.gg refuses it
  // for any other state.
  $("btn-start").addEventListener("click", async () => {
    startBusy = true;
    $("btn-start").disabled = true;
    const r = await act("/api/start-set", {}, "Set started on start.gg", "Couldn't start the set");
    startBusy = false;
    if (r.ok) fetchSets();
  });

  // Two steps, because this publishes to the live bracket.
  $("btn-report").addEventListener("click", () => {
    const cs = status && status.currentSet;
    if (!cs || !cs.canReport || !sb) return;
    const [a, b] = sb.sides.map((s) => s.score);
    const w = sb.sides[a > b ? 0 : 1];
    confirmIn($("report-confirm"), {
      html: rich("Report ", { b: sideName(w) || "the winner" }, " wins ", { b: `${Math.max(a, b)}–${Math.min(a, b)}` }, " to start.gg?"),
      yes: "Report it",
      onYes: async () => {
        // The reported set leaves the open list, so the next is one tap away.
        const r = await act("/api/report", {}, (x) => `Reported: ${x.winnerName} ${x.score}`, "Report failed");
        if (r.ok) fetchSets();
      },
    });
  });

  // ── Header ──────────────────────────────────────────────────────────────────

  const renderLamp = guard("lamp", () => {
    $("lamp").classList.toggle("on", gameLive);
  });

  const renderHealth = guard("health", () => {
    const s = status || {};
    const gg = $("led-startgg");
    const ggState = s.startgg && s.startgg.state;
    gg.className = "led " + (s.startgg && s.startgg.ok ? "up" : ggState === "error" ? "down" : "warn");
    gg.title = (s.startgg && s.startgg.error) || (ggState === "none" ? "No event loaded yet" : "");
    const sl = $("led-slippi");
    sl.className = "led " + (s.slippi ? "up" : "down");
    sl.title = (s.slippiDetail && s.slippiDetail.detail) || "";
    const clip = s.clipper || {};
    const obs = $("led-obs");
    obs.className = "led " + (!(clip.settings && clip.settings.enabled) ? "off" : clip.obs && clip.obs.connected ? "up" : "down");
    obs.title = (clip.obs && clip.obs.lastError) || "";
  });

  function renderTournament(t) {
    const name = [t && t.name, t && t.eventName].filter(Boolean).join(" — ");
    $("event-name").textContent = name || "No event loaded";
    if (!bracketBusy && !bracketMsg) {
      $("bracket-hint").textContent = name ? `Loaded: ${name}` : "No event loaded — press Singles or Doubles.";
    }
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  function showTab(name) {
    if (!TABS.includes(name)) name = "set";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
    TABS.forEach((t) => $("panel-" + t).classList.toggle("on", t === name));
    store(TAB_KEY, name);
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  showTab(store(TAB_KEY));

  // ── Set tab: the picker ─────────────────────────────────────────────────────

  let sets = [];
  let setsError = null;
  let showFinished = false;
  let setsReq = 0;

  /** @param {boolean} [fromStartgg] — re-read start.gg first (the ↻ key) */
  async function fetchSets(fromStartgg) {
    const req = ++setsReq;
    if (!sets.length && !setsError) $("sets-list").replaceChildren(h("div", "empty-note", "Loading…"));
    const q = [showFinished ? "finished=1" : "", fromStartgg ? "refresh=1" : ""].filter(Boolean).join("&");
    const r = await api("/api/sets" + (q ? "?" + q : ""));
    if (req !== setsReq) return; // a newer fetch is on its way
    setsError = r.ok ? null : (r.error || "unknown error");
    if (r.ok) sets = r.data || [];
    $("sets-stamp").textContent = r.ok
      ? `${sets.length} ${showFinished ? "sets" : "open"} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";
    renderSets();
  }

  let pendingLoad = null; // the set waiting on the "replace the set in progress?" confirm
  let drawnLiveId;        // the on-air set the list was last drawn with

  const renderSets = guard("sets", () => {
    const list = $("sets-list");
    const filter = $("set-filter");
    filter.classList.toggle("gone", sets.length <= 8);
    drawnLiveId = sb ? sb.setId : null;

    if (setsError) return list.replaceChildren(h("div", "empty-note", `Couldn't load sets: ${setsError}`));
    if (!sets.length) {
      return list.replaceChildren(h("div", "empty-note", showFinished
        ? "No sets in this event yet."
        : "No open sets — the bracket may be finished. Try Show finished."));
    }
    const f = filter.value.trim().toLowerCase();
    const rows = f ? sets.filter((s) => [s.names[0], s.names[1], s.roundName, s.phase]
      .some((v) => String(v || "").toLowerCase().includes(f))) : sets;
    if (!rows.length) return list.replaceChildren(h("div", "empty-note", "Nothing matches that filter."));

    const out = [];
    for (const set of rows) {
      const onAir = drawnLiveId != null && String(set.setId) === String(drawnLiveId);
      const row = h("button", `set-row ${set.status}` + (onAir ? " air" : ""));
      row.type = "button";

      const meta = h("div", "set-meta");
      meta.append(h("span", "round-name", set.roundName || `Set ${set.identifier}`));
      if (set.phase) meta.append(h("span", "phase", set.phase));
      if (onAir) meta.append(h("span", "chip air", "On air"));
      else if (set.status === "playable") meta.append(h("span", "chip ready", "Ready"));
      else if (set.status === "live") meta.append(h("span", "chip", "In progress"));
      else if (set.status === "waiting") meta.append(h("span", "chip", "Waiting"));
      else if (set.status === "done") meta.append(h("span", "chip", "Done"));

      const players = h("div", "set-players");
      const side = (n) => {
        const p = h("span", `p p${n + 1}`, set.names[n] || "TBD");
        if (set.seeds[n] != null) p.append(" ", h("span", "seed", `(${set.seeds[n]})`));
        return p;
      };
      const t1 = Math.max(0, Number(set.scores && set.scores[0]) || 0);
      const t2 = Math.max(0, Number(set.scores && set.scores[1]) || 0);
      players.append(side(0), h("span", "sc", t1 || t2 ? `${t1}–${t2}` : "vs"), side(1));

      row.append(meta, players);
      if (onAir) row.disabled = true;
      else row.addEventListener("click", () => requestLoad(set));
      out.push(row);

      if (pendingLoad && pendingLoad.setId === set.setId) {
        const slot = h("div");
        confirmIn(slot, {
          html: rich("The set on the scoreboard is at ", { b: sb.sides.map((s) => s.score).join("–") }, ". Loading this replaces it."),
          yes: "Load anyway",
          onYes: () => loadSet(set),
          onNo: () => { pendingLoad = null; },
        });
        out.push(slot);
      }
    }
    list.replaceChildren(...out);
  });

  /** The list's ON AIR row follows the scoreboard without a refetch. */
  function renderSetsMarks() {
    if ((sb ? sb.setId : null) !== drawnLiveId) renderSets();
  }

  /** One tap loads, except over a set that already has games on it. */
  function requestLoad(set) {
    const scored = sb && sb.sides.some((s) => s.score > 0);
    if (scored) {
      pendingLoad = set;
      renderSets();
      return;
    }
    loadSet(set);
  }

  async function loadSet(set) {
    pendingLoad = null;
    const r = await act("/api/load-set", { setId: set.setId },
      (x) => `Loaded ${set.roundName || "set"}` + (x.warning ? ` — ${x.warning}` : ""), "Load failed");
    if (r.ok) fetchSets();
  }

  $("btn-refresh-sets").addEventListener("click", () => fetchSets(true));
  $("set-filter").addEventListener("input", () => renderSets());
  $("btn-toggle-finished").addEventListener("click", () => {
    showFinished = !showFinished;
    $("btn-toggle-finished").textContent = showFinished ? "Hide finished" : "Show finished";
    fetchSets();
  });

  $("btn-clear-set").addEventListener("click", () => {
    const busy = sb && (sb.setId || sb.sides.some((s) => s.score > 0 || s.players.some((p) => p.tag)));
    const clear = () => act("/api/clear-set", {}, "Scoreboard cleared", "Couldn't clear it");
    if (!busy) return clear();
    confirmIn($("clear-confirm"), {
      html: rich("Clear ", { b: sb.sides.map(sideName).map((n) => n || "?").join(" vs ") }, " off the scoreboard? Nothing is reported."),
      yes: "Clear it",
      onYes: clear,
    });
  });

  // ── Bracket tab ─────────────────────────────────────────────────────────────

  // No confirm on the event switch: it keeps the set on the scoreboard, its
  // score and its set id, so a misclick costs one re-read of start.gg.
  let bracketBusy = false;
  let bracketMsg = null;
  const BRACKET_KEYS = ["btn-bracket-singles", "btn-bracket-doubles"];

  async function switchBracket(kind) {
    bracketMsg = null;
    bracketBusy = true;
    BRACKET_KEYS.forEach((id) => { $(id).disabled = true; });
    $("bracket-hint").textContent = "Finding this week's tournament on start.gg…";
    const r = await api("/api/bracket", { kind });
    bracketBusy = false;
    BRACKET_KEYS.forEach((id) => { $(id).disabled = false; });
    if (!r.ok) {
      bracketMsg = r.error; // stays up: it's usually a config fix
      $("bracket-hint").textContent = r.error;
      return toast(`Bracket switch failed: ${r.error}`, false);
    }
    if (r.warning) {
      bracketMsg = r.warning;
      $("bracket-hint").textContent = r.warning;
    }
    const what = (r.tournamentName ? r.tournamentName + " — " : "") + (r.eventName || kind);
    toast(r.refreshed ? `${what} was already loaded — re-read it` : `Loaded ${what}`, true);
    fetchSets();
  }
  BRACKET_KEYS.forEach((id) => $(id).addEventListener("click", () => switchBracket($(id).dataset.kind)));

  let view = null;
  let bracket = null;
  const VIEW_NAMES = { winners: "Winners", losers: "Losers", top8: "Top 8", top16: "Top 16", full: "Full" };

  const renderBracketTab = guard("bracket", () => {
    document.querySelectorAll("#bracket-views .key").forEach((b) =>
      b.classList.toggle("lit", !!view && b.dataset.view === view.bracketView));

    const sel = $("bracket-group");
    const groups = (bracket && bracket.groups) || [];
    const want = ["", ...groups.map((g) => g.id)].join("|");
    if (sel.dataset.ids !== want) {
      const follow = h("option", "", "Follow the set on air");
      follow.value = "";
      sel.replaceChildren(follow, ...groups.map((g) => {
        const o = h("option", "", g.label || g.id);
        o.value = g.id;
        return o;
      }));
      sel.dataset.ids = want;
    }
    if (document.activeElement !== sel) sel.value = (view && view.bracketPhaseGroupId) || "";
    sel.disabled = !groups.length;

    $("bracket-view-hint").textContent = bracket
      ? `On stream: ${VIEW_NAMES[view && view.bracketView] || "?"} · ${bracket.label || "bracket"}` + (bracket.preview ? " (preview)" : "")
      : "No bracket yet — load an event.";
  });

  document.querySelectorAll("#bracket-views .key").forEach((b) => b.addEventListener("click", () =>
    api("/api/bracket-view", { view: b.dataset.view }).then((r) => {
      if (!r.ok) toast(`View switch failed: ${r.error}`, false);
    })));

  $("bracket-group").addEventListener("change", () =>
    api("/api/bracket-view", { phaseGroupId: $("bracket-group").value || null }).then((r) => {
      if (!r.ok) toast(`Group switch failed: ${r.error}`, false);
    }));

  // ── Clips tab ───────────────────────────────────────────────────────────────

  // The form is built from this list, so its ids can't drift from the code
  // that reads them. Keys match clipper-settings.js, which validates and
  // clamps every value; min/max here only shape the spinners.
  const CLIP_FIELDS = [
    { key: "minMoves",            label: "Min moves",                 type: "number", min: 1, max: 50 },
    { key: "minDamage",           label: "Min damage %",              type: "number", min: 0, max: 999 },
    { key: "comboWindowSec",      label: "Within last (s, 0 = off)",  type: "number", min: 0, max: 120 },
    { key: "cooldownSec",         label: "Cooldown (s)",              type: "number", min: 0, max: 600 },
    { key: "saveDelayMs",         label: "Save delay (ms)",           type: "number", min: 0, max: 60000, step: 100 },
    { key: "maxComboDurationSec", label: "Max combo (s, 0 = off)",    type: "number", min: 0, max: 480 },
    { key: "maxClipsPerGame",     label: "Max clips a game (0 = ∞)",  type: "number", min: 0, max: 100 },
    { key: "requireKill",         label: "Only combos that kill",     type: "check" },
    { key: "autoStartBuffer",     label: "Start OBS's buffer",        type: "check" },
    { key: "notifySidePanel",     label: "Toast on the side panel",   type: "check", full: true },
    { key: "obsUrl",              label: "OBS WebSocket URL",         type: "text", full: true, placeholder: "ws://127.0.0.1:4455" },
    { key: "obsPassword",         label: "OBS WebSocket password",    type: "password", full: true, placeholder: "(blank if auth is off)" },
    { key: "clipFolder",          label: "Replay folder (for the OBS playlist script)", type: "text", full: true, placeholder: "C:\\Users\\…\\Videos" },
  ];
  const clipInput = {};
  let clipDirty = false;

  (function buildClipFields() {
    $("clip-fields").replaceChildren(...CLIP_FIELDS.map((f) => {
      const label = h("label", "field" + (f.type === "check" ? " check" : "") + (f.full ? " full" : ""));
      const input = h("input");
      input.type = f.type === "check" ? "checkbox" : f.type;
      input.id = "clip-" + f.key;
      if (f.type === "number") {
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = String(f.step || 1);
      }
      if (f.placeholder) input.placeholder = f.placeholder;
      input.addEventListener(f.type === "check" ? "change" : "input", () => { clipDirty = true; });
      clipInput[f.key] = input;
      if (f.type === "check") label.append(input, h("span", "", f.label));
      else label.append(h("span", "", f.label), input);
      return label;
    }));
  })();

  function clipperStatusText(c) {
    // Conversions only exist in 2-player games (slippi-js), so say so rather
    // than leave the operator waiting for clips that can't come.
    if (!c.settings || !c.settings.enabled) return "Off. Turn it on to save an OBS clip when a combo lands. Singles only — doubles has no combo data.";
    if (!c.obs || !c.obs.connected) return (c.obs && c.obs.lastError) || "Connecting to OBS…";
    if (c.obs.bufferActive === false) return "OBS connected, but its replay buffer isn't running.";
    return "OBS connected, replay buffer running." + (c.clipsThisGame ? ` ${c.clipsThisGame} clip(s) this game.` : "");
  }

  const renderClipper = guard("clipper", (c) => {
    if (!c) return;
    const s = c.settings || {};
    if (!clipDirty) {
      $("clip-enabled").checked = !!s.enabled;
      for (const f of CLIP_FIELDS) {
        const input = clipInput[f.key];
        if (f.type === "check") input.checked = !!s[f.key];
        else input.value = s[f.key] == null ? "" : String(s[f.key]);
      }
    }
    $("clip-status").textContent = clipperStatusText(c);

    const clips = c.recentClips || [];
    if (!clips.length) {
      $("clip-list").replaceChildren(h("div", "empty-note", "No clips yet tonight."));
      return;
    }
    $("clip-list").replaceChildren(...clips.slice(0, 8).map((clip) => {
      const when = new Date(clip.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const what = clip.ok
        ? (clip.playerName || "Clip") + (clip.moveCount ? ` · ${clip.moveCount} moves, ${clip.damage}%` : "") + (clip.file ? ` · ${clip.file}` : "")
        : (clip.error || "Save failed");
      const row = h("div", "clip-row" + (clip.ok ? "" : " failed"));
      row.append(h("span", "what", what), h("span", "when", when));
      return row;
    }));
  });

  function collectClipper() {
    const out = { enabled: $("clip-enabled").checked };
    for (const f of CLIP_FIELDS) {
      const input = clipInput[f.key];
      out[f.key] = f.type === "check" ? input.checked : f.type === "number" ? Number(input.value) : input.value;
    }
    return out;
  }

  // The master switch applies at once — it's the one control reached for
  // mid-set, and a Save step would leave it looking on while it's off.
  $("clip-enabled").addEventListener("change", () => {
    const enabled = $("clip-enabled").checked;
    act("/api/clipper/toggle", { enabled }, enabled ? "Combo clipper on" : "Combo clipper off", "Couldn't change it");
  });

  $("btn-clip-save").addEventListener("click", async () => {
    const r = await api("/api/clipper/settings", collectClipper());
    clipDirty = false;
    // ok:false can mean only the disk write failed — the settings are live
    // either way, so the message has to say which.
    toast(r.ok ? "Clipper settings saved" : (r.error || "Save failed"), r.ok);
    if (r.settings) renderClipper({ ...((status && status.clipper) || {}), settings: r.settings });
  });

  $("btn-clip-test").addEventListener("click", async () => {
    $("clip-hint").textContent = "Asking OBS to save the buffer…";
    const r = await api("/api/clipper/test", {});
    $("clip-hint").textContent = r.ok
      ? "Saved" + (r.clip && r.clip.file ? `: ${r.clip.file}` : " (OBS reported no path)")
      : (r.error || "Test failed");
    toast(r.ok ? "Test clip saved" : `Test clip failed: ${r.error}`, r.ok);
  });

  // ── The character picker ────────────────────────────────────────────────────

  /** Who the picker is choosing for, and which character's costumes it shows. */
  let picking = null; // { side, index, costumesFor: codename|null }

  function pickingPlayer() {
    return picking && sb ? sb.sides[picking.side].players[picking.index] : null;
  }

  /**
   * Tap = onTap; hold (or right-click) = onHold. A hold doesn't also tap.
   */
  function bindPress(el, onTap, onHold) {
    let timer = null;
    let held = false;
    const cancel = () => { clearTimeout(timer); el.classList.remove("holding"); };
    el.addEventListener("pointerdown", () => {
      held = false;
      cancel();
      el.classList.add("holding");
      timer = setTimeout(() => { held = true; el.classList.remove("holding"); onHold(); }, HOLD_MS);
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("click", () => {
      if (held) { held = false; return; }
      onTap();
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancel();
      held = false;
      onHold();
    });
  }

  function tile(character, skin, title) {
    const b = h("button", "tile");
    b.type = "button";
    b.title = title;
    const img = h("img");
    img.alt = "";
    img.src = icon({ codename: character.codename, skin });
    b.append(img);
    return b;
  }

  /** The 26 characters, built once /api/characters answers. */
  function buildGrid() {
    $("picker-grid").replaceChildren(...characters.map((c) => {
      const b = tile(c, 0, c.name);
      b.dataset.codename = c.codename;
      bindPress(b,
        () => {
          const cur = pickingPlayer() && pickingPlayer().character;
          pick(c.codename, cur && cur.codename === c.codename ? cur.skin : 0);
        },
        () => { picking.costumesFor = c.codename; renderPicker(); });
      return b;
    }));
  }

  const renderPicker = guard("picker", () => {
    if (!picking) return;
    const p = pickingPlayer();
    const cur = p && p.character;
    const where = `${picking.side === 0 ? "Left" : "Right"}${sb && sb.isDoubles ? ` · player ${picking.index + 1}` : ""}`;
    $("picker-who").textContent = `${(p && playerName(p)) || "Unnamed player"} — ${where}`;

    document.querySelectorAll("#picker-grid .tile").forEach((b) =>
      b.classList.toggle("current", !!cur && b.dataset.codename === cur.codename));

    // Costumes: of the character just held, else of the one shown now.
    const forCode = picking.costumesFor || (cur && cur.codename);
    const c = characters.find((x) => x.codename === forCode);
    if (!c || c.skins < 2) return $("picker-costumes").replaceChildren();
    const row = [];
    for (let skin = 0; skin < c.skins; skin++) {
      const b = tile(c, skin, `${c.name}, costume ${skin + 1}`);
      if (cur && cur.codename === c.codename && Number(cur.skin) === skin) b.classList.add("current");
      b.addEventListener("click", () => pick(c.codename, skin));
      row.push(b);
    }
    $("picker-costumes").replaceChildren(...row);
  });

  function openPicker(side, index, opts = {}) {
    if (!sb) return;
    picking = { side, index, costumesFor: opts.costumesFor || null };
    renderPicker();
    $("picker").classList.add("open");
  }

  function closePicker() {
    picking = null;
    $("picker").classList.remove("open");
  }

  /** Set the character (null = none) and close. */
  async function pick(codename, skin) {
    if (!picking) return;
    const { side, index } = picking;
    const r = await api("/api/character", { side, index, codename, skin });
    if (!r.ok) return toast(`Couldn't set the character: ${r.error}`, false);
    closePicker();
  }

  $("picker-close").addEventListener("click", closePicker);
  $("picker-none").addEventListener("click", () => pick(null));
  $("picker").addEventListener("click", (e) => { if (e.target === $("picker")) closePicker(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) closePicker(); });

  api("/api/characters").then((r) => {
    if (!r.ok) return toast(`Couldn't load the characters: ${r.error}`, false);
    characters = r.characters || [];
    buildGrid();
    renderPicker();
  });

  // ── Wiring ──────────────────────────────────────────────────────────────────

  const ov = window.Overlay.connect({ tag: "dock", namespace: "/dock" });

  ov.select("scoreboard", (now) => {
    sb = now;
    renderStrip();
    renderPicker();
  });

  let eventSlug;
  ov.select("tournament", (t) => {
    renderTournament(t || {});
    // A different event is a different set list.
    const slug = (t && t.eventSlug) || "";
    if (eventSlug !== undefined && slug !== eventSlug) fetchSets();
    eventSlug = slug;
  });

  ov.select("view", (v) => { view = v; renderBracketTab(); });
  ov.select("bracket", (b) => { bracket = b; renderBracketTab(); });

  ov.on("status", (s) => {
    status = s;
    statusAt = Date.now();
    document.body.classList.remove("stale");
    renderHealth();
    renderPorts();
    renderActions();
    renderClipper(s && s.clipper);
  });

  ov.on("game:start", () => { gameLive = true; renderLamp(); });
  ov.on("game:end", () => { gameLive = false; renderLamp(); });
  ov.on("clip:saved", (c) => toast(`Clip saved${c && c.playerName ? ` — ${c.playerName}` : ""}`, true));
  ov.on("clip:error", (c) => toast(`Clip failed: ${(c && c.error) || "OBS didn't save it"}`, false));

  if (ov.socket) {
    ov.socket.on("connect", () => document.body.classList.remove("offline"));
    ov.socket.on("disconnect", () => {
      document.body.classList.add("offline");
      // Whatever was live is unknown until the app is back; it re-sends the game.
      gameLive = false;
      renderLamp();
    });
  }

  // The status heartbeat is 5s; well past that, the app is up but not talking.
  setInterval(() => {
    if (statusAt && Date.now() - statusAt > STALE_MS) document.body.classList.add("stale");
  }, 3000);

  fetchSets();
  setInterval(() => { if (document.visibilityState === "visible") fetchSets(); }, SETS_POLL_MS);

  // For tests, and for poking at the console from the dock's devtools.
  window.Dock = {
    get scoreboard() { return sb; },
    get status() { return status; },
    get gameLive() { return gameLive; },
    get picking() { return picking; },
    get sets() { return sets; },
    openPicker, closePicker, pick, fetchSets, showTab, CLIP_FIELDS,
  };
})();
