# Cutroom

A desktop video editor laid out like CapCut, so it feels familiar from the
first minute. It runs fully offline, and your AI agent can edit the same
project live.

**Familiar layout.** The library is top left (Media, Audio, Text, Effects,
Transitions, Filters, Captions), the player sits in the middle, and a tabbed
properties panel is on the right (Video, Audio, Speed, Animation, Adjust). The
timeline at the bottom has a magnetic main track and CapCut's tool row and
shortcuts.

**Pro-level features, no subscription:**

- **Editing:** split, delete left/right of the playhead (Q/W), ripple delete,
  copy/paste, blade tool, snapping, a main-track magnet, lockable/hideable
  tracks, filmstrips and waveforms, undo/redo and autosave.
- **Speed and time:** constant speed 0.1–10× with pitch kept, reverse, and
  freeze frame.
- **Framing:** scale, position, rotation, flip, opacity and crop. Zoom and pan
  keyframes, plus one-key punch-in zooms (P).
- **Look:**
  - 12 adjustment controls (exposure, temperature, tint, highlights/shadows,
    vignette, grain…) and 12 filters.
  - `.cube` LUT import.
  - 12 effects, including camera shake, glow, VHS, RGB split and pixelate.
- **Motion:** 22 transitions and 9 in/out animations (zoom, pop, slide, spin,
  fade).
- **Compositing:** picture-in-picture on extra video tracks, chroma key and
  stabilization.
- **Text:** 10 styles over 13 fonts, with stroke, box and shadow. Arabic
  shaping and right-to-left text work.
- **Auto captions:** local Whisper (faster-whisper large-v3). Captions follow
  your cuts and nothing is uploaded.
- **Audio:**
  - Clean-up: noise reduction, voice enhance and loudness normalize.
  - Voice changer (9 voices) and pitch shift.
  - Beat detection, extract audio, fades and volume up to 400%.
  - Bleeps (Shift+B).
- **Find long pauses:** listens to your voice track and marks stalls so you
  can review them before cutting.
- **Export:** H.264, HEVC, AV1 or ProRes; 720p–4K; 24–60 fps. Uses
  NVENC/Quick Sync/AMF when available. Includes a Shorts layout (square
  gameplay panel over blurred footage) and a vertical crop.
- **Exact preview:** when playback is paused, the player shows the real export
  render of that frame.
- **CapCut import:** opens your CapCut desktop drafts (clips, trims, volume,
  fades, zoom keyframes).
- **Agent-native:** the project is readable JSON. The app live-reloads outside
  edits, and the built-in MCP server lets Claude (or any MCP client) use every
  feature.

See [docs/capcut-findings.md](docs/capcut-findings.md) for the architecture
study behind the design. Cutroom uses none of CapCut's code, assets or
branding.

## Download

Windows 10/11 x64 builds are on the
[Releases](https://github.com/TheMeshMaker/cutroom/releases) page: an
installer and a portable zip. FFmpeg is bundled, and the builds are currently
early access and unsigned.

## Run from source

Requires Node.js 22+ and FFmpeg 7+ (`ffmpeg`/`ffprobe` on PATH, or set
`CUTROOM_FFMPEG` / `CUTROOM_FFPROBE`). Auto captions need Python with
`faster-whisper`. They run on the CPU, or on an NVIDIA GPU after
`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`.

```bash
npm install
npm start          # build the UI and open the app
npm run dev        # hot-reloading UI during development
npm test           # core, feature and MCP tests (real FFmpeg renders)
npm run dist       # Windows installer + portable zip in release/ (bundles vendor/ffmpeg)
```

`npm run dist` expects `ffmpeg.exe`, `ffprobe.exe` and their license files in
`vendor/ffmpeg/` (not committed). The packaged app uses that bundled copy
unless `CUTROOM_FFMPEG` / `CUTROOM_FFPROBE` are set.

## Use it with Claude (MCP)

```bash
claude mcp add cutroom -s user -- node /absolute/path/to/cutroom/mcp/server.mjs
```

Tools:

- **Project:** `project_status`, `project_create`, `project_open`, `catalog_list`
- **Media and clips:** `media_import`, `clip_add`, `clip_split`, `clip_trim`,
  `clip_move`, `clip_delete`, `clip_set` (every clip property)
- **Pro features:** `text_add`, `transition_set`, `punch_in`,
  `keyframes_clear`, `clip_reverse`, `clip_freeze`, `audio_extract`,
  `captions_generate`, `beats_detect`
- **Cleanup:** `bleep_add`, `bleep_remove`, `ranges_cut`, `pauses_find`
- **CapCut:** `capcut_list_drafts`, `capcut_import`
- **Output:** `frame_render` (returns the frame as an image) and
  `export_video` (codec, encoder, resolution, fps, layout)

The server works on the project open in the app. Every edit shows up live and
can be undone with Ctrl+Z.

## Shortcuts (CapCut-compatible where CapCut has one)

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl+B | Split at playhead |
| Q / W | Delete left / right of playhead |
| Del (Shift+Del) | Delete (ripple) |
| A / B | Select tool / split tool |
| Ctrl+C / Ctrl+V | Copy / paste clip at playhead |
| N | Snapping on/off |
| Ctrl + / Ctrl − / Shift+Z | Zoom in / out / fit timeline |
| M | Marker |
| I / O / X | Range in / out / clear |
| P | Punch-in zoom |
| Shift+B | Bleep |
| ← → (Shift) | Step one frame (one second) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+I / Ctrl+E | Import / export |

## Project format

```jsonc
{
  "format": "cutroom/1",
  "settings": { "magnet": true },
  "canvas": { "width": 1920, "height": 1080, "fps": 30 },
  "media":  [{ "id": "m_…", "path": "G:/Obs/rec.mkv", "duration": 1113.6, "hasAudio": true }],
  "tracks": [{ "id": "t_…", "kind": "text" }, { "id": "v1", "kind": "video" }, { "id": "a1", "kind": "audio" }],
  "clips":  [{ "id": "c_…", "trackId": "v1", "mediaId": "m_…",
               "start": 0, "in": 628.2, "out": 630.03, "speed": 1,      // seconds
               "transform": { "scale": 1, "x": 0, "y": 0, "rotation": 0 },
               "keyframes": [{ "t": 0.75, "scale": 1.3, "x": 0, "y": 0, "ease": "smooth" }],
               "adjust": { "contrast": 20 }, "filter": { "id": "horror", "intensity": 80 },
               "effects": [{ "id": "shake", "intensity": 60 }],
               "animIn": { "type": "zoom-in", "duration": 0.5 },
               "transition": { "type": "dissolve", "duration": 0.5 },
               "audio": { "denoise": 40, "enhance": true, "voice": null, "pitch": 0, "normalize": false } },
             { "id": "c_…", "trackId": "t_…", "text": "Hello", "style": { "font": "Segoe UI", "size": 72 },
               "start": 2, "in": 0, "out": 3 }],
  "bleeps":  [{ "start": 61.2, "end": 61.7 }],
  "markers": [{ "time": 120.4, "end": 126.9, "label": "pause" }]
}
```

Track order is display order: text rows on top, then video (the last video row
is the main track), then audio.

## Not yet

Speed curves, masks, AI background removal, text-to-speech, templates and a
packaged installer.
