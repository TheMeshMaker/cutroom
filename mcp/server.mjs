#!/usr/bin/env node
// Cutroom MCP server (stdio). Every tool edits the project file on disk with
// the same operations the app uses; an open Cutroom window reloads the change
// live, and the user can undo it there.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { importCapcutDraft } from "../core/capcut-import.js";
import { clipEnd, createProject, CANVAS_PRESETS, formatTime, mediaById, projectDuration, trackById, videoLayers } from "../core/model.js";
import * as ops from "../core/ops.js";
import { EXPORT_PRESETS } from "../core/render.js";
import { availableEncoders, renderFrame, renderProject } from "../node/exporter.js";
import { detectSilence, FFMPEG, probe, run } from "../node/media.js";
import { loadProject, PROJECT_EXT, readState, saveProject, writeState } from "../node/store.js";

const CAPCUT_DRAFTS = join(process.env.LOCALAPPDATA ?? homedir(), "CapCut", "User Data", "Projects", "com.lveditor.draft");
const server = new McpServer({ name: "cutroom", version: "0.1.0" });

let currentPath = process.env.CUTROOM_PROJECT ?? null;

function projectPath(explicit) {
  const p = explicit ?? currentPath ?? readState().lastProject;
  if (!p) throw new Error("No project selected. Call project_open or project_create first.");
  if (!existsSync(p)) throw new Error(`Project file not found: ${p}`);
  return resolve(p);
}

function select(path) {
  currentPath = resolve(path);
  writeState({ lastProject: currentPath });
}

function summarize(path, p) {
  const fps = p.canvas.fps;
  const layers = videoLayers(p).map((t) => t.id);
  return {
    path,
    name: p.name,
    revision: p.revision,
    canvas: p.canvas,
    duration: round(projectDuration(p)),
    durationText: formatTime(projectDuration(p), fps),
    media: p.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: round(m.duration), width: m.width, height: m.height, hasAudio: m.hasAudio, path: m.path })),
    tracks: p.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      ...(t.kind === "video" ? { layer: layers.indexOf(t.id) } : {}),
      muted: t.muted,
      hidden: t.hidden,
      clips: p.clips
        .filter((c) => c.trackId === t.id)
        .sort((a, b) => a.start - b.start)
        .map((c) => ({
          id: c.id,
          media: mediaById(p, c.mediaId)?.name,
          mediaId: c.mediaId,
          start: round(c.start),
          end: round(clipEnd(c)),
          in: round(c.in),
          out: round(c.out),
          ...(c.volume !== 1 ? { volume: c.volume } : {}),
          ...(c.muted ? { muted: true } : {}),
          ...(c.fadeIn || c.fadeOut ? { fadeIn: c.fadeIn, fadeOut: c.fadeOut } : {}),
          ...(c.transform.scale !== 1 || c.transform.x || c.transform.y ? { transform: c.transform } : {}),
          ...(c.keyframes.length ? { keyframes: c.keyframes.map((k) => ({ time: round(c.start + k.t), scale: k.scale, x: k.x, y: k.y, ease: k.ease })) } : {}),
        })),
    })),
    bleeps: p.bleeps.map((b) => ({ id: b.id, start: round(b.start), end: round(b.end) })),
    markers: p.markers.map((m) => ({ id: m.id, time: round(m.time), ...(m.end != null ? { end: round(m.end) } : {}), label: m.label })),
  };
}

const round = (x) => Math.round(x * 1000) / 1000;
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

// Load -> edit -> save -> return the summary (or a custom result).
function editTool(fn) {
  return async (args) => {
    const path = projectPath(args.project);
    const before = loadProject(path);
    const result = await fn(before, args);
    const after = result?.project ?? result;
    saveProject(path, after);
    return text({ ...(result?.note ? { note: result.note } : {}), project: summarize(path, after) });
  };
}

function guard(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err?.message ?? String(err) }] };
    }
  };
}

const tool = (name, description, shape, handler) =>
  server.registerTool(name, { description, inputSchema: shape }, guard(handler));

const projectArg = { project: z.string().optional().describe(`Project file (*${PROJECT_EXT}). Defaults to the current one.`) };
const seconds = (d) => z.number().describe(d);

// ---- projects
tool(
  "project_status",
  "Summarize the current Cutroom project: canvas, media, tracks with every clip (timeline start/end and source in/out, seconds), keyframes, bleeps and markers. Call this before editing.",
  projectArg,
  async ({ project }) => {
    const path = projectPath(project);
    return text(summarize(path, loadProject(path)));
  },
);

