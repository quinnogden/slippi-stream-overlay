/**
 * layouts.js — the stats popup's layouts and picture styles. Pure: from the
 * app's `setStats` section and the popup's settings to markup, plus the small
 * rotating sections each layout runs. set-stats.js puts it on screen and
 * animates it. Loaded by the page and by Node (tests/set-stats.test.js).
 *
 * Every layout reads the same view: the ledger rows (`rows[key].g` the game
 * just played, `.s` the set, `.pg` each game), the callouts (`insights`), the
 * summaries (`stories`, segments: { t } text, { em } lit) and the `facts`,
 * each in two readings — "game" (after a game) and "set" (the wrap-up).
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
    return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
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
  // blur; img takes mask. opK scales the layout's portrait opacity.

  const STYLES = {
    cream:    { pieces: [{ img: 1, filter: "grayscale(1) sepia(0.55) brightness(0.95)" }] },
    scan:     { opK: 1.1, pieces: [
      { img: 1, filter: "saturate(0.85) contrast(1.12)" },
      { img: 1, filter: "sepia(1) saturate(5) hue-rotate(-25deg)", blend: "screen", o: 0.4, off: [7, 0] },
      { fill: "repeating-linear-gradient(180deg, rgba(4,10,12,0.6) 0 2px, transparent 2px 5px)" }] },
    halftone: { opK: 1.25, pieces: [
      { img: 1, filter: "grayscale(1) brightness(0.55)", o: 0.4 },
      { img: 1, filter: "grayscale(1) sepia(0.7) contrast(1.45) brightness(1.2)", mask: "radial-gradient(circle, #000 2.4px, transparent 3.1px) 0 0 / 8px 8px" }] },
    riso:     { opK: 1.3, pieces: [
      { img: 1, filter: "grayscale(1) contrast(1.35) brightness(1.08)" },
      { fill: "#16404a", blend: "lighten" },
      { fill: "#f09a4c", blend: "multiply", off: [6, 4] }] },
    silRim:   { opK: 1.7, pieces: [
      { fill: "rgba(224,138,60,0.30)", blur: 46 },
      { fill: "#f2a65a", off: [4, -3] },
      { fill: "#0d1f25" },
      { img: 1, filter: "grayscale(1) brightness(1.6) contrast(1.3)", blend: "screen", o: 0.1 }] },
    silLine:  { opK: 1.7, pieces: [
      { fill: "#e08a3c", off: [-3, 0] }, { fill: "#e08a3c", off: [3, 0] }, { fill: "#e08a3c", off: [0, -3] }, { fill: "#e08a3c", off: [0, 3] },
      { fill: "linear-gradient(180deg, #13282f, #0b1a1f 70%)" },
      { img: 1, filter: "grayscale(1) brightness(1.5)", blend: "screen", o: 0.08 }] },
    silCream: { opK: 1.2, pieces: [
      { fill: "linear-gradient(180deg, rgba(245,219,162,0.95) 0%, rgba(245,219,162,0.75) 45%, rgba(224,138,60,0.55) 100%)" },
      { img: 1, filter: "grayscale(1) contrast(1.6) brightness(1.05)", blend: "multiply", o: 0.55 }] },
    silSketch:{ opK: 1.1, pieces: [
      { fill: "#b0581a", off: [-2.5, 0] }, { fill: "#b0581a", off: [2.5, 0] }, { fill: "#b0581a", off: [0, -2.5] }, { fill: "#b0581a", off: [0, 2.5] },
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
  const storyLabel = (R) => (R.set ? `The set · ${R.d.total} games` : `The story of game ${R.last ? R.last.n : ""}`);
  const story = (segs) => join((segs || []).map((s) => (s.em != null ? html`<em>${s.em}</em>` : s.t)));
  const val = (x) => html`${x.big}${x.unit ? html`<span class="u">${x.unit}</span>` : ""}`;
  const edge = (x) => (x.side === 0 ? "e-l" : x.side === 1 ? "e-r" : "");

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
      return html`<div class="pc" style="${css.join(";")}">${inner}</div>`;
    });
    const style = `--op:${op};opacity:${op};--mask:${P.mask || "linear-gradient(90deg, #000 0%, rgba(0,0,0,0.7) 35%, rgba(0,0,0,0.25) 70%, transparent 96%)"};`
      + `${P.wash ? `--wash:${P.wash};` : ""}${P.w ? `width:${P.w}px;` : ""}${P.blend ? `mix-blend-mode:${P.blend};` : ""}`;
    return html`<div class="por ${pos} ${role}" data-base="${pos === "r" ? "scaleX(-1)" : ""}" ${P.still ? "" : new Raw("data-por")} style="${style}">
      <div class="por-in" style="transform:${P.tilt || "none"};${shadow ? `filter:${shadow};` : ""}${cut}">${join(pieces)}</div></div>`;
  }

  // ── Pieces ──────────────────────────────────────────────────────────────────

  const title = (R, style) => { const t = titles(R); return html`<div class="ttl" style="${style}"><div class="eyebrow" data-beat data-fit>${t.eyebrow}</div><div class="title" data-beat>${t.title}</div></div>`; };

  function stageCorner(R, style, r) {
    const games = R.d.games;
    if (!R.set) {
      const s = R.last.stage || {};
      return html`<div class="corner ${r ? "r" : ""}" data-corner style="${style}">
        ${s.pic ? html`<div class="thumb" style="background-image:url('${s.pic}')"></div>` : ""}
        <div><div class="lab">Stage</div><div class="cval" data-fit>${s.name || "—"}</div></div></div>`;
    }
    const counts = {};
    games.forEach((g) => { if (g.stage && g.stage.name) counts[g.stage.name] = (counts[g.stage.name] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const pics = games.filter((g) => g.stage && g.stage.pic);
    return html`<div class="corner ${r ? "r" : ""}" data-corner style="${style}">
      ${pics.length ? html`<div class="thumbs">${join(pics.map((g) => html`<div class="thumb" style="background-image:url('${g.stage.pic}')"></div>`))}</div>` : ""}
      <div><div class="lab">${games.length} ${games.length === 1 ? "stage" : "stages"}</div><div class="cval" data-fit>${top ? `${top[0]}${top[1] > 1 ? ` ×${top[1]}` : ""}` : "—"}</div></div></div>`;
  }
  function timeCorner(R, style, r = true) {
    const total = R.d.games.reduce((t, g) => t + (g.seconds || 0), 0);
    const len = R.set ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}` : R.last.len;
    return html`<div class="corner ${r ? "r" : ""}" data-corner style="${style}">
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
  function rowLedger(R, key, opts = {}) {
    const st = R.ST[key], w = R.lead(key);
    return html`<div class="lr" data-beat>
      <div class="g num l ${leadCls(w, 0)}">${w === 0 ? pip : ""}${R.big(key, 0)}</div><div class="s num">${R.small(key, 0)}</div>
      <div class="k"><div class="lab">${st.label}</div>${st.hint && !opts.share ? html`<div class="hint">${st.hint}</div>` : ""}</div>
      <div class="s num">${R.small(key, 1)}</div><div class="g num r ${leadCls(w, 1)}">${R.big(key, 1)}${w === 1 ? pip : ""}</div>${opts.share ? shareBar(R, key) : ""}</div>`;
  }
  function ledgerCap(R) {
    const a = R.set ? "Set" : `Game ${R.last.n}`, b = R.set ? "By game" : "Set";
    return html`<div class="cap" data-beat><div class="lab" style="text-align:right">${a}</div><div class="lab" style="text-align:center">${b}</div><div></div><div class="lab" style="text-align:center">${b}</div><div class="lab">${a}</div></div>`;
  }
  const ledger = (R, keys, opts) => html`${ledgerCap(R)}${join(keys.map((k) => rowLedger(R, k, opts)))}`;

  // Callouts, the spotlight strip, the highlight reel.
  const mini = (x, cls = "", style = "") => html`<div class="mini ${edge(x)} ${cls}" data-beat style="${style}"><div class="ins-big num">${val(x)}</div><div><div class="ins-tag">${x.tag}</div><div class="ins-txt" data-fitbox>${x.text}</div><div class="ins-who">${x.who}</div></div></div>`;
  const railMini = (x, style) => html`<div class="mini glass ${edge(x)}" data-beat style="${style}"><div class="ins-big num">${val(x)}</div><div><div class="ins-tag">${x.tag}</div><div class="ins-txt" data-fitbox>${x.text}</div></div></div>`;
  const sayItem = (segs, cls = "say") => html`<div class="${cls}" data-beat data-fitbox>${story(segs)}</div>`;
  const dotsFor = (id, n) => html`<div class="dots" data-dots="${id}">${join(Array.from({ length: n }, (_, i) => html`<i class="${i === 0 ? "on" : ""}"></i>`))}</div>`;
  const storyRot = (R, id, cls = "say") => ({ id, items: R.stories.map((s) => sayItem(s, cls)) });
  function strip(R, id, style) {
    return html`<div class="strip glass" data-beat-card style="${style}"><div><div class="ins-tag" style="white-space:normal">${storyLabel(R)}</div>${dotsFor(id, R.stories.length)}</div><div data-rot="${id}">${R.stories.length ? sayItem(R.stories[0]) : ""}</div></div>`;
  }

  // Field notes. A note goes in its player's margin, beside its row — never
  // over that player's face (`faces`: each side's face height, window px).
  function marginNotes(R, keys, firstRowTop, rh, { lx, rx, max = 4, faces = [] } = {}) {
    const notes = [];
    const clear = (x, i) => faces[x.side] == null || Math.abs(firstRowTop + i * rh + rh / 2 - faces[x.side]) > FACE_CLEAR;
    R.ins.filter((x) => x.row && x.note && x.side >= 0 && keys.includes(x.row)).forEach((x) => {
      const i = keys.indexOf(x.row);
      if (notes.length < max && clear(x, i) && !notes.some((n) => n.side === x.side && Math.abs(keys.indexOf(n.row) - i) < 2)) notes.push(x);
    });
    const arrow = new Raw('<svg width="40" height="24" viewBox="0 0 40 24"><path d="M3 18 C 13 4, 26 2, 37 11"/><path d="M30 5 L 37 11 L 28 14"/></svg>');
    return {
      used: notes,
      markup: join(notes.map((x) => {
        const top = firstRowTop + keys.indexOf(x.row) * rh + rh / 2 - 22;
        return html`<div class="fn hand ${x.side ? "r" : ""}" data-beat style="top:${top}px;${x.side ? `right:${rx}px` : `left:${lx}px`}"><span>${x.note}</span>${arrow}</div>`;
      })),
    };
  }
  /** How far (px) a margin note's middle stays from a face's height: about a head. */
  const FACE_CLEAR = 110;
  /** Each side's face height in the window (a box offset `top` added), for the notes to keep clear of. */
  const faceHeights = (R, P, top = 0) => [0, 1].map((s) => { const p = placed(R, s, P); return p ? p.fy + top : null; });
  const uline = (w) => html`<svg width="${w}" height="14" viewBox="0 0 ${w} 14"><path d="M4 9 C ${w * 0.25} 2, ${w * 0.55} 13, ${w - 4} 4"/></svg>`;
  const stamp = (x, style, r) => html`<div data-beat style="${style}"><div class="stamp-in" style="--r:${r}deg"><div class="ins-tag">${x.tag}</div><div class="ins-big num">${val(x)}</div><div class="ins-txt" data-fitbox>${x.text}${x.side >= 0 ? ` · ${x.who}` : ""}</div></div></div>`;
  const rest = (list, used) => list.filter((x) => !used.includes(x));

  // ── The layouts ─────────────────────────────────────────────────────────────

  const KEYS7 = ["kills", "damage", "opk", "dpo", "neutral", "punish", "lcancel"];

  const LAYOUTS = {
    /** Trail card: title, the summary in a lit strip, the ledger on frosted glass over big portraits, three callouts. */
    spotlight: {
      style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],
      // The face left of the ledger's glass (it starts at 318), not under its edge.
      por: { op: 0.78, tilt: "rotate(-3deg)", scale: 1.7, fx: 200, dy: 40, mask: FADE(30, 100) },
      render(R) {
        const keys = keysFor(R, KEYS7);
        const minis = R.ins.slice(0, 3);
        return html`${title(R, at(368, 30, 800))}${corners(R)}
          ${strip(R, "story", at(318, 138, 900, 98))}
          <div class="surface glass sep-rows" data-beat-card style="${at(318, 250, 900)}padding:12px 30px 8px;--rh:54px">${ledger(R, keys)}</div>
          <div style="${at(318, 698, 900, 100)}display:grid;grid-template-columns:repeat(3,1fr);gap:14px">${join(minis.map((x) => mini(x, "glass")))}</div>`;
      },
      rots: (R) => [storyRot(R, "story")],
    },

    /** Trail card: a tall card per player, their portrait fading into their own callouts; the ledger with share bars between. */
    players: {
      style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], noWinPor: true,
      por: [0, 0].map((dx) => ({ slot: "card", op: 0.9, w: 344, fx: 160, fy: 205, dx, scale: 0.95, tilt: "rotate(-3deg)", mask: "linear-gradient(180deg, #000 0%, #000 42%, transparent 76%)", wash: "none" })),
      render(R) {
        const keys = keysFor(R, ["kills", "damage", "opk", "dpo", "neutral", "counter", "earliest", "ipm"]);
        const both = R.ins.filter((x) => x.side < 0);
        const rails = [0, 1].map((s) => R.ins.filter((x) => x.side === s).concat(s ? both.slice(1) : both.slice(0, 1)).slice(0, 3));
        const rail = (side, l) => html`<div class="rail" data-beat-card style="${at(l, 34, 344, 796)}">${portrait(R, side, this.por)}${join(rails[side].map((x, i) => railMini(x, at(14, 404 + i * 128, 316, 116))))}</div>`;
        return html`${title(R, at(400, 30, 736))}${rail(0, 36)}${rail(1, 1156)}${cornersBottom(R, 28, 412)}
          <div class="surface" data-beat-card style="${at(408, 150, 720)}padding:12px 22px 0;--cols:96px 70px 1fr 70px 96px;--rh:58px;--gs:38px">${ledger(R, keys, { share: true })}
            <div class="foot-story">
              <div><div class="ins-tag">${R.set ? "The set" : "The story"}</div>${dotsFor("story", R.stories.length)}</div><div data-rot="story" style="flex:1">${R.stories.length ? sayItem(R.stories[0]) : ""}</div></div></div>`;
      },
      rots: (R) => [storyRot(R, "story")],
    },

    /** Field notes: the page is the window; halftone portraits printed in the margins under handwritten notes. */
    margins: {
      style: "cream", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], skin: "page",
      por: { op: 0.66, tilt: "rotate(-3deg)", w: 520, fx: 200, fy: 340, scale: 1.75, mask: FADE(45, 100), wash: PAGE_WASH },
      render(R) {
        const t = titles(R), rh = 56, L = 206, top = L + 24, M = 300;
        const keys = keysFor(R, ["kills", "damage", "combo", "opk", "neutral", "punish", "earliest"]);
        const notes = marginNotes(R, keys, top, rh, { lx: M - 146, rx: M - 146, faces: faceHeights(R, this.por) });
        const stamps = rest(R.ins, notes.used).slice(0, 3);
        return html`<div class="rules" style="${at(0, top, 1536, keys.length * rh)}--rh:${rh}px"></div><div class="mrule" style="left:${M}px"></div><div class="mrule" style="right:${M}px"></div>
          <div class="htitle hand" data-beat style="${at(M + 30, 34)}">${t.title}${uline(250)}</div>
          <div class="eyebrow" data-beat data-fit style="right:${M + 30}px;top:60px;max-width:520px;text-align:right">${t.eyebrow}</div>
          <div data-rot="story" style="${at(M + 30, 116, 876, 86)}">${R.stories.length ? sayItem(R.stories[0], "hsay") : ""}</div>
          <div style="${at(M, L, 936)}--rh:${rh}px">${ledger(R, keys)}</div>
          ${notes.markup}
          ${join(stamps.map((x, i) => stamp(x, at(378 + i * 290, 640, 260, 140), [-3, 2, -1.5][i])))}
          ${stageCorner(R, "left:30px;bottom:26px")}${timeCorner(R, "right:30px;bottom:26px")}`;
      },
      rots: (R) => [storyRot(R, "story", "hsay")],
    },

    /** Field notes: a cream form on a clipboard, the characters sketched on the paper; facts as form fields. */
    rangerlog: {
      style: "silSketch", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"], skin: "paper",
      por: { op: 0.88, tilt: "rotate(-4deg)", w: 470, fx: 170, fy: 330, scale: 1.6, mask: FADE(50, 98), wash: "none" },
      render(R) {
        const t = titles(R), rh = 54, L = 180, top = L + 24, M = 308;
        const keys = keysFor(R, KEYS7);
        const notes = marginNotes(R, keys, top, rh, { lx: M - 146, rx: M - 146, max: 3, faces: faceHeights(R, this.por) });
        const boxes = rest(R.ins, notes.used).slice(0, 2);
        let reel = rest(R.ins, boxes);
        if (reel.length < 2) reel = R.ins;
        const box = (x, style) => html`<div data-beat style="${style}"><div class="box-in"><div class="ins-tag">${x.tag}</div><div class="ins-big num" style="margin-top:4px">${val(x)}</div><div class="ins-txt" data-fitbox>${x.text}</div></div></div>`;
        return html`<div class="clip" style="top:2px"></div>
          <div class="paper bare">
            <div class="rules" style="${at(0, top, 1492, keys.length * rh)}--rh:${rh}px"></div><div class="mrule" style="left:${M}px"></div><div class="mrule" style="right:${M}px"></div>
            <div class="eyebrow" data-beat data-fit style="${at(M + 30, 30, 330)}font-size:12px">${["Ranger log", R.d.round].filter(Boolean).join(" · ")}</div>
            <div class="htitle hand" data-beat style="${at(M + 30, 54)}font-size:52px">${t.title}</div>
            <div data-beat style="${at(680, 30, 470)}display:grid;grid-template-columns:repeat(2,1fr);gap:10px 24px">${join(R.facts.map((f) => html`<div class="field"><div class="lab" style="font-size:10px">${f.lab}</div><div class="fv hand" data-fit>${f.val}</div></div>`))}</div>
            <div style="${at(M + 10, L, 856)}--rh:${rh}px;--cols:110px 84px 1fr 84px 110px;--gs:36px">${ledger(R, keys, { share: true })}</div>
            ${notes.markup}
            ${reel.length ? html`<div data-beat-card style="${at(M + 30, 604, 420, 140)}"><div class="box-in reel-in" style="display:flex;flex-direction:column;padding:10px 18px"><div class="eyebrow" style="font-size:11px">Sighting of the ${R.set ? "set" : "game"}</div><div data-rot="reel" style="flex:1">${logItem(reel[0])}</div><div class="reel-foot"><div class="track"><i data-prog="reel"></i></div>${dotsFor("reel", reel.length)}</div></div></div>` : ""}
            ${join(boxes.map((x, i) => box(x, at(M + 470 + i * 196, 604, 180, 140))))}
          </div>`;
      },
      rots(R) {
        const notes = marginNotes(R, keysFor(R, KEYS7), 180 + 24, 54, { max: 3, faces: faceHeights(R, this.por) }).used;
        const boxes = rest(R.ins, notes).slice(0, 2);
        let reel = rest(R.ins, boxes);
        if (reel.length < 2) reel = R.ins;
        return [{ id: "reel", items: reel.map(logItem) }];
      },
    },
  };
  function logItem(x) {
    return html`<div style="display:grid;grid-template-columns:120px 1fr;align-items:center;height:100%"><div class="rb num" data-beat>${val(x)}</div><div><div class="ins-tag" data-beat>${x.tag}</div><div class="rt hand" data-beat data-fitbox>${x.text}</div><div class="ins-who" data-beat>${x.who}</div></div></div>`;
  }
  /** A callout big, its words beside it: the Tale of the tape's band. */
  function tapeHero(x) {
    return html`<div class="hi"><div class="hb num" data-beat>${val(x)}</div><div><div class="ins-tag" data-beat>${x.tag}${x.side >= 0 && x.who ? ` · ${x.who}` : ""}</div><div class="htx" data-beat data-fitbox>${x.text}</div></div></div>`;
  }

  const KEYS8 = ["kills", "damage", "opk", "dpo", "neutral", "punish", "earliest", "lcancel"];

  Object.assign(LAYOUTS, {
    /** A boxing poster: one narrow glass column of big numbers either side of a tug-of-war bar, the portraits filling each half; a rotating highlight band along the foot. */
    tape: {
      style: "riso", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"],
      por: { op: 0.72, tilt: "rotate(-3deg)", scale: 2.15, dy: 70, mask: FADE(38, 100) },
      render(R) {
        const keys = keysFor(R, KEYS8);
        const row = (key) => {
          const w = R.lead(key);
          return html`<div class="tape-row" data-beat><div class="tv num l ${leadCls(w, 0)}">${R.big(key, 0)}</div><div class="tk"><div class="lab">${R.ST[key].label}</div>${shareBar(R, key)}</div><div class="tv num r ${leadCls(w, 1)}">${R.big(key, 1)}</div></div>`;
        };
        return html`${title(R, at(368, 24, 800))}${corners(R)}
          <div class="surface glass" data-beat-card style="${at(498, 132, 540, 548)}padding:6px 22px">${join(keys.map(row))}</div>
          ${R.ins.length ? html`<div class="hero tape-band" data-beat-card style="${at(168, 700, 1200, 132)}"><div data-rot="tape">${tapeHero(R.ins[0])}</div>
            <div class="reel-foot"><div class="track"><i data-prog="tape"></i></div>${dotsFor("tape", R.ins.length)}</div></div>` : ""}`;
      },
      rots: (R) => [{ id: "tape", items: R.ins.map(tapeHero) }],
    },

    /** Field notes: each player's portrait as a taped instant photo, their best callout as its caption; the ledger on ruled lines between. */
    polaroids: {
      style: "plain", packs: ["CSProject_MeleeFull", "portrait", "CSProject_AltFull", "full"], skin: "page", noWinPor: true,
      // Head and shoulders, like a photo of someone: the face a little above the middle.
      por: [0, 0].map((dx) => ({ slot: "card", op: 1, w: 308, fx: 142, fy: 132, dx, scale: 0.92, tilt: "none", mask: "none", wash: "linear-gradient(0deg, rgba(0,0,0,0.25), transparent 40%)" })),
      render(R) {
        const t = titles(R), rh = 54, L = 214, top = L + 24;
        const keys = keysFor(R, KEYS7);
        const best = (s) => R.ins.find((x) => x.side === s) || null;
        const used = [best(0), best(1)];
        const snap = (s, l, r) => {
          const x = used[s];
          return html`<div data-beat-card style="${at(l, 176, 330, 452)}"><div class="polaroid" style="--r:${r}deg"><div class="ph">${portrait(R, s, this.por)}</div>
            ${x ? html`<div class="pcap hand" data-fitbox><span class="pbig num">${val(x)}</span> ${x.tag.toLowerCase()}<small>${x.text}</small></div>` : ""}</div></div>`;
        };
        return html`<div class="rules" style="${at(0, top, 1536, keys.length * rh)}--rh:${rh}px"></div>
          <div class="htitle hand" data-beat style="${at(430, 30)}">${t.title}${uline(250)}</div>
          <div class="eyebrow" data-beat data-fit style="right:430px;top:58px;max-width:330px;text-align:right">${t.eyebrow}</div>
          <div data-rot="story" style="${at(430, 112, 676, 90)}">${R.stories.length ? sayItem(R.stories[0], "hsay") : ""}</div>
          ${snap(0, 64, -4)}${snap(1, 1142, 3.5)}
          <div style="${at(420, L, 696)}--rh:${rh}px;--cols:104px 80px 1fr 80px 104px;--gs:36px">${ledger(R, keys)}</div>
          ${join(rest(R.ins, used).slice(0, 3).map((x, i) => stamp(x, at(430 + i * 228, 650, 210, 140), [-2.5, 1.5, -1][i])))}`;
      },
      rots: (R) => [storyRot(R, "story", "hsay")],
    },

    /** Only the bottom third: the game or the players' cam stays in view above it. The summary across the top, the ledger in two short columns, the facts as one line. */
    lowerthird: {
      style: "riso", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"], win: { l: 192, t: 556, w: 1536, h: 372 },
      // A short window: a close-up, the face low enough that a head never meets its top edge.
      por: { op: 0.85, tilt: "rotate(-3deg)", scale: 1.4, w: 480, fx: 180, fy: 165, mask: FADE(42, 100) },
      render(R) {
        const keys = keysFor(R, KEYS8);
        const half = (ks, l) => html`<div class="surface glass sep-rows lt-half" data-beat-card style="${at(l, 104, 452)}padding:6px 18px 4px;--rh:46px;--gs:30px;--cols:84px 70px 1fr 70px 84px">${ledger(R, ks)}</div>`;
        return html`<div class="strip glass" data-beat-card style="${at(310, 18, 916, 74)}grid-template-columns:150px 1fr"><div><div class="ins-tag" style="white-space:normal">${titles(R).title}</div>${dotsFor("story", R.stories.length)}</div><div data-rot="story">${R.stories.length ? sayItem(R.stories[0]) : ""}</div></div>
          ${half(keys.slice(0, 4), 310)}${half(keys.slice(4), 774)}
          <div class="lt-facts" data-beat style="${at(310, 326, 916, 30)}">${join(R.facts.map((f) => html`<span><b>${f.lab}</b> ${f.val}</span>`))}</div>`;
      },
      rots: (R) => [storyRot(R, "story")],
    },
  });

  /**
   * Each side's portrait from the chosen pack, each game's stage picture from
   * the chosen stage set: the app sends one from every installed pack and set
   * (lib/set-stats/portraits.js), by id, the dock's order first. One that isn't
   * there (not downloaded, or no picture of this character or stage) falls
   * back to the first that is; stages "none" draws no stage pictures.
   */
  /** The first of `ids` (a pack id, or a list best first) that `all` has, else its first. */
  const pickId = (all, ids) => {
    if (!all) return null;
    for (const id of [].concat(ids || [])) if (all[id]) return id;
    return Object.keys(all)[0] || null;
  };
  const pick = (all, id) => { const k = pickId(all, id); return k ? all[k] : null; };
  function withPack(d, pack, stages) {
    if (!d || !Array.isArray(d.sides)) return d;
    return Object.assign({}, d, {
      sides: d.sides.map((s) => {
        const k = pickId(s && s.portraits, pack);
        return Object.assign({}, s, { portrait: k ? Object.assign({ pack: k }, s.portraits[k]) : null });
      }),
      games: (d.games || []).map((g) => (g && g.stage ? Object.assign({}, g, {
        stage: Object.assign({}, g.stage, { pic: stages === "none" ? null : pick(g.stage.pics, stages) }),
      }) : g)),
    });
  }

  /**
   * What "auto" means for one layout: the operator's saved combo for it, else
   * its best fit (style, packs best first). Shared by the overlay and the dock's
   * labels, so they agree.
   * @param {string} layout @param {{ style?, pack?, combos? }} cfg
   * @returns {{ style: string, packs: string[], saved: boolean }}
   */
  function bestFit(layout, cfg = {}) {
    const L = LAYOUTS[layout] || LAYOUTS.spotlight;
    const fav = cfg.combos && cfg.combos[layout];
    const style = cfg.style && cfg.style !== "auto" && STYLES[cfg.style] ? cfg.style : fav && STYLES[fav.style] ? fav.style : L.style;
    const packs = cfg.pack && cfg.pack !== "auto" ? [cfg.pack] : fav && fav.pack ? [fav.pack, ...L.packs] : L.packs;
    return { style, packs, saved: !!fav };
  }

  /**
   * One layout, drawn: the window's skin, its portraits (if the layout puts
   * them behind everything), the content, and the rotating sections.
   * @param {object} d — setStats
   * @param {{ layout: string, style: string, mode: "game"|"set", pack?: string, stages?: string, combos?: object, fit?: object }} o — style / pack "auto" = the layout's
   *   best fit (`combos[layout]` if saved, else its own); pack = a portrait pack id; stages = a stage set id, or "none"; fit = a portrait-fit map to use instead of the file's (the tuning page)
   * @returns {{ skin: string, portraits: string, content: string, rots: Array<{ id, items: string[] }>, style: string }}
   */
  function render(d, o) {
    const id = LAYOUTS[o.layout] ? o.layout : "spotlight", L = LAYOUTS[id];
    const fit = bestFit(id, o);
    const style = fit.style;
    const R = reader(withPack(d, fit.packs, o.stages), { mode: o.mode, style });
    R.layout = id;
    R.fit = o.fit;
    const portraits = L.noWinPor ? "" : html`${portrait(R, 0, L.por)}${portrait(R, 1, L.por)}`;
    return {
      skin: L.skin || "",
      win: L.win || null, // a window of its own size and place ({ l, t, w, h }); null = the full one
      style,
      portraits: esc(portraits),
      content: esc(L.render(R)),
      rots: (L.rots ? L.rots(R) : []).filter((r) => r.items.length > 1).map((r) => ({ id: r.id, items: r.items.map(esc) })),
    };
  }

  return { render, bestFit, LAYOUTS, STYLES, html, esc };
});
