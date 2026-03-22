/**
 * side-panel.js
 *
 * Right-side OBS overlay panel (611 × 1080 px).
 *
 * Implements TSH layout hooks:
 *   Start()  — called on initial load
 *   Update() — called when program_state.json changes
 *
 * Also connects to slippi-bridge Socket.io server for future hooks.
 *
 * Config:
 *   LOGO_PATH    — tournament logo (relative to this file)
 *   SPONSOR_PATH — sponsor logo to cycle with
 *   LOGO_INTERVAL — ms between logo swaps (default 20s)
 *
 * URL param:
 *   ?animate=false — disables ambient CSS animation (adds .no-animate to body)
 */

const LOGO_PATH    = "../logo.png";
const SPONSOR_PATH = "../ThePark.png";
const LOGO_INTERVAL = 20000; // 20 seconds

// ── Animation toggle ───────────────────────────────────────────────────────
(function applyAnimationParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("animate") === "false") {
    document.body.classList.add("no-animate");
  }
})();

// ── Logo cycle ─────────────────────────────────────────────────────────────
(function initLogo() {
  const primary = document.querySelector(".logo-primary");
  const sponsor = document.querySelector(".logo-sponsor");
  if (!primary || !sponsor) return;

  primary.src = LOGO_PATH;
  sponsor.src = SPONSOR_PATH;

  // Show primary once loaded; start cycle after first interval
  primary.onload = () => {
    primary.classList.add("visible");

    setInterval(() => {
      const showPrimary = !primary.classList.contains("visible");
      primary.classList.toggle("visible", showPrimary);
      sponsor.classList.toggle("visible", !showPrimary);
    }, LOGO_INTERVAL);
  };
})();

// ── Tournament name ────────────────────────────────────────────────────────
const TOURNAMENT_NAME_URL = "../../out/tournamentInfo/tournamentName.txt";
const POLL_INTERVAL = 5000; // ms between file polls

function setTournamentName(name) {
  const el = document.querySelector(".tournament-name");
  if (el && name) el.textContent = name.trim();
}

async function fetchTournamentName() {
  try {
    const res = await fetch(TOURNAMENT_NAME_URL, { cache: "no-store" });
    if (res.ok) setTournamentName(await res.text());
  } catch (_) {
    // TSH not running — fail silently
  }
}

// Fetch immediately on load, then poll
fetchTournamentName();
setInterval(fetchTournamentName, POLL_INTERVAL);

// ── TSH hooks ─────────────────────────────────────────────────────────────

/**
 * Called by globals.js on initial load/Start.
 */
Start = async function () {};

/**
 * Called by globals.js whenever program_state.json changes.
 * Supplements the poll — keeps the name in sync on TSH state changes.
 * @param {{ data: object, oldData: object }} event
 */
Update = async function (event) {
  const name = event?.data?.tournamentInfo?.tournamentName ?? "";
  setTournamentName(name);
};

// ── Slippi Bridge ──────────────────────────────────────────────────────────
(function initSlippiBridge() {
  function tryConnect(attemptsLeft) {
    if (typeof io === "undefined") {
      if (attemptsLeft > 0) {
        setTimeout(() => tryConnect(attemptsLeft - 1), 300);
      }
      return;
    }

    const socket = io("http://localhost:5001", {
      reconnectionDelay:    5000,
      reconnectionDelayMax: 30000,
    });

    socket.on("connect", () => {
      console.log("[side-panel] Bridge connected");
    });

    socket.on("slippi_game_start", (data) => {
      console.log("[side-panel] Game start:", data);
      // Reserved for future use (e.g. show player names in #3 slot)
    });

    socket.on("slippi_game_end", (data) => {
      console.log("[side-panel] Game end:", data);
      // Reserved for future use
    });

    socket.on("disconnect", () => {
      console.log("[side-panel] Bridge disconnected — waiting to reconnect");
    });

    socket.on("connect_error", () => {
      // Bridge not running — fail silently
    });
  }

  tryConnect(10); // try up to ~3 seconds for the async script to load
})();
