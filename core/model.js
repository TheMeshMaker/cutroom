// Cutroom project model. Pure JS (no Node or DOM imports) so the renderer,
// the Electron main process and the MCP server all share one definition.
//
// Times are seconds (floats). A media clip plays source range [in, out) at
// `speed`, starting at timeline position `start`; its timeline length is
// (out - in) / speed. Text clips have no media: in = 0, out = their length.

import { ADJUST_KEYS, ANIMATIONS, DEFAULT_TEXT_STYLE, EFFECTS, FILTERS, byId } from "./catalog.js";

export const FORMAT = "cutroom/1";

export const CANVAS_PRESETS = {
  "1080p": { width: 1920, height: 1080, fps: 30 },
  "1080p60": { width: 1920, height: 1080, fps: 60 },
  "720p": { width: 1280, height: 720, fps: 30 },
  "4K": { width: 3840, height: 2160, fps: 30 },
  vertical: { width: 1080, height: 1920, fps: 30 },
  square: { width: 1080, height: 1080, fps: 30 },
};

const EPS = 1e-6;

export function uid(prefix = "id") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function createProject({ name = "Untitled", canvas = "1080p" } = {}) {
  const base = typeof canvas === "string" ? CANVAS_PRESETS[canvas] : canvas;
  if (!base) throw new Error(`Unknown canvas preset: ${canvas}`);
  return normalizeProject({
    format: FORMAT,
    name,
    canvas: { ...base },
    tracks: [
      { id: "v1", kind: "video", name: "Main" },
      { id: "a1", kind: "audio", name: "Audio 1" },
    ],
  });
}

const TRACK_NAMES = { video: "Video", audio: "Audio", text: "Text" };
export const ROLES = ["dialogue", "music", "sfx", "ambience"];

const wheel = (w) => ({ x: clamp(num(w?.x, 0), -1, 1), y: clamp(num(w?.y, 0), -1, 1), l: clamp(num(w?.l, 0), -1, 1) });
export const DEFAULT_CURVE = [
  [0, 0],
  [1, 1],
];

