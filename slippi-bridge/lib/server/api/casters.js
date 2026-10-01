/**
 * The caster name tags. Each caster is { tag, prefix, pronoun, twitter }; an
 * empty tag hides that caster's card.
 */

const MAX_CASTERS = 4;

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store }
 */
function register(app, { store }) {
  app.get("/api/casters", (req, res) => {
    res.json({ ok: true, casters: store.casters() });
  });

  app.post("/api/casters", (req, res) => {
    const list = req.body?.casters;
    if (!Array.isArray(list) || list.length > MAX_CASTERS || list.some((c) => !c || typeof c !== "object")) {
      return res.status(400).json({ ok: false, error: `casters must be an array of up to ${MAX_CASTERS} objects` });
    }
    store.setCasters(list);
    res.json({ ok: true, casters: store.casters() });
  });
}

module.exports = { register, MAX_CASTERS };
