/**
 * art-packs.js — the stats popup's art, downloaded on demand (the dock's
 * Setup → Art packs, one click), so the repo carries none of it.
 *
 * The art is TSH's Melee asset packs, from the GitHub releases TSH itself
 * downloads them from (joaorb64/StreamHelperAssets): each pack is a .7z —
 * sometimes split into .7z.001, .002 …, joined in order — holding one folder,
 * `<pack>/`, of `<character>_<costume>.png` plus a config.json (each
 * character's `eyesights`, the credits). Unpacked into
 * overlays/assets/packs/<pack>/ (gitignored, served at /assets/packs/), where
 * portraits.js reads them.
 *
 * Every portrait pack the release lists (one with face positions) and every
 * stage picture set is fetched; icon packs and TSH's base files aren't — the popup
 * can't use them. A pack already at the release's version is skipped, so the
 * same click updates. A pack is unpacked beside the old one and swapped in
 * only once it's whole, so a failed download never costs the art already
 * there.
 *
 * Unpacked by the system's bsdtar — Windows 10+ ships it as tar.exe, macOS as
 * tar — which reads 7z: no extra dependency. (GNU tar can't; on Linux the
 * download fails with that error.)
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const REPO_URL = "https://github.com/joaorb64/StreamHelperAssets";
const MANIFEST_URL = "https://raw.githubusercontent.com/joaorb64/StreamHelperAssets/main/assets.json";
const fileUrl = (name) => `${REPO_URL}/releases/latest/download/${encodeURIComponent(name)}`;
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const MARKER = ".installed.json";

/**
 * The packs the popup knows how to draw, in the order the dock lists them.
 * `fill`: how much of NORMAL_HEIGHT (portraits.js) the pack's frame stands
 * for — the VS-screen renders sit in their frame with room around them, the
 * CSProject renders fill theirs, the select-screen portraits are busts — so
 * a character comes out about the same size whichever pack draws it.
 */
const KNOWN = [
  { id: "full", kind: "portraits", name: "VS screen", fill: 1 },
  { id: "CSProject_MeleeFull", kind: "portraits", name: "CSProject · Melee poses", fill: 0.85 },
  { id: "CSProject_AltFull", kind: "portraits", name: "CSProject · alternate poses", fill: 0.85 },
  { id: "portrait", kind: "portraits", name: "Select screen", fill: 0.42 },
  { id: "stage_icon", kind: "stages", name: "Stage pictures" },
];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The system bsdtar: Windows' own, by its full path (Git's GNU tar can sit earlier on PATH and can't read 7z). */
function tarPath() {
  return process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
}

