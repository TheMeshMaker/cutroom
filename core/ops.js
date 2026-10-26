// Editing operations. Every function takes a project and returns a new,
// normalized project; inputs are never mutated. The UI and the MCP server both
// call these, so behavior is identical whichever side makes the edit.

import {
  clipById,
  clipEnd,
  clipLength,
  mediaById,
  normalizeProject,
  projectDuration,
  trackById,
  trackClips,
  uid,
} from "./model.js";

const EPS = 1e-6;

function edit(p, fn) {
  const next = structuredClone(p);
  fn(next);
  next.revision = (p.revision ?? 0) + 1;
  return normalizeProject(next);
}

function requireClip(p, id) {
  const c = clipById(p, id);
  if (!c) throw new Error(`No clip ${id}`);
  return c;
}

function overlaps(p, trackId, start, end, ignoreIds = []) {
  return p.clips.some(
    (c) =>
      c.trackId === trackId &&
      !ignoreIds.includes(c.id) &&
      c.start < end - EPS &&
      clipEnd(c) > start + EPS,
  );
}

export function addMedia(p, info) {
  const existing = p.media.find((m) => m.path === info.path);
  if (existing) return { project: p, media: existing };
  const media = { id: uid("m"), ...info };
  const project = edit(p, (n) => n.media.push(media));
  return { project, media: mediaById(project, media.id) };
}

export function setMedia(p, id, patch) {
  return edit(p, (n) => Object.assign(mediaById(n, id) ?? {}, patch));
}

export function addTrack(p, kind, name) {
  const count = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track = { id: uid(kind[0]), kind, name: name ?? `${kind === "video" ? "Video" : "Audio"} ${count}` };
  // New video rows go above existing video (higher layer); audio rows go last.
  const project = edit(p, (n) => {
    if (kind === "video") n.tracks.unshift(track);
    else n.tracks.push(track);
  });
  return { project, track: trackById(project, track.id) };
}

export function setTrack(p, id, patch) {
  return edit(p, (n) => Object.assign(trackById(n, id) ?? {}, patch));
}

// Add a clip for `mediaId`. Defaults: the first track of the matching kind,
// the whole media, appended after the last clip on that track. If the spot is
// taken, the clip goes on the first track of that kind with room (creating one
// if needed).
export function addClip(p, { mediaId, trackId, start, in: inn = 0, out } = {}) {
  const m = mediaById(p, mediaId);
  if (!m) throw new Error(`No media ${mediaId}`);
  const kind = m.hasVideo ? "video" : "audio";
  let project = p;
  let track = trackId ? trackById(p, trackId) : p.tracks.find((t) => t.kind === kind);
  if (!track) ({ project, track } = addTrack(p, kind));
  if (track.kind !== kind) throw new Error(`Track ${track.id} is ${track.kind}; media ${m.id} needs ${kind}`);
  const srcOut = out ?? (m.duration > 0 ? m.duration : inn + 5);
  if (srcOut <= inn) throw new Error("Clip out must be after in");
  const len = srcOut - inn;
  let at = start ?? trackClips(project, track.id).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  if (overlaps(project, track.id, at, at + len)) {
    const free = project.tracks.find((t) => t.kind === kind && !overlaps(project, t.id, at, at + len));
    if (free) track = free;
    else ({ project, track } = addTrack(project, kind));
  }
  const clip = { id: uid("c"), trackId: track.id, mediaId, start: at, in: inn, out: srcOut };
  project = edit(project, (n) => n.clips.push(clip));
  return { project, clip: clipById(project, clip.id) };
}

// Move a clip to a new start (and optionally another track of the same kind).
// Refuses moves that would overlap another clip.
export function moveClip(p, id, { start, trackId } = {}) {
  const c = requireClip(p, id);
  const to = trackId ? trackById(p, trackId) : trackById(p, c.trackId);
  if (!to) throw new Error(`No track ${trackId}`);
  if (to.kind !== trackById(p, c.trackId).kind) throw new Error("Clips can only move between tracks of the same kind");
  const s = Math.max(0, start ?? c.start);
  if (overlaps(p, to.id, s, s + clipLength(c), [c.id])) throw new Error("That spot overlaps another clip");
  return edit(p, (n) => Object.assign(clipById(n, id), { start: s, trackId: to.id }));
}

