/**
 * Stream-set replays (lib/replays/): the Replays tab's list, its per-game
 * corrections, and the LuckyStats uploads and tournament collection.
 */

const isSetId = (v) => (typeof v === "string" || typeof v === "number") && String(v).length > 0 && String(v).length < 40;
const bad = (res, error) => res.status(400).json({ ok: false, error });

/**
 * @param {import("express").Express} app
 * @param {object} deps — { replays }
 */
function register(app, { replays }) {
  app.get("/api/replays", (req, res) => {
    res.json({ ok: true, ...replays.snapshot() });
  });

  // The SLP folder's newest replays, for attaching one to a game.
  app.get("/api/replays/files", (req, res) => {
    res.json({ ok: true, files: replays.files() });
  });

  app.post("/api/replays/upload", (req, res) => {
    const { setId } = req.body ?? {};
    if (!isSetId(setId)) return bad(res, "setId required");
    res.json(replays.upload(String(setId)));
  });

  app.post("/api/replays/cancel", async (req, res) => {
    const { setId } = req.body ?? {};
    if (!isSetId(setId)) return bad(res, "setId required");
    res.json(await replays.uploads.cancel(String(setId)));
  });

  app.post("/api/replays/refresh", async (req, res) => {
    const { setId } = req.body ?? {};
    if (!isSetId(setId)) return bad(res, "setId required");
    res.json(await replays.uploads.refresh(String(setId)));
  });

  app.post("/api/replays/forget", (req, res) => {
    const { setId } = req.body ?? {};
    if (!isSetId(setId)) return bad(res, "setId required");
    res.json(replays.forget(String(setId)));
  });

  // { setId, index, op: winner | ports | remove | zelda-sheik (side, slot) | attach (file) }
  app.post("/api/replays/game", (req, res) => {
    const { setId, index, op, side, slot, file } = req.body ?? {};
    if (!isSetId(setId)) return bad(res, "setId required");
    if (!Number.isInteger(index) || index < 0) return bad(res, "index must be a game number from 0");
    if (op === "attach") {
      if (typeof file !== "string" || !file) return bad(res, "file required");
      return res.json(replays.attachFile(String(setId), index, file));
    }
    if (!["winner", "ports", "remove", "zelda-sheik"].includes(op)) return bad(res, "op must be winner, ports, remove, zelda-sheik or attach");
    if (op === "zelda-sheik" && (![0, 1].includes(side) || !Number.isInteger(slot))) return bad(res, "side and slot required");
    res.json(replays.editGame(String(setId), index, { op, side, slot }));
  });

  // { action: status | complete | reopen } on the current tournament collection.
  app.post("/api/replays/collection", async (req, res) => {
    const { action } = req.body ?? {};
    if (action === "status") return res.json(await replays.uploads.tournamentStatus());
    if (action !== "complete" && action !== "reopen") return bad(res, "action must be status, complete or reopen");
    res.json(await replays.uploads.collectionAction(action));
  });

  app.post("/api/replays/connection", async (req, res) => {
    const connection = await replays.uploads.checkConnection();
    res.json({ ok: !!connection.ok, connection, error: connection.ok ? undefined : connection.error });
  });
}

module.exports = { register };
