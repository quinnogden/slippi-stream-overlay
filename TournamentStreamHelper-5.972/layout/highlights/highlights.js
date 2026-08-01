/* ============================================================
   highlights.js — URL flags for the replay-scene overlay.

   That is the whole job. This layout reads no TSH state and no
   bridge events, so there is no LoadEverything(), no Start(), no
   Update() and no Socket.io here — see the comment block in
   highlights.html for why globals.js is deliberately absent.

     ?animate=false  freeze the title orbs and the sheen sweep
                     (same convention as side-panel.js)
     ?guides=1       outline each frame's transparent hole and
                     label it with its measured rect, to check the
                     OBS source transforms underneath
   ============================================================ */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);

  if (params.get("animate") === "false") {
    document.body.classList.add("no-animate");
  }

  if (!params.has("guides")) return;
  document.body.classList.add("guides");

  // Report the PADDING box, not the border box: the padding box is the
  // transparent hole, and it is what the OBS source has to line up with.
  // Measured rather than read back from the CSS variables, so a bad calc()
  // shows up here instead of silently on stream.
  Array.prototype.forEach.call(document.querySelectorAll(".frame"), function (frame) {
    var box = frame.getBoundingClientRect();
    var pad = parseFloat(getComputedStyle(frame).borderTopWidth) || 0;

    frame.dataset.guide =
      (frame.dataset.label || "") +
      "   " + Math.round(box.left + pad) + ", " + Math.round(box.top + pad) +
      "   " + Math.round(box.width - pad * 2) + " × " + Math.round(box.height - pad * 2);
  });
})();
