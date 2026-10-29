/**
 * bracket-director.js — what the bracket overlay shows right now, published as
 * the store's `bracketShot` section.
 *
 *   tour   the view's pages in turn (bracket.pages[view]), each held for
 *          layout.holdMs(page), opening on the page with the action
 *   page   one page, held until the dock presses Auto
 *   board  the classic connected board, steered from the dock (the camera
 *          math is overlays/bracket/layout.js's); never moves by itself
 *
 * It owns the tour's clock, so every source and the dock's page strip agree on
 * the page up. The rules a press can't see:
 *
 *   - A view or phase-group switch opens the new view on its action page — in
 *     the tour if it was touring, held otherwise (a switch is the operator's
 *     doing; the camera doesn't start touring behind them).
 *   - A page that disappears (a round with somebody in it now, so the pages
 *     were cut again) gives way to the page with the action, in the same mode.
 *   - Up Next has no Board.
 */

const Layout = require("../../../overlays/bracket/layout");

const DIRS = ["up", "down", "left", "right"];
const ACTIONS = ["auto", "next", "prev", "page", "live", "pan", "zoom", "overview", "goto"];

/**
 * @param {{ store: import("../scoreboard/store").ScoreboardStore,
 *           now?: () => number,
 *           timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 */
function createBracketDirector({ store, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  let timer = null;

  const viewName = () => store.view().bracketView;
  const pagesOf = (b, v) => b?.pages?.[v] ?? [];

  /** The set the action is on, in the view's pages (the set on air first). */
  function actionId(b, v) {
    const pages = pagesOf(b, v);
    const view = Layout.subView(b, pages.flatMap((p) => p.setIds));
    return Layout.actionSetId(b, view, store.scoreboard().setId);
  }

  function actionPage(b, v) {
    const pages = pagesOf(b, v);
    if (pages.length === 0) return null;
    if (v === "upnext") return pages[0];
    const id = actionId(b, v);
    return pages.find((p) => p.setIds.includes(id)) ?? pages[0];
  }

  /** Put `page` up in `mode`; the tour's hold starts now. */
  function show(mode, page) {
    const b = store.bracket();
    store.setBracketShot({
      mode,
      view: viewName(),
      group: b?.phaseGroupId ?? null,
      page: page?.key ?? null,
      since: now(),
      holdMs: mode === "tour" && page ? Layout.holdMs(page) : 0,
      camera: null,
    });
    schedule();
  }

  function schedule() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    const shot = store.bracketShot();
    if (shot.mode !== "tour" || !shot.page) return;
    if (pagesOf(store.bracket(), viewName()).length < 2) return; // nothing to turn to
    timer = timers.setTimeout(advance, Math.max(0, shot.since + shot.holdMs - now()));
  }

  function advance() {
    timer = null;
    const shot = store.bracketShot();
    if (shot.mode !== "tour") return;
    const pages = pagesOf(store.bracket(), viewName());
    if (pages.length === 0) return;
    const i = pages.findIndex((p) => p.key === shot.page);
    show("tour", pages[(i + 1) % pages.length]);
  }

  /** After the bracket or the view changed: keep the shot pointing at something real. */
  function reconcile() {
    const b = store.bracket();
    const v = viewName();
    const shot = store.bracketShot();
    if (!b) {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      if (shot.page || shot.camera) store.setBracketShot({ mode: shot.mode === "board" ? "page" : shot.mode });
      return;
    }
    if (shot.view !== v || shot.group !== b.phaseGroupId) {
      return show(shot.mode === "tour" ? "tour" : "page", actionPage(b, v));
    }
    if (shot.mode === "board") return;
    if (!pagesOf(b, v).some((p) => p.key === shot.page)) return show(shot.mode, actionPage(b, v));
    schedule();
  }

  /** The pruned classic board, as the overlay draws it in Board mode. */
  function boardLayout(b, v) {
    return Layout.layoutView(b, Layout.prunedView(b, v));
  }

  /**
   * A press in the dock.
   * @param {{ action: string, page?: string, dir?: string, cx?: number, cy?: number }} cmd
   * @returns {{ ok: true, shot: object } | { ok: false, status: number, error: string }}
   */
  function command(cmd = {}) {
    const { action } = cmd;
    if (!ACTIONS.includes(action)) return { ok: false, status: 400, error: `action must be one of ${ACTIONS.join(", ")}` };
    const b = store.bracket();
    const v = viewName();
    if (!b) return { ok: false, status: 409, error: "No bracket loaded" };
    const pages = pagesOf(b, v);
    const shot = store.bracketShot();
    const at = Math.max(0, pages.findIndex((p) => p.key === shot.page));

    switch (action) {
      case "auto": show("tour", actionPage(b, v)); break;
      case "live": show("page", actionPage(b, v)); break;
      case "next":
      case "prev":
        if (pages.length === 0) return { ok: false, status: 409, error: "This view has no pages yet" };
        show("page", pages[(at + (action === "next" ? 1 : -1) + pages.length) % pages.length]);
        break;
      case "page": {
        const page = pages.find((p) => p.key === cmd.page);
        if (!page) return { ok: false, status: 400, error: `no page "${cmd.page}" in this view` };
        show("page", page);
        break;
      }
      default: {
        if (v === "upnext") return { ok: false, status: 409, error: "Up Next has no Board view" };
        if (action === "pan" && !DIRS.includes(cmd.dir)) return { ok: false, status: 400, error: `dir must be one of ${DIRS.join(", ")}` };
        if (action === "zoom" && cmd.dir !== "in" && cmd.dir !== "out") return { ok: false, status: 400, error: "dir must be in or out" };
        if (action === "goto" && !(Number.isFinite(cmd.cx) && Number.isFinite(cmd.cy))) {
          return { ok: false, status: 400, error: "goto needs numeric cx and cy (board pixels)" };
        }
        const lay = boardLayout(b, v);
        if (!lay.width) return { ok: false, status: 409, error: "Nothing to show in this view yet" };
        const focus = actionId(b, v);
        const atAction = () => Layout.cameraForSets(lay, [focus], focus);
        const cam = shot.mode === "board" ? shot.camera : null;
        let next;
        if (action === "overview") next = cam?.overview ? atAction() : { overview: true };
        else if (action === "goto") next = Layout.cameraAt(lay, cmd.cx, cmd.cy, cam && !cam.overview ? cam.zoom : undefined);
        else if (!cam) next = Layout.cameraForSets(lay, pages[at]?.setIds ?? [], focus); // entering: framed on the page
        else if (cam.overview) next = action === "zoom" && cmd.dir === "out" ? cam : atAction();
        else if (action === "pan") next = Layout.moveCamera(lay, cam, cmd.dir);
        else next = Layout.zoomCamera(lay, cam, cmd.dir);
        if (timer) timers.clearTimeout(timer);
        timer = null;
        store.setBracketShot({ ...shot, mode: "board", view: v, group: b.phaseGroupId, holdMs: 0, camera: next });
      }
    }
    return { ok: true, shot: store.bracketShot() };
  }

  const onChange = ({ keys }) => {
    if (keys.includes("bracket") || keys.includes("view")) reconcile();
  };

  return {
    start() {
      store.on("change", onChange);
      reconcile();
    },
    stop() {
      store.off("change", onChange);
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    command,
  };
}

module.exports = { createBracketDirector, ACTIONS, DIRS };
