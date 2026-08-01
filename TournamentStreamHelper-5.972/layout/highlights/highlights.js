/* ============================================================
   highlights.js — geometry + URL flags for the replay-scene overlay.

   That is the whole job. This layout reads no TSH state and no
   bridge events, so there is no LoadEverything(), no Start(), no
   Update() and no Socket.io here — see the comment block in
   highlights.html for why globals.js is deliberately absent.

     ?clip=x,y,w,h    move/resize the clip window
     ?cam=y,w,h       both cams' vertical position and size
     ?camx=left,right the two cams' x positions
     ?pad=clip,cam    plate thickness

     ?animate=false   freeze the title orbs and the sheen sweep
                      (same convention as side-panel.js)
     ?guides=1        outline each frame's transparent hole and
                      label it with its measured rect, to check the
                      OBS source transforms underneath
   ============================================================ */
(function () {
  "use strict";

  var root = document.documentElement;
  var params = new URLSearchParams(window.location.search);

  /* ── Geometry overrides ──────────────────────────────────────
     Alignment is the only thing about this overlay that differs
     per scene, and getting it wrong is its one visible failure —
     the plate misses the source and leaves a gap. So it is
     settable from the browser source URL: plain pixel numbers in
     1920×1080 space, copied straight out of OBS's Edit Transform
     dialog, no CSS edit and no OBS restart.

     The two cams deliberately SHARE --cam-y/-w/-h. Their centres
     have to land on the same line as the clip's for the row to
     read level, and one shared size is the cheapest way to keep
     that true. Only their x positions are independent. */
  var OVERRIDES = [
    ["clip", ["--clip-x", "--clip-y", "--clip-w", "--clip-h"]],
    ["cam",  ["--cam-y", "--cam-w", "--cam-h"]],
    ["camx", ["--cam-l-x", "--cam-r-x"]],
    ["pad",  ["--frame-pad", "--cam-pad"]],
  ];

  OVERRIDES.forEach(function (entry) {
    var raw = params.get(entry[0]);
    if (!raw) return;

    entry[1].forEach(function (name, i) {
      var value = parseFloat(raw.split(",")[i]);
      // Blanks are skipped rather than zeroed, so ?clip=,,960 can set
      // the width alone without collapsing x and y to 0.
      if (!isFinite(value)) return;
      root.style.setProperty(name, value + "px");
    });
  });

  if (params.get("animate") === "false") {
    document.body.classList.add("no-animate");
  }

  var guides = params.has("guides");
  if (guides) document.body.classList.add("guides");

  /* ── Per-frame pass ──────────────────────────────────────────
     Everything below works off the MEASURED padding box, not a
     read-back of the CSS variables: the padding box is the
     transparent hole, so a bad calc() shows up here — in the
     guides label, or as a bleed class that does or doesn't
     appear — instead of silently on stream. */
  var canvas = getComputedStyle(root);
  var canvasW = parseFloat(canvas.getPropertyValue("--canvas-w")) || 1920;
  var canvasH = parseFloat(canvas.getPropertyValue("--canvas-h")) || 1080;
  var EPS = 0.5; // sub-pixel slack, so 1919.7 still counts as the edge

  Array.prototype.forEach.call(document.querySelectorAll(".frame"), function (frame) {
    var box = frame.getBoundingClientRect();
    var style = getComputedStyle(frame);

    // Per side, not one --pad: nothing guarantees a frame's four borders
    // match, and guessing wrong here misreports the hole quietly rather
    // than failing loudly — which is the exact failure guides mode exists
    // to catch.
    var edge = function (side) { return parseFloat(style["border" + side + "Width"]) || 0; };

    var left = box.left + edge("Left");
    var top = box.top + edge("Top");
    var right = box.right - edge("Right");
    var bottom = box.bottom - edge("Bottom");

    // A window running off the canvas gets its corners squared on that
    // side — see the .bleed-* block in highlights.css. Class names are
    // written out in full rather than built from a side name, so a
    // grep for them finds both halves.
    if (left <= EPS) frame.classList.add("bleed-l");
    if (top <= EPS) frame.classList.add("bleed-t");
    if (right >= canvasW - EPS) frame.classList.add("bleed-r");
    if (bottom >= canvasH - EPS) frame.classList.add("bleed-b");

    if (!guides) return;
    frame.dataset.guide =
      (frame.dataset.label || "") +
      "   " + Math.round(left) + ", " + Math.round(top) +
      "   " + Math.round(right - left) + " × " + Math.round(bottom - top);
  });
})();
