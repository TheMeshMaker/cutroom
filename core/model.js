// Cutroom project model. Pure JS (no Node or DOM imports) so the renderer,
// the Electron main process and the MCP server all share one definition.
//
// Times are seconds (floats). A clip plays source range [in, out) starting at
// timeline position `start`; its length is out - in.

export const FORMAT = "cutroom/1";

export const CANVAS_PRESETS = {
  "1080p": { width: 1920, height: 1080, fps: 30 },
  "1080p60": { width: 1920, height: 1080, fps: 60 },
  "720p": { width: 1280, height: 720, fps: 30 },
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
      { id: "v1", kind: "video", name: "Video 1" },
      { id: "a1", kind: "audio", name: "Audio 1" },
    ],
  });
}

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
      ...(m.proxy ? { proxy: m.proxy } : {}),
    }));
  p.tracks = (Array.isArray(p.tracks) ? p.tracks : [])
    .filter((t) => t && (t.kind === "video" || t.kind === "audio"))
    .map((t) => ({
      id: t.id ?? uid("t"),
      kind: t.kind,
      name: t.name ?? (t.kind === "video" ? "Video" : "Audio"),
      muted: !!t.muted,
      hidden: !!t.hidden,
    }));
  if (!p.tracks.some((t) => t.kind === "video"))
    p.tracks.unshift({ id: "v1", kind: "video", name: "Video 1", muted: false, hidden: false });
  const trackIds = new Set(p.tracks.map((t) => t.id));
  const mediaIds = new Set(p.media.map((m) => m.id));
  p.clips = (Array.isArray(p.clips) ? p.clips : [])
    .filter((k) => k && trackIds.has(k.trackId) && mediaIds.has(k.mediaId))
    .map((k) => {
      const inn = Math.max(0, num(k.in, 0));
      const out = Math.max(inn + 1 / p.canvas.fps, num(k.out, inn + 1));
      const tr = k.transform ?? {};
      return {
        id: k.id ?? uid("c"),
        trackId: k.trackId,
        mediaId: k.mediaId,
        start: Math.max(0, num(k.start, 0)),
        in: inn,
        out,
        volume: clamp(num(k.volume, 1), 0, 4),
        fadeIn: Math.max(0, num(k.fadeIn, 0)),
        fadeOut: Math.max(0, num(k.fadeOut, 0)),
        muted: !!k.muted,
        transform: { scale: num(tr.scale, 1), x: num(tr.x, 0), y: num(tr.y, 0) },
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
    });
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

export const clipLength = (clip) => clip.out - clip.in;
export const clipEnd = (clip) => clip.start + clipLength(clip);

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
// display order (top row first), so the last video row is the bottom layer.
export function videoLayers(p) {
  return p.tracks.filter((t) => t.kind === "video").reverse();
}

const ease = {
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  hold: () => 0,
};

// Transform of a clip `t` seconds after its timeline start.
export function transformAt(clip, t) {
  const k = clip.keyframes;
  if (!k.length) return { ...clip.transform };
  if (t <= k[0].t) return pick(k[0]);
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t < b.t) {
      const u = ease[a.ease]((t - a.t) / Math.max(EPS, b.t - a.t));
      return {
        scale: a.scale + (b.scale - a.scale) * u,
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
      };
    }
  }
  return pick(k[k.length - 1]);
}

// Bleep ranges overlapping [a, b).
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
  return `${h ? `${h}:` : ""}${pad(m)}:${pad(whole)}.${pad(f)}`;
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