tool(
  "project_create",
  "Create a new empty project file and make it current.",
  {
    path: z.string().describe(`Where to save it (ends with ${PROJECT_EXT}).`),
    name: z.string().optional(),
    canvas: z.enum(Object.keys(CANVAS_PRESETS)).optional().describe("Canvas preset (default 1080p)."),
  },
  async ({ path, name, canvas }) => {
    const file = path.endsWith(PROJECT_EXT) ? path : `${path.replace(/\.json$/, "")}${PROJECT_EXT}`;
    if (existsSync(file)) throw new Error(`Already exists: ${file}`);
    const p = createProject({ name: name ?? "Untitled", canvas: canvas ?? "1080p" });
    saveProject(file, p);
    select(file);
    return text(summarize(file, p));
  },
);

tool("project_open", "Make an existing project file current.", { path: z.string() }, async ({ path }) => {
  const p = loadProject(path);
  select(path);
  return text(summarize(resolve(path), p));
});

// ---- media and clips
tool(
  "media_import",
  "Probe media files with ffprobe and add them to the project. With addToTimeline, each is appended to the end of the first matching track.",
  { ...projectArg, paths: z.array(z.string()).min(1), addToTimeline: z.boolean().optional() },
  editTool(async (p, { paths, addToTimeline }) => {
    let next = p;
    for (const file of paths) {
      const r = ops.addMedia(next, await probe(file));
      next = r.project;
      if (addToTimeline) next = ops.addClip(next, { mediaId: r.media.id }).project;
    }
    return next;
  }),
);

tool(
  "clip_add",
  "Place a media item on the timeline. Defaults: first matching track, whole media, appended after the last clip.",
  { ...projectArg, mediaId: z.string(), trackId: z.string().optional(), start: seconds("Timeline position.").optional(), in: seconds("Source in.").optional(), out: seconds("Source out.").optional() },
  editTool((p, a) => ops.addClip(p, a).project),
);

tool(
  "clip_split",
  "Split at a timeline time: one clip if clipId is given, otherwise every clip under that time.",
  { ...projectArg, time: seconds("Timeline time."), clipId: z.string().optional() },
  editTool((p, { time, clipId }) => (clipId ? ops.splitClip(p, clipId, time).project : ops.splitAt(p, time))),
);

tool(
  "clip_trim",
  "Change a clip's source in/out (seconds). Changing `in` keeps its right edge fixed on the timeline.",
  { ...projectArg, clipId: z.string(), in: z.number().optional(), out: z.number().optional() },
  editTool((p, { clipId, ...r }) => ops.trimClip(p, clipId, r)),
);

tool(
  "clip_move",
  "Move a clip to a new timeline start and/or another track of the same kind. Fails if it would overlap.",
  { ...projectArg, clipId: z.string(), start: z.number().optional(), trackId: z.string().optional() },
  editTool((p, { clipId, ...r }) => ops.moveClip(p, clipId, r)),
);

tool(
  "clip_delete",
  "Delete clips. ripple=true closes the gap on their tracks.",
  { ...projectArg, clipIds: z.array(z.string()).min(1), ripple: z.boolean().optional() },
  editTool((p, { clipIds, ripple }) => ops.deleteClips(p, clipIds, { ripple: !!ripple })),
);