// Fill defaults and drop malformed entries. Used on every load so a project
// edited by hand or by an agent is always safe to render.
export function normalizeProject(input) {
  const p = structuredClone(input ?? {});
  p.format = FORMAT;
  p.revision = Number.isFinite(p.revision) ? p.revision : 0;
  p.name = typeof p.name === "string" && p.name ? p.name : "Untitled";
  const c = p.canvas ?? {};
  p.canvas = {
    width: posInt(c.width, 1920),
    height: posInt(c.height, 1080),
    fps: num(c.fps, 30) > 0 ? num(c.fps, 30) : 30,
  };
  // Editor settings that change how edits behave, saved with the project so
  // the app and the MCP server agree. magnet: the main track never has gaps.
  // loudness: master loudness target in LUFS applied on export (null = off).
  p.settings = { magnet: p.settings?.magnet !== false, loudness: Number.isFinite(p.settings?.loudness) ? clamp(p.settings.loudness, -30, -8) : null };
  p.media = (Array.isArray(p.media) ? p.media : [])
    .filter((m) => m && typeof m.path === "string")
    .map((m) => ({
      id: m.id ?? uid("m"),
      path: m.path,
      name: m.name ?? baseName(m.path),
      duration: num(m.duration, 0),
      width: num(m.width, 0),
      height: num(m.height, 0),
      fps: num(m.fps, 0),
      hasVideo: m.hasVideo !== false,
      hasAudio: m.hasAudio !== false,
      kind: m.kind ?? (m.hasVideo === false ? "audio" : "video"),
      ...(m.derivedFrom ? { derivedFrom: m.derivedFrom } : {}),
    }));
  p.tracks = (Array.isArray(p.tracks) ? p.tracks : [])
    .filter((t) => t && TRACK_NAMES[t.kind])
    .map((t) => ({
      id: t.id ?? uid("t"),
      kind: t.kind,
      name: t.name ?? TRACK_NAMES[t.kind],
      muted: !!t.muted,
      hidden: !!t.hidden,
      locked: !!t.locked,
      // Mixer: fader (1 = 0 dB), pan (-1 left .. 1 right), solo, sound role
      // and auto-ducking under dialogue.
      volume: clamp(num(t.volume, 1), 0, 2),
      pan: clamp(num(t.pan, 0), -1, 1),
      solo: !!t.solo,
      role: ROLES.includes(t.role) ? t.role : null,
      duck: { enabled: !!t.duck?.enabled, amount: clamp(num(t.duck?.amount, 60), 0, 100) },
    }));
  if (!p.tracks.some((t) => t.kind === "video"))
    p.tracks.push({ id: "v1", kind: "video", name: "Main", muted: false, hidden: false, locked: false });
  const trackKind = new Map(p.tracks.map((t) => [t.id, t.kind]));
  const mediaIds = new Set(p.media.map((m) => m.id));
  p.clips = (Array.isArray(p.clips) ? p.clips : [])
    .filter((k) => {
      if (!k || !trackKind.has(k.trackId)) return false;
      if (trackKind.get(k.trackId) === "text") return typeof k.text === "string";
      if (trackKind.get(k.trackId) === "video" && k.adjustment === true) return true;
      return mediaIds.has(k.mediaId);
    })
    .map((k) => normalizeClip(k, trackKind.get(k.trackId), p.canvas.fps));
  // Word-level transcripts per media item (source seconds), for text-based
  // editing and captions.
  const transcripts = {};
  for (const [id, t] of Object.entries(p.transcripts ?? {})) {
    if (!mediaIds.has(id) || !Array.isArray(t?.words)) continue;
    transcripts[id] = {
      language: t.language ?? "",
      words: t.words.filter((w) => w && Number.isFinite(w.s) && Number.isFinite(w.e) && typeof w.w === "string").map((w) => ({ s: w.s, e: Math.max(w.s, w.e), w: w.w })),
    };
  }
  p.transcripts = transcripts;
  // Saved render-queue jobs (Deliver page).
  p.deliver = (Array.isArray(p.deliver) ? p.deliver : []).filter((j) => j && typeof j.name === "string").map((j) => ({ id: j.id ?? uid("j"), ...j }));
  p.bleeps = (Array.isArray(p.bleeps) ? p.bleeps : [])
    .filter((b) => b && num(b.end, 0) > num(b.start, 0))
    .map((b) => ({ id: b.id ?? uid("b"), start: Math.max(0, b.start), end: b.end }))
    .sort((a, b) => a.start - b.start);
  p.markers = (Array.isArray(p.markers) ? p.markers : [])
    .filter((m) => m && Number.isFinite(m.time))
    .map((m) => ({
      id: m.id ?? uid("mk"),
      time: Math.max(0, m.time),
      ...(Number.isFinite(m.end) && m.end > m.time ? { end: m.end } : {}),
      label: m.label ?? "",
      color: m.color ?? "amber",
    }))
    .sort((a, b) => a.time - b.time);
  return p;
}

