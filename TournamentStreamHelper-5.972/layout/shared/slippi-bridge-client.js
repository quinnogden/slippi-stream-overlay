/**
 * Shared slippi-bridge Socket.io client for this repo's custom layouts.
 *
 * Two things used to be duplicated between the scoreboard and the side panel:
 * the injected <script> that pulls socket.io.js off the bridge, and the poll
 * that waits for `io` to appear before connecting. They had already drifted.
 *
 * Everything here no-ops when the bridge isn't running — a layout must keep
 * working on TSH data alone.
 */
(function (global) {
  "use strict";

  var BRIDGE_URL = "http://localhost:5001";

  // socket.io.js is fetched from the bridge rather than shipped, so the layout
  // works whether or not the bridge is up.
  var SOCKET_IO_SRC = BRIDGE_URL + "/socket.io/socket.io.js";

  var loaderStarted = false;

  /** Inject the bridge's socket.io.js once per page. */
  function loadSocketIo() {
    if (loaderStarted) return;
    loaderStarted = true;
    var s = document.createElement("script");
    s.src = SOCKET_IO_SRC;
    document.head.appendChild(s);
  }

  /**
   * Connect to the bridge and bind event handlers.
   *
   * @param {Object<string, Function>} handlers — Socket.io event name → handler.
   *        "connect" / "disconnect" are bound like any other event.
   * @param {{ tag?: string, attempts?: number }} [opts]
   *        tag: log prefix. attempts: how many 300ms polls to wait for io().
   */
  function connectBridge(handlers, opts) {
    opts = opts || {};
    var tag = opts.tag || "slippi-bridge";
    var attempts = opts.attempts == null ? 10 : opts.attempts;

    loadSocketIo();

    (function tryConnect(left) {
      // io() only exists once the injected script above has loaded.
      if (typeof io === "undefined") {
        if (left > 0) setTimeout(function () { tryConnect(left - 1); }, 300);
        return;
      }

      var socket = io(BRIDGE_URL, {
        reconnectionDelay: 5000,
        reconnectionDelayMax: 30000,
      });

      Object.keys(handlers || {}).forEach(function (event) {
        socket.on(event, handlers[event]);
      });

      // Bridge not running — fail silently. The layout still works on TSH data.
      if (!handlers || !handlers.connect_error) {
        socket.on("connect_error", function () {});
      }

      global["__" + tag + "Socket"] = socket;
    })(attempts);
  }

  global.SlippiBridge = { connectBridge: connectBridge, BRIDGE_URL: BRIDGE_URL };
})(window);