tool(
  "clip_set",
  "Set clip properties: volume (1 = 100%, up to 4), fades in seconds, mute, and static framing (scale 1 = fit, x/y = pan as canvas fractions, + is right/down).",
  {
    ...projectArg,
    clipId: z.string(),
    volume: z.number().min(0).max(4).optional(),
    fadeIn: z.number().min(0).optional(),
    fadeOut: z.number().min(0).optional(),
    muted: z.boolean().optional(),
    scale: z.number().positive().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  editTool((p, { clipId, scale, x, y, ...rest }) => {
    const transform = Object.fromEntries(Object.entries({ scale, x, y }).filter(([, v]) => v != null));
    return ops.setClip(p, clipId, { ...rest, ...(Object.keys(transform).length ? { transform } : {}) });
  }),
);

tool(
  "punch_in",
  "Add a punch-in zoom at a timeline time: ease to `scale` over `ramp` s, optionally hold for `hold` s and ease back over `release` s. Targets clipId, or the top visible video clip at that time.",
  {
    ...projectArg,
    time: seconds("Timeline time where the zoom starts."),
    clipId: z.string().optional(),
    scale: z.number().positive().optional().describe("Default 1.3."),
    x: z.number().optional(),
    y: z.number().optional(),
    ramp: z.number().positive().optional().describe("Default 0.12 s."),
    hold: z.number().min(0).optional().describe("Omit to stay zoomed."),
    release: z.number().positive().optional(),
  },
  editTool((p, { time, clipId, ...o }) => {
    let id = clipId;
    if (!id) {
      const order = videoLayers(p).map((t) => t.id).reverse();
      const under = p.clips
        .filter((c) => c.start <= time && clipEnd(c) > time && trackById(p, c.trackId).kind === "video" && !trackById(p, c.trackId).hidden)
        .sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId));
      if (!under.length) throw new Error(`No video clip at ${time}s`);
      id = under[0].id;
    }
    return ops.punchIn(p, id, time, { scale: o.scale ?? 1.3, ramp: o.ramp ?? 0.12, x: o.x ?? 0, y: o.y ?? 0, hold: o.hold ?? null, release: o.release ?? null });
  }),
);

tool(
  "keyframes_clear",
  "Remove all zoom/pan keyframes from a clip.",
  { ...projectArg, clipId: z.string() },
  editTool((p, { clipId }) => ops.clearKeyframes(p, clipId)),
);

// ---- bleeps, cuts, pauses
tool(
  "bleep_add",
  "Bleep a timeline range: every track is muted and a 1 kHz tone plays (for swears).",
  { ...projectArg, start: z.number(), end: z.number() },
  editTool((p, { start, end }) => ops.addBleep(p, start, end)),
);

tool("bleep_remove", "Remove a bleep by id.", { ...projectArg, bleepId: z.string() }, editTool((p, { bleepId }) => ops.removeBleep(p, bleepId)));

tool(
  "ranges_cut",
  "Cut timeline ranges [start, end] out of every track and close the gaps (ripple). Use it to remove stalls. Ranges refer to the timeline before the cut.",
  { ...projectArg, ranges: z.array(z.tuple([z.number(), z.number()])).min(1), ripple: z.boolean().optional() },
  editTool((p, { ranges, ripple }) => {
    const before = projectDuration(p);
    const next = ops.removeRanges(p, ranges, { ripple: ripple !== false });
    return { project: next, note: `Removed ${round(before - projectDuration(next))} s` };
  }),
);

tool(
  "pauses_find",
  "Detect long quiet stretches in one media item's audio (ffmpeg silencedetect), map them to the timeline, and (by default) mark them on the Pauses lane for review. Returns the timeline ranges; pass them to ranges_cut to remove them.",
  {
    ...projectArg,
    mediaId: z.string().optional().describe("Defaults to the first audio-only media on the timeline (e.g. a voice stem), else the first media with audio."),
    noiseDb: z.number().optional().describe("Quieter than this counts as silence (default -35)."),
    minSeconds: z.number().positive().optional().describe("Minimum pause length (default 2.5)."),
    keepSeconds: z.number().min(0).optional().describe("Silence kept at each edge (default 0.35)."),
    mark: z.boolean().optional().describe("Replace pause markers with the result (default true)."),
  },
  async ({ project, mediaId, noiseDb = -35, minSeconds = 2.5, keepSeconds = 0.35, mark = true }) => {
    const path = projectPath(project);
    let p = loadProject(path);
    const used = new Set(p.clips.map((c) => c.mediaId));
    const audible = p.media.filter((m) => used.has(m.id) && m.hasAudio);
    const media = mediaId ? mediaById(p, mediaId) : (audible.find((m) => !m.hasVideo) ?? audible[0]);
    if (!media) throw new Error("No media with audio on the timeline");
    const raw = await detectSilence(media, { noise: noiseDb, minDuration: minSeconds });
    const shrunk = raw.map(([a, b]) => [a + keepSeconds, b - keepSeconds]).filter(([a, b]) => b - a > 0.2);
    const ranges = ops.sourceRangesToTimeline(p, media.id, shrunk).map(([a, b]) => [round(a), round(b)]);
    if (mark) {
      p = ops.removeMarkers(p, p.markers.filter((m) => m.end != null).map((m) => m.id));
      for (const [a, b] of ranges) p = ops.addMarker(p, a, { end: b, label: "pause", color: "pause" });
      saveProject(path, p);
    }
    const total = ranges.reduce((s, [a, b]) => s + b - a, 0);
    return text({ media: media.name, count: ranges.length, totalSeconds: round(total), ranges });
  },
);