function normalizeClip(k, kind, fps) {
  const adjustmentLayer = kind === "video" && k.adjustment === true;
  const isText = kind === "text" || adjustmentLayer; // both have no media: in = 0, out = length
  const inn = isText ? 0 : Math.max(0, num(k.in, 0));
  const out = Math.max(inn + 1 / fps, num(k.out, inn + (isText ? 3 : 1)));
  const tr = k.transform ?? {};
  const crop = k.crop ?? {};
  const chroma = k.chroma ?? {};
  const stab = k.stabilize ?? {};
  const af = k.audio ?? {};
  const adjust = {};
  for (const [key, [lo, hi]] of Object.entries(ADJUST_KEYS)) adjust[key] = clamp(num(k.adjust?.[key], 0), lo, hi);
  const col = k.color ?? {};
  const curve = Array.isArray(col.curve) && col.curve.length >= 2
    ? col.curve.filter((pt) => Array.isArray(pt) && pt.every(Number.isFinite)).map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)]).sort((a, b) => a[0] - b[0])
    : DEFAULT_CURVE;
  const clip = {
    id: k.id ?? uid("c"),
    trackId: k.trackId,
    ...(adjustmentLayer ? { adjustment: true } : kind === "text" ? { text: k.text, style: { ...DEFAULT_TEXT_STYLE, ...(k.style ?? {}) } } : { mediaId: k.mediaId }),
    // Primary color wheels: puck x/y (color push) and l (luminance) each.
    color: { lift: wheel(col.lift), gamma: wheel(col.gamma), gain: wheel(col.gain), offset: wheel(col.offset), curve: curve.length >= 2 ? curve : DEFAULT_CURVE },
    videoDenoise: clamp(num(k.videoDenoise, 0), 0, 100),
    start: Math.max(0, num(k.start, 0)),
    in: inn,
    out,
    speed: isText ? 1 : clamp(num(k.speed, 1), 0.1, 10),
    volume: clamp(num(k.volume, 1), 0, 4),
    fadeIn: Math.max(0, num(k.fadeIn, 0)),
    fadeOut: Math.max(0, num(k.fadeOut, 0)),
    muted: !!k.muted,
    transform: { scale: num(tr.scale, 1), x: num(tr.x, 0), y: num(tr.y, 0), rotation: num(tr.rotation, 0) },
    flipH: !!k.flipH,
    flipV: !!k.flipV,
    opacity: clamp(num(k.opacity, 1), 0, 1),
    crop: { l: clamp(num(crop.l, 0), 0, 0.45), t: clamp(num(crop.t, 0), 0, 0.45), r: clamp(num(crop.r, 0), 0, 0.45), b: clamp(num(crop.b, 0), 0, 0.45) },
    adjust,
    filter: k.filter && byId(FILTERS, k.filter.id) ? { id: k.filter.id, intensity: clamp(num(k.filter.intensity, 100), 0, 100) } : null,
    lut: typeof k.lut === "string" && k.lut ? k.lut : null,
    effects: (Array.isArray(k.effects) ? k.effects : []).filter((e) => e && byId(EFFECTS, e.id)).map((e) => ({ id: e.id, intensity: clamp(num(e.intensity, 60), 0, 100) })),
    chroma: { enabled: !!chroma.enabled, color: /^#[0-9a-f]{6}$/i.test(chroma.color ?? "") ? chroma.color : "#00ff00", similarity: clamp(num(chroma.similarity, 0.18), 0.01, 1), blend: clamp(num(chroma.blend, 0.08), 0, 1) },
    stabilize: { enabled: !!stab.enabled, strength: clamp(num(stab.strength, 50), 0, 100) },
    animIn: animOf(k.animIn),
    animOut: animOf(k.animOut),
    transition: k.transition?.type ? { type: k.transition.type, duration: clamp(num(k.transition.duration, 0.5), 0.1, 3) } : null,
    audio: {
      denoise: clamp(num(af.denoise, 0), 0, 100),
      enhance: !!af.enhance,
      voice: af.voice ?? null,
      pitch: clamp(num(af.pitch, 0), -12, 12),
      normalize: !!af.normalize,
    },
    keyframes: (Array.isArray(k.keyframes) ? k.keyframes : [])
      .filter((f) => f && Number.isFinite(f.t))
      .map((f) => ({
        t: Math.max(0, f.t),
        scale: num(f.scale, 1),
        x: num(f.x, 0),
        y: num(f.y, 0),
        ease: ["linear", "smooth", "hold"].includes(f.ease) ? f.ease : "smooth",
      }))
      .sort((a, b) => a.t - b.t),
  };
  return clip;
}

function animOf(a) {
  if (!a || !byId(ANIMATIONS, a.type)) return null;
  return { type: a.type, duration: clamp(num(a.duration, 0.5), 0.05, 5) };
}

export const clipLength = (clip) => (clip.out - clip.in) / (clip.speed || 1);
export const clipEnd = (clip) => clip.start + clipLength(clip);
export const isText = (clip) => typeof clip.text === "string";
export const isAdjustment = (clip) => clip.adjustment === true;
// Clips that play a media file (not text or adjustment layers).
export const hasMedia = (clip) => typeof clip.mediaId === "string";
// Source time shown at timeline time `t` within the clip.
export const sourceAt = (clip, t) => clip.in + (t - clip.start) * (clip.speed || 1);

