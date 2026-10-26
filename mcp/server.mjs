#!/usr/bin/env node
// Cutroom MCP server (stdio). Every tool edits the project file on disk with
// the same operations the app uses; an open Cutroom window reloads the change
// live, and the user can undo it there.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { importCapcutDraft } from "../core/capcut-import.js";
import { detectBeats } from "../core/analysis.js";
import { captionLines, captionsTrack, parseSubtitles, toSrt } from "../core/captions.js";
import { ADJUST_KEYS, ANIMATIONS, EFFECTS, FILTERS, FONTS, TEXT_STYLES, TITLE_TEMPLATES, TRANSITIONS, VOICE_EFFECTS, byId } from "../core/catalog.js";
import { clipById, clipEnd, createProject, CANVAS_PRESETS, DEFAULT_CURVE, formatTime, hasMedia, isAdjustment, isText, mediaById, projectDuration, ROLES, sourceAt, trackById, videoLayers } from "../core/model.js";
import * as ops from "../core/ops.js";
import { EXPORT_PRESETS } from "../core/render.js";
import { timelineWords, wordRanges, wordsFromSegments } from "../core/transcript.js";
import { transcribe } from "../node/captions.js";
import { renderFrame, renderProject } from "../node/exporter.js";
import { detectScenes, detectSilence, extractFrame, FFMPEG, makeReversed, probe, run, waveform } from "../node/media.js";
import { listBackups, loadProject, PROJECT_EXT, readState, restoreBackup, saveProject, writeState } from "../node/store.js";

const CAPCUT_DRAFTS = join(process.env.LOCALAPPDATA ?? homedir(), "CapCut", "User Data", "Projects", "com.lveditor.draft");
const server = new McpServer({ name: "cutroom", version: "0.3.0" });

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
    settings: p.settings,
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
      ...(t.volume !== 1 ? { volume: t.volume } : {}),
      ...(t.pan ? { pan: t.pan } : {}),
      ...(t.solo ? { solo: true } : {}),
      ...(t.role ? { role: t.role } : {}),
      ...(t.duck?.enabled ? { duck: t.duck } : {}),
      clips: p.clips
        .filter((c) => c.trackId === t.id)
        .sort((a, b) => a.start - b.start)
        .map((c) => clipSummary(p, c)),
    })),
    bleeps: p.bleeps.map((b) => ({ id: b.id, start: round(b.start), end: round(b.end) })),
    markers: p.markers.map((m) => ({ id: m.id, time: round(m.time), ...(m.end != null ? { end: round(m.end) } : {}), label: m.label })),
    transcripts: Object.fromEntries(Object.entries(p.transcripts).map(([id, t]) => [id, { language: t.language, words: t.words.length }])),
  };
}

// Only what differs from defaults, so long projects stay readable.
function clipSummary(p, c) {
  const nonZero = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  const adjust = nonZero(c.adjust);
  const crop = nonZero(c.crop);
  const audioFx = nonZero({ ...c.audio });
  return {
    id: c.id,
    ...(isText(c) ? { text: c.text, style: c.style } : isAdjustment(c) ? { adjustment: true } : { media: mediaById(p, c.mediaId)?.name, mediaId: c.mediaId, in: round(c.in), out: round(c.out) }),
    start: round(c.start),
    end: round(clipEnd(c)),
    ...(c.speed !== 1 ? { speed: c.speed } : {}),
    ...(c.volume !== 1 ? { volume: c.volume } : {}),
    ...(c.muted ? { muted: true } : {}),
    ...(c.fadeIn || c.fadeOut ? { fadeIn: c.fadeIn, fadeOut: c.fadeOut } : {}),
    ...(c.transform.scale !== 1 || c.transform.x || c.transform.y || c.transform.rotation ? { transform: c.transform } : {}),
    ...(c.opacity !== 1 ? { opacity: c.opacity } : {}),
    ...(c.flipH || c.flipV ? { flipH: c.flipH, flipV: c.flipV } : {}),
    ...(Object.keys(crop).length ? { crop } : {}),
    ...(Object.keys(adjust).length ? { adjust } : {}),
    ...(c.filter ? { filter: c.filter } : {}),
    ...(c.lut ? { lut: c.lut } : {}),
    ...(colorChanged(c.color) ? { color: c.color } : {}),
    ...(c.videoDenoise ? { videoDenoise: c.videoDenoise } : {}),
    ...(c.effects.length ? { effects: c.effects } : {}),
    ...(c.chroma.enabled ? { chroma: c.chroma } : {}),
    ...(c.stabilize.enabled ? { stabilize: c.stabilize } : {}),
    ...(c.animIn ? { animIn: c.animIn } : {}),
    ...(c.animOut ? { animOut: c.animOut } : {}),
    ...(c.transition ? { transition: c.transition } : {}),
    ...(Object.keys(audioFx).length ? { audio: audioFx } : {}),
    ...(c.keyframes.length ? { keyframes: c.keyframes.map((k) => ({ time: round(c.start + k.t), scale: k.scale, x: k.x, y: k.y, ease: k.ease })) } : {}),
  };
}

