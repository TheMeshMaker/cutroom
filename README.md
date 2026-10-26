# Cutroom

A desktop video editor for long gameplay recordings that your AI agent can
edit with you.

- **Timeline editing**: multi-track video and audio, drag to move, trim handles,
  split, ripple delete, snapping, waveforms, undo/redo, autosave.
- **Punch-in zooms**: one key (P) adds an eased zoom-and-hold, and keyframes
  give you full control over zoom and pan.
- **Bleeps**: B mutes every track and plays a tone over a range.
- **Find long pauses**: listens to your voice track, marks the long stalls on a
  Pauses lane, and cuts the ones you pick (or all of them) across every track
  at once.
- **Export**: H.264 MP4 through FFmpeg (x264, NVENC, Quick Sync or AMF), plus a
  Shorts preset with the centered gameplay square over a blurred backdrop.
- **CapCut import**: opens your existing CapCut desktop drafts (clips, trims,
  volume, fades, zoom keyframes).
- **Agent-native**: the project is a readable JSON file, the app live-reloads
  outside edits, and a built-in MCP server lets Claude (or any MCP client) do
  the editing.

See [docs/capcut-findings.md](docs/capcut-findings.md) for the architecture
study behind the design.

## Run it

Requires Node.js 22+ and FFmpeg (`ffmpeg`/`ffprobe` on PATH, or set
`CUTROOM_FFMPEG` / `CUTROOM_FFPROBE`).

```bash
npm install
npm start          # build the UI and open the app
npm run dev        # hot-reloading UI during development
npm test           # core + MCP tests (renders real video with FFmpeg)
```

## Use it with Claude (MCP)

```bash
claude mcp add cutroom -s user -- node /absolute/path/to/cutroom/mcp/server.mjs
```

Tools: `project_status`, `project_create`, `project_open`, `media_import`,
`clip_add`, `clip_split`, `clip_trim`, `clip_move`, `clip_delete`, `clip_set`,
`punch_in`, `keyframes_clear`, `bleep_add`, `bleep_remove`, `ranges_cut`,
`pauses_find`, `capcut_list_drafts`, `capcut_import`, `frame_render` (returns
the frame as an image), `export_video`.

The server works on the project open in the app (it shares the "last project"
state in `~/.cutroom/state.json`). Every edit shows up in the app immediately
and can be undone with Ctrl+Z.

## Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| S | Split at playhead (selected clips, or everything under it) |
| Del / Shift+Del | Delete / ripple delete |
| P | Punch-in zoom at playhead |
| B | Bleep (0.4 s at the playhead, or the I–O range) |
| I / O / X | Set range in / out / clear |
| M | Marker |
| ← → (Shift) | Step one frame (one second) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+I / Ctrl+E | Import media / export |
| Ctrl+wheel | Zoom the timeline |

## Project format

```jsonc
{
  "format": "cutroom/1",
  "canvas": { "width": 1920, "height": 1080, "fps": 30 },
  "media":  [{ "id": "m_…", "path": "G:/Obs/rec.mkv", "duration": 1113.6, "hasAudio": true }],
  "tracks": [{ "id": "v1", "kind": "video" }, { "id": "a1", "kind": "audio" }],
  "clips":  [{ "id": "c_…", "trackId": "v1", "mediaId": "m_…",
               "start": 0, "in": 628.2, "out": 630.03,   // seconds
               "volume": 1, "fadeIn": 0, "fadeOut": 0,
               "transform": { "scale": 1, "x": 0, "y": 0 },
               "keyframes": [{ "t": 0.75, "scale": 1.3, "x": 0, "y": 0, "ease": "smooth" }] }],
  "bleeps":  [{ "start": 61.2, "end": 61.7 }],
  "markers": [{ "time": 120.4, "end": 126.9, "label": "pause" }]
}
```

Track order is display order: the top video row is the top layer.

## Not yet

Speed changes, text and titles, transitions and effects, multi-clip drag, and
a packaged installer. CapCut import reports anything it skips.
