# Cutroom

A desktop video editor laid out like CapCut, so it feels familiar from the
first minute. It's a native Windows app written in Rust (no browser or web
view inside), it runs fully offline, it speaks nine languages (including
Arabic and Urdu, right to left), and your AI agent can edit the same project
live.

**Familiar layout.** The asset panel is top left (Media, Audio, Text,
Stickers, Effects, Transitions, Captions, Filters, Adjustment), the player
sits in the middle with a ratio menu, and a tabbed details panel is on the
right (Video, Text, Audio, Speed, Animation, Color, or Project when nothing is
selected). The timeline at the bottom has a magnetic main track, CapCut's tool
row and its shortcuts. The app always opens on the **Projects** home.

**What's inside:**

- **Editing:** split, delete left/right of the playhead (Q/W), ripple delete,
  copy/paste, duplicate, box selection and group moves, snapping, the
  main-track magnet, lockable/hideable/mutable tracks, filmstrips and
  waveforms, markers, undo/redo and autosave (with a backup every 5 minutes).
- **Speed and time:** 0.1–10× with pitch kept, five speed curves (ramp up/down,
  montage, hero moment, bullet time), reverse and freeze frame.
- **Framing:** scale, position, rotation, mirror/flip, opacity, crop,
  keyframes (diamonds on the clip), **masks** (circle, rectangle, linear, band;
  position, size, feather, invert), green-screen removal and stabilization.
- **Canvas:** aspect ratios (16:9, 9:16, 1:1, 4:3, 3:4, 21:9), 720p–4K,
  24–60 fps, and a **canvas background** (black, blur or a color) around
  footage that doesn't fill the frame.
- **Look:** 12 filters and 12 effects whose tiles show *your* footage, 12
  adjustment sliders, **color wheels** (shadows, midtones, highlights,
  offset), a **tone curve** editor, `.cube` LUTs and adjustment layers.
- **Motion:** 22 transitions and 9 in/out animations.
- **Text:** a multi-line text box, 10 styles, 8 animated title templates, 13
  fonts, color, outline, background box, shadow and alignment. Arabic text is
  shaped and right-to-left.
- **Stickers:** 42 color emoji and drawn stickers (arrow, highlight circle,
  speech bubble, burst, subscribe button) on their own track.
- **Captions:** auto captions with local Whisper (detect, Arabic or English),
  `.srt`/`.vtt` import and `.srt` export.
- **Audio:**
  - Volume up to 400%, fades, mute, voice enhance, noise reduction, loudness
    normalize, pitch and 9 voice effects.
  - **Voice, game and music separation** and **remove music**, on your GPU with
    local models; nothing is uploaded.
  - **OBS recordings:** each recorded audio track (game, mic, Discord…) onto
    its own timeline track, with your cuts kept.
  - Mark beats, extract audio, bleeps, and **read text aloud** with the
    Windows voices on your PC.
- **Live preview:** playback renders the same picture as the export, and edits
  made while playing show up straight away.
- **Export:** H.264, HEVC, AV1 or ProRes up to 4K60 with NVENC, tuned for
  quality, plus a loudness target (YouTube −14 LUFS, TV −23).
- **CapCut import:** opens your CapCut desktop drafts.
- **Nine languages:** English, العربية, Español, Français, Deutsch, Türkçe,
  Bahasa Indonesia, اردو and Português, picked from the menu at the top right
  (the first start follows your Windows language). Everything is translated,
  including error messages and default track names; Arabic and Urdu mirror the
  whole layout right to left, and shortcuts follow the physical keys, so they
  work with any keyboard layout.
- **Any screen:** opens maximized and sizes itself to the monitor, from an HD
  laptop to 4K, with any Windows display scaling; re-fits when you move it to
  another monitor. An **Interface size** menu (Auto, 70–150%) sits next to the
  language.
- **Agent-native:** the project is readable JSON. The app picks up outside
  edits, and the built-in MCP server lets Claude (or any MCP client) use every
  feature.

Cutroom uses none of CapCut's code, assets or branding; only the general
layout is familiar.

## Run from source

Requires Rust (stable), Node.js 22+ for the MCP server and tests, and FFmpeg 7+
(`vendor/ffmpeg/ffmpeg.exe` and `ffprobe.exe`, or `CUTROOM_FFMPEG` /
`CUTROOM_FFPROBE`). Captions need Python with `faster-whisper`; voice/music
separation needs the CDX23 models and a PyTorch environment
(`CUTROOM_STEM_PYTHON`); stickers need Python with Pillow.