export function projectDuration(p) {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export const mediaById = (p, id) => p.media.find((m) => m.id === id);
export const trackById = (p, id) => p.tracks.find((t) => t.id === id);
export const clipById = (p, id) => p.clips.find((c) => c.id === id);

export function trackClips(p, trackId) {
  return p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function clipsAt(p, time) {
  return p.clips.filter((c) => c.start <= time + EPS && clipEnd(c) > time + EPS);
}

// Video tracks from the lowest layer to the highest. Tracks are stored in
// display order (top row first), so the last video row is the bottom layer:
// the "main track".
export function videoLayers(p) {
  return p.tracks.filter((t) => t.kind === "video").reverse();
}
export const mainTrack = (p) => videoLayers(p)[0];

const ease = {
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  hold: () => 0,
};
const smooth = (u) => u * u * (3 - 2 * u);

// Keyframed transform a clip has `t` seconds after its timeline start.
export function transformAt(clip, t) {
  const k = clip.keyframes;
  const base = clip.transform;
  if (!k.length) return { scale: base.scale, x: base.x, y: base.y };
  if (t <= k[0].t) return pick(k[0]);
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t < b.t) {
      const u = ease[a.ease]((t - a.t) / Math.max(EPS, b.t - a.t));
      return { scale: a.scale + (b.scale - a.scale) * u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return pick(k[k.length - 1]);
}

// Everything that moves a clip at time t: keyframes, in/out animations and
// motion effects. Mirrors the FFmpeg expressions built in render.js.
export function evaluateClip(clip, t) {
  const kf = transformAt(clip, t);
  const len = clipLength(clip);
  let scale = kf.scale;
  let x = kf.x;
  let y = kf.y;
  let rotation = clip.transform.rotation;
  let opacity = clip.opacity;
  const apply = (anim, u) => {
    const def = ANIMATIONS.find((a) => a.id === anim.type);
    const e = smooth(Math.min(1, Math.max(0, u)));
    if (def.fade) opacity *= Math.min(1, Math.max(0, u));
    if (def.scale) scale *= def.scale.js(e);
    if (def.x) x += def.x.js(e);
    if (def.y) y += def.y.js(e);
    if (def.rotation) rotation += def.rotation.js(e);
  };
  if (clip.animIn) apply(clip.animIn, t / clip.animIn.duration);
  if (clip.animOut) apply(clip.animOut, (len - t) / clip.animOut.duration);
  for (const fx of clip.effects) {
    const def = EFFECTS.find((e) => e.id === fx.id);
    if (!def?.motion) continue;
    const I = fx.intensity / 100;
    if (def.motion.scale) scale *= def.motion.scale.js(t, I);
    if (def.motion.x) x += def.motion.x.js(t, I);
    if (def.motion.y) y += def.motion.y.js(t, I);
  }
  return { scale, x, y, rotation, opacity };
}

// Look + manual adjustments merged into one set of values.
export function effectiveAdjust(clip) {
  const out = { ...clip.adjust };
  const look = clip.filter && FILTERS.find((f) => f.id === clip.filter.id);
  if (look) {
    const i = clip.filter.intensity / 100;
    for (const [k, v] of Object.entries(look.adjust)) {
      const [lo, hi] = ADJUST_KEYS[k];
      out[k] = clamp(out[k] + v * i, lo, hi);
    }
  }
  return out;
}

export function bleepsIn(p, a, b) {
  return p.bleeps.filter((x) => x.end > a && x.start < b);
}

export function formatTime(sec, fps = 30) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const f = Math.floor((s - Math.floor(s)) * fps + EPS);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${h ? `${h}:` : ""}${pad(m)}:${pad(whole)}:${pad(f)}`;
}

function pick(f) {
  return { scale: f.scale, x: f.x, y: f.y };
}
function num(v, d) {
  return Number.isFinite(v) ? v : d;
}
function posInt(v, d) {
  return Number.isInteger(v) && v > 0 ? v : d;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function baseName(path) {
  return path.split(/[\\/]/).pop();
}