// Trim by setting new source in/out. Changing `in` keeps the clip's right edge
// fixed (like dragging the left handle); changing `out` keeps the left edge.
export function trimClip(p, id, { in: inn, out } = {}) {
  const c = requireClip(p, id);
  const m = mediaById(p, c.mediaId);
  const maxOut = m.duration > 0 ? m.duration : Infinity;
  const newIn = Math.max(0, Math.min(inn ?? c.in, (out ?? c.out) - 0.04));
  const newOut = Math.min(maxOut, Math.max(out ?? c.out, newIn + 0.04));
  const start = Math.max(0, c.start + (newIn - c.in));
  const shift = start - c.start;
  if (overlaps(p, c.trackId, start, start + newOut - newIn, [c.id])) throw new Error("Trim would overlap another clip");
  return edit(p, (n) => {
    const k = clipById(n, id);
    Object.assign(k, { in: newIn, out: newOut, start });
    k.keyframes = k.keyframes.map((f) => ({ ...f, t: f.t - shift })).filter((f) => f.t >= -EPS);
  });
}

// Split one clip at absolute timeline `time`. Returns [left, right] ids.
export function splitClip(p, id, time) {
  const c = requireClip(p, id);
  const rel = time - c.start;
  if (rel <= EPS || rel >= clipLength(c) - EPS) return { project: p, ids: [c.id] };
  const rightId = uid("c");
  const project = edit(p, (n) => {
    const left = clipById(n, id);
    const right = structuredClone(left);
    right.id = rightId;
    right.start = time;
    right.in = left.in + rel;
    right.fadeIn = 0;
    right.keyframes = left.keyframes.filter((f) => f.t >= rel - EPS).map((f) => ({ ...f, t: f.t - rel }));
    left.out = left.in + rel;
    left.fadeOut = 0;
    left.keyframes = left.keyframes.filter((f) => f.t <= rel + EPS);
    n.clips.push(right);
  });
  return { project, ids: [id, rightId] };
}

// Split every clip under `time` (optionally only on some tracks).
export function splitAt(p, time, { trackIds } = {}) {
  let project = p;
  for (const c of p.clips) {
    if (trackIds && !trackIds.includes(c.trackId)) continue;
    if (c.start < time - EPS && clipEnd(c) > time + EPS) project = splitClip(project, c.id, time).project;
  }
  return project;
}

// Delete clips. With ripple, later clips on the same track close the gap.
export function deleteClips(p, ids, { ripple = false } = {}) {
  const doomed = p.clips.filter((c) => ids.includes(c.id));
  return edit(p, (n) => {
    n.clips = n.clips.filter((c) => !ids.includes(c.id));
    if (!ripple) return;
    for (const d of [...doomed].sort((a, b) => b.start - a.start)) {
      const len = clipLength(d);
      for (const c of n.clips) if (c.trackId === d.trackId && c.start >= clipEnd(d) - EPS) c.start -= len;
    }
  });
}

// Cut timeline ranges out of every track at once and close the gaps. This is
// how long stalls are removed: everything after a range (clips, bleeps,
// markers) shifts left by its length.
export function removeRanges(p, ranges, { ripple = true } = {}) {
  const sorted = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.max(a, b)])
    .filter(([a, b]) => b - a > EPS)
    .sort((x, y) => y[0] - x[0]);
  let project = p;
  for (const [a, b] of sorted) {
    project = splitAt(splitAt(project, a), b);
    const len = b - a;
    project = edit(project, (n) => {
      n.clips = n.clips.filter((c) => !(c.start >= a - EPS && clipEnd(c) <= b + EPS));
      n.bleeps = n.bleeps
        .map((x) => cutSpan(x, a, b, ripple))
        .filter(Boolean);
      n.markers = n.markers.filter((m) => !(m.time >= a && m.time < b));
      if (!ripple) return;
      for (const c of n.clips) if (c.start >= b - EPS) c.start -= len;
      for (const m of n.markers) if (m.time >= b) m.time -= len;
    });
  }
  return project;
}

function cutSpan(x, a, b, ripple) {
  const len = ripple ? b - a : 0;
  if (x.end <= a) return x;
  if (x.start >= b) return { ...x, start: x.start - len, end: x.end - len };
  if (x.start >= a && x.end <= b) return null;
  const start = x.start < a ? x.start : a;
  const end = x.end > b ? x.end - len : a;
  return end - start > EPS ? { ...x, start, end } : null;
}

