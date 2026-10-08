/**
 * luckystats.gg — the side panel's Lucky Ranks, classes, regions and win
 * probability. The only module that talks to luckystats.gg; the endpoint was
 * supplied by its developer for this stream, and every card that shows its
 * data credits it.
 *
 *   GET /api/stream/players?ids=<userId>,<userId>
 *
 * **The ids are start.gg USER ids, not player ids.** A player id is not
 * refused: it answers with whoever has that user id (ZODD-01's player id 1097
 * is "Captain Crunch"), so the caller maps player → user through start.gg and
 * checks the `startggUserId` on every answer (normalize.luckyFromResponse).
 * Exactly two ids carry the `matchup` block; one id, or three, leave it out
 * along with a few per-player fields.
 *
 * It needs an API key from a claimed luckystats account (`LUCKYSTATS_KEY` in
 * config.local.js, sent as a Bearer token); without one the client is
 * disabled and the side panel shows no luckystats data at all.
 *
 * Images: class badges (SVGs on luckystats.gg) and Region artwork (rasters on
 * luckystats' blob storage). A browser source must never load from the web
 * (venue Wi-Fi), so the app saves each one once into stats-cache/luckystats/,
 * which lib/server/overlays.js serves at /assets/luckystats/. An image that
 * can't be saved is left out.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const axios  = require("axios");

const BASE_URL   = "https://luckystats.gg";
const TIMEOUT_MS = 10000;
const IMAGE_DIR  = path.join(__dirname, "..", "..", "stats-cache", "luckystats");
const IMAGE_URL  = "/assets/luckystats/";
const BADGE_MAX  = 64 * 1024;
const BADGE_KEY  = /^[a-z0-9-]{1,40}$/;
const ART_MAX    = 4 * 1024 * 1024;
// Where Region artwork may come from: the urls arrive in a response body, so
// nothing else is fetched. A refusal is logged — a new host shows up there.
const ART_HOSTS  = [/^([a-z0-9-]+\.)*luckystats\.gg$/, /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/];
// Rasters only, recognised by their bytes, so the file's extension (and the
// type it's served as) is the image's own.
const RASTERS = [
  ["jpg",  (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["png",  (b) => b.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n"],
  ["gif",  (b) => b.toString("latin1", 0, 4) === "GIF8"],
  ["webp", (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"],
];

class LuckyStatsClient {
  /**
   * @param {{ apiKey?: string, baseUrl?: string, http?: { get: Function }, imageDir?: string|null, log?: Function }} [opts]
   *   imageDir null: no images (tests).
   */
  constructor(opts = {}) {
    this.apiKey   = String(opts.apiKey ?? "").trim();
    this.enabled  = Boolean(this.apiKey);
    this.baseUrl  = opts.baseUrl ?? BASE_URL;
    this.http     = opts.http ?? axios;
    this.imageDir = opts.imageDir === undefined ? IMAGE_DIR : opts.imageDir;
    this.log      = opts.log ?? ((m) => console.log(`[luckystats] ${m}`));
    this._images  = new Map(); // badge key or artwork url → Promise<url|null>
  }

  /**
   * The players and (for two) their matchup, as luckystats sends them.
   * @param {Array<string|number>} userIds — start.gg user ids
   * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string }>}
   */
  async players(userIds) {
    if (!this.enabled) return { ok: false, error: "no luckystats API key (LUCKYSTATS_KEY)" };
    const ids = userIds.map(String).filter((id) => /^[1-9]\d*$/.test(id));
    if (ids.length === 0) return { ok: false, error: "no start.gg user ids" };
    try {
      const res = await this.http.get(`${this.baseUrl}/api/stream/players`, {
        params: { ids: ids.join(",") },
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `the API key was refused (HTTP ${res.status}) — check LUCKYSTATS_KEY in config.local.js` };
      }
      if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
      if (!res.data || !Array.isArray(res.data.players)) return { ok: false, error: "unexpected response" };
      return { ok: true, data: res.data };
    } catch (err) {
      return { ok: false, error: err.code || err.message };
    }
  }

  /**
   * The app's url for a class badge, saving it the first time. Null when it
   * can't be had — the card shows the class name without it.
   * @param {string} key — playerClass.key
   * @param {string} svgUrl — playerClass.svgUrl
   */
  badge(key, svgUrl) {
    if (!this.imageDir || !BADGE_KEY.test(String(key ?? ""))) return Promise.resolve(null);
    return this._once(`class:${key}`, () => this._saveBadge(key, svgUrl));
  }

  /**
   * The app's url for a Region's artwork (displayRegion.imageUrl), saving it
   * the first time. Null when it can't be had — the card shows a pin instead.
   * Keyed by the url, which changes when the Region uploads new artwork.
   * @param {string} imageUrl
   */
  regionArt(imageUrl) {
    const src = String(imageUrl ?? "");
    if (!this.imageDir || !src) return Promise.resolve(null);
    return this._once(`art:${src}`, () => this._saveArt(src));
  }

  /** One save per image per process; a failure that may pass is retried next time. */
  _once(id, save) {
    if (!this._images.has(id)) {
      this._images.set(id, save().then(({ url, retry }) => {
        if (!url && retry) this._images.delete(id);
        return url;
      }));
    }
    return this._images.get(id);
  }

  async _saveBadge(key, svgUrl) {
    const name = `class-${key}.svg`;
    if (fs.existsSync(path.join(this.imageDir, name))) return { url: IMAGE_URL + name };
    // Only luckystats.gg's own badges — the url comes from a response body.
    if (!String(svgUrl ?? "").startsWith(`${this.baseUrl}/player-classes/`)) return { url: null };
    try {
      const res = await this.http.get(svgUrl, {
        timeout: TIMEOUT_MS, responseType: "text", maxContentLength: BADGE_MAX, validateStatus: () => true,
      });
      const body = String(res.data ?? "").trim();
      if (res.status !== 200 || !/^(<\?xml[^>]*>\s*)?<svg[\s>]/.test(body)) {
        this.log(`badge ${key}: not saved (HTTP ${res.status})`);
        return { url: null, retry: true };
      }
      return { url: this._write(name, body) };
    } catch (err) {
      this.log(`badge ${key}: not saved (${err.code || err.message})`);
      return { url: null, retry: true };
    }
  }

  async _saveArt(src) {
    let host = "";
    try {
      const u = new URL(src);
      if (u.protocol === "https:") host = u.hostname;
    } catch { /* not a url */ }
    if (!ART_HOSTS.some((re) => re.test(host))) {
      this.log(`region artwork not fetched: ${host || src} isn't a luckystats host`);
      return { url: null };
    }
    const stem = "region-" + crypto.createHash("sha1").update(src).digest("hex").slice(0, 16);
    const saved = RASTERS.map(([ext]) => `${stem}.${ext}`).find((f) => fs.existsSync(path.join(this.imageDir, f)));
    if (saved) return { url: IMAGE_URL + saved };
    try {
      const res = await this.http.get(src, {
        timeout: TIMEOUT_MS, responseType: "arraybuffer", maxContentLength: ART_MAX, validateStatus: () => true,
      });
      const body = Buffer.from(res.data ?? []);
      const type = body.length > 12 ? RASTERS.find(([, is]) => is(body)) : null;
      if (res.status !== 200 || !type) {
        this.log(`region artwork not saved (HTTP ${res.status}${res.status === 200 ? ", not an image" : ""})`);
        return { url: null, retry: res.status !== 200 };
      }
      return { url: this._write(`${stem}.${type[0]}`, body) };
    } catch (err) {
      this.log(`region artwork not saved (${err.code || err.message})`);
      return { url: null, retry: !/maxContentLength/.test(err.message) }; // too big stays too big
    }
  }

  /** Atomically, so a source never loads half a file. */
  _write(name, body) {
    const file = path.join(this.imageDir, name);
    fs.mkdirSync(this.imageDir, { recursive: true });
    fs.writeFileSync(file + ".tmp", body);
    fs.renameSync(file + ".tmp", file);
    return IMAGE_URL + name;
  }
}

module.exports = { LuckyStatsClient, IMAGE_DIR, IMAGE_URL };