// ---- CapCut interop
tool(
  "capcut_list_drafts",
  "List the user's local CapCut desktop drafts (folder name, path to draft_content.json, last modified).",
  {},
  async () => {
    if (!existsSync(CAPCUT_DRAFTS)) return text({ drafts: [], note: `No CapCut drafts folder at ${CAPCUT_DRAFTS}` });
    const drafts = readdirSync(CAPCUT_DRAFTS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(CAPCUT_DRAFTS, d.name, "draft_content.json")))
      .map((d) => {
        const file = join(CAPCUT_DRAFTS, d.name, "draft_content.json");
        return { name: d.name, path: file, modified: statSync(file).mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    return text({ drafts });
  },
);

tool(
  "capcut_import",
  "Convert a CapCut draft_content.json (read-only) into a new Cutroom project and make it current. Video/audio clips, trims, volume, audio fades and zoom/position keyframes carry over; text, effects, stickers and speed changes are reported as warnings.",
  { draftPath: z.string(), projectPath: z.string().describe(`New project file (ends with ${PROJECT_EXT}).`), name: z.string().optional() },
  async ({ draftPath, projectPath: out, name }) => {
    const { project, warnings } = importCapcutDraft(JSON.parse(readFileSync(draftPath, "utf8")), { name });
    const file = out.endsWith(PROJECT_EXT) ? out : `${out.replace(/\.json$/, "")}${PROJECT_EXT}`;
    if (existsSync(file)) throw new Error(`Already exists: ${file}`);
    saveProject(file, project);
    select(file);
    return text({ warnings, project: summarize(file, project) });
  },
);

// ---- seeing and exporting
tool(
  "frame_render",
  "Render the composed frame at a timeline time (exactly as export would) and return it as an image, so you can check framing, zooms and cuts.",
  { ...projectArg, time: z.number(), preset: z.enum(Object.keys(EXPORT_PRESETS)).optional(), width: z.number().int().positive().optional().describe("Downscale to this width (default 960).") },
  async ({ project, time, preset, width = 960 }) => {
    const path = projectPath(project);
    const p = loadProject(path);
    const out = join(tmpdir(), "cutroom", `frame-${Date.now()}.jpg`);
    await renderFrame(p, Math.min(Math.max(0, time), Math.max(0, projectDuration(p) - 1 / p.canvas.fps)), out, { preset: preset ?? "landscape" });
    const small = out.replace(/\.jpg$/, "-s.jpg");
    await run(FFMPEG, ["-hide_banner", "-y", "-i", out, "-vf", `scale=${width}:-2`, "-q:v", "4", small]);
    const data = readFileSync(small).toString("base64");
    rmSync(out, { force: true });
    rmSync(small, { force: true });
    return { content: [{ type: "image", data, mimeType: "image/jpeg" }, { type: "text", text: `Frame at ${formatTime(time, p.canvas.fps)}` }] };
  },
);

tool(
  "export_video",
  "Render the project (or a timeline range) to an H.264 MP4 with FFmpeg. Presets: landscape (project canvas), shorts-square (1080x1920 with the centered square over blurred footage), vertical-fill.",
  {
    ...projectArg,
    outPath: z.string(),
    preset: z.enum(Object.keys(EXPORT_PRESETS)).optional(),
    background: z.enum(["blur", "black"]).optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
    encoder: z.enum(["x264", "nvenc", "qsv", "amf"]).optional(),
  },
  async ({ project, outPath, preset, background, range, encoder }, extra) => {
    const path = projectPath(project);
    const p = loadProject(path);
    if (encoder && encoder !== "x264" && !(await availableEncoders()).includes(encoder)) throw new Error(`Encoder ${encoder} is not available in this FFmpeg build`);
    const token = extra?._meta?.progressToken;
    let last = 0;
    const r = await renderProject(p, {
      outPath: resolve(outPath),
      preset,
      background,
      range,
      encoder,
      signal: extra?.signal,
      onProgress: (x) => {
        if (token == null || x - last < 0.02) return;
        last = x;
        extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round(x * 100), total: 100 } }).catch(() => {});
      },
    });
    return text({ path: r.path, durationSeconds: round(r.duration), renderSeconds: round(r.seconds) });
  },
);

await server.connect(new StdioServerTransport());
