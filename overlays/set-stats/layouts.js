/**
 * layouts.js — the stats popup's layouts and picture styles. Pure: from the
 * app's `setStats` section and the popup's settings to markup, plus the small
 * rotating sections each layout runs. set-stats.js puts it on screen and
 * animates it. Loaded by the page and by Node (tests/set-stats.test.js).
 *
 * Every layout reads the same view: the ledger rows (`rows[key].g` the game
 * just played, `.s` the set, `.pg` each game), the callouts (`insights`), the
 * summaries (`stories`, segments: { t } text, { em } lit, { t, name: true } a
 * player's name) and the `facts`, each in two readings — "game" (after a
 * game) and "set" (the wrap-up).
 *
 * Markup is built with html``, which escapes every value it's given (names
 * come from start.gg and from whoever typed them); only another html`` result
 * goes in as markup.
 *
 * Positions are the window's (1536×864), inline per piece, as tuned in the
 * preview (.scratch/set-stats-preview/), where new layouts are tried first.
 * The ids match lib/set-stats/catalog.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./portrait-fit"));
  else root.SetStatsLayouts = factory(root.SetStatsFit);
})(typeof self !== "undefined" ? self : this, function (Fit) {
  "use strict";

  // ── Markup ──────────────────────────────────────────────────────────────────

  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(v) {
    if (v == null || v === false) return "";
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(esc).join("");
    // A score (3–2) or range never splits at its dash: Chrome breaks a line after an en dash.
    return String(v).replace(/[&<>"']/g, (c) => ESC[c]).replace(/(\d)–(?=\d)/g, "$1\u2060–\u2060");
  }
  function html(strings, ...vals) {
    let out = strings[0];
    vals.forEach((v, i) => { out += esc(v) + strings[i + 1]; });
    return new Raw(out);
  }
  const join = (list) => new Raw(list.map(esc).join(""));
  const at = (l, t, w, h) => `left:${l}px;top:${t}px;${w != null ? `width:${w}px;` : ""}${h != null ? `height:${h}px;` : ""}`;

  // ── Picture styles ──────────────────────────────────────────────────────────
  // A stack of pieces over the art: { img } a copy of it, { fill } a colour cut
  // to the figure's shape. Either takes filter, o (opacity), blend, off [x, y],
  // blur; img takes mask. opK scales the layout's portrait opacity. `fx` is the
  // piece's own touch as it comes in (set-stats.js piecesIn): "reg" slides an
  // offset ink into register, "rim" catches a beat after the figure, "scan"
  // rolls down the picture.

  const STYLES = {
    cream:    { pieces: [{ img: 1, filter: "grayscale(1) sepia(0.55) brightness(0.95)" }] },
    scan:     { opK: 1.1, pieces: [
      { img: 1, filter: "saturate(0.85) contrast(1.12)" },
      { img: 1, filter: "sepia(1) saturate(5) hue-rotate(-25deg)", blend: "screen", o: 0.4, off: [7, 0], fx: "reg" },
      { fill: "repeating-linear-gradient(180deg, rgba(4,10,12,0.6) 0 2px, transparent 2px 5px)", fx: "scan" }] },
    riso:     { opK: 1.3, pieces: [
      { img: 1, filter: "grayscale(1) contrast(1.35) brightness(1.08)" },
      { fill: "#16404a", blend: "lighten" },
      { fill: "#f09a4c", blend: "multiply", off: [6, 4], fx: "reg" }] },
    silRim:   { opK: 1.7, pieces: [
      { fill: "rgba(224,138,60,0.30)", blur: 46, fx: "rim" },
      { fill: "#f2a65a", off: [4, -3], fx: "rim" },
      { fill: "#0d1f25" },
      { img: 1, filter: "grayscale(1) brightness(1.6) contrast(1.3)", blend: "screen", o: 0.1 }] },
    silSketch:{ opK: 1.1, pieces: [
      { fill: "#b0581a", off: [-2.5, 0], fx: "rim" }, { fill: "#b0581a", off: [2.5, 0], fx: "rim" }, { fill: "#b0581a", off: [0, -2.5], fx: "rim" }, { fill: "#b0581a", off: [0, 2.5], fx: "rim" },
      { fill: "linear-gradient(180deg, #f3e6c6, #e6d3a6)" },
      { img: 1, filter: "grayscale(1) contrast(1.5) brightness(1.08)", blend: "multiply", o: 0.38 }] },
    plain:    { pieces: [{ img: 1 }] },
  };

  const FADE = (solid, gone) => `linear-gradient(90deg, #000 0%, #000 ${solid}%, transparent ${gone}%)`;
  const PAGE_WASH = "linear-gradient(0deg, rgb(var(--page-rgb)) 0%, rgba(var(--page-rgb), 0) 24%)";

  // ── Reading the view ────────────────────────────────────────────────────────

  /**
   * Everything a layout reads, for one render.
   * @param {object} d — the setStats section
   * @param {{ mode: "game"|"set", style: string }} o — the reading and the resolved picture style
   */
  function reader(d, o) {
    const set = o.mode === "set";
    const ST = d.stats || {};
    const rows = d.rows || {};
    const last = d.games[d.games.length - 1] || null;
    const fixed = (v, dp) => (v == null ? "–" : Number(v).toFixed(dp));
    // One span: a ledger cell is a flex row with a gap, which would part the number from its unit.
    const fmtVal = (st, v, dp) => html`<span class="v">${fixed(v, dp)}${v != null && st.unit ? html`<span class="u">${st.unit}</span>` : ""}</span>`;
    return {
      d, set, ST, rows, last, style: o.style, over: !!d.over,
      ins: (d.insights && d.insights[o.mode]) || [],
      stories: (d.stories && d.stories[o.mode]) || [],
      facts: (d.facts && d.facts[o.mode]) || [],
      lead: (key) => (rows[key] ? (set ? rows[key].lead.s : rows[key].lead.g) : null),
      big: (key, side) => { const st = ST[key], r = rows[key]; return set ? fmtVal(st, r.s[side], st.dp[1]) : fmtVal(st, r.g[side], st.dp[0]); },
      small: (key, side) => { const st = ST[key], r = rows[key]; return set ? spark(r, side, st) : fmtVal(st, r.s[side], st.dp[1]); },
    };
  }

  /** The keys a layout asks for that the set has, topped up from the rest so a short row list still fills it. */
  const FALLBACK = ["counter", "avgkill", "ipm", "combo", "earliest", "lcancel", "punish", "dpo", "kills", "damage", "opk", "neutral"];
  function keysFor(R, prefer) {
    const out = prefer.filter((k) => R.rows[k]);
    for (const k of FALLBACK) if (out.length < prefer.length && R.rows[k] && !out.includes(k)) out.push(k);
    return out;
  }

  function titles(R) {
    const d = R.d;
    if (R.set) return { eyebrow: [d.round, `${d.total} ${d.total === 1 ? "game" : "games"}`].filter(Boolean).join(" · "), title: d.over ? "Set Complete" : "The Set So Far" };
    return { eyebrow: [d.round, d.bestOf ? `Best of ${d.bestOf}` : d.format].filter(Boolean).join(" · "), title: `Game ${R.last ? R.last.n : ""}` };
  }
  const storyLabel = (R) => (R.set ? `The set · ${R.d.total} ${R.d.total === 1 ? "game" : "games"}` : `The story of game ${R.last ? R.last.n : ""}`);
  // A sentence: its numbers lit (em), its players' names set apart (.nm), the rest plain.
  const story = (segs) => join((segs || []).map((s) => (s.em != null ? html`<em>${s.em}</em>` : s.name ? html`<span class="nm">${s.t}</span>` : s.t)));
  const val = (x) => html`${x.big}${x.unit ? html`<span class="u">${x.unit}</span>` : ""}`;
  const edge = (x) => (x.side === 0 ? "e-l" : x.side === 1 ? "e-r" : "");
  /** Whose a callout is: a player (a side) behind a lit dot, or a span of games without one. */
  const whoCls = (x) => (x.side === 0 || x.side === 1 ? "ins-who pl" : "ins-who");

  function spark(row, side, st, W = 56, H = 18) {
    const v = row.pg[side];
    const all = row.pg.flat().filter((n) => n != null);
    if (!all.length || v.every((n) => n == null)) return "–";
    const lo = Math.min(...all), hi = Math.max(...all);
    const x = (i) => 3 + i * ((W - 6) / Math.max(1, v.length - 1));
    const y = (n) => H - 3 - (hi === lo ? 0.5 : (n - lo) / (hi - lo)) * (H - 6);
    const pts = v.map((n, i) => (n == null ? null : [x(i), y(n)])).filter(Boolean);
    const vals = v.filter((n) => n != null);
    const best = st.better === "lo" ? Math.min(...vals) : Math.max(...vals);
    return html`<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${pts.map((p) => p.join(",")).join(" ")}"/>${join(v.map((n, i) => (n == null ? "" : html`<circle cx="${x(i)}" cy="${y(n)}" r="${n === best ? 2.8 : 1.8}" class="${n === best ? "hi" : ""}"/>`)))}</svg>`;
  }

  // ── Portraits ───────────────────────────────────────────────────────────────

  /**
   * A side's portrait, placed by its face. P: { fx, fy (the face, from the box's
   * outer edge), dx, dy, scale, op, w (box width), mask, wash, tilt, blend,
   * shadow, still, slot ("edge" | "card") }, or [left, right]. pos: which edge
   * the box sits on. Then the pose's own tweak (portrait-fit.js) for this pack,
   * character, layout and slot: mirror, zoom, move, tilt.
   */
  /**
   * Where a side's portrait goes: its tweak, size, and the face's point in the
   * box (fx, fy: from the box's outer edge and top). null with no portrait.
   */
  function placed(R, side, P) {
    if (Array.isArray(P)) P = P[side];
    const src = R.d.sides && R.d.sides[side] && R.d.sides[side].portrait;
    if (!src) return null;
    const t = Fit ? Fit.tweak(src.pack, src.char, R.layout, P.slot || "edge", R.fit) : {};
    const base = P.scale == null ? 1.55 : P.scale;
    const sc = src.k * base * (t.z || 1), W = src.w * sc;
    const eye = t.e || src.eye;
    const flip = (src.faces !== "right") !== !!t.f;
    const fx = (P.fx == null ? 300 : P.fx) + (P.dx || 0) + (t.x || 0) * base;
    const fy = (P.fy == null ? 290 : P.fy) + (P.dy || 0) + (t.y || 0) * base;
    return { P, src, t, sc, W, eye, flip, fx, fy };
  }

  // A pack cut at its frame (the select screen's busts): the cut fades out
  // rather than stand as a straight edge on the window.
  /** A dark figure's rim of light (a tweak's `l`), so it stands off a dark window. */
  const RIM = "drop-shadow(0 0 1.5px rgba(245,232,205,0.85)) drop-shadow(0 0 16px rgba(245,232,205,0.35))";
  const CUT = "radial-gradient(ellipse 50% 50% at 50% 44%, #000 58%, transparent 100%)";

  function portrait(R, side, P, pos) {
    const at0 = placed(R, side, P);
    if (!at0) return "";
    pos = pos || (side ? "r" : "l");
    const { src, t, sc, W, eye, flip, fx, fy } = at0;
    P = at0.P;
    const eyeX = flip ? W - eye[0] * sc : eye[0] * sc;
    const left = fx - eyeX;
    const top = fy - eye[1] * sc;
    // A tweak's tilt turns about the face, so the face stays where it was put
    // (the origin on the image's middle line keeps the mirror a mirror; the fill
    // pieces' box is taller than the image, so it's in px, not %).
    const ax = eyeX - W / 2;
    const turn = t.r ? `transform-origin:${W / 2}px ${eye[1] * sc}px;transform:translate(${ax}px,0) rotate(${t.r}deg) translate(${-ax}px,0)${flip ? " scaleX(-1)" : ""};` : "";
    const sty = STYLES[R.style] || STYLES.cream;
    const role = R.set && R.over ? (R.d.score[side] > R.d.score[1 - side] ? "winner" : "loser") : "";
    // The wrap-up lifts the winner and fades the loser. In the inline opacity,
    // not a stylesheet !important, which the entrance's fade couldn't animate.
    const roleK = role === "winner" ? 1.25 : role === "loser" ? 0.55 : 1;
    const op = Math.min(1, (P.op == null ? 0.5 : P.op) * (sty.opK || 1) * roleK);
    const box = `width:${W}px;left:${left}px;top:${top}px;${turn || (flip ? "transform:scaleX(-1);" : "")}`;
    const shadow = [P.shadow, t.l ? RIM : ""].filter(Boolean).join(" ");
    // The cut's feather goes on the whole stack, over the picture's box: per piece, a
    // style's offset rims would show through the faded edge of the pieces over them.
    const cut = src.cut ? (() => {
      const m = `${CUT};-webkit-mask-size:${W}px ${src.h * sc}px;-webkit-mask-position:${left}px ${top}px;-webkit-mask-repeat:no-repeat;`;
      return `-webkit-mask-image:${m}mask-image:${CUT};mask-size:${W}px ${src.h * sc}px;mask-position:${left}px ${top}px;mask-repeat:no-repeat;`;
    })() : "";
    // A cut pack's art fades out at its frame: a silhouette's offset outline copies
    // (plain offset fills), stacked, would come through that fade as patches. It goes
    // without the outline; a blended offset fill (riso's second ink) stays.
    const pieces = sty.pieces.filter((p) => !(src.cut && p.fill && p.off && !p.blend)).map((p) => {
      const css = [];
      if (p.o != null) css.push(`opacity:${p.o}`);
      const f = [p.filter, p.blur ? `blur(${p.blur}px)` : ""].filter(Boolean).join(" ");
      if (f) css.push(`filter:${f}`);
      if (p.blend) css.push(`mix-blend-mode:${p.blend}`);
      if (p.off) css.push(`transform:translate(${p.off[0]}px,${p.off[1]}px)`);
      if (p.mask) css.push(`-webkit-mask:${p.mask}`, `mask:${p.mask}`);
      const inner = p.img
        ? html`<img src="${src.url}" style="${box}" alt="" />`
        : html`<div class="fig" style="${box}-webkit-mask-image:url('${src.url}');mask-image:url('${src.url}')"><div class="fill" style="background:${p.fill}"></div></div>`;
      const fx = p.fx ? new Raw(`data-pc="${p.fx}" data-off="${(p.off || [0, 0]).join(",")}"`) : "";
      return html`<div class="pc" ${fx} style="${css.join(";")}">${inner}</div>`;
    });
    const style = `--op:${op};opacity:${op};--mask:${P.mask || "linear-gradient(90deg, #000 0%, rgba(0,0,0,0.7) 35%, rgba(0,0,0,0.25) 70%, transparent 96%)"};`
      + `${P.wash ? `--wash:${P.wash};` : ""}${P.w ? `width:${P.w}px;` : ""}${P.blend ? `mix-blend-mode:${P.blend};` : ""}`;
    return html`<div class="por ${pos} ${role}" data-base="${pos === "r" ? "scaleX(-1)" : ""}" ${P.still ? "" : new Raw("data-por")} style="${style}">
      <div class="por-in" style="transform:${P.tilt || "none"};${shadow ? `filter:${shadow};` : ""}${cut}">${join(pieces)}</div></div>`;
  }

  // ── Pieces ──────────────────────────────────────────────────────────────────

  const title = (R, style) => { const t = titles(R); return html`<div class="ttl" style="${style}"><div class="eyebrow" data-beat data-fit>${t.eyebrow}</div><div class="title" data-beat>${t.title}</div></div>`; };

  /** `cls` "stack": the picture over the words, for a corner kept inside a narrow margin. */
  // `attrs` (html``): the corner's own way in (data-fx …), instead of the text lift.
  function stageCorner(R, style, r, cls = "", attrs = "") {
    const games = R.d.games;
    if (!R.set) {
      const s = R.last.stage || {};
      return html`<div class="corner ${r ? "r" : ""} ${cls}" data-corner ${attrs} style="${style}">
        ${s.pic ? html`<div class="thumb" style="background-image:url('${s.pic}')"></div>` : ""}
        <div><div class="lab">Stage</div><div class="cval" data-fit>${s.name || "—"}</div></div></div>`;
    }
    const counts = {};
    games.forEach((g) => { if (g.stage && g.stage.name) counts[g.stage.name] = (counts[g.stage.name] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const pics = games.filter((g) => g.stage && g.stage.pic);
    return html`<div class="corner ${r ? "r" : ""} ${cls}" data-corner ${attrs} style="${style}">
      ${pics.length ? html`<div class="thumbs">${join(pics.map((g) => html`<div class="thumb" style="background-image:url('${g.stage.pic}')"></div>`))}</div>` : ""}
      <div><div class="lab">${games.length} ${games.length === 1 ? "stage" : "stages"}</div><div class="cval" data-fit>${top ? `${top[0]}${top[1] > 1 ? ` ×${top[1]}` : ""}` : "—"}</div></div></div>`;
  }
  function timeCorner(R, style, r = true, cls = "", attrs = "") {
    const total = R.d.games.reduce((t, g) => t + (g.seconds || 0), 0);
    const len = R.set ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}` : R.last.len;
    return html`<div class="corner ${r ? "r" : ""} ${cls}" data-corner ${attrs} style="${style}">
      <div class="clock"></div>
      <div><div class="lab">${R.set ? "Set length" : "Game length"}</div><div class="cval time num">${len || "—"}</div></div></div>`;
  }
  const corners = (R, top = 34, inset = 40) => html`${stageCorner(R, `left:${inset}px;top:${top}px`)}${timeCorner(R, `right:${inset}px;top:${top}px`)}`;
  const cornersBottom = (R, bottom = 34, inset = 40) => html`${stageCorner(R, `left:${inset}px;bottom:${bottom}px`)}${timeCorner(R, `right:${inset}px;bottom:${bottom}px`)}`;

  // The ledger: the game big, the set small, the label between (set reading: the set big, each game's line small).
  const pip = new Raw('<span class="pip"></span>');
  const leadCls = (w, s) => (w === s ? "lead" : w == null ? "" : "trail");
  function shareBar(R, key) {
    const r = R.rows[key], st = R.ST[key];
    const [a, b] = R.set ? r.s : r.g;
    if (a == null || b == null) return "";
    const w = R.lead(key);
    let l = a / (a + b || 1);
    if (st.better === "lo") l = 1 - l;
    return html`<div class="share"><i class="${w === 0 ? "on" : ""}" style="width:${(l * 100).toFixed(1)}%"></i><i class="${w === 1 ? "on" : ""}" style="width:${((1 - l) * 100).toFixed(1)}%"></i></div>`;
  }
  /**
   * One ledger row. `inner`: the big numbers inside, next to the label, and the
   * small ones outside (the field notes, whose notes are written in the
   * label's gap: `notes`, by row, from innerNotes()).
   */
  function rowLedger(R, key, opts = {}) {
    const st = R.ST[key], w = R.lead(key);
    const n = opts.notes && opts.notes[key];
    const big = (s) => (n && n.side === s && NUM_MARK[n.kind] ? html`<span class="mk-at">${R.big(key, s)}${NUM_MARK[n.kind]}</span>` : R.big(key, s));
    const g = (s) => html`<div class="g num ${s ? "r" : "l"} ${leadCls(w, s)}">${w === s && !s ? pip : ""}${big(s)}${w === s && s ? pip : ""}</div>`;
    const sm = (s) => html`<div class="s num">${R.small(key, s)}</div>`;
    const k = html`<div class="k"><div class="kl"><div class="lab">${st.label}</div>${st.hint && !opts.share ? html`<div class="hint">${st.hint}</div>` : ""}</div>${n ? noteIn(n) : ""}</div>`;
    const cells = opts.inner ? [sm(0), g(0), k, g(1), sm(1)] : [g(0), sm(0), k, sm(1), g(1)];
    return html`<div class="lr ${opts.inner ? "in" : ""}" data-beat>${cells}${opts.share ? shareBar(R, key) : ""}</div>`;
  }
  function ledgerCap(R, inner) {
    const a = R.set ? "Set" : `Game ${R.last.n}`, b = R.set ? "By game" : "Set";
    const A = (side) => html`<div class="lab" style="text-align:${side}">${a}</div>`, B = html`<div class="lab sm" style="text-align:center">${b}</div>`;
    const cells = inner ? [B, A("right"), html`<div></div>`, A("left"), B] : [A("right"), B, html`<div></div>`, B, A("left")];
    return html`<div class="cap" data-beat>${cells}</div>`;
  }
  const ledger = (R, keys, opts = {}) => html`${ledgerCap(R, opts.inner)}${join(keys.map((k) => rowLedger(R, k, opts)))}`;

  // Callouts, the spotlight strip, the highlight reel.
  // A callout card: its title across the top, the number beside its line, whose it is across the foot.
  const mini = (x, cls = "", style = "", who = true) => html`<div class="mini ${edge(x)} ${cls}" data-beat style="${style}"><div class="ins-tag" data-fit>${x.tag}</div><div class="ins-big num" data-fit>${val(x)}</div><div class="ins-txt" data-fitbox>${x.text}</div>${who && x.who ? html`<div class="${whoCls(x)}" data-fit>${x.who}</div>` : ""}</div>`;
  // A player's own rail: whose it is goes without saying.
  const railMini = (x, style) => mini(x, "glass", style, false);
  const sayItem = (segs, cls = "say") => html`<div class="${cls}" data-beat data-fitbox>${story(segs)}</div>`;
  const dotsFor = (id, n) => html`<div class="dots" data-dots="${id}">${join(Array.from({ length: n }, (_, i) => html`<i class="${i === 0 ? "on" : ""}"></i>`))}</div>`;
  const storyRot = (R, id, cls = "say") => ({ id, items: R.stories.map((s) => sayItem(s, cls)) });
  function strip(R, id, style) {
    return html`<div class="strip glass" data-beat-card style="${style}"><div><div class="ins-tag" style="white-space:normal">${storyLabel(R)}</div>${dotsFor(id, R.stories.length)}</div><div data-rot="${id}">${R.stories.length ? sayItem(R.stories[0]) : ""}</div></div>`;
  }

  // Field notes. Up to `max` handwritten notes, each in the gap between its
  // row's label and its player's number (so never over a portrait), marked
  // one of the layout's ways (`kinds`), no two alike while there are kinds to
  // go round. No two on one row or saying the same, none a row from another on its side.
  function innerNotes(R, keys, { kinds, max = 3 }) {
    const used = [];
    R.ins.filter((x) => x.row && x.note && x.side >= 0 && keys.includes(x.row)).forEach((x) => {
      const i = keys.indexOf(x.row);
      if (used.length < max && !used.some((n) => n.row === x.row || n.note === x.note || (n.side === x.side && Math.abs(keys.indexOf(n.row) - i) < 2))) used.push(x);
    });
    // Where the kinds start turns with the game, so the next game's notes are marked differently.
    const start = R.set ? 0 : R.last ? R.last.n : 0;
    const byRow = {};
    used.forEach((x, i) => { byRow[x.row] = { side: x.side, text: x.note, kind: kinds[(start + i) % kinds.length] }; });
    return { used, byRow };
  }
  // A note's own stroke, beside its words: an arrow out to the number, a star.
  const NOTE_MARK = {
    arrow: new Raw('<svg class="nm" width="38" height="22" viewBox="0 0 40 24"><path pathLength="1" data-draw d="M3 18 C 13 4, 26 2, 37 11"/><path pathLength="1" data-draw d="M30 5 L 37 11 L 28 14"/></svg>'),
    star: new Raw('<svg class="nm" width="24" height="24" viewBox="0 0 24 24"><path pathLength="1" data-draw d="M12 2.5 L17.6 20 L2.8 9.2 L21.2 9.2 L6.4 20 L12.5 3.6"/></svg>'),
  };
  // Or a stroke on the number itself, drawn once the words are written: circled, boxed, underlined.
  const numMark = (cls, vb, d) => new Raw(`<svg class="mk ${cls}" data-beat data-fx="draw" data-delay="360" viewBox="${vb}" preserveAspectRatio="none"><path pathLength="1" data-draw d="${d}"/></svg>`);
  const NUM_MARK = {
    circle: numMark("ring", "0 0 100 50", "M60 5 C 30 1, 3 11, 5 27 C 7 43, 42 49, 68 45 C 91 41, 99 29, 94 17 C 89 6, 68 2, 44 6"),
    box: numMark("box", "0 0 100 50", "M5 7 C 35 5, 70 6, 97 4 M 94 2 C 96 18, 95 34, 96 48 M 98 46 C 66 47, 34 46, 3 47 M 6 49 C 4 33, 5 18, 3 3"),
    swash: numMark("swash", "0 0 100 16", "M2 9 C 22 2, 46 15, 70 7 C 82 3, 92 5, 98 10 M 14 14 C 40 11, 66 15, 88 13"),
  };
  const noteIn = (n) => html`<div class="an ${n.side ? "r" : "l"} ${n.kind}" data-beat data-fx="write" data-delay="160">${NOTE_MARK[n.kind] || ""}<span class="hand" data-fitbox>${n.text}</span></div>`;
  const uline = (w) => html`<svg width="${w}" height="14" viewBox="0 0 ${w} 14"><path pathLength="1" data-draw d="M4 9 C ${w * 0.25} 2, ${w * 0.55} 13, ${w - 4} 4"/></svg>`;
  const stamp = (x, style, r) => html`<div data-beat data-fx="press" style="${style}"><div class="stamp-in" style="--r:${r}deg"><div class="ins-tag">${x.tag}</div><div class="ins-big num">${val(x)}</div><div class="ins-txt" data-fitbox>${x.text}</div>${x.who ? html`<div class="${whoCls(x)}" data-fit>${x.who}</div>` : ""}</div></div>`;
  const rest = (list, used) => list.filter((x) => !used.includes(x));

  // ── The layouts ─────────────────────────────────────────────────────────────

  const RANGER_MARKS = ["arrow", "star", "box"];
  const KEYS7 = ["kills", "damage", "opk", "dpo", "neutral", "punish", "lcancel"];

  const LAYOUTS = {
    /** Trail card: title, the summary in a lit strip, the ledger on frosted glass over big portraits, three callouts. */
    spotlight: {
      style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],
      // The face left of the ledger's glass (it starts at 318), not under its edge.
      por: { op: 0.78, tilt: "rotate(-3deg)", scale: 1.7, fx: 200, dy: 40, mask: FADE(30, 100) },
      // The house motion: the window rises out of the players bar, portraits slide in through its edges.
      motion: {},
      render(R) {
        const keys = keysFor(R, KEYS7);
        const minis = R.ins.slice(0, 3);
        return html`${title(R, at(368, 30, 800))}${corners(R)}
          ${strip(R, "story", at(318, 138, 900, 98))}
          <div class="surface glass sep-rows" data-beat-card style="${at(318, 250, 900)}padding:12px 30px 8px;--rh:56px;--gs:46px">${ledger(R, keys)}</div>
          <div style="${at(318, 702, 900, 130)}display:grid;grid-template-columns:repeat(3,1fr);gap:14px">${join(minis.map((x) => mini(x, "glass")))}</div>`;
      },
      rots: (R) => [storyRot(R, "story")],
    },

    /** Trail card: a tall card per player, their portrait fading into their own callouts; the ledger with share bars between. */
    players: {
      style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], noWinPor: true,
      por: [0, 0].map((dx) => ({ slot: "card", op: 0.9, w: 344, fx: 160, fy: 205, dx, scale: 0.95, tilt: "rotate(-3deg)", mask: "linear-gradient(180deg, #000 0%, #000 42%, transparent 76%)", wash: "none" })),
      // Each player's card stands up out of the players bar on their side, carrying their portrait.
      motion: { por: "ride" },
      render(R) {
        const keys = keysFor(R, ["kills", "damage", "opk", "dpo", "neutral", "counter", "earliest", "ipm"]);
        const both = R.ins.filter((x) => x.side < 0);
        const rails = [0, 1].map((s) => R.ins.filter((x) => x.side === s).concat(s ? both.slice(1) : both.slice(0, 1)).slice(0, 3));
        const rail = (side, l) => html`<div class="rail" data-beat-card data-fx="rise" data-delay="${side * 90 - 120}" style="${at(l, 34, 344, 796)}">${portrait(R, side, this.por)}${join(rails[side].map((x, i) => railMini(x, at(14, 386 + i * 134, 316, 126))))}</div>`;
        return html`${title(R, at(400, 30, 736))}${rail(0, 36)}${rail(1, 1156)}${cornersBottom(R, 28, 412)}
          <div class="surface" data-beat-card style="${at(408, 150, 720)}padding:12px 22px 0;--cols:104px 74px 1fr 74px 104px;--rh:58px;--gs:44px">${ledger(R, keys, { share: true })}
            <div class="foot-story">
              <div><div class="ins-tag">${R.set ? "The set" : "The story"}</div>${dotsFor("story", R.stories.length)}</div><div data-rot="story" style="flex:1">${R.stories.length ? sayItem(R.stories[0]) : ""}</div></div></div>`;
      },
      rots: (R) => [storyRot(R, "story")],
    },

    /** Field notes: the page is the window; portraits printed in the margins under handwritten notes. */
    margins: {
      style: "cream", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], skin: "page",
      por: { op: 0.66, tilt: "rotate(-3deg)", w: 520, fx: 200, fy: 340, scale: 1.75, mask: FADE(45, 100), wash: PAGE_WASH },
      // Printed and written, never slid: the margins' portraits uncovered from the page's edge.
      motion: { por: "wipe" },
      render(R) {
        const t = titles(R), rh = 58, L = 206, top = L + 24, M = 300;
        const keys = keysFor(R, ["kills", "damage", "combo", "opk", "neutral", "punish", "earliest"]);
        const notes = innerNotes(R, keys, { kinds: ["arrow", "circle", "swash"] });
        const stamps = rest(R.ins, notes.used).slice(0, 3);
        return html`<div class="rules" data-fx="rule" style="${at(0, top, 1536, keys.length * rh)}--rh:${rh}px"></div><div class="mrule" data-fx="rule" data-delay="120" style="left:${M}px"></div><div class="mrule" data-fx="rule" data-delay="120" style="right:${M}px"></div>
          <div class="htitle hand" data-beat data-fx="write" data-fit style="${at(M + 30, 34, 420)}white-space:nowrap">${t.title}${uline(250)}</div>
          <div class="eyebrow" data-beat data-fit style="right:${M + 30}px;top:60px;max-width:440px;text-align:right">${t.eyebrow}</div>
          <div data-rot="story" style="${at(M + 30, 116, 876, 86)}">${R.stories.length ? sayItem(R.stories[0], "hsay") : ""}</div>
          <div style="${at(M, L, 936)}--rh:${rh}px;--cols:88px 124px 1fr 124px 88px;--gs:46px">${ledger(R, keys, { inner: true, notes: notes.byRow })}</div>
          ${join(stamps.map((x, i) => stamp(x, at(331 + i * 298, 652, 278, 178), [-3, 2, -1.5][i])))}
          ${stageCorner(R, "left:30px;bottom:26px;max-width:236px", false, "stack")}${timeCorner(R, "right:30px;bottom:26px;max-width:236px", true, "stack")}`;
      },
      rots: (R) => [storyRot(R, "story", "hsay")],
    },

    /** Field notes: a cream form on a clipboard, the characters sketched on the paper; facts as form fields. */
    rangerlog: {
      style: "silSketch", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"], skin: "paper",
      por: { op: 0.88, tilt: "rotate(-4deg)", w: 470, fx: 170, fy: 330, scale: 1.6, mask: FADE(50, 98), wash: "none" },
      // The clip settles, the form is ruled, the sketches uncovered, the fields filled in by hand.
      motion: { por: "wipe" },
      render(R) {
        const t = titles(R), rh = 54, L = 180, top = L + 24, M = 308;
        const keys = keysFor(R, KEYS7);
        const notes = innerNotes(R, keys, { kinds: RANGER_MARKS });
        const boxes = rest(R.ins, notes.used).slice(0, 2);
        let reel = rest(R.ins, boxes);
        if (reel.length < 2) reel = R.ins;
        const box = (x, style) => html`<div data-beat style="${style}"><div class="box-in"><div class="ins-tag">${x.tag}</div><div class="ins-big num" style="margin-top:4px" data-fit>${val(x)}</div><div class="ins-txt" data-fitbox>${x.text}</div>${x.who ? html`<div class="${whoCls(x)}" data-fit>${x.who}</div>` : ""}</div></div>`;
        return html`<div class="clip" data-fx="settle" data-delay="-60" style="top:2px"></div>
          <div class="paper bare">
            <div class="rules" data-fx="rule" style="${at(0, top, 1492, keys.length * rh)}--rh:${rh}px"></div><div class="mrule" data-fx="rule" data-delay="120" style="left:${M}px"></div><div class="mrule" data-fx="rule" data-delay="120" style="right:${M}px"></div>
            <div class="eyebrow" data-beat data-fit style="${at(M + 30, 30, 360)}font-size:15px">${["Ranger log", R.d.round].filter(Boolean).join(" · ")}</div>
            <div class="htitle hand" data-beat data-fx="write" data-fit style="${at(M + 30, 54, 352)}font-size:56px;white-space:nowrap">${t.title}</div>
            <div class="facts-patch" data-beat data-fx="write" style="${at(740, 30, 440)}display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px">${join(R.facts.map((f) => html`<div class="field"><div class="lab" style="font-size:14px">${f.lab}</div><div class="fv hand" data-fit>${f.val}</div></div>`))}</div>
            <div style="${at(M + 10, L, 856)}--rh:${rh}px;--cols:80px 118px 1fr 118px 80px;--gs:42px">${ledger(R, keys, { share: true, inner: true, notes: notes.byRow })}</div>
            ${reel.length ? html`<div data-beat-card style="${at(M + 30, 598, 404, 192)}"><div class="box-in reel-in" style="display:flex;flex-direction:column;padding:12px 18px 10px"><div class="eyebrow" style="font-size:14px">Sighting of the ${R.set ? "set" : "game"}</div><div data-rot="reel" style="flex:1">${logItem(reel[0])}</div><div class="reel-foot"><div class="track"><i data-prog="reel"></i></div>${dotsFor("reel", reel.length)}</div></div></div>` : ""}
            ${join(boxes.map((x, i) => box(x, at(M + 448 + i * 221, 598, 207, 192))))}
          </div>`;
      },
      rots(R) {
        const notes = innerNotes(R, keysFor(R, KEYS7), { kinds: RANGER_MARKS }).used;
        const boxes = rest(R.ins, notes).slice(0, 2);
        let reel = rest(R.ins, boxes);
        if (reel.length < 2) reel = R.ins;
        return [{ id: "reel", items: reel.map(logItem) }];
      },
    },
  };
  function logItem(x) {
    return html`<div style="display:grid;grid-template-columns:124px minmax(0,1fr);gap:14px;align-items:center;height:100%"><div class="rb num" data-beat data-fit>${val(x)}</div><div><div class="ins-tag" data-beat data-fit>${x.tag}</div><div class="rt hand" data-beat data-fitbox>${x.text}</div><div class="${whoCls(x)}" data-beat data-fit>${x.who}</div></div></div>`;
  }
  // The Tale of the tape's band: the summaries and the callouts' long forms in
  // turn (a summary, then two callouts), each a stub (its title, its number,
  // whose it is, an arrow toward their side) beside its sentence.
  const TAPE_MAX = 12;
  function tapeItems(R) {
    const S = R.stories, I = R.ins;
    const out = [];
    let s = 0, i = 0;
    while (out.length < TAPE_MAX && (s < S.length || i < I.length)) {
      if ((out.length % 3 === 0 && s < S.length) || i >= I.length) out.push(tapeStory(R, S[s++]));
      else out.push(tapeCall(I[i++]));
    }
    return out;
  }
  const tapeItem = (cls, tag, big, who, say) => html`<div class="tb ${cls}"><div class="tb-stub"><div class="ins-tag" data-beat data-fit>${tag}</div><div class="tb-big num" data-beat data-fit>${big}</div>${who ? html`<div class="ins-who tb-who" data-beat>${who}</div>` : ""}</div><div class="tb-say" data-beat data-fitbox>${say}</div></div>`;
  const tapeCall = (x) => tapeItem(x.side === 0 ? "l" : x.side === 1 ? "r" : "", x.tag, val(x), x.side >= 0 ? html`<span data-fit>${x.who}</span>` : "", x.long ? story(x.long) : x.text);
  function tapeStory(R, segs) {
    const sc = R.d.score || [0, 0];
    const when = R.set ? (R.over ? "Final" : "So far") : `After game ${R.last ? R.last.n : ""}`;
    return tapeItem("story", R.set ? "The set" : "The story", `${sc[0]}–${sc[1]}`, when, story(segs));
  }

  const KEYS8 = ["kills", "damage", "opk", "dpo", "neutral", "punish", "earliest", "lcancel"];

  Object.assign(LAYOUTS, {
    /** A boxing poster: one narrow glass column of big numbers either side of a tug-of-war bar, the portraits filling each half; a rotating highlight band along the foot. */
    tape: {
      style: "riso", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"],
      por: { op: 0.72, tilt: "rotate(-3deg)", scale: 2.15, dy: 70, mask: FADE(38, 100) },
      // A face-off: the fighters walk out first, then each row's numbers close in from their own corner.
      motion: { por: "walkout", lead: 260 },
      render(R) {
        const keys = keysFor(R, KEYS8);
        const band = tapeItems(R);
        const row = (key) => {
          const w = R.lead(key);
          return html`<div class="tape-row" data-beat data-fx="converge"><div class="tv num l ${leadCls(w, 0)}">${R.big(key, 0)}</div><div class="tk"><div class="lab">${R.ST[key].label}</div>${shareBar(R, key)}</div><div class="tv num r ${leadCls(w, 1)}">${R.big(key, 1)}</div></div>`;
        };
        return html`${title(R, at(368, 24, 800))}${corners(R)}
          <div class="surface glass" data-beat-card style="${at(474, 132, 588, 548)}padding:6px 22px">${join(keys.map(row))}</div>
          ${band.length ? html`<div class="tape-band" data-beat-card data-fx="rise" style="${at(328, 698, 880, 126)}"><div data-rot="tape">${band[0]}</div>
            ${dotsFor("tape", band.length)}<div class="track"><i data-prog="tape"></i></div></div>` : ""}`;
      },
      rots: (R) => [{ id: "tape", items: tapeItems(R) }],
    },

    /** Field notes: each player's portrait as a taped instant photo, their best callout as its caption; the ledger on ruled lines between. */
    polaroids: {
      style: "plain", packs: ["CSProject_MeleeFull", "portrait", "CSProject_AltFull", "full"], skin: "page", noWinPor: true,
      // Head and shoulders, like a photo of someone: the face a little above the middle.
      por: [0, 0].map((dx) => ({ slot: "card", op: 1, w: 308, fx: 142, fy: 132, dx, scale: 0.92, tilt: "none", mask: "none", wash: "linear-gradient(0deg, rgba(0,0,0,0.25), transparent 40%)" })),
      // Photos tossed onto the page, developing as they land.
      motion: { por: "develop" },
      render(R) {
        const t = titles(R), rh = 56, L = 214, top = L + 24;
        const keys = keysFor(R, KEYS7);
        const best = (s) => R.ins.find((x) => x.side === s) || null;
        const used = [best(0), best(1)];
        const snap = (s, l, r) => {
          const x = used[s];
          return html`<div data-beat-card data-fx="toss" data-toss="${r}" data-delay="${s * 110 - 120}" style="${at(l, 170, 330, 476)}"><div class="polaroid" style="--r:${r}deg"><div class="ph">${portrait(R, s, this.por)}</div>
            ${x ? html`<div class="pcap hand" data-fitbox><span class="pbig num">${val(x)}</span> ${x.tag.toLowerCase()}<small>${x.text}</small></div>` : ""}</div></div>`;
        };
        return html`<div class="rules" data-fx="rule" style="${at(0, top, 1536, keys.length * rh)}--rh:${rh}px"></div>
          <div class="htitle hand" data-beat data-fx="write" data-fit style="${at(430, 30, 350)}white-space:nowrap">${t.title}${uline(250)}</div>
          <div class="eyebrow" data-beat data-fit style="right:430px;top:58px;max-width:310px;text-align:right">${t.eyebrow}</div>
          <div data-rot="story" style="${at(430, 112, 676, 90)}">${R.stories.length ? sayItem(R.stories[0], "hsay") : ""}</div>
          ${snap(0, 64, -4)}${snap(1, 1142, 3.5)}
          <div style="${at(420, L, 696)}--rh:${rh}px;--cols:108px 80px 1fr 80px 108px;--gs:42px">${ledger(R, keys)}</div>
          ${join(rest(R.ins, used).slice(0, 3).map((x, i) => stamp(x, at(422 + i * 236, 648, 220, 176), [-2.5, 1.5, -1][i])))}`;
      },
      rots: (R) => [storyRot(R, "story", "hsay")],
    },

    /** Only the bottom third: the game or the players' cam stays in view above it. The summary across the top, the ledger in two short columns, the facts as one line. */
    lowerthird: {
      style: "riso", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], win: { l: 192, t: 618, w: 1536, h: 372 },
      // A short window: a close-up, the face low enough that a head never meets its top edge.
      por: { op: 0.85, tilt: "rotate(-3deg)", scale: 1.4, w: 480, fx: 180, fy: 165, mask: FADE(42, 100) },
      // A broadcast bar: it opens from its middle, and its rows run in from the left.
      motion: { win: "wipe", rows: "slide" },
      render(R) {
        const keys = keysFor(R, KEYS8);
        const half = (ks, l) => html`<div class="surface glass sep-rows lt-half" data-beat-card style="${at(l, 104, 452)}padding:6px 18px 4px;--rh:46px;--gs:33px;--cols:86px 68px 1fr 68px 86px">${ledger(R, ks)}</div>`;
        return html`<div class="strip glass" data-beat-card style="${at(310, 18, 916, 74)}grid-template-columns:150px 1fr"><div><div class="ins-tag" style="white-space:normal">${titles(R).title}</div>${dotsFor("story", R.stories.length)}</div><div data-rot="story">${R.stories.length ? sayItem(R.stories[0]) : ""}</div></div>
          ${half(keys.slice(0, 4), 310)}${half(keys.slice(4), 774)}
          <div class="lt-facts" data-beat style="${at(310, 326, 916, 30)}">${join(R.facts.map((f) => html`<span><b>${f.lab}</b> ${f.val}</span>`))}</div>`;
      },
      rots: (R) => [storyRot(R, "story")],
    },

    /**
     * Round the Players bar, the middle left clear for the cam: a small column
     * of the head-to-head out of the round card, each player's own numbers and
     * callouts standing on their name card, the title, summary, stages and
     * length along the top, and the portraits bookending the bar's corners
     * (cut where the name cards are, so each stands behind its card's outer end).
     * The window is the whole frame, with no background; each piece is its own
     * plate. Positions are the frame's: they match /o/scoreboard/players.
     */
    condensed: {
      style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], skin: "bare", win: { l: 0, t: 0, w: 1920, h: 1080 },
      // Standing in the corner beside the card, the face well above the bar; faded off before the stack's plates.
      por: { op: 1, tilt: "none", w: 430, fx: 150, fy: 812, scale: 1.05, mask: FADE(62, 100), wash: "none" },
      // Everything from the outside in: the column and stacks up out of the bar's
      // cards, the top band down from the top edge, the corners in from their
      // sides, the portraits in through the frame's edges. No window motion.
      motion: { win: "none" },
      render(R) {
        const t = titles(R);
        const mid = pickKeys(R, ["kills", "damage", "opk", "neutral"], 4);
        const own = pickKeys(R, ["punish", "lcancel", "ipm", "combo", "avgkill", "earliest", "counter", "dpo"], 3, mid);
        // One plate, one entrance: what's inside rides in with it (data-carry).
        const piece = (cls, style, fx, delay, inner, from = "") => html`<div class="cz ${cls}" data-beat-card data-carry data-fx="${fx}" data-delay="${delay}" ${from ? new Raw(`data-from="${from}"`) : ""} style="${style}">${inner}</div>`;
        const chip = (key, s) => html`<div class="cz-chip ${leadCls(R.lead(key), s)}"><div class="cz-v num" data-fit>${R.big(key, s)}</div><div class="lab" data-fit>${R.ST[key].label}</div></div>`;
        // A callout card like the minis: the title across the top, the number (on the outer side) beside its line.
        const acc = (x) => html`<div class="cz-in"><div class="ins-tag" data-fit>${x.tag}</div><div class="ins-big num" data-fit>${val(x)}</div><div class="ins-txt" data-fitbox>${x.text}</div></div>`;
        // Each player's stack stands on the inner part of their card (the outer end is the portrait's).
        const stack = (s) => {
          const l = s ? CZ.p2[0] : CZ.p1[1] - CZ.stackW;
          const keys = s ? own.slice().reverse() : own; // mirrored, so each stat sits the same way from the middle
          const mine = R.ins.filter((x) => x.side === s).slice(0, 2);
          return html`${piece(`cz-chips ${s ? "r" : "l"}`, at(l, CZ.foot - 62, CZ.stackW, 62), "emerge", -100, join(keys.map((k) => chip(k, s))))}
            ${join(mine.map((x, i) => piece(`cz-acc ${s ? "r" : "l"}`, at(l, CZ.foot - 62 - 12 - 92 - i * 104, CZ.stackW, 92), "emerge", -40 + i * 40, acc(x))))}`;
        };
        const row = (key) => {
          const w = R.lead(key);
          return html`<div class="cz-row"><div class="v num l ${leadCls(w, 0)}" data-fit>${R.big(key, 0)}</div><div class="lab" data-fit>${R.ST[key].label}</div><div class="v num r ${leadCls(w, 1)}" data-fit>${R.big(key, 1)}</div>${shareBar(R, key)}</div>`;
        };
        const colH = 38 + mid.length * 48;
        const fx = (from, delay) => new Raw(`data-fx="inward" data-from="${from}" data-delay="${delay}"`);
        return html`${piece("cz-title", at(670, 22, 580, 80), "inward", -60, html`<div class="eyebrow" data-fit>${t.eyebrow}</div><div class="t" data-fit>${t.title}</div>`, "t")}
          ${R.stories.length ? piece("cz-story", at(530, 114, 860, 94), "inward", 0, html`<div data-rot="story">${sayItem(R.stories[0])}</div>${R.stories.length > 1 ? html`<div class="track"><i data-prog="story"></i></div>` : ""}`, "t") : ""}
          ${stageCorner(R, "left:40px;top:30px", false, "", fx("l", 80))}${timeCorner(R, "right:40px;top:30px", true, "", fx("r", 80))}
          ${piece("cz-mid", at(CZ.mid[0], CZ.foot - colH, CZ.mid[1] - CZ.mid[0], colH), "emerge", -140, html`<div class="cz-cap lab">${R.set ? (R.over ? "The set" : "The set so far") : `Game ${R.last ? R.last.n : ""}`}</div>${join(mid.map(row))}`)}
          ${stack(0)}${stack(1)}`;
      },
      rots: (R) => [storyRot(R, "story")],
    },
  });

  // The Players bar (/o/scoreboard/players), in the frame: the name cards and
  // the round card between them, and where the condensed pieces stand on them.
  const CZ = { p1: [164, 714], p2: [1206, 1756], mid: [815, 1105], foot: 992, stackW: 414 };
  /** `n` of the keys a layout asks for that the set has, none of `not`, topped up from the rest. */
  function pickKeys(R, prefer, n, not = []) {
    return prefer.concat(FALLBACK).filter((k, i, all) => R.rows[k] && !not.includes(k) && all.indexOf(k) === i).slice(0, n);
  }

  /**
   * Each side's portrait from the chosen pack, each game's stage picture from
   * the first installed stage set (or a source's ?stages=): the app sends one
   * from every installed pack and set (lib/set-stats/portraits.js), by id, the
   * dock's order first. One that isn't there (not downloaded, or no picture of
   * this character or stage) falls back to the first that is; with nothing
   * installed there's no picture, and stages "none" draws none.
   */
  /** Pack "random": random poses (randomPair). */
  const RANDOM = "random";
  /** The first of `ids` (a pack id, or a list best first) that `all` has, else its first. */
  const pickId = (all, ids) => {
    if (!all) return null;
    for (const id of [].concat(ids || [])) if (all[id]) return id;
    return Object.keys(all)[0] || null;
  };
  const pick = (all, id) => { const k = pickId(all, id); return k ? all[k] : null; };
  /**
   * A side whose pose can't be drawn looking inward (`ok` says no: it looks
   * outward and carries lettering, portrait-fit.js `o`) takes the next pack that
   * has the character — `alts` (the layout's own order), then any installed.
   * So does the right side of a mirror match (the same character on both
   * sides), which would otherwise draw the left's pose twice. Either way the
   * style stays, so the two still read as one picture; with no other pack, the
   * picked one is drawn.
   */
  const isMirror = (d) => {
    const cs = d.sides.map((s) => s && s.character && s.character.codename);
    return d.sides.length === 2 && !!cs[0] && cs[0] === cs[1];
  };

  /** A seeded random number in [0, 1) (mulberry32): one seed, the same picks, in every source and every redraw. */
  function seeded(seed) {
    let a = (Number(seed) >>> 0) || 1;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Random poses (pack "random"): a pack per side, picked by the show's seed
   * (director.js `statsShot.seed`), so it stays put for the whole show and
   * changes at the next. Only the full-body renders — a bust pack (`cut`, the
   * select screen's square crops) never — and both sides from one family of
   * renders (portraits.js `family`: CSProject's two pose sets are one, the VS
   * screen's another), so the two read as one picture. Every pair that can be
   * drawn is as likely: each pose looks inward (`ok`) and a mirror match's two
   * differ. A side with no character takes nothing; null when no pair can be
   * drawn (the caller's pack order then).
   * @returns {Array<string|null>|null} a pack id per side
   */
  function randomPair(d, seed, ok) {
    if (!d || !Array.isArray(d.sides) || d.sides.length !== 2) return null;
    const mirror = isMirror(d);
    const cands = d.sides.map((s, i) => {
      const all = s && s.portraits;
      if (!all) return [null];
      return Object.keys(all).filter((id) => all[id] && !all[id].cut && ok(id, all[id], i));
    });
    const fam = (i, id) => d.sides[i].portraits[id].family || id;
    const pairs = [];
    for (const a of cands[0]) for (const b of cands[1]) {
      if (a && b && (fam(0, a) !== fam(1, b) || (mirror && a === b))) continue;
      if (a || b) pairs.push([a, b]);
    }
    return pairs.length ? pairs[Math.min(pairs.length - 1, Math.floor(seeded(seed)() * pairs.length))] : null;
  }

  /** Style "random": any style, picked by the show's seed (salted, so it doesn't follow the random poses' pick). */
  function randomStyle(seed) {
    const ids = Object.keys(STYLES);
    return ids[Math.min(ids.length - 1, Math.floor(seeded((Number(seed) || 0) ^ 0x5bd1e995)() * ids.length))];
  }

  function withPack(d, pack, stages, alts, ok = () => true, pair = null) {
    if (!d || !Array.isArray(d.sides)) return d;
    const mirror = isMirror(d);
    let left = null;
    return Object.assign({}, d, {
      sides: d.sides.map((s, i) => {
        const all = s && s.portraits;
        let k = pair && pair[i] && all && all[pair[i]] ? pair[i] : pickId(all, pack);
        const good = (id) => !!all[id] && ok(id, all[id], i) && !(i === 1 && mirror && id === left);
        if (k && !good(k)) {
          const other = [].concat(pack || [], alts || [], Object.keys(all)).find(good);
          if (other) k = other;
        }
        if (i === 0) left = k;
        return Object.assign({}, s, { portrait: k ? Object.assign({ pack: k }, all[k]) : null });
      }),
      games: (d.games || []).map((g) => (g && g.stage ? Object.assign({}, g, {
        stage: Object.assign({}, g.stage, { pic: stages === "none" ? null : pick(g.stage.pics, stages) }),
      }) : g)),
    });
  }

  /**
   * What "auto" means for one layout: the operator's saved combo for it, else
   * its best fit (style, packs best first). Shared by the overlay and the dock's
   * labels, so they agree. Pack "random" (picked, or saved in the combo) is
   * random poses (`random`), in the same style; `packs` is then the order a
   * show with no pair to draw falls back to.
   * @param {string} layout @param {{ style?, pack?, combos? }} cfg
   * @returns {{ style: string, packs: string[], random: boolean, saved: boolean }}
   */
  function bestFit(layout, cfg = {}) {
    const L = LAYOUTS[layout] || LAYOUTS.spotlight;
    const fav = cfg.combos && cfg.combos[layout];
    const known = (s) => s === RANDOM || !!STYLES[s];
    const style = cfg.style && cfg.style !== "auto" && known(cfg.style) ? cfg.style : fav && known(fav.style) ? fav.style : L.style;
    const picked = cfg.pack && cfg.pack !== "auto" ? cfg.pack : fav && fav.pack ? fav.pack : null;
    const random = picked === RANDOM;
    const real = (id) => id && id !== RANDOM;
    const packs = real(cfg.pack) && cfg.pack !== "auto" ? [cfg.pack] : fav && real(fav.pack) ? [fav.pack, ...L.packs] : L.packs;
    return { style, packs, random, saved: !!fav };
  }

  /**
   * One layout, drawn: the window's skin, its portraits (if the layout puts
   * them behind everything), the content, and the rotating sections.
   * @param {object} d — setStats
   * @param {{ layout: string, style: string, mode: "game"|"set", pack?: string, stages?: string, combos?: object, fit?: object, seed?: number }} o — style / pack "auto" = the layout's
   *   best fit (`combos[layout]` if saved, else its own); style "random" = one picked by `seed`; pack = a portrait pack id, or "random" (random poses, picked by `seed`);
   *   stages = a stage set id (unset: the first installed), or "none"; fit = a portrait-fit map to use instead of the file's (the tuning page)
   * @returns {{ skin: string, portraits: string, content: string, rots: Array<{ id, items: string[] }>, style: string }}
   */
  function render(d, o) {
    const id = LAYOUTS[o.layout] ? o.layout : "spotlight", L = LAYOUTS[id];
    const fit = bestFit(id, o);
    // Style "random": one per show, from its seed, so every source draws the same.
    const style = fit.style === RANDOM ? randomStyle(o.seed) : fit.style;
    // A pose that can't look inward (lettering that can't be mirrored) gives way to the next pack's.
    const inward = (pack, src, side) => {
      const P = Array.isArray(L.por) ? L.por[side] : L.por;
      return !Fit || !Fit.tweak(pack, src.char, id, (P && P.slot) || "edge", o.fit).o;
    };
    const pair = fit.random ? randomPair(d, o.seed, inward) : null;
    const R = reader(withPack(d, fit.packs, o.stages, L.packs, inward, pair), { mode: o.mode, style });
    R.layout = id;
    R.fit = o.fit;
    const portraits = L.noWinPor ? "" : html`${portrait(R, 0, L.por)}${portrait(R, 1, L.por)}`;
    return {
      skin: L.skin || "",
      win: L.win || null, // a window of its own size and place ({ l, t, w, h }); null = the full one
      motion: L.motion || {}, // how it moves (set-stats.js): { win, por, rows, lead }
      style,
      portraits: esc(portraits),
      content: esc(L.render(R)),
      rots: (L.rots ? L.rots(R) : []).filter((r) => r.items.length > 1).map((r) => ({ id: r.id, items: r.items.map(esc) })),
    };
  }

  return { render, bestFit, LAYOUTS, STYLES, html, esc };
});