const colorChanged = (col) =>
  !!col && (["lift", "gamma", "gain", "offset"].some((k) => col[k].x || col[k].y || col[k].l) || JSON.stringify(col.curve) !== JSON.stringify(DEFAULT_CURVE));

const round = (x) => Math.round(x * 1000) / 1000;
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

// Load -> edit -> save -> return the summary (or a custom result).
function editTool(fn) {
  return async (args) => {
    const path = projectPath(args.project);
    const before = loadProject(path);
    const result = await fn(before, args);
    const after = ops.settle(result?.project ?? result);
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

tool(
  "settings_set",
  "Project settings: magnet (close gaps on the main track after every edit, like CapCut) and loudness (LUFS target applied to every export, e.g. -14 for YouTube; null = off).",
  { ...projectArg, magnet: z.boolean().optional(), loudness: z.number().min(-30).max(-8).nullable().optional() },
  editTool((p, { project, ...patch }) => ops.setSettings(p, patch)),
);

tool(
  "backups_list",
  "List the automatic backups of a project (one every 5 minutes of editing, the last 30), newest first. Use backup_restore to go back to one.",
  projectArg,
  async ({ project }) => {
    const path = projectPath(project);
    return text({ backups: listBackups(path).map((b) => ({ file: b.file, time: new Date(b.time).toISOString(), clips: b.clips, duration: b.duration != null ? round(b.duration) : undefined })) });
  },
);

tool(
  "backup_restore",
  "Replace the project with one of its backups (from backups_list). The current version is backed up first, so this can be undone the same way.",
  { ...projectArg, file: z.string() },
  async ({ project, file }) => {
    const path = projectPath(project);
    return text(summarize(path, restoreBackup(path, resolve(file))));
  },
);

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

const ids = (list) => list.map((x) => x.id);
const unit = z.number().min(-1).max(1).optional();
const wheelShape = z.object({ x: unit, y: unit, l: unit }).optional();
const adjustShape = Object.fromEntries(Object.entries(ADJUST_KEYS).map(([k, [lo, hi]]) => [k, z.number().min(lo).max(hi).optional()]));

tool(
  "clip_set",
  "Set any clip property (omit what you don't change). Framing: scale 1 = fit, x/y pan as canvas fractions (+ right/down), rotation degrees. speed 0.1-10 (pitch kept; slowing down pushes later clips). adjust values are -100..100 (fade/sharpen/vignette/grain 0..100). filter/effects/animations/voice ids come from catalog_list. Text clips also take text and style.",
  {
    ...projectArg,
    clipId: z.string(),
    volume: z.number().min(0).max(4).optional(),
    fadeIn: z.number().min(0).optional(),
    fadeOut: z.number().min(0).optional(),
    muted: z.boolean().optional(),
    speed: z.number().min(0.1).max(10).optional(),
    scale: z.number().positive().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
    crop: z.object({ l: z.number().optional(), t: z.number().optional(), r: z.number().optional(), b: z.number().optional() }).optional().describe("Canvas fractions 0..0.45 per side."),
    adjust: z.object(adjustShape).optional(),
    filter: z.object({ id: z.enum(ids(FILTERS)), intensity: z.number().min(0).max(100).optional() }).nullable().optional(),
    lut: z.string().nullable().optional().describe("Path to a .cube LUT, or null."),
    color: z
      .object({ lift: wheelShape, gamma: wheelShape, gain: wheelShape, offset: wheelShape, curve: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(2).optional() })
      .optional()
      .describe("Primary color wheels (Resolve style): lift = shadows, gamma = midtones, gain = highlights, offset = everything. x/y push the color (x + toward blue, - toward yellow; y + toward red, - toward cyan/green), l brightens or darkens; each -1..1. curve is the master luma curve as [input, output] points 0..1."),
    videoDenoise: z.number().min(0).max(100).optional().describe("Video noise reduction strength (0 = off)."),
    effects: z.array(z.object({ id: z.enum(ids(EFFECTS)), intensity: z.number().min(0).max(100).optional() })).optional().describe("Replaces the clip's effect list."),
    chroma: z.object({ enabled: z.boolean().optional(), color: z.string().optional(), similarity: z.number().optional(), blend: z.number().optional() }).optional(),
    stabilize: z.object({ enabled: z.boolean().optional(), strength: z.number().min(0).max(100).optional() }).optional(),
    animIn: z.object({ type: z.enum(ids(ANIMATIONS)), duration: z.number().positive().optional() }).nullable().optional(),
    animOut: z.object({ type: z.enum(ids(ANIMATIONS)), duration: z.number().positive().optional() }).nullable().optional(),
    audio: z.object({ denoise: z.number().min(0).max(100).optional(), enhance: z.boolean().optional(), voice: z.enum(ids(VOICE_EFFECTS)).nullable().optional(), pitch: z.number().min(-12).max(12).optional(), normalize: z.boolean().optional() }).optional(),
    text: z.string().optional(),
    style: z.object({ font: z.enum(FONTS.map((f) => f.family)).optional(), size: z.number().optional(), color: z.string().optional(), bold: z.boolean().optional(), strokeColor: z.string().optional(), strokeWidth: z.number().optional(), bg: z.string().nullable().optional(), shadow: z.boolean().optional() }).optional(),
  },
  editTool((p, { clipId, scale, x, y, rotation, effects, animIn, animOut, filter, color, ...rest }) => {
    const transform = Object.fromEntries(Object.entries({ scale, x, y, rotation }).filter(([, v]) => v != null));
    const patch = { ...rest };
    if (color) {
      // A wheel given as {y: 0.2} keeps that wheel's other values.
      const current = clipById(p, clipId)?.color ?? {};
      patch.color = Object.fromEntries(Object.entries(color).map(([k, v]) => [k, k === "curve" ? v : { ...current[k], ...v }]));
    }
    if (Object.keys(transform).length) patch.transform = transform;
    if (effects) patch.effects = effects.map((e) => ({ intensity: 60, ...e }));
    if (filter !== undefined) patch.filter = filter && { intensity: 100, ...filter };
    if (animIn !== undefined) patch.animIn = animIn && { duration: 0.5, ...animIn };
    if (animOut !== undefined) patch.animOut = animOut && { duration: 0.5, ...animOut };
    return ops.setClip(p, clipId, patch);
  }),
);

tool(
  "catalog_list",
  "List the ids you can use: filters (looks), effects, transitions, in/out animations, voice effects, text styles and fonts.",
  {},
  async () =>
    text({
      filters: FILTERS.map((x) => ({ id: x.id, name: x.name })),
      effects: EFFECTS.map((x) => ({ id: x.id, name: x.name })),
      transitions: TRANSITIONS.map((x) => ({ id: x.id, name: x.name })),
      animations: ANIMATIONS.map((x) => ({ id: x.id, name: x.name })),
      voiceEffects: VOICE_EFFECTS.map((x) => ({ id: x.id, name: x.name })),
      textStyles: TEXT_STYLES.map((x) => ({ id: x.id, name: x.name })),
      fonts: FONTS.map((f) => f.family),
      adjust: ADJUST_KEYS,
    }),
);

tool(
  "text_add",
  "Add a text clip (title, label, caption). y is a canvas fraction (+ down; 0.3 = lower third). Pick a styleId from catalog_list or pass style fields.",
  { ...projectArg, text: z.string(), start: z.number().min(0), duration: z.number().positive().optional(), styleId: z.enum(ids(TEXT_STYLES)).optional(), x: z.number().optional(), y: z.number().optional(), trackId: z.string().optional() },
  editTool((p, { text: body, start, duration = 3, styleId, x = 0, y = 0.3, trackId }) => ops.addText(p, { text: body, start, duration, x, y, trackId, style: styleId ? byId(TEXT_STYLES, styleId).style : {} }).project),
);

tool(
  "transition_set",
  "Put a transition on the cut before clipId (it must touch the previous clip on its track). type null removes it.",
  { ...projectArg, clipId: z.string(), type: z.enum(ids(TRANSITIONS)).nullable(), duration: z.number().min(0.1).max(3).optional() },
  editTool((p, { clipId, type, duration = 0.5 }) => ops.setTransition(p, clipId, type ? { type, duration } : null)),
);

tool(
  "clip_reverse",
  "Play a clip backwards (renders a reversed copy of its source range once, then points the clip at it).",
  { ...projectArg, clipId: z.string() },
  editTool(async (p, { clipId }) => {
    const c = clipById(p, clipId);
    if (!c || isText(c)) throw new Error("Pick a video or audio clip");
    const info = await makeReversed(mediaById(p, c.mediaId), c.in, c.out);
    const r = ops.addMedia(p, info);
    return ops.replaceClipMedia(r.project, clipId, r.media.id, { in: 0, out: info.duration, reverseKeyframes: true });
  }),
);

tool(
  "clip_freeze",
  "Freeze frame: split the clip at a timeline time and hold that frame for `duration` seconds (later clips on the track move right).",
  { ...projectArg, clipId: z.string(), time: z.number(), duration: z.number().positive().optional() },
  editTool(async (p, { clipId, time, duration = 3 }) => {
    const c = clipById(p, clipId);
    if (!c || isText(c)) throw new Error("Pick a video clip");
    const still = await extractFrame(mediaById(p, c.mediaId), sourceAt(c, time));
    const r = ops.addMedia(p, still);
    return ops.insertFreeze(r.project, clipId, time, r.media.id, duration);
  }),
);

tool(
  "audio_extract",
  "Move a video clip's sound onto its own audio track (the video clip is muted).",
  { ...projectArg, clipId: z.string() },
  editTool((p, { clipId }) => ops.extractAudio(p, clipId)),
);

tool(
  "captions_generate",
  "Auto captions: transcribe a media item's speech locally (faster-whisper large-v3, GPU) and add caption text clips on a new Captions track, following the edit (cut-out words are dropped).",
  { ...projectArg, mediaId: z.string().optional().describe("Defaults to the first audio-only media on the timeline, else the first with audio."), language: z.string().optional().describe("ISO code like en or ar; default auto-detect."), styleId: z.enum(ids(TEXT_STYLES)).optional(), maxChars: z.number().int().min(8).max(80).optional() },
  editTool(async (p, { mediaId, language = "auto", styleId = "subtitle", maxChars = 32 }) => {
    const used = new Set(p.clips.map((c) => c.mediaId));
    const audible = p.media.filter((m) => used.has(m.id) && m.hasAudio);
    const media = mediaId ? mediaById(p, mediaId) : (audible.find((m) => !m.hasVideo) ?? audible[0]);
    if (!media) throw new Error("No media with audio on the timeline");
    const result = await transcribe(media, { language });
    const lines = captionLines(p, media.id, result.segments, { maxChars });
    if (!lines.length) throw new Error("No speech found");
    return { project: ops.addTextTrack(p, lines, { name: "Captions", style: byId(TEXT_STYLES, styleId).style }).project, note: `${lines.length} captions, language ${result.language}` };
  }),
);

tool(
  "captions_save",
  "Save the captions track (or any text track) as a SubRip .srt file, e.g. to upload to YouTube next to the video.",
  { ...projectArg, outPath: z.string().describe("Where to write the .srt."), trackId: z.string().optional().describe("Defaults to the Captions track.") },
  async ({ project, outPath, trackId }) => {
    const p = loadProject(projectPath(project));
    const srt = toSrt(p, { trackId });
    const file = resolve(outPath.endsWith(".srt") ? outPath : `${outPath}.srt`);
    writeFileSync(file, srt, "utf8");
    return text({ path: file, lines: srt ? srt.split("\n\n").length : 0, track: (trackId ? trackById(p, trackId) : captionsTrack(p))?.name });
  },
);

tool(
  "captions_import",
  "Import subtitles from an .srt or .vtt file as caption text clips on a new Captions track (timings are timeline seconds).",
  { ...projectArg, path: z.string(), styleId: z.enum(ids(TEXT_STYLES)).optional(), offset: z.number().optional().describe("Shift every line by this many seconds.") },
  editTool((p, { path, styleId = "subtitle", offset = 0 }) => {
    const lines = parseSubtitles(readFileSync(path, "utf8"))
      .map((l) => ({ ...l, start: l.start + offset, end: l.end + offset }))
      .filter((l) => l.end > 0)
      .map((l) => ({ ...l, start: Math.max(0, l.start) }));
    if (!lines.length) throw new Error(`No subtitles found in ${path}`);
    return { project: ops.addTextTrack(p, lines, { name: "Captions", style: byId(TEXT_STYLES, styleId).style }).project, note: `${lines.length} captions` };
  }),
);

tool(
  "beats_detect",
  "Mark the beats of a music clip on the timeline (markers labeled beat), for cutting to the rhythm.",
  { ...projectArg, clipId: z.string(), sensitivity: z.number().min(0).max(1).optional() },
  editTool(async (p, { clipId, sensitivity = 0.5 }) => {
    const c = clipById(p, clipId);
    if (!c || isText(c)) throw new Error("Pick a clip with audio");
    const wave = await waveform(mediaById(p, c.mediaId));
    const times = detectBeats(wave, { sensitivity })
      .filter((t) => t >= c.in && t < c.out)
      .map((t) => c.start + (t - c.in) / c.speed);
    return { project: ops.addMarkers(p, times.map((time) => ({ time, label: "beat", color: "beat" }))), note: `${times.length} beats` };
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

// ---- pro editing (ideas from Premiere Pro / DaVinci Resolve, made simple)
tool(
  "track_set",
  "Change a track: name, mute, hide, and the mixer (volume 1 = 0 dB up to 4, pan -1 left .. 1 right, solo). role tags the sound (dialogue/music/sfx/ambience); duck lowers this track while any dialogue track is talking (amount 0..100).",
  {
    ...projectArg,
    trackId: z.string(),
    name: z.string().optional(),
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    volume: z.number().min(0).max(4).optional(),
    pan: z.number().min(-1).max(1).optional(),
    solo: z.boolean().optional(),
    role: z.enum(ROLES).nullable().optional(),
    duck: z.object({ enabled: z.boolean().optional(), amount: z.number().min(0).max(100).optional() }).optional(),
  },
  editTool((p, { project, trackId, duck, ...patch }) => {
    const t = trackById(p, trackId);
    if (!t) throw new Error(`No track ${trackId}`);
    if (t.kind === "text" && (patch.volume != null || patch.pan != null || patch.solo != null || patch.role !== undefined || duck)) throw new Error("Text tracks have no sound");
    return ops.setTrack(p, trackId, { ...patch, ...(duck ? { duck: { ...t.duck, ...duck } } : {}) });
  }),
);

tool(
  "adjustment_add",
  "Add an adjustment layer (an empty clip on the top video track). Its color, looks and effects (set them with clip_set) apply to every clip beneath it for as long as it lasts.",
  { ...projectArg, start: z.number().min(0), duration: z.number().positive().optional() },
  editTool((p, { start, duration = 5 }) => {
    const r = ops.addAdjustment(p, { start, duration });
    return { project: r.project, note: `Adjustment layer ${r.clip.id}` };
  }),
);

tool(
  "roll_edit",
  "Roll edit: move the cut between two touching clips on a track by `delta` seconds (+ later). The left clip gets longer as the right one gets shorter, so nothing else moves. Clamped to the source both clips have.",
  { ...projectArg, leftClipId: z.string(), rightClipId: z.string(), delta: z.number() },
  editTool((p, { leftClipId, rightClipId, delta }) => ops.rollEdit(p, leftClipId, rightClipId, delta)),
);

tool(
  "clip_slip",
  "Slip edit: show a later (+) or earlier (-) part of the source inside the same clip, without moving it on the timeline.",
  { ...projectArg, clipId: z.string(), delta: z.number() },
  editTool((p, { clipId, delta }) => ops.slipClip(p, clipId, delta)),
);

tool(
  "speed_ramp",
  `Speed ramp preset: the clip becomes ${Object.values(ops.SPEED_RAMPS)[0].speeds.length} pieces whose speeds follow a curve (pitch is kept). Presets: ${Object.entries(ops.SPEED_RAMPS).map(([k, v]) => `${k} = ${v.label}`).join("; ")}.`,
  { ...projectArg, clipId: z.string(), preset: z.enum(Object.keys(ops.SPEED_RAMPS)) },
  editTool((p, { clipId, preset }) => ops.speedRamp(p, clipId, preset)),
);

tool(
  "title_add",
  `Add an animated title from a template: ${TITLE_TEMPLATES.map((t) => `${t.id} (${t.name})`).join(", ")}. text replaces the template's placeholder (a newline makes a second line).`,
  { ...projectArg, templateId: z.enum(TITLE_TEMPLATES.map((t) => t.id)), start: z.number().min(0), text: z.string().optional() },
  editTool((p, { templateId, start, text: body }) => {
    const r = ops.addTitle(p, templateId, { start, text: body });
    return { project: r.project, note: `Title ${r.clip.id}` };
  }),
);

tool(
  "source_place",
  "Three-point edit from a media item's in/out (source seconds) at timeline time `at`. mode: insert (opens room on every track, so sync is kept), overwrite (replaces what's on the target track), append (end of the track), top (a free track above, e.g. B-roll).",
  { ...projectArg, mediaId: z.string(), in: z.number().min(0), out: z.number().positive(), at: z.number().min(0).optional(), mode: z.enum(["insert", "overwrite", "append", "top"]).optional(), trackId: z.string().optional() },
  editTool((p, { mediaId, in: inn, out, at = 0, mode = "insert", trackId }) => {
    const r = ops.placeSource(p, { mediaId, in: inn, out, at, mode, trackId });
    return { project: r.project, note: `Clip ${r.clip.id}` };
  }),
);

tool(
  "gaps_close",
  "Close every gap on every track (each track keeps its clip order).",
  projectArg,
  editTool((p) => ops.closeGaps(p)),
);

tool(
  "scenes_split",
  "Scene cut detection: find the camera cuts inside a video clip (ffmpeg scene score) and split the clip at each one.",
  { ...projectArg, clipId: z.string(), threshold: z.number().min(0.05).max(0.9).optional().describe("Scene-change score 0..1 (default 0.35; lower finds more cuts).") },
  editTool(async (p, { clipId, threshold = 0.35 }) => {
    const c = clipById(p, clipId);
    if (!c || !hasMedia(c)) throw new Error("Pick a video clip");
    const m = mediaById(p, c.mediaId);
    const times = (await detectScenes(m, { threshold })).filter((s) => s > c.in + 0.2 && s < c.out - 0.2);
    return { project: ops.splitAtSourceTimes(p, m.id, times), note: `${times.length} scene change${times.length === 1 ? "" : "s"}` };
  }),
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

// ---- text-based editing (edit the video by editing its transcript)
function pickAudible(p, mediaId) {
  const used = new Set(p.clips.map((c) => c.mediaId));
  const audible = p.media.filter((m) => used.has(m.id) && m.hasAudio);
  const media = mediaId ? mediaById(p, mediaId) : (audible.find((m) => !m.hasVideo) ?? audible[0]);
  if (!media) throw new Error("No media with audio on the timeline");
  return media;
}

function wordsOnTimeline(p, media) {
  const t = p.transcripts[media.id];
  if (!t) throw new Error(`${media.name} has no transcript yet. Call transcript_create first.`);
  return timelineWords(p, media.id, t.words);
}

tool(
  "transcript_create",
  "Transcribe a media item word by word (faster-whisper large-v3, local; filler words like um/uh are kept) and store it in the project for text-based editing. Then use transcript_words and words_remove.",
  { ...projectArg, mediaId: z.string().optional().describe("Defaults to the first audio-only media on the timeline, else the first with audio."), language: z.string().optional().describe("ISO code like en or ar; default auto-detect.") },
  editTool(async (p, { mediaId, language = "auto" }) => {
    const media = pickAudible(p, mediaId);
    const result = await transcribe(media, { language, fillers: true });
    const words = wordsFromSegments(result.segments);
    return { project: ops.setTranscript(p, media.id, { language: result.language, words }), note: `${words.length} words, language ${result.language}` };
  }),
);

tool(
  "transcript_words",
  "Read the transcript as it plays on the timeline (cut-out words are gone): rows of [index, start, end, word] in timeline seconds, plus the plain text. Filter by a time window, or fillersOnly to list um/uh-type words.",
  { ...projectArg, mediaId: z.string().optional(), from: z.number().optional(), to: z.number().optional(), fillersOnly: z.boolean().optional() },
  async ({ project, mediaId, from = 0, to = Infinity, fillersOnly }) => {
    const p = loadProject(projectPath(project));
    const media = pickAudible(p, mediaId);
    const words = wordsOnTimeline(p, media).filter((w) => w.end > from && w.start < to && (!fillersOnly || w.filler));
    return text({ media: media.name, mediaId: media.id, count: words.length, text: words.map((w) => w.text).join(" "), words: words.map((w) => [w.i, round(w.start), round(w.end), w.text]) });
  },
);

tool(
  "words_remove",
  "Text-based cut: remove words from the edit by their transcript index (from transcript_words), or every filler word with fillers=true. The timeline closes up (ripple) on every track.",
  { ...projectArg, mediaId: z.string().optional(), indices: z.array(z.number().int().min(0)).optional(), fillers: z.boolean().optional() },
  editTool((p, { mediaId, indices = [], fillers }) => {
    const media = pickAudible(p, mediaId);
    const pick = new Set(indices);
    const words = wordsOnTimeline(p, media).filter((w) => pick.has(w.i) || (fillers && w.filler));
    if (!words.length) throw new Error("None of those words are on the timeline");
    const before = projectDuration(p);
    const next = ops.removeRanges(p, wordRanges(words));
    return { project: next, note: `Cut ${words.length} word${words.length === 1 ? "" : "s"} (${round(before - projectDuration(next))} s)` };
  }),
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
  "Render the project (or a timeline range) with FFmpeg. Presets: landscape (project canvas), shorts-square (1080x1920 with the centered square over blurred footage), vertical-fill. codec h264/hevc/av1 (.mp4) or prores (.mov); hardware auto picks the GPU encoder when available; resolution is the output's short side (720/1080/1440/2160).",
  {
    ...projectArg,
    outPath: z.string(),
    preset: z.enum(Object.keys(EXPORT_PRESETS)).optional(),
    background: z.enum(["blur", "black"]).optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
    codec: z.enum(["h264", "hevc", "av1", "prores"]).optional(),
    hardware: z.enum(["auto", "cpu", "nvenc", "qsv", "amf"]).optional(),
    quality: z.enum(["high", "recommended", "compact"]).optional(),
    resolution: z.number().int().positive().optional(),
    fps: z.number().positive().optional(),
    loudness: z.number().min(-30).max(-8).nullable().optional().describe("Normalize the mix to this LUFS (-14 YouTube/Spotify, -16 podcasts, -23 broadcast). Defaults to the project's loudness setting; null turns it off."),
  },
  async ({ project, outPath, ...settings }, extra) => {
    const path = projectPath(project);
    const p = loadProject(path);
    const token = extra?._meta?.progressToken;
    let last = 0;
    const r = await renderProject(p, {
      ...settings,
      outPath: resolve(outPath),
      signal: extra?.signal,
      onProgress: (x) => {
        if (token == null || x - last < 0.02) return;
        last = x;
        extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round(x * 100), total: 100 } }).catch(() => {});
      },
    });
    return text({ path: r.path, encoder: r.encoder, durationSeconds: round(r.duration), renderSeconds: round(r.seconds) });
  },
);

await server.connect(new StdioServerTransport());