export function setClip(p, id, patch) {
  requireClip(p, id);
  const allowed = ["volume", "fadeIn", "fadeOut", "muted", "transform"];
  return edit(p, (n) => {
    const c = clipById(n, id);
    for (const k of allowed) if (k in patch) c[k] = k === "transform" ? { ...c.transform, ...patch.transform } : patch[k];
  });
}

// Set (or replace) a transform keyframe at clip-relative time `t`.
export function setKeyframe(p, clipId, t, values, ease = "smooth") {
  const c = requireClip(p, clipId);
  const rel = Math.min(Math.max(0, t), clipLength(c));
  return edit(p, (n) => {
    const k = clipById(n, clipId);
    const base = { ...k.transform, ...values };
    k.keyframes = k.keyframes.filter((f) => Math.abs(f.t - rel) > 1e-3);
    k.keyframes.push({ t: rel, scale: base.scale, x: base.x, y: base.y, ease });
  });
}

export function removeKeyframe(p, clipId, t) {
  requireClip(p, clipId);
  return edit(p, (n) => {
    const k = clipById(n, clipId);
    k.keyframes = k.keyframes.filter((f) => Math.abs(f.t - t) > 1e-3);
  });
}

export function clearKeyframes(p, clipId) {
  requireClip(p, clipId);
  return edit(p, (n) => {
    clipById(n, clipId).keyframes = [];
  });
}

// A punch-in zoom at absolute timeline `time`: ramp from the clip's current
// framing to `scale` over `ramp` seconds, optionally hold, then ramp back.
// x/y move the zoom target (canvas fractions, + is right/down).
export function punchIn(p, clipId, time, { scale = 1.25, x = 0, y = 0, ramp = 0.12, hold = null, release = null } = {}) {
  const c = requireClip(p, clipId);
  const t0 = time - c.start;
  if (t0 < -EPS || t0 > clipLength(c) + EPS) throw new Error("Time is outside the clip");
  const base = { ...c.transform };
  let next = setKeyframe(p, clipId, t0, base, "smooth");
  next = setKeyframe(next, clipId, t0 + ramp, { scale, x, y }, "smooth");
  if (hold != null) {
    const back = release ?? ramp;
    next = setKeyframe(next, clipId, t0 + ramp + hold, { scale, x, y }, "smooth");
    next = setKeyframe(next, clipId, t0 + ramp + hold + back, base, "smooth");
  }
  return next;
}

export function addBleep(p, start, end) {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  if (b - a < 0.02) throw new Error("Bleep is too short");
  return edit(p, (n) => {
    n.bleeps.push({ id: uid("b"), start: a, end: b });
  });
}

export function setBleep(p, id, patch) {
  return edit(p, (n) => Object.assign(n.bleeps.find((b) => b.id === id) ?? {}, patch));
}

export function removeBleep(p, id) {
  return edit(p, (n) => {
    n.bleeps = n.bleeps.filter((b) => b.id !== id);
  });
}

export function addMarker(p, time, { label = "", color = "amber", end } = {}) {
  return edit(p, (n) => {
    n.markers.push({ id: uid("mk"), time, label, color, ...(end != null ? { end } : {}) });
  });
}

export function removeMarkers(p, ids) {
  return edit(p, (n) => {
    n.markers = n.markers.filter((m) => !ids.includes(m.id));
  });
}

export function setCanvas(p, canvas) {
  return edit(p, (n) => Object.assign(n.canvas, canvas));
}

// Map source-time ranges of one media item (e.g. detected silences) to the
// timeline ranges where clips actually play them.
export function sourceRangesToTimeline(p, mediaId, ranges) {
  const out = [];
  for (const c of p.clips) {
    if (c.mediaId !== mediaId) continue;
    for (const [a, b] of ranges) {
      const s = Math.max(a, c.in);
      const e = Math.min(b, c.out);
      if (e - s > EPS) out.push([c.start + (s - c.in), c.start + (e - c.in)]);
    }
  }
  return mergeRanges(out);
}

export function mergeRanges(ranges) {
  const r = [...ranges].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of r) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export { projectDuration };
