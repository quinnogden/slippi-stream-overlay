module.exports = {
  // ── Slippi Connection ──────────────────────────────────────────────────────
  // "tcp"    → connect directly to your Wii's LAN IP (lowest latency)
  // "folder" → watch a folder where Slippi desktop app writes live .slp files
  CONNECTION_MODE: "folder",

  // TCP mode: set this to your Wii's local IP address
  CONSOLE_IP: "192.168.137.2",
  CONSOLE_PORT: 51441,

  // Folder mode: path to the directory Slippi writes the live game file into
  // (usually the "CurrentGame" subfolder inside your Slippi replays folder)
  SLP_FOLDER: "C:/Users/ogden/OneDrive/Documents/Slippi/Spectate/quinn",

  // ── TSH Integration ────────────────────────────────────────────────────────
  // URL of the running TSH web server (default port 5000)
  TSH_URL: "http://localhost:5000",

  // Which TSH scoreboard number to control (1 for the default scoreboard)
  SCOREBOARD_NUM: 1,

  // ── Bridge Server ──────────────────────────────────────────────────────────
  // Port the bridge's Socket.io server listens on for layout connections
  BRIDGE_PORT: 5001,

  // ── Port Mapping ───────────────────────────────────────────────────────────
  // Maps Slippi player port index (0-based) to TSH team number (1-based).
  // In a standard 1v1 mirror, port 0 = P1 (left side) and port 1 = P2 (right side).
  PORT_TO_TEAM: { 0: 1, 1: 2 },
};