```bash
npm run dev        # build and open the app (debug)
npm start          # optimized build
npm test           # engine, feature and MCP tests (real FFmpeg renders)
npm run shots      # screenshot checks of every panel, English and Arabic
npm run dist       # release build in native/target/release
```

**Adding a language:** copy `native/i18n/es.json` to `native/i18n/<code>.json`,
translate the values (keep `{0}`, `{1}`… as they are), add a line to
`LANGUAGES` in `native/src/i18n.rs`, and run `npm test`: it fails if any
string is missing.

Handy flags for checks: `cutroom --project=<file> --lang=ar
--do=a-filters,select,color --shot=out.png` opens off-screen, runs the steps
and saves a screenshot; `cutroom --selftest=<media>` tests the embedded engine.

## Use it with Claude (MCP)

```bash
claude mcp add cutroom -s user -- node /absolute/path/to/cutroom/mcp/server.mjs
```

The server works on the project open in the app; every edit shows up live and
can be undone with Ctrl+Z. It has 45 tools covering media and clips, text and
titles, transitions, keyframes and punch-ins, reverse/freeze, captions,
beats, speed ramps, roll/slip trims, adjustment layers, scene splitting,
text-based editing (`transcript_create`, `words_remove`), bleeps, pause
finding, CapCut import, frame rendering and export.

## Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl+B | Split at the playhead |
| Q / W | Delete left / right of the playhead |
| Del (Shift+Del) | Delete (ripple) |
| Ctrl+C / Ctrl+V / Ctrl+D | Copy / paste / duplicate |
| Ctrl+A | Select all |
| M | Marker |
| ← → (Shift) | Step one frame (one second) |
| Home / End | Start / end |
| Ctrl + / Ctrl − / Shift+Z | Zoom in / out / fit timeline |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+I / Ctrl+E | Import / export |

## Project format

```jsonc
{
  "format": "cutroom/1",
  "settings": { "magnet": true, "loudness": -14, "background": "blur" },
  "canvas": { "width": 1920, "height": 1080, "fps": 30 },
  "media":  [{ "id": "m_…", "path": "G:/Obs/rec.mkv", "duration": 1113.6, "hasAudio": true, "audioTracks": ["Game", "Mic"] }],
  "tracks": [{ "id": "t_…", "kind": "text" }, { "id": "v1", "kind": "video" }, { "id": "a1", "kind": "audio" }],
  "clips":  [{ "id": "c_…", "trackId": "v1", "mediaId": "m_…", "start": 0, "in": 628.2, "out": 630.03, "speed": 1,
               "transform": { "scale": 1, "x": 0, "y": 0, "rotation": 0 },
               "keyframes": [{ "t": 0.75, "scale": 1.3, "x": 0, "y": 0, "ease": "smooth" }],
               "mask": { "type": "circle", "x": 0, "y": 0, "w": 0.6, "h": 0.6, "feather": 0.1, "invert": false },
               "filter": { "id": "horror", "intensity": 80 }, "effects": [{ "id": "shake", "intensity": 60 }],
               "color": { "lift": { "x": 0, "y": 0.1, "l": 0 }, "curve": [[0, 0], [0.5, 0.55], [1, 1]] },
               "animIn": { "type": "zoom-in", "duration": 0.5 }, "transition": { "type": "dissolve", "duration": 0.5 },
               "audio": { "denoise": 40, "enhance": true, "voice": null, "pitch": 0 } },
             { "id": "c_…", "trackId": "t_…", "text": "Hello", "style": { "font": "Segoe UI", "size": 72 }, "start": 2, "in": 0, "out": 3 }],
  "markers": [{ "time": 120.4, "label": "beat" }]
}
```

Track order is display order: text rows on top, then video (the last video row
is the main track), then audio.

## Not yet

- **Online CapCut content** can't be copied: the stock music and sound
  library, store templates, AI avatars and online effects.
- **From the old web version, not in the native app yet** (the engine and MCP
  server still have them): the Script tab (text-based editing), the audio
  mixer page, the source monitor, the Deliver render queue, video scopes,
  keyboard presets and the command palette.
- Motion tracking, blend modes, auto reframe, AI background removal,
  multicam, and an installer for the native build.
