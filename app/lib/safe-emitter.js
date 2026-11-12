/**
 * SafeEmitter — an EventEmitter whose listeners can't break each other or the
 * code that emitted.
 *
 * Each listener runs on its own: one that throws is logged and the rest still
 * run, and the throw never comes back out of emit(). The store and the game
 * source use it because every feature hangs off their events, and a throw
 * coming back out lands in the wrong place: a stats bug in a `change` listener
 * would come out of the game end that recorded the point, stop the overlay
 * channel's listener from sending it, and leave the game source stuck on a
 * finished file — no game recorded for the rest of the session.
 *
 * `error` keeps EventEmitter's own behaviour.
 */

const { EventEmitter } = require("events");

class SafeEmitter extends EventEmitter {
  /** @param {string} [label] — the log tag a failed listener is reported under */
  constructor(label = "events") {
    super();
    this._label = label;
  }

  emit(event, ...args) {
    if (event === "error") return super.emit(event, ...args);
    // rawListeners: a copy, with once() wrappers, which take themselves off when called.
    const listeners = this.rawListeners(event);
    for (const fn of listeners) {
      try {
        fn.apply(this, args);
      } catch (err) {
        console.error(`[${this._label}] a "${String(event)}" listener failed: ${err?.stack ?? err}`);
      }
    }
    return listeners.length > 0;
  }
}

module.exports = { SafeEmitter };
