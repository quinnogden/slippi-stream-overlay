"""
auto_replays.py — build a break-scene highlight playlist from replay-buffer clips.

Pairs with slippi-bridge's combo clipper: the bridge detects a combo mid-game and
asks OBS to save the replay buffer (obs-websocket v5). This script, running inside
OBS, collects those clips into a media source's playlist so switching to the break
scene plays back everything banked since the last break.

Descended from Melee-Ghost-Streamer's scripts/auto_replays.py, with the same
behaviour (append new clips; reset when the break scene is left and re-entered)
but rebuilt around OBS's own events:

  * The original listed the output directory every second and diffed filenames.
    This listens for OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED and reads the exact
    path from obs_frontend_get_last_replay() — no polling delay, no guessing which
    file is new, and no chance of grabbing a clip while OBS is still writing it.
    Directory polling remains as an opt-in fallback for clips arriving from
    outside OBS.
  * ffmpeg_source (Media Source) is handled as well as vlc_source. The original
    listed both in its dropdown but only ever built a playlist for VLC, so
    picking a Media Source silently did nothing.
  * obs_data handles are released on every path. The original created one
    obs_data per playlist entry inside its loop and released only the last one,
    leaking the rest on every clip.
  * script_defaults / script_description actually populate the UI (the original's
    description had a bare `return` before its string, so it rendered blank).

Requires: OBS 28+ with Python scripting configured (Tools → Scripts → Python
Settings). Written for modern Python — the interpreter is whichever version that
tab points at, so if OBS rejects the one you have, install a version it accepts
and point it there.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import obspython as obs

CLIP_SUFFIXES = (".mkv", ".mp4", ".mov", ".flv", ".ts")

VLC_SOURCE_ID = "vlc_source"
FFMPEG_SOURCE_ID = "ffmpeg_source"


def log(message: str) -> None:
    """Scripts share the OBS log, so every line says where it came from."""
    print(f"[auto_replays] {message}")


@dataclass
class Config:
    clip_folder: Path | None = None
    source_name: str = ""
    break_scene: str = ""
    max_clips: int = 8
    newest_first: bool = False
    keep_across_scenes: bool = False
    poll_folder: bool = False


@dataclass
class State:
    config: Config = field(default_factory=Config)
    # Clips banked since the last reset, oldest first — playback order.
    clips: list[Path] = field(default_factory=list)
    # Everything already accounted for, so the folder poll never re-adds a clip
    # and clips predating script load are ignored.
    known: set[Path] = field(default_factory=set)
    viewed: bool = False
    seconds_since_poll: float = 0.0


state = State()


# ── Playlist plumbing ─────────────────────────────────────────────────────────


def apply_playlist() -> None:
    """Push state.clips into the configured media source."""
    cfg = state.config
    if not cfg.source_name:
        return

    source = obs.obs_get_source_by_name(cfg.source_name)
    if source is None:
        log(f"source {cfg.source_name!r} not found — is it in the break scene?")
        return

    try:
        source_id = obs.obs_source_get_id(source)
        ordered = list(reversed(state.clips)) if cfg.newest_first else list(state.clips)

        settings = obs.obs_data_create()
        try:
            if source_id == VLC_SOURCE_ID:
                array = obs.obs_data_array_create()
                try:
                    for clip in ordered:
                        item = obs.obs_data_create()
                        try:
                            obs.obs_data_set_string(item, "value", str(clip))
                            obs.obs_data_array_push_back(array, item)
                        finally:
                            # Released per iteration — the array holds its own
                            # reference, so this is not a use-after-free.
                            obs.obs_data_release(item)
                    obs.obs_data_set_array(settings, "playlist", array)
                finally:
                    obs.obs_data_array_release(array)

            elif source_id == FFMPEG_SOURCE_ID:
                # A Media Source plays exactly one file. Point it at the clip
                # that would play first so the source isn't simply dead; a real
                # playlist needs VLC.
                obs.obs_data_set_string(settings, "local_file", str(ordered[0]) if ordered else "")
                if len(ordered) > 1:
                    log(f"{cfg.source_name!r} is a Media Source — only 1 of "
                        f"{len(ordered)} clips will play. Use a VLC Video Source for a playlist.")

            else:
                log(f"{cfg.source_name!r} is a {source_id!r}, not a VLC or Media Source — skipping")
                return

            obs.obs_source_update(source, settings)
            log(f"playlist now {len(ordered)} clip(s)")
        finally:
            obs.obs_data_release(settings)
    finally:
        obs.obs_source_release(source)


def add_clip(path: Path) -> None:
    """Bank one clip, newest-wins if the cap is reached."""
    cfg = state.config
    if path.suffix.lower() not in CLIP_SUFFIXES:
        return
    if path in state.known:
        return

    state.known.add(path)
    state.clips.append(path)

    # Drop the oldest rather than refusing the newest — during a long set the
    # most recent highlights are the ones worth showing at the break.
    if cfg.max_clips > 0 and len(state.clips) > cfg.max_clips:
        dropped = state.clips.pop(0)
        log(f"playlist full ({cfg.max_clips}) — dropped {dropped.name}")

    log(f"added {path.name}")
    apply_playlist()


def reset_playlist() -> None:
    """Clear the playlist after the break scene has been shown and left."""
    if not state.clips:
        return
    log(f"break scene left — clearing {len(state.clips)} clip(s)")
    state.clips.clear()
    apply_playlist()


# ── Scene tracking ────────────────────────────────────────────────────────────


def showing_break_scene() -> bool:
    """
    True when the current scene is the break scene.

    Prefers the configured scene name; with none set, falls back to "the current
    scene contains the media source", which is how the original decided and keeps
    the script working with no scene configured.
    """
    cfg = state.config
    scene_source = obs.obs_frontend_get_current_scene()
    if scene_source is None:
        return False

    try:
        if cfg.break_scene:
            return obs.obs_source_get_name(scene_source) == cfg.break_scene
        if not cfg.source_name:
            return False
        scene = obs.obs_scene_from_source(scene_source)  # borrowed, do not release
        return obs.obs_scene_find_source(scene, cfg.source_name) is not None
    finally:
        obs.obs_source_release(scene_source)


def on_frontend_event(event) -> None:
    if event == obs.OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED:
        # The authoritative path, available the moment the file is complete.
        saved = obs.obs_frontend_get_last_replay()
        if saved:
            add_clip(Path(saved))
        else:
            log("replay saved but OBS reported no path")

    elif event == obs.OBS_FRONTEND_EVENT_SCENE_CHANGED:
        if showing_break_scene():
            state.viewed = True
        elif state.viewed:
            state.viewed = False
            if not state.config.keep_across_scenes:
                reset_playlist()


# ── OBS script interface ──────────────────────────────────────────────────────


def script_description() -> str:
    return (
        "<b>Auto replay playlist</b><br>"
        "Collects OBS replay-buffer clips into a VLC Video Source playlist for a "
        "break scene, then clears them once the break scene has been shown and "
        "left.<br><br>"
        "Driven by OBS's replay-saved event, so it pairs directly with "
        "slippi-bridge's combo clipper."
    )


def script_defaults(settings) -> None:
    obs.obs_data_set_default_int(settings, "max_clips", 8)
    obs.obs_data_set_default_bool(settings, "newest_first", False)
    obs.obs_data_set_default_bool(settings, "keep_across_scenes", False)
    obs.obs_data_set_default_bool(settings, "poll_folder", False)


def script_properties():
    props = obs.obs_properties_create()

    obs.obs_properties_add_path(
        props, "clip_folder", "Clip folder", obs.OBS_PATH_DIRECTORY, None, None
    )

    source_list = obs.obs_properties_add_list(
        props, "source_name", "Media source",
        obs.OBS_COMBO_TYPE_EDITABLE, obs.OBS_COMBO_FORMAT_STRING,
    )
    sources = obs.obs_enum_sources()
    if sources is not None:
        for source in sources:
            if obs.obs_source_get_id(source) in (VLC_SOURCE_ID, FFMPEG_SOURCE_ID):
                name = obs.obs_source_get_name(source)
                obs.obs_property_list_add_string(source_list, name, name)
        obs.source_list_release(sources)

    scene_list = obs.obs_properties_add_list(
        props, "break_scene", "Break scene (blank = any scene with the source)",
        obs.OBS_COMBO_TYPE_EDITABLE, obs.OBS_COMBO_FORMAT_STRING,
    )
    obs.obs_property_list_add_string(scene_list, "", "")
    scenes = obs.obs_frontend_get_scene_names()
    for name in scenes or []:
        obs.obs_property_list_add_string(scene_list, name, name)

    obs.obs_properties_add_int(props, "max_clips", "Max clips (0 = unlimited)", 0, 100, 1)
    obs.obs_properties_add_bool(props, "newest_first", "Play newest clip first")
    obs.obs_properties_add_bool(props, "keep_across_scenes", "Keep the playlist after the break")
    obs.obs_properties_add_bool(
        props, "poll_folder", "Also watch the folder (for clips not saved by this OBS)"
    )
    obs.obs_properties_add_button(props, "clear_now", "Clear playlist now", on_clear_clicked)

    return props


def on_clear_clicked(props, prop) -> bool:
    state.clips.clear()
    apply_playlist()
    log("playlist cleared manually")
    return True


def script_update(settings) -> None:
    folder_text = obs.obs_data_get_string(settings, "clip_folder")
    folder = Path(folder_text) if folder_text else None

    previous_folder = state.config.clip_folder
    state.config = Config(
        clip_folder=folder,
        source_name=obs.obs_data_get_string(settings, "source_name"),
        break_scene=obs.obs_data_get_string(settings, "break_scene"),
        max_clips=obs.obs_data_get_int(settings, "max_clips"),
        newest_first=obs.obs_data_get_bool(settings, "newest_first"),
        keep_across_scenes=obs.obs_data_get_bool(settings, "keep_across_scenes"),
        poll_folder=obs.obs_data_get_bool(settings, "poll_folder"),
    )

    # Clips already in the folder are history, not highlights from this session —
    # baseline them so neither the poll nor a reload replays last week's set.
    if folder is not None and folder != previous_folder:
        state.known = set(scan_folder(folder))
        log(f"watching {folder} ({len(state.known)} existing clip(s) ignored)")


def scan_folder(folder: Path) -> list[Path]:
    try:
        return sorted(
            (p for p in folder.iterdir() if p.suffix.lower() in CLIP_SUFFIXES),
            key=lambda p: p.stat().st_mtime,
        )
    except OSError as err:
        log(f"can't read {folder}: {err}")
        return []


def script_load(settings) -> None:
    obs.obs_frontend_add_event_callback(on_frontend_event)
    log("loaded")


def script_unload() -> None:
    obs.obs_frontend_remove_event_callback(on_frontend_event)


def script_tick(seconds: float) -> None:
    """Opt-in folder fallback. The replay-saved event is the primary path."""
    cfg = state.config
    if not cfg.poll_folder or cfg.clip_folder is None:
        return

    state.seconds_since_poll += seconds
    if state.seconds_since_poll < 2.0:
        return
    state.seconds_since_poll = 0.0

    for clip in scan_folder(cfg.clip_folder):
        if clip not in state.known:
            add_clip(clip)