/** Unpack an archive into a folder with bsdtar (which refuses absolute and ../ paths by default). */
function bsdtarExtract(archive, into) {
  return new Promise((resolve, reject) => {
    execFile(tarPath(), ["-xf", archive, "-C", into], { windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (err) reject(new Error(`couldn't unpack (${String(stderr || err.message).trim().split("\n")[0]})`));
      else resolve();
    });
  });
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

/**
 * The release's Melee packs, as { id → { name, description, credits, version, files: [{ name, size }] } },
 * only the ones the popup can draw.
 */
function packsFromManifest(json) {
  const assets = json?.ssbm?.assets;
  if (!assets || typeof assets !== "object") return null;
  const out = {};
  for (const [id, a] of Object.entries(assets)) {
    if (!ID.test(id) || !a || typeof a !== "object") continue;
    const known = KNOWN.find((k) => k.id === id);
    if (!known && !a.has_eyesight_data && !/stage/i.test(id)) continue; // base files, icon packs
    const files = Object.values(a.files ?? {})
      .filter((f) => f && typeof f.name === "string" && /^[\w.-]+$/.test(f.name))
      .map((f) => ({ name: f.name, size: Number(f.size) || 0 }))
      .sort((x, y) => x.name.localeCompare(y.name));
    if (!files.length) continue;
    out[id] = {
      name: typeof a.name === "string" ? a.name : id,
      description: typeof a.description === "string" ? a.description : "",
      credits: typeof a.credits === "string" ? a.credits : "",
      version: a.version == null ? null : String(a.version),
      files,
    };
  }
  return out;
}

/**
 * @param {{ dir: string, fetch?: typeof fetch, extract?: (archive: string, into: string) => Promise<void>,
 *           onInstalled?: (id: string) => void, now?: () => number }} opts
 */
function createArtPacks({ dir, fetch: fetchImpl = globalThis.fetch, extract = bsdtarExtract, onInstalled = () => {}, now = Date.now }) {
  let manifest = null;      // packsFromManifest(), once read
  let manifestAt = 0;
  let manifestError = null;
  let job = null;           // the download in progress, or the last one's result

  async function readManifest(force = false) {
    if (!force && manifest && now() - manifestAt < MANIFEST_TTL_MS) return manifest;
    try {
      const res = await fetchImpl(MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const m = packsFromManifest(await res.json());
      if (!m) throw new Error("the pack list has no Melee packs");
      manifest = m;
      manifestAt = now();
      manifestError = null;
    } catch (err) {
      manifestError = err.message;
    }
    return manifest;
  }

  /** What's on disk for a pack: its marker, else (an older copy dropped in by hand) its config.json's version. */
  function installed(id) {
    const conf = readJson(path.join(dir, id, "config.json"));
    if (!conf) return null;
    const mark = readJson(path.join(dir, id, MARKER));
    return { version: mark?.version ?? (conf.version == null ? null : String(conf.version)), at: mark?.at ?? null };
  }

  /** Every pack, known or listed, with what's installed and what the release has. */
  function list() {
    const ids = [...KNOWN.map((k) => k.id), ...Object.keys(manifest ?? {}).filter((id) => !KNOWN.some((k) => k.id === id)).sort()];
    return ids.map((id) => {
      const known = KNOWN.find((k) => k.id === id);
      const m = manifest?.[id];
      const kind = known?.kind ?? (/stage/i.test(id) ? "stages" : "portraits");
      const have = installed(id);
      return {
        id,
        kind,
        name: known?.name ?? m?.name ?? id,
        description: m?.description ?? "",
        credits: m?.credits ?? "",
        size: m ? m.files.reduce((s, f) => s + f.size, 0) : null,
        latest: m?.version ?? null,
        installed: have,
        current: !!(have && m && have.version === m.version),
      };
    });
  }

  function status() {
    return { ok: true, folder: dir, source: REPO_URL, packs: list(), manifestError, job };
  }

  /** One part of a pack, appended to `into`, counting bytes into the job. */
  async function fetchPart(name, into) {
    const res = await fetchImpl(fileUrl(name), { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`${name}: GitHub answered ${res.status}`);
    const count = new Transform({
      transform(chunk, _enc, done) { job.received += chunk.length; done(null, chunk); },
    });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(into, { flags: "a" }));
  }

  async function install(id, pack) {
    const work = path.join(dir, ".download");
    const archive = path.join(work, `${id}.7z`);
    const out = path.join(work, id);
    rm(archive);
    rm(out);
    fs.mkdirSync(out, { recursive: true });
    try {
      for (const f of pack.files) await fetchPart(f.name, archive);
      job.step = "unpacking";
      await extract(archive, out);
      const unpacked = path.join(out, id);
      if (!fs.existsSync(path.join(unpacked, "config.json"))) throw new Error("the download had no config.json in it");
      fs.writeFileSync(path.join(unpacked, MARKER), JSON.stringify({ version: pack.version, at: new Date(now()).toISOString() }) + "\n");
      // Swap it in: the old copy aside, the new one in place, the old one gone.
      const target = path.join(dir, id);
      const old = path.join(work, `${id}.old`);
      rm(old);
      if (fs.existsSync(target)) fs.renameSync(target, old);
      try {
        fs.renameSync(unpacked, target);
      } catch (err) {
        if (fs.existsSync(old)) fs.renameSync(old, target); // put it back
        throw err;
      }
      rm(old);
    } finally {
      rm(archive);
      rm(out);
    }
  }

  async function run(ids) {
    for (const id of ids) {
      const pack = manifest[id];
      job.pack = id;
      job.step = "downloading";
      try {
        await install(id, pack);
        job.done.push(id);
        console.log(`[art] ${id} ${pack.version ?? ""} installed`);
        onInstalled(id);
      } catch (err) {
        job.failed.push({ id, error: err.message });
        console.warn(`[art] ${id}: ${err.message}`);
      }
    }
    try { fs.rmdirSync(path.join(dir, ".download")); } catch { /* not empty or gone */ }
    Object.assign(job, { running: false, pack: null, step: null, finishedAt: now() });
  }

  /**
   * Download every pack that's missing or behind the release. Starts in the
   * background and answers at once; a second press while it runs is the same job.
   * @returns {Promise<{ ok: boolean, error?: string, job?: object }>}
   */
  async function downloadAll() {
    if (job?.running) return { ok: true, job };
    const m = await readManifest(true);
    if (!m) return { ok: false, error: `Couldn't read the pack list from GitHub: ${manifestError ?? "no answer"}` };
    const ids = list().filter((p) => m[p.id] && !p.current).map((p) => p.id);
    if (!ids.length) return { ok: true, job: null, upToDate: true };
    fs.mkdirSync(dir, { recursive: true });
    job = {
      running: true, ids, done: [], failed: [], pack: null, step: null,
      received: 0, total: ids.reduce((s, id) => s + m[id].files.reduce((t, f) => t + f.size, 0), 0),
      startedAt: now(), finishedAt: null,
    };
    job.finished = run(ids);
    // (the promise isn't sent to the dock: JSON drops it, and tests await it)
    Object.defineProperty(job, "finished", { enumerable: false });
    return { ok: true, job };
  }

  return { list, status, readManifest, downloadAll, get job() { return job; } };
}

module.exports = { createArtPacks, packsFromManifest, KNOWN, ID, MANIFEST_URL };
