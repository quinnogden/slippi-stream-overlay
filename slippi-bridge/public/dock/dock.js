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

  const TABS = ["set", "bracket", "casters", "players", "clips", "setup"];
  const TAB_KEY = "dock.tab";
  const FOLD_KEY = "dock.stripFolded";
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

  /** A hardware key, built rather than written as markup. */
  function key(label, cls) {
    const b = h("button", "key" + (cls ? " " + cls : ""), label);
    b.type = "button";
    return b;
  }

  // ── Autocomplete ────────────────────────────────────────────────────────────

  /**
   * A suggestion list under a text field, as TSH has on its manual fields. One
   * menu (#ac-menu) serves every field, placed under whichever has focus. A
   * list of our own rather than a <datalist>: OBS's dock browser draws those
   * badly, and a player suggestion carries their main's icon.
   *
   * ↑/↓ move, Enter or a tap picks, Escape closes. Enter with nothing
   * highlighted is left to the field — it commits what was typed — unless the
   * text is exactly a suggestion, which starts highlighted. A field's own
   * keydown handler must be added after this one and skip a defaultPrevented
   * key, so Enter on a suggestion doesn't also commit the typed text.
   *
   * @param {HTMLInputElement} input
   * @param {{
   *   source: (text: string) => (object[] | Promise<object[]>), // "" = the field just got focus
   *   label: (item: object) => string,
   *   render?: (item: object) => Node[],
   *   caption?: (items: object[]) => string,
   *   pick: (item: object) => void,
   * }} o
   */
  function autocomplete(input, o) {
    input.setAttribute("autocomplete", "off");
    input.addEventListener("focus", () => acOpen(input, o, ""));
    input.addEventListener("click", () => { if (ac.input !== input) acOpen(input, o, ""); });
    input.addEventListener("input", () => {
      clearTimeout(ac.timer);
      ac.timer = setTimeout(() => acOpen(input, o, input.value), 120);
    });
    input.addEventListener("blur", () => { if (ac.input === input) acClose(); });
    input.addEventListener("keydown", (e) => {
      const open = ac.input === input;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!open) return acOpen(input, o, input.value);
        acMove(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" && open && ac.active >= 0) {
        e.preventDefault();
        acPick(ac.active);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        acClose();
      } else if (e.key === "Tab" && open) {
        acClose();
      }
    });
  }

  const ac = { input: null, o: null, items: [], active: -1, req: 0, timer: null };

  async function acOpen(input, o, text) {
    clearTimeout(ac.timer);
    const req = ++ac.req;
    let items = [];
    try { items = (await o.source(text.trim())) || []; } catch (err) { console.error("[dock] suggestions failed", err); }
    if (req !== ac.req || document.activeElement !== input) return; // typed on, or left the field
    if (!items.length) return acHide(); // not acClose: a lookup for what's being typed may be queued
    const want = text.trim().toLowerCase();
    Object.assign(ac, { input, o, items, active: want ? items.findIndex((it) => o.label(it).toLowerCase() === want) : -1 });
    acRender();
  }

  /** Close the menu and drop any lookup still on its way. */
  function acClose() {
    ac.req++;
    clearTimeout(ac.timer);
    acHide();
  }

  function acHide() {
    Object.assign(ac, { input: null, o: null, items: [], active: -1 });
    $("ac-menu").classList.remove("open");
    $("ac-menu").replaceChildren();
  }

  function acMove(delta) {
    const n = ac.items.length;
    ac.active = ac.active < 0 ? (delta > 0 ? 0 : n - 1) : (ac.active + delta + n) % n;
    acRender();
  }

  function acPick(i) {
    const { items, o } = ac;
    acClose();
    if (o && items[i]) o.pick(items[i]);
  }

  const acRender = guard("autocomplete", () => {
    const menu = $("ac-menu");
    const rows = [];
    const cap = ac.o.caption ? ac.o.caption(ac.items) : "";
    if (cap) rows.push(h("div", "ac-cap", cap));
    ac.items.forEach((it, i) => {
      const row = h("button", "ac-item" + (i === ac.active ? " on" : ""));
      row.type = "button";
      row.tabIndex = -1;
      row.append(...(ac.o.render ? ac.o.render(it) : [h("span", "ac-label", ac.o.label(it))]));
      // mousedown, not click, keeps the focus in the field — a blur would close the menu first.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => acPick(i));
      rows.push(row);
    });
    menu.replaceChildren(...rows);
    menu.classList.add("open");
    acPlace();
    const on = menu.querySelector(".ac-item.on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
  });

  /** Under the field, or over it when the dock has no room below. */
  function acPlace() {
    if (!ac.input) return;
    const menu = $("ac-menu");
    const r = ac.input.getBoundingClientRect();
    const vh = window.innerHeight || 600;
    const vw = window.innerWidth || 400;
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 160 && above > below;
    const width = Math.min(Math.max(r.width, 260), vw - 16);
    menu.style.left = Math.max(8, Math.min(r.left, vw - width - 8)) + "px";
    menu.style.width = width + "px";
    menu.style.maxHeight = Math.max(120, Math.min(300, up ? above : below)) + "px";
    menu.style.top = up ? "auto" : r.bottom + 2 + "px";
    menu.style.bottom = up ? vh - r.top + 2 + "px" : "auto";
  }

  if (window.addEventListener) {
    window.addEventListener("resize", acPlace);
    window.addEventListener("scroll", (e) => { if (e.target !== $("ac-menu")) acPlace(); }, true);
  }

  /** `list` narrowed to `text`: entries starting with it first, then containing it. */
  function narrow(list, text, limit = 40) {
    const q = text.toLowerCase();
    if (!q) return list.slice(0, limit);
    const starts = list.filter((v) => v.toLowerCase().startsWith(q));
    const has = list.filter((v) => !v.toLowerCase().startsWith(q) && v.toLowerCase().includes(q));
    return [...starts, ...has].slice(0, limit);
  }

  // The player list's prefixes and pronouns. Re-read at most every 30s: a
  // save on the Players tab adds one rarely, and these are only suggestions.
  let fieldValues = null;
  async function knownValues() {
    if (fieldValues && Date.now() - fieldValues.at < 30000) return fieldValues;
    const r = await api("/api/players/values");
    if (r.ok) fieldValues = { at: Date.now(), prefixes: r.prefixes || [], pronouns: r.pronouns || [] };
    return fieldValues || { prefixes: [], pronouns: [] };
  }

  const COMMON_PRONOUNS = ["he/him", "she/her", "they/them", "he/they", "she/they", "any/all"];
  const textItem = { label: (v) => v };

  /** A field suggesting the player list's prefixes. */
  function prefixSuggest(input, pick) {
    autocomplete(input, {
      ...textItem,
      source: async (text) => narrow((await knownValues()).prefixes, text),
      pick,
    });
  }

  /** A field suggesting pronouns: the common ones, then any others in the player list. */
  function pronounSuggest(input, pick) {
    autocomplete(input, {
      ...textItem,
      source: async (text) => {
        const seen = new Set(COMMON_PRONOUNS);
        const more = (await knownValues()).pronouns.filter((v) => !seen.has(v.toLowerCase()));
        return narrow([...COMMON_PRONOUNS, ...more], text);
      },
      pick,
    });
  }

  /**
   * A suggestion row for a player: main, prefix, tag, pronoun. No seed or
   * team — at OBS-dock width they crowded the names out of the row.
   */
  function playerItem(p) {
    const out = [];
    const url = p.main ? icon(p.main) : null;
    if (url) {
      const img = h("img");
      img.alt = "";
      img.src = url;
      out.push(img);
    } else {
      out.push(h("span", "ac-noimg"));
    }
    const name = h("span", "ac-label");
    if (p.prefix) name.append(h("span", "ac-prefix", p.prefix));
    name.append(h("span", "ac-tag", p.tag || "?"));
    out.push(name);
    if (p.pronoun) out.push(h("span", "chip", p.pronoun));
    return out;
  }

  const playerName = (p) => [p.prefix, p.tag].filter(Boolean).join(" ");
  // As the overlay names a side: doubles players by tag alone.
  const sideName = (side) => side.teamName
    || side.players.map((p) => (side.players.length > 1 ? p.tag : playerName(p))).filter(Boolean).join(" / ");

  // ── Live state ──────────────────────────────────────────────────────────────

  let sb = null;           // state.scoreboard
  let status = null;       // the last control status
  let statusAt = 0;
  let gameLive = false;
  let characters = [];     // /api/characters, Melee's select-screen order

  // ── The live strip ──────────────────────────────────────────────────────────

  /** Per side: the nodes the strip updates in place. Rebuilt only when the player count or the mode changes. */
  const sides = [null, null];

  // Melee's team colours, as the app stores them (modes/doubles.js TEAM_COLORS).
  const TEAM_SWATCHES = [["red", "#D32F2F"], ["blue", "#1565C0"], ["green", "#2E7D32"]];
  const sameHex = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  /**
   * A text field bound to the scoreboard. Commits on change (Enter or leaving
   * the field); Escape puts the saved value back.
   * @param {(value: string) => Promise<object>} commit
   */
  function bindField(input, commit) {
    input.addEventListener("input", () => { input.dataset.dirty = "1"; });
    input.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return; // the autocomplete took it
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
    if (input.dataset.dirty || input.dataset.sending || document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  /**
   * A suggestion picked into a bound field: shown at once, the field left,
   * and `send` commits it — directly, since a value set from script raises no
   * change event. The field holds the pick until the app answers.
   * @param {() => Promise<object>} send
   */
  async function commitPick(input, value, send) {
    const before = input.dataset.saved || "";
    delete input.dataset.dirty;
    input.dataset.sending = "1";
    input.dataset.saved = value;
    input.value = value;
    input.blur();
    const r = await send();
    delete input.dataset.sending;
    if (!r.ok) {
      toast(`Couldn't save that: ${r.error}`, false);
      if (input.dataset.saved === value) input.dataset.saved = before;
    }
    if (document.activeElement !== input && !input.dataset.dirty) input.value = input.dataset.saved || "";
  }

  /**
   * Players for a name field: the loaded event's entrants, or the player list
   * (with no event, or `listOnly`). Clicked into empty, it's all of them —
   * by seed, or A–Z — so a name can be picked without typing.
   */
  async function playerSuggestions(text, listOnly) {
    const r = await api("/api/players/suggest?q=" + encodeURIComponent(text) + (listOnly ? "&scope=list" : ""));
    if (!r.ok) return [];
    const total = r.total || 0;
    return (r.players || []).map((p) => ({ ...p, scope: r.scope, total }));
  }

  function playerCaption(items) {
    const first = items[0] || {};
    const name = first.scope === "event" ? "Entered in this event" : "Player list";
    return first.total > items.length && items.length > 12 ? `${name} · ${items.length} of ${first.total} — type to search` : name;
  }

  /**
   * A name change on the strip. Changing a tag or prefix unlinks the
   * scoreboard from its start.gg set (the app says `detached`), so say so —
   * Report and the seed have just gone.
   */
  async function editPlayer(path, body) {
    const r = await api(path, body);
    if (r.ok && r.detached) toast("Name changed — unlinked from the start.gg set. Load it again from Up next to relink", true);
    return r;
  }

  /**
   * A strip tag field's suggestions. A pick puts the whole player in that
   * slot — tag, prefix, pronoun, start.gg id and main — as a set load would.
   */
  function tagSuggest(input, side, index) {
    autocomplete(input, {
      label: (p) => p.tag,
      source: (text) => playerSuggestions(text, false),
      caption: playerCaption,
      render: playerItem,
      pick: (p) => commitPick(input, p.tag, () => {
        if (p.scope === "event" && p.startggPlayerId) return editPlayer("/api/players/assign", { side, index, playerId: p.startggPlayerId });
        if (p.ref != null) return editPlayer("/api/players/assign", { side, index, ref: p.ref, tag: p.tag });
        return editPlayer("/api/player", { side, index, tag: p.tag, prefix: p.prefix || "" });
      }),
    });
  }

  /**
   * One side of the strip. Singles: a character per player. Doubles: the
   * team's colour instead, as TSH has — the overlay shows the colour, not four
   * characters. No prefix either: the overlay shows doubles players by tag
   * alone. The colour dots go on a line under the players, with the seed and
   * team name, so the tags get the column's whole width.
   */
  function buildSide(i, count, doubles) {
    const root = $("side-" + i);
    root.classList.toggle("doubles", doubles);
    const lChip = h("button", "l-chip", "L");
    lChip.type = "button";
    lChip.title = "[L] on stream — the side that came from losers. Set automatically in grand finals";
    lChip.addEventListener("click", () => toggleLosers(i));

    const who = h("div", "who");
    const players = [];
    // Singles: seed and team name ride on the prefix line rather than a line
    // of their own. Doubles has no prefix line, so they go on the colour line
    // under both players.
    const seedSub = h("span", "side-sub");
    const teamSub = h("span", "side-sub");
    for (let n = 0; n < count; n++) {
      const row = h("div", "player");
      const charWrap = h("div", "char-wrap");
      let charBtn = null;
      let img = null;
      if (!doubles) {
        charBtn = h("button", "char empty");
        charBtn.type = "button";
        charBtn.title = "Character";
        img = h("img");
        img.alt = "";
        charBtn.append(img);
        charBtn.addEventListener("click", () => openPicker(i, n));
        charWrap.append(charBtn);
      }
      const port = h("span", "port");
      const tag = h("input", "tag");
      tag.type = "text";
      tag.placeholder = count > 1 ? `Player ${n + 1}` : "Player";
      tag.spellcheck = false;
      // The suggestions first: their Enter must run before the field's own.
      tagSuggest(tag, i, n);
      bindField(tag, (v) => editPlayer("/api/player", { side: i, index: n, tag: v }));
      const names = h("div", "names");
      let prefix = null;
      if (!doubles) {
        prefix = h("input", "prefix");
        prefix.type = "text";
        prefix.placeholder = "Team";
        prefix.spellcheck = false;
        prefixSuggest(prefix, (v) => commitPick(prefix, v, () => editPlayer("/api/player", { side: i, index: n, prefix: v })));
        bindField(prefix, (v) => editPlayer("/api/player", { side: i, index: n, prefix: v }));
        const preRow = h("div", "pre-row");
        preRow.append(prefix, seedSub, teamSub);
        names.append(preRow);
      }
      names.append(tag);
      charWrap.append(port);
      row.append(charWrap, names);
      who.append(row);
      players.push({ charBtn, img, port, prefix, tag });
    }

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

    let swatches = null;
    if (doubles) {
      const group = h("div", "team-colors");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Team colour");
      swatches = TEAM_SWATCHES.map(([name, hex]) => {
        const b = h("button", "swatch " + name);
        b.type = "button";
        b.title = `${name[0].toUpperCase()}${name.slice(1)} team`;
        b.setAttribute("aria-label", b.title);
        b.addEventListener("click", () => setTeamColor(i, name, hex));
        group.append(b);
        return { hex, b };
      });
      const subRow = h("div", "sub-row");
      subRow.append(group, seedSub, teamSub);
      who.append(subRow);
    }
    root.replaceChildren(lChip, who, box);
    sides[i] = { count, doubles, lChip, players, seedSub, teamSub, score, dec, inc, swatches };
    applyKeyHints();
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
    $("set-ref").textContent = ref.join(" · ");

    const doubles = !!sb.isDoubles;
    const mode = $("btn-doubles");
    mode.classList.toggle("lit", doubles);
    mode.setAttribute("aria-pressed", String(doubles));

    sb.sides.forEach((side, i) => {
      const count = doubles ? side.players.length : 1;
      if (!sides[i] || sides[i].count !== count || sides[i].doubles !== doubles) buildSide(i, count, doubles);
      const s = sides[i];
      s.lChip.classList.toggle("on", !!side.losers);
      s.lChip.classList.toggle("pinned", (edited.losers || [])[i] != null);
      side.players.slice(0, count).forEach((p, n) => {
        const ui = s.players[n];
        if (ui.prefix) setField(ui.prefix, p.prefix || "");
        setField(ui.tag, p.tag || "");
        if (!ui.charBtn) return;
        const url = icon(p.character);
        ui.charBtn.classList.toggle("empty", !url);
        if (url && ui.img.getAttribute("src") !== url) ui.img.src = url;
        ui.charBtn.title = p.character ? `${p.character.name} — change` : "Pick a character";
      });
      (s.swatches || []).forEach((w) => {
        const on = sameHex(side.color, w.hex);
        w.b.classList.toggle("on", on);
        w.b.setAttribute("aria-pressed", String(on));
      });
      s.seedSub.textContent = side.seed != null ? `Seed ${side.seed}` : "";
      s.teamSub.textContent = side.teamName || "";
      s.teamSub.title = side.teamName ? `Team name on stream: ${side.teamName}` : "";
      s.score.textContent = String(side.score);
      s.dec.disabled = side.score <= 0;
    });

    $("btn-clear-score").disabled = !sb.sides.some((x) => x.score > 0);
    renderSummary();
    renderPorts();
    renderActions();
    renderSetsMarks();
  });

  /** The folded strip's one line: both names and the score. */
  function renderSummary() {
    const [a, b] = sb.sides;
    $("strip-summary").replaceChildren(
      h("span", "sum-name", sideName(a) || "Left"),
      h("span", "sum-score", `${a.score}–${b.score}`),
      h("span", "sum-name", sideName(b) || "Right"),
    );
  }

  function setFolded(folded) {
    $("strip").classList.toggle("folded", folded);
    const btn = $("btn-strip-fold");
    btn.setAttribute("aria-expanded", String(!folded));
    btn.title = folded ? "Open the scoreboard" : "Fold the scoreboard to one line";
    store(FOLD_KEY, folded ? "1" : "0");
  }
  $("btn-strip-fold").addEventListener("click", () => setFolded(!$("strip").classList.contains("folded")));
  setFolded(store(FOLD_KEY) === "1");

  /** Tap a colour to set it; tap the lit one to clear it. */
  function setTeamColor(i, name, hex) {
    if (!sb) return;
    const clear = sameHex(sb.sides[i].color, hex);
    api("/api/side-color", { side: i, color: clear ? null : name }).then((r) => {
      if (!r.ok) toast(`Colour change failed: ${r.error}`, false);
    });
  }

  // Back to singles drops each side's second player, so it asks first if
  // there's a name to lose.
  $("btn-doubles").addEventListener("click", () => {
    if (!sb) return;
    const on = !sb.isDoubles;
    const go = () => act("/api/doubles", { on }, on ? "Doubles — two players a side" : "Singles", "Couldn't switch");
    const partners = on ? [] : sb.sides.map((x) => x.players[1]).filter((p) => p && p.tag).map(playerName);
    if (!partners.length) return go();
    if ($("strip").classList.contains("folded")) setFolded(false);
    confirmIn($("clear-confirm"), {
      html: rich("Back to singles? ", { b: partners.join(" and ") }, " come off the scoreboard."),
      yes: "Singles",
      onYes: go,
    });
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

  // TSH's round and match terms, after the loaded bracket's own round names.
  const ROUND_TERMS = [
    "Winners Round 1", "Winners Round 2", "Winners Round 3", "Winners Quarter-Final", "Winners Semi-Final", "Winners Final",
    "Losers Round 1", "Losers Round 2", "Losers Round 3", "Losers Round 4", "Losers Top 8",
    "Losers Quarter-Final", "Losers Semi-Final", "Losers Final", "Grand Final", "Grand Final Reset",
    "Pools", "Top 8", "Top 16", "Top 32", "Final", "Semi-Final", "Quarter-Final",
    "Friendlies", "Casuals", "Exhibition Match", "Money Match", "Crew Battle", "Round Robin", "Ladder", "Freeplay",
  ];

  function roundOptions() {
    const out = [];
    const seen = new Set();
    const add = (name) => {
      const v = String(name || "").trim();
      if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
    };
    ((bracket && bracket.rounds) || []).forEach((r) => add(r.name));
    sets.forEach((s) => add(s.roundName));
    ROUND_TERMS.forEach(add);
    return out;
  }

  autocomplete($("round"), {
    ...textItem,
    source: (text) => narrow(roundOptions(), text, 60),
    pick: (v) => commitPick($("round"), v, () => api("/api/set-text", { round: v })),
  });
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

  // Start and Report exist only for a set loaded from start.gg: a manual set
  // has nothing to report to. Start also only while start.gg has it waiting.
  const renderActions = guard("actions", () => {
    const cs = (status && status.currentSet) || {};
    const fromStartgg = !!(sb && sb.setId);
    const start = $("btn-start");
    if (!startBusy) {
      start.classList.toggle("gone", !fromStartgg || !cs.canStart);
      start.disabled = !cs.canStart;
    }
    const report = $("btn-report");
    report.classList.toggle("gone", !fromStartgg);
    report.disabled = !fromStartgg || !cs.canReport;
    if (!fromStartgg) $("report-confirm").replaceChildren();
    $("strip-hint").textContent = fromStartgg && !cs.canReport ? cs.reason || "" : "";
  });

  $("btn-sides").addEventListener("click", () => act("/api/swap-sides", {}, "Sides switched", "Switch sides failed"));

  // No confirm, as ± has none: it's a couple of + to put back.
  $("btn-clear-score").addEventListener("click", () => {
    const was = sb ? sb.sides.map((x) => x.score).join("–") : "";
    act("/api/clear-score", {}, `Score cleared${was ? ` (was ${was})` : ""}`, "Couldn't clear the score");
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
    // Read when looked at: neither changes on its own mid-set.
    if (name === "players" && !playersFetched) fetchPlayers();
    if (name === "setup") fetchSetup();
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

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

  // ── Bracket tab ─────────────────────────────────────────────────────────────

  // No confirm on the event switch: it keeps the set on the scoreboard, its
  // score and its set id, so a misclick costs one re-read of start.gg.
  let bracketBusy = false;
  let bracketMsg = null;
  const BRACKET_KEYS = ["btn-bracket-singles", "btn-bracket-doubles", "btn-bracket-url"];

  /** Both ways of choosing the event: a Singles/Doubles key, or a pasted URL. */
  async function switchBracket(route, body, busyText, fallbackName) {
    bracketMsg = null;
    bracketBusy = true;
    BRACKET_KEYS.forEach((id) => { $(id).disabled = true; });
    $("bracket-hint").textContent = busyText;
    const r = await api(route, body);
    bracketBusy = false;
    BRACKET_KEYS.forEach((id) => { $(id).disabled = false; });
    if (!r.ok) {
      bracketMsg = r.error; // stays up: it's usually a config fix or a wrong link
      $("bracket-hint").textContent = r.error;
      toast(`Bracket switch failed: ${r.error}`, false);
      return false;
    }
    if (r.warning) {
      bracketMsg = r.warning;
      $("bracket-hint").textContent = r.warning;
    }
    const what = (r.tournamentName ? r.tournamentName + " — " : "") + (r.eventName || fallbackName);
    toast(r.refreshed ? `${what} was already loaded — re-read it` : `Loaded ${what}`, true);
    fetchSets();
    return true;
  }
  ["btn-bracket-singles", "btn-bracket-doubles"].forEach((id) => $(id).addEventListener("click", () => {
    const kind = $(id).dataset.kind;
    switchBracket("/api/bracket", { kind }, "Finding this week's tournament on start.gg…", kind);
  }));

  async function loadBracketUrl() {
    const input = $("bracket-url");
    const url = input.value.trim();
    if (!url) return input.focus();
    if (await switchBracket("/api/bracket-url", { url }, "Loading that event from start.gg…", "event")) input.value = "";
  }
  $("btn-bracket-url").addEventListener("click", loadBracketUrl);
  $("bracket-url").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.defaultPrevented || $("btn-bracket-url").disabled) return;
    e.preventDefault();
    loadBracketUrl();
  });

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

  // ── Casters tab ─────────────────────────────────────────────────────────────

  // Edited as a draft and sent whole with Put on stream: the casters' cards
  // are on the broadcast, so a half-typed tag must never reach them, and a
  // push (another dock, a restart) must never undo what's being typed.
  const MAX_CASTERS = 4;
  const CASTER_FIELDS = [
    { key: "tag",     placeholder: "Tag" },
    { key: "prefix",  placeholder: "Team" },
    { key: "pronoun", placeholder: "Pronouns" },
    { key: "twitter", placeholder: "@handle" },
  ];
  let casters = [];       // what's on stream (state.casters)
  let casterDraft = null; // the form's rows once touched; null = showing what's on stream

  const blankCaster = () => ({ tag: "", prefix: "", pronoun: "", twitter: "" });
  const casterList = (list) => (list || []).map((c) => ({ ...blankCaster(), ...c }));
  const sameCasters = (a, b) => JSON.stringify(casterList(a)) === JSON.stringify(casterList(b));

  function draft() {
    if (!casterDraft) casterDraft = casterList(casters);
    return casterDraft;
  }

  /** Whether the operator is in one of the caster fields right now. */
  function typingCaster() {
    const a = document.activeElement;
    return !!(a && a.parentElement && a.parentElement.classList.contains("c-fields"));
  }

  const renderCasters = guard("casters", () => {
    const rows = casterDraft || casters;
    $("casters-list").replaceChildren(...(rows.length
      ? rows.map(casterRow)
      : [h("div", "empty-note", "Nobody on the mic. Add a caster.")]));
    $("btn-caster-add").disabled = rows.length >= MAX_CASTERS;
    renderCastersDirty();
  });

  function renderCastersDirty() {
    const dirty = !!casterDraft && !sameCasters(casterDraft, casters);
    $("casters-card").classList.toggle("dirty", dirty);
    $("btn-casters-save").disabled = !dirty;
    $("btn-casters-revert").disabled = !dirty;
    const live = casters.filter((c) => c.tag).length;
    $("casters-stamp").textContent = dirty ? "Not on stream yet" : live ? `${live} on stream` : "";
  }

  function casterRow(c, i) {
    const row = h("div", "caster-row");
    const fields = h("div", "c-fields");
    for (const f of CASTER_FIELDS) {
      const input = h("input", "c-" + f.key);
      input.type = "text";
      input.placeholder = f.placeholder;
      input.spellcheck = false;
      input.value = c[f.key] || "";
      input.addEventListener("input", () => {
        draft()[i][f.key] = input.value;
        renderCastersDirty();
      });
      const set = (v) => {
        draft()[i][f.key] = v;
        input.value = v;
        renderCastersDirty();
      };
      if (f.key === "tag") {
        casterSuggest(input, i);
        input.addEventListener("change", () => fillCaster(i));
      }
      if (f.key === "prefix") prefixSuggest(input, set);
      if (f.key === "pronoun") pronounSuggest(input, set);
      fields.append(input);
    }
    const ops = h("div", "c-ops");
    const up = key("↑", "mini");
    up.title = "Up a seat — caster 1 is ?i=0";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      const d = draft();
      [d[i - 1], d[i]] = [d[i], d[i - 1]];
      renderCasters();
    });
    const del = key("✕", "mini");
    del.title = "Take this caster off";
    del.addEventListener("click", () => {
      draft().splice(i, 1);
      renderCasters();
    });
    ops.append(up, del);
    row.append(h("span", "c-num", String(i + 1)), fields, ops);
    return row;
  }

  /** The input of caster row i's field, or null. */
  function casterInput(i, k) {
    const row = $("casters-list").querySelectorAll(".caster-row")[i];
    return (row && row.querySelector(".c-" + k)) || null;
  }

  /**
   * The tag field suggests from the whole player list (casters aren't
   * entrants), all of it on a click into the field. A pick is that person:
   * every field is theirs, blanks included, so nothing is left over from
   * whoever the row held before.
   */
  function casterSuggest(input, i) {
    autocomplete(input, {
      label: (p) => p.tag,
      source: (text) => playerSuggestions(text, true),
      caption: playerCaption,
      render: playerItem,
      pick: (p) => {
        const c = draft()[i];
        if (!c) return;
        for (const f of CASTER_FIELDS) {
          c[f.key] = p[f.key] || "";
          const el = casterInput(i, f.key);
          if (el && el.value !== c[f.key]) el.value = c[f.key];
        }
        renderCastersDirty();
      },
    });
  }

  /** A tag typed out in full that's in the player list fills the fields left blank. */
  async function fillCaster(i) {
    const c = casterDraft && casterDraft[i];
    const tag = c ? c.tag.trim() : "";
    if (!tag) return;
    const r = await api("/api/players?q=" + encodeURIComponent(tag));
    const hit = r.ok && (r.players || []).find((p) => p.tag.toLowerCase() === tag.toLowerCase());
    if (!hit || !casterDraft || casterDraft[i] !== c) return; // saved, reverted or moved meanwhile
    c.tag = hit.tag;
    for (const k of ["prefix", "pronoun", "twitter"]) {
      if (!c[k] && hit[k]) c[k] = hit[k];
    }
    // Into that row's fields in place: a redraw would take the focus, and
    // Enter commits a tag without leaving the field.
    for (const f of CASTER_FIELDS) {
      const input = casterInput(i, f.key);
      if (input && input.value !== c[f.key]) input.value = c[f.key];
    }
    renderCastersDirty();
  }

  $("btn-caster-add").addEventListener("click", () => {
    const d = draft();
    if (d.length >= MAX_CASTERS) return;
    d.push(blankCaster());
    renderCasters();
    const tags = $("casters-list").querySelectorAll(".c-tag");
    if (tags.length) tags[tags.length - 1].focus();
  });

  $("btn-casters-save").addEventListener("click", async () => {
    const list = casterList(casterDraft || casters).map((c) => ({
      tag: c.tag.trim(), prefix: c.prefix.trim(), pronoun: c.pronoun.trim(), twitter: c.twitter.trim(),
    }));
    const r = await act("/api/casters", { casters: list }, "Casters on stream", "Couldn't update the casters");
    if (!r.ok) return;
    casters = r.casters || list;
    casterDraft = null;
    renderCasters();
  });

  $("btn-casters-revert").addEventListener("click", () => {
    casterDraft = null;
    renderCasters();
  });

  /** state.casters arrived: drawn unless the operator has edits of their own. */
  function onCasters(list) {
    const prev = casters;
    casters = Array.isArray(list) ? list : [];
    // A draft that was never really changed follows the push.
    if (casterDraft && sameCasters(casterDraft, prev) && !typingCaster()) casterDraft = null;
    if (casterDraft) renderCastersDirty();
    else renderCasters();
  }

  // ── Players tab ─────────────────────────────────────────────────────────────

  let players = [];          // the last /api/players answer
  let playersMeta = null;    // { total, file }
  let playersError = null;
  let playersFetched = false;
  let playersReq = 0;
  let editingRef = null;     // the player whose editor is open

  /** The search's matches, or with no search the players on the scoreboard. */
  async function fetchPlayers() {
    const req = ++playersReq;
    const q = $("player-search").value.trim();
    const r = await api("/api/players" + (q ? "?q=" + encodeURIComponent(q) : ""));
    if (req !== playersReq) return;
    playersFetched = true;
    playersError = r.ok ? null : (r.error || "no answer from the app");
    if (r.ok) {
      players = r.players || [];
      playersMeta = { total: r.total, file: r.file };
    }
    renderPlayers();
  }

  const renderPlayers = guard("players", () => {
    const list = $("players-list");
    const q = $("player-search").value.trim();
    $("players-stamp").textContent = playersMeta ? `${playersMeta.total} in the list` : "";
    if (playersError) return list.replaceChildren(h("div", "empty-note", `Couldn't read the player list: ${playersError}`));
    if (!players.length) {
      return list.replaceChildren(h("div", "empty-note", q
        ? `Nobody in the list matches “${q}”.`
        : "Search by tag. Everyone in a set loaded from start.gg is added automatically."));
    }
    const rows = players.map(playerRow);
    if (!q) rows.unshift(h("div", "list-cap", "On the scoreboard"));
    list.replaceChildren(...rows);
  });

  function playerRow(p) {
    const open = editingRef === p.ref;
    const row = h("div", "pl-row" + (p.onAir ? " air" : "") + (open ? " open" : ""));

    const shown = p.pinnedMain || p.main;
    const charBtn = h("button", "char" + (shown ? "" : " empty") + (p.pinnedMain ? " pinned" : ""));
    charBtn.type = "button";
    charBtn.title = p.pinnedMain ? `Pinned: ${p.pinnedMain.name} — change` : "Pin the main their sets open on";
    const img = h("img");
    img.alt = "";
    if (shown) img.src = icon(shown);
    charBtn.append(img);
    charBtn.addEventListener("click", () => openPinPicker(p));

    const name = h("button", "pl-name");
    name.type = "button";
    name.title = open ? "Close" : "Edit";
    if (p.prefix) name.append(h("span", "pl-prefix", p.prefix));
    name.append(h("span", "pl-tag", p.tag || "?"));
    if (p.pronoun) name.append(h("span", "chip", p.pronoun));
    if (p.onAir) name.append(h("span", "chip air", "On stream"));
    if (p.pinnedMain) name.append(h("span", "chip pin", "Pinned"));
    name.addEventListener("click", () => {
      editingRef = open ? null : p.ref;
      renderPlayers();
    });

    const learned = h("div", "pl-learned");
    learned.title = "Learned from Slippi, most recent first";
    (p.learnedMains || []).forEach((c) => {
      const i = h("img");
      i.alt = c.name;
      i.title = `${c.name} (learned)`;
      i.src = icon(c);
      learned.append(i);
    });

    row.append(charBtn, name, learned);
    if (open) row.append(playerEditor(p));
    return row;
  }

  function playerEditor(p) {
    const box = h("div", "pl-edit");
    const fields = {};
    for (const [k, label, placeholder] of [["prefix", "Team", ""], ["pronoun", "Pronouns", "they/them"], ["twitter", "Twitter", "@handle"]]) {
      const f = h("label", "field");
      const input = h("input");
      input.type = "text";
      input.spellcheck = false;
      input.placeholder = placeholder;
      input.value = p[k] || "";
      const set = (v) => { input.value = v; };
      if (k === "prefix") prefixSuggest(input, set);
      if (k === "pronoun") pronounSuggest(input, set);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.defaultPrevented) save(); });
      fields[k] = input;
      f.append(h("span", "", label), input);
      box.append(f);
    }
    async function save() {
      const body = { ref: p.ref, tag: p.tag };
      for (const k of Object.keys(fields)) body[k] = fields[k].value.trim();
      const r = await act("/api/players/update", body,
        `${p.tag} saved` + (p.onAir ? " — on stream now" : ""), "Couldn't save");
      if (!r.ok) return;
      editingRef = null;
      replacePlayer(r.player);
    }
    const keys = h("div", "key-row");
    const ok = key("Save", "go");
    ok.addEventListener("click", save);
    const cancel = key("Cancel");
    cancel.addEventListener("click", () => { editingRef = null; renderPlayers(); });
    keys.append(ok, cancel);
    if (p.pinnedMain) {
      const unpin = key("Unpin main");
      unpin.addEventListener("click", () => pinMain(p, null));
      keys.append(unpin);
    }
    box.append(keys);
    return box;
  }

  function replacePlayer(entry) {
    if (!entry) return;
    players = players.map((x) => (x.ref === entry.ref ? entry : x));
    renderPlayers();
  }

  async function pinMain(p, codename, skin) {
    const r = await api("/api/players/pin", { ref: p.ref, tag: p.tag, codename, skin });
    if (!r.ok) {
      toast(`Couldn't pin that: ${r.error}`, false);
      return r;
    }
    toast(r.player.pinnedMain ? `${p.tag}'s sets open on ${r.player.pinnedMain.name}` : `${p.tag}: back to learned mains`, true);
    replacePlayer(r.player);
    return r;
  }

  $("player-search").addEventListener("input", () => {
    clearTimeout(fetchPlayers.timer);
    fetchPlayers.timer = setTimeout(fetchPlayers, 150);
  });

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

  // ── Setup tab ───────────────────────────────────────────────────────────────

  let setup = null; // /api/setup
  let chords = {};  // action → chord, while the hotkeys are global

  async function fetchSetup() {
    const r = await api("/api/setup");
    if (!r.ok) {
      $("setup-overlays").replaceChildren(h("div", "empty-note", `Couldn't read the setup: ${r.error}`));
      return;
    }
    setup = r;
    renderSetup();
  }

  /** A url to paste somewhere else, with a Copy key. */
  function copyRow(name, url, meta, note) {
    const row = h("div", "url-row");
    const head = h("div", "u-head");
    head.append(h("span", "u-name", name));
    if (meta) head.append(h("span", "u-meta", meta));
    const line = h("div", "u-line");
    const input = h("input", "u-url");
    input.type = "text";
    input.readOnly = true;
    input.value = url;
    const btn = key("Copy", "mini");
    btn.addEventListener("click", () => copy(input));
    line.append(input, btn);
    row.append(head, line);
    if (note) row.append(h("div", "u-note", note));
    return row;
  }

  /** The clipboard API needs a secure origin, which a phone on the LAN isn't. */
  function copy(input) {
    const fallback = () => {
      input.focus();
      input.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { /* unsupported */ }
      toast(ok ? "Copied" : "Selected — press Ctrl+C", true);
    };
    const clip = typeof navigator !== "undefined" && navigator.clipboard;
    if (clip && window.isSecureContext) clip.writeText(input.value).then(() => toast("Copied", true), fallback);
    else fallback();
  }

  function keycaps(chord) {
    const caps = h("span", "keycaps");
    chord.split("+").forEach((k) => caps.append(h("kbd", "", k)));
    return caps;
  }

  const HOTKEY_HINTS = {
    global: "Work from any window — and still reach it, so Dolphin and OBS see the keys too. A held key fires once. Change them in config.HOTKEYS.",
    terminal: "The global listener (uiohook-napi) didn't load: these keys only work typed into the app's own console window.",
    none: "The global listener (uiohook-napi) didn't load and the app has no console: use the strip's keys.",
  };

  const renderSetup = guard("setup", () => {
    if (!setup) return;
    $("setup-theme").textContent = setup.theme ? `Theme: ${setup.theme}` : "";
    $("setup-overlays").replaceChildren(...(setup.overlays || []).map((o) =>
      copyRow(o.name, (setup.base || "") + o.path, o.size, o.note)));

    const hk = setup.hotkeys || {};
    const mode = hk.mode || "none";
    $("hotkeys-mode").textContent = mode === "global" ? "Global" : mode === "terminal" ? "Console only" : "Off";
    $("hotkeys-mode").className = "badge " + (mode === "global" ? "ok" : "warn");
    const bindings = hk.bindings || [];
    $("setup-hotkeys").replaceChildren(...(bindings.length ? bindings.map((b) => {
      const row = h("div", "hk-row");
      row.append(h("span", "hk-label", b.label), keycaps(b.chord));
      return row;
    }) : [h("div", "empty-note", "No hotkeys bound.")]));
    $("hotkeys-hint").replaceChildren(document.createTextNode(HOTKEY_HINTS[mode] || ""),
      ...(hk.errors || []).map((e) => h("div", "hk-err", e)));
    chords = {};
    if (mode === "global") for (const b of bindings) chords[b.action] = b.chord;
    applyKeyHints();

    const lan = setup.lan || [];
    $("setup-lan").replaceChildren(...(lan.length
      ? lan.map((a) => copyRow(a.name + (a.tailscale ? " · Tailscale" : ""), a.url))
      : [h("div", "empty-note", "No network address — this machine isn't on a network.")]));

    const fact = (k, v) => {
      const row = h("div", "fact");
      row.append(h("span", "k", k), h("span", "v", v));
      return row;
    };
    const gg = setup.startgg || {};
    const pl = setup.players || {};
    $("setup-files").replaceChildren(
      fact("Players", `${pl.file || "?"} · ${pl.count == null ? "?" : pl.count} players`),
      fact("Slippi", setup.slippiFolder || "not set (config.SLP_FOLDER)"),
      fact("start.gg", (gg.token ? "Token set — Start and Report work" : "No token — reads only (config.local.js)")
        + (gg.shortLink ? ` · start.gg/${gg.shortLink}` : "")),
    );
  });

  /** The bound chords, on the keys they press (titles only — the strip stays clean). */
  function applyKeyHints() {
    const hint = (base, action) => base + (chords[action] ? ` (${chords[action]})` : "");
    for (const [id, action] of [["btn-ports", "swapPorts"], ["btn-sides", "switchSides"], ["btn-clear-score", "clearScore"]]) {
      const k = $(id);
      if (!k.dataset.base) k.dataset.base = k.title;
      k.title = hint(k.dataset.base, action);
    }
    sides.forEach((s, i) => {
      if (!s) return;
      s.inc.title = hint("Give this side a game", i === 0 ? "leftPlus" : "rightPlus");
      s.dec.title = hint("Take a game away", i === 0 ? "leftMinus" : "rightMinus");
    });
  }

  // ── The character picker ────────────────────────────────────────────────────

  /**
   * Who the picker is choosing for, and which character's costumes it shows:
   * a player on the strip ({ side, index }), or a player-list entry whose main
   * is being pinned ({ pin: entry }).
   */
  let picking = null; // { side, index, pin, costumesFor: codename|null }

  /** The character the picker marks as current. */
  function pickingCurrent() {
    if (!picking) return null;
    if (picking.pin) return picking.pin.pinnedMain || null;
    const p = sb ? sb.sides[picking.side].players[picking.index] : null;
    return (p && p.character) || null;
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
          const cur = pickingCurrent();
          pick(c.codename, cur && cur.codename === c.codename ? cur.skin : 0);
        },
        () => { picking.costumesFor = c.codename; renderPicker(); });
      return b;
    }));
  }

  const renderPicker = guard("picker", () => {
    if (!picking) return;
    if (picking.pin) {
      $("picker-title").textContent = "Pinned main";
      $("picker-who").textContent = `${playerName(picking.pin) || "?"} — their sets open on this`;
      $("picker-none").textContent = "Unpin";
    } else {
      const p = sb ? sb.sides[picking.side].players[picking.index] : null;
      const where = `${picking.side === 0 ? "Left" : "Right"}${sb && sb.isDoubles ? ` · player ${picking.index + 1}` : ""}`;
      $("picker-title").textContent = "Character";
      $("picker-who").textContent = `${(p && playerName(p)) || "Unnamed player"} — ${where}`;
      $("picker-none").textContent = "No character";
    }
    const cur = pickingCurrent();

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
    picking = { side, index, pin: null, costumesFor: opts.costumesFor || null };
    renderPicker();
    $("picker").classList.add("open");
  }

  /** The picker, choosing a player-list entry's pinned main. */
  function openPinPicker(entry) {
    picking = { pin: entry, costumesFor: null };
    renderPicker();
    $("picker").classList.add("open");
  }

  function closePicker() {
    picking = null;
    $("picker").classList.remove("open");
  }

  /** Set the character (null = none, or unpin) and close. */
  async function pick(codename, skin) {
    if (!picking) return;
    if (picking.pin) {
      const r = await pinMain(picking.pin, codename, skin);
      if (r.ok) closePicker();
      return;
    }
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

  let onAirKey = null;
  ov.select("scoreboard", (now) => {
    sb = now;
    renderStrip();
    renderPicker();
    // The Players tab with no search lists who's on the scoreboard; it follows
    // a new set, unless a player is open in the editor.
    const who = sb ? sb.sides.map((s) => s.players.map((p) => `${p.playerId}:${p.tag}`).join(",")).join("|") : "";
    if (who !== onAirKey) {
      onAirKey = who;
      if (playersFetched && editingRef == null && !$("player-search").value.trim()) fetchPlayers();
    }
  });

  ov.select("casters", onCasters);

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

  renderCasters();
  showTab(store(TAB_KEY));
  // The strip's keys carry the bound chords in their titles.
  if (!$("panel-setup").classList.contains("on")) fetchSetup();
  fetchSets();
  setInterval(() => { if (document.visibilityState === "visible") fetchSets(); }, SETS_POLL_MS);

  // For tests, and for poking at the console from the dock's devtools.
  window.Dock = {
    get scoreboard() { return sb; },
    get status() { return status; },
    get gameLive() { return gameLive; },
    get picking() { return picking; },
    get sets() { return sets; },
    get players() { return players; },
    get casterDraft() { return casterDraft; },
    get setup() { return setup; },
    openPicker, openPinPicker, closePicker, pick, fetchSets, fetchPlayers, fetchSetup, showTab, CLIP_FIELDS,
  };
})();
