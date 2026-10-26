// Editing operations. Every function takes a project and returns a new,
// normalized project; inputs are never mutated. The UI and the MCP server both
// call these, so behavior is identical whichever side makes the edit.

import { TITLE_TEMPLATES, TRANSITIONS, byId } from "./catalog.js";
import {
  clipById,
  clipEnd,
  clipLength,
  hasMedia,
  mainTrack,
  mediaById,
  normalizeProject,
  projectDuration,
  trackById,
  trackClips,
  uid,
} from "./model.js";

const EPS = 1e-6;
const TOUCH = 0.02; // clips closer than this count as touching

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
    (c) => c.trackId === trackId && !ignoreIds.includes(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS,
  );
}

// Shift clips on a track that start at/after `from` by `delta` seconds.
function shiftAfter(n, trackId, from, delta, exceptId) {
  for (const c of n.clips) if (c.trackId === trackId && c.id !== exceptId && c.start >= from - EPS) c.start = Math.max(0, c.start + delta);
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
  const label = { video: "Video", audio: "Audio", text: "Text" }[kind];
  const track = { id: uid(kind[0]), kind, name: name ?? `${label} ${count}` };
  // Display order: text rows on top, then video (new = higher layer), then audio.
  const project = edit(p, (n) => {
    if (kind === "audio") n.tracks.push(track);
    else if (kind === "text") n.tracks.unshift(track);
    else {
      const firstVideo = n.tracks.findIndex((t) => t.kind === "video");
      n.tracks.splice(firstVideo < 0 ? 0 : firstVideo, 0, track);
    }
  });
  return { project, track: trackById(project, track.id) };
}

export function setTrack(p, id, patch) {
  return edit(p, (n) => Object.assign(trackById(n, id) ?? {}, patch));
}

export function removeTrack(p, id) {
  const t = trackById(p, id);
  if (!t) return p;
  if (t.kind === "video" && p.tracks.filter((x) => x.kind === "video").length === 1) throw new Error("The main track can't be removed");
  return edit(p, (n) => {
    n.tracks = n.tracks.filter((x) => x.id !== id);
    n.clips = n.clips.filter((c) => c.trackId !== id);
  });
}

// Add a clip for `mediaId`. Defaults: the first track of the matching kind
// (the main track for video), the whole media, appended after the last clip.
// If the spot is taken, the clip goes on the first track with room.
export function addClip(p, { mediaId, trackId, start, in: inn = 0, out } = {}) {
  const m = mediaById(p, mediaId);
  if (!m) throw new Error(`No media ${mediaId}`);
  const kind = m.hasVideo ? "video" : "audio";
  let project = p;
  let track = trackId ? trackById(p, trackId) : kind === "video" ? mainTrack(p) : p.tracks.find((t) => t.kind === kind);
  if (!track) ({ project, track } = addTrack(p, kind));
  if (track.kind !== kind) throw new Error(`Track ${track.id} is ${track.kind}; media ${m.id} needs ${kind}`);
  const srcOut = out ?? (m.duration > 0 ? m.duration : inn + 5);
  if (srcOut <= inn) throw new Error("Clip out must be after in");
  const len = srcOut - inn;
  const at = start ?? trackClips(project, track.id).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  if (overlaps(project, track.id, at, at + len)) {
    const free = project.tracks.find((t) => t.kind === kind && !overlaps(project, t.id, at, at + len));
    if (free) track = free;
    else ({ project, track } = addTrack(project, kind));
  }
  const clip = { id: uid("c"), trackId: track.id, mediaId, start: at, in: inn, out: srcOut };
  project = edit(project, (n) => n.clips.push(clip));
  return { project, clip: clipById(project, clip.id) };
}

// Add a text clip. Creates a text track when none has room.
export function addText(p, { text = "Text", style, start = 0, duration = 3, trackId, x = 0, y = 0.3 } = {}) {
  let project = p;
  let track = trackId ? trackById(p, trackId) : p.tracks.find((t) => t.kind === "text" && !overlaps(p, t.id, start, start + duration));
  if (!track) ({ project, track } = addTrack(p, "text"));
  if (track.kind !== "text") throw new Error(`Track ${track.id} is not a text track`);
  if (overlaps(project, track.id, start, start + duration)) throw new Error("That spot on the text track is taken");
  const clip = { id: uid("c"), trackId: track.id, text, style: style ?? {}, start, in: 0, out: duration, transform: { scale: 1, x, y, rotation: 0 } };
  project = edit(project, (n) => n.clips.push(clip));
  return { project, clip: clipById(project, clip.id) };
}

// An animated title from a template (TITLE_TEMPLATES) at `start`.
export function addTitle(p, templateId, { start = 0, text } = {}) {
  const tpl = TITLE_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`Unknown title template: ${templateId}`);
  const r = addText(p, { text: text ?? tpl.text, style: tpl.style, start, duration: tpl.duration, x: tpl.x, y: tpl.y });
  const project = setClip(r.project, r.clip.id, { animIn: tpl.animIn, animOut: tpl.animOut });
  return { project, clip: clipById(project, r.clip.id) };
}

// Many text clips on a fresh track (auto captions).
export function addTextTrack(p, items, { name = "Captions", style } = {}) {
  let { project, track } = addTrack(p, "text", name);
  project = edit(project, (n) => {
    for (const it of items) {
      if (!(it.end > it.start)) continue;
      n.clips.push({ id: uid("c"), trackId: track.id, text: it.text, style: { ...(style ?? {}), ...(it.style ?? {}) }, start: it.start, in: 0, out: it.end - it.start, transform: { scale: 1, x: 0, y: it.y ?? 0.36, rotation: 0 } });
    }
  });
  return { project, track: trackById(project, track.id) };
}

// Move a clip to a new start (and optionally another track of the same kind).
export function moveClip(p, id, { start, trackId } = {}) {
  const c = requireClip(p, id);
  const from = trackById(p, c.trackId);
  const to = trackId ? trackById(p, trackId) : from;
  if (!to) throw new Error(`No track ${trackId}`);
  if (to.kind !== from.kind) throw new Error("Clips can only move between tracks of the same kind");
  const s = Math.max(0, start ?? c.start);
  if (overlaps(p, to.id, s, s + clipLength(c), [c.id])) throw new Error("That spot overlaps another clip");
  return edit(p, (n) => {
    const k = clipById(n, id);
    k.start = s;
    if (k.trackId !== to.id) k.transition = null;
    k.trackId = to.id;
  });
}

// Magnetic insert: put a clip into a track's order at the position nearest
// `time`, then close every gap on that track (CapCut's main-track magnet).
export function insertOnTrack(p, id, time, trackId) {
  const c = requireClip(p, id);
  const target = trackId ?? c.trackId;
  if (trackById(p, target).kind !== trackById(p, c.trackId).kind) throw new Error("Clips can only move between tracks of the same kind");
  const others = trackClips(p, target).filter((x) => x.id !== id);
  let index = others.findIndex((x) => time < x.start + clipLength(x) / 2);
  if (index < 0) index = others.length;
  const order = [...others.slice(0, index).map((x) => x.id), id, ...others.slice(index).map((x) => x.id)];
  return edit(p, (n) => {
    const k = clipById(n, id);
    if (k.trackId !== target || index !== others.findIndex((x) => x.start > c.start)) k.transition = null;
    k.trackId = target;
    let t = 0;
    for (const cid of order) {
      const x = clipById(n, cid);
      x.start = t;
      t += clipLength(x);
    }
  });
}

// Close all gaps on a track, keeping clip order.
export function compactTrack(p, trackId) {
  const clips = trackClips(p, trackId);
  let t = 0;
  let changed = false;
  for (const c of clips) {
    if (Math.abs(c.start - t) > EPS) changed = true;
    t += clipLength(c);
  }
  if (!changed) return p;
  return edit(p, (n) => {
    let at = 0;
    for (const c of trackClips(n, trackId)) {
      clipById(n, c.id).start = at;
      at += clipLength(c);
    }
  });
}

// Trim by setting new source in/out. Changing `in` keeps the clip's right edge
// fixed (like dragging the left handle); changing `out` keeps the left edge.
// For text clips in/out act on the clip's length.
export function trimClip(p, id, { in: inn, out } = {}) {
  const c = requireClip(p, id);
  const speed = c.speed || 1;
  let newIn = inn ?? c.in;
  let newOut = out ?? c.out;
  if (!hasMedia(c)) {
    const delta = newIn - c.in; // dragging the left edge
    newOut = Math.max(0.1, newOut - delta);
    newIn = 0;
    const start = Math.max(0, c.start + delta);
    if (overlaps(p, c.trackId, start, start + newOut, [c.id])) throw new Error("Trim would overlap another clip");
    return edit(p, (n) => Object.assign(clipById(n, id), { start, out: newOut }));
  }
  const m = mediaById(p, c.mediaId);
  const maxOut = m.duration > 0 && m.kind !== "image" ? m.duration : Infinity;
  newIn = Math.max(0, Math.min(newIn, newOut - 0.04));
  newOut = Math.min(maxOut, Math.max(newOut, newIn + 0.04));
  const shift = (newIn - c.in) / speed;
  const start = Math.max(0, c.start + shift);
  if (overlaps(p, c.trackId, start, start + (newOut - newIn) / speed, [c.id])) throw new Error("Trim would overlap another clip");
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
    const cut = !hasMedia(left) ? rel : left.in + rel * (left.speed || 1);
    right.id = rightId;
    right.start = time;
    right.fadeIn = 0;
    right.animIn = null;
    right.transition = null;
    right.keyframes = left.keyframes.filter((f) => f.t >= rel - EPS).map((f) => ({ ...f, t: f.t - rel }));
    if (!hasMedia(left)) {
      right.out = left.out - rel;
      left.out = rel;
    } else {
      right.in = cut;
      left.out = cut;
    }
    left.fadeOut = 0;
    left.animOut = null;
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

// CapCut's Q / W: remove the part of each clip left (or right) of `time`.
export function trimToTime(p, ids, time, side, { ripple = false } = {}) {
  let project = p;
  for (const id of ids) {
    const c = clipById(project, id);
    if (!c || c.start >= time - EPS || clipEnd(c) <= time + EPS) continue;
    const { project: next, ids: parts } = splitClip(project, id, time);
    const [left, right] = parts;
    const doomed = side === "left" ? left : right;
    project = deleteClips(next, [doomed], { ripple: ripple && side === "left" });
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
    const len = b - a;
    project = edit(project, (n) => {
      const frame = 1 / (n.canvas?.fps || 30);
      n.clips = n.clips.flatMap((c) => partsOutside(c, a, b, frame));
      n.bleeps = n.bleeps.map((x) => cutSpan(x, a, b, ripple)).filter(Boolean);
      n.markers = n.markers.filter((m) => !(m.time >= a && m.time < b));
      if (!ripple) return;
      for (const c of n.clips) if (c.start >= b - EPS) c.start -= len;
      for (const m of n.markers) if (m.time >= b) m.time -= len;
    });
  }
  return project;
}

// What's left of clip `c` once [a, b] is cut out: 0, 1 or 2 clips. A leftover
// shorter than a frame is dropped (normalizing would grow it into its
// neighbor).
function partsOutside(c, a, b, frame) {
  const end = clipEnd(c);
  if (end <= a + EPS || c.start >= b - EPS) return [c];
  const media = hasMedia(c);
  const speed = media ? c.speed || 1 : 1;
  const parts = [];
  if (a - c.start >= frame - EPS) {
    const left = structuredClone(c);
    left.out = (media ? c.in : 0) + (a - c.start) * speed;
    left.fadeOut = 0;
    left.animOut = null;
    left.keyframes = c.keyframes.filter((f) => f.t <= a - c.start + EPS);
    parts.push(left);
  }
  if (end - b >= frame - EPS) {
    const rel = b - c.start;
    const right = structuredClone(c);
    right.id = parts.length ? uid("c") : c.id;
    right.start = b;
    if (media) right.in = c.in + rel * speed;
    else right.out = end - b;
    right.fadeIn = 0;
    right.animIn = null;
    right.transition = null;
    right.keyframes = c.keyframes.filter((f) => f.t >= rel - EPS).map((f) => ({ ...f, t: f.t - rel }));
    parts.push(right);
  }
  return parts;
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

const MERGE_KEYS = ["transform", "crop", "adjust", "chroma", "stabilize", "audio", "style", "color"];
const SET_KEYS = ["volume", "fadeIn", "fadeOut", "muted", "opacity", "flipH", "flipV", "filter", "lut", "effects", "animIn", "animOut", "text", "speed", "videoDenoise", ...MERGE_KEYS];

// Set clip properties. Objects listed in MERGE_KEYS merge into the existing
// value. Changing speed keeps the clip's start.
export function setClip(p, id, patch) {
  const c = requireClip(p, id);
  for (const k of Object.keys(patch)) if (!SET_KEYS.includes(k)) throw new Error(`Unknown clip property: ${k}`);
  return edit(p, (n) => {
    const k = clipById(n, id);
    for (const key of Object.keys(patch)) {
      if (MERGE_KEYS.includes(key)) k[key] = { ...k[key], ...patch[key] };
      else k[key] = patch[key];
    }
    if ("speed" in patch && hasMedia(c)) {
      const speed = Math.min(10, Math.max(0.1, patch.speed));
      k.speed = speed;
      const ratio = (c.speed || 1) / speed;
      k.keyframes = k.keyframes.map((f) => ({ ...f, t: f.t * ratio }));
      // Getting longer pushes later clips; getting shorter leaves a gap.
      const delta = (c.out - c.in) / speed - clipLength(c);
      if (delta > 0) shiftAfter(n, c.trackId, clipEnd(c), delta, id);
    }
  });
}

// Copy of a clip placed at `start` on the first track of its kind with room.
export function duplicateClip(p, id, start) {
  const c = requireClip(p, id);
  const len = clipLength(c);
  const kind = trackById(p, c.trackId).kind;
  let project = p;
  let track = [trackById(p, c.trackId), ...p.tracks.filter((t) => t.kind === kind)].find((t) => !overlaps(p, t.id, start, start + len));
  if (!track) ({ project, track } = addTrack(p, kind));
  const copy = { ...structuredClone(c), id: uid("c"), trackId: track.id, start, transition: null };
  project = edit(project, (n) => n.clips.push(copy));
  return { project, clip: clipById(project, copy.id) };
}

// Detach a video clip's sound onto an audio track (and mute the video clip).
export function extractAudio(p, id) {
  const c = requireClip(p, id);
  const m = mediaById(p, c.mediaId);
  if (!m?.hasAudio || !m.hasVideo) throw new Error("This clip has no separate audio to extract");
  let project = p;
  const len = clipLength(c);
  let track = p.tracks.find((t) => t.kind === "audio" && !overlaps(p, t.id, c.start, c.start + len));
  if (!track) ({ project, track } = addTrack(p, "audio"));
  const audio = { id: uid("c"), trackId: track.id, mediaId: c.mediaId, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, audio: { ...c.audio } };
  return edit(project, (n) => {
    n.clips.push(audio);
    clipById(n, id).muted = true;
  });
}

// Transition into `clipId` from the clip that ends right where it starts.
export function setTransition(p, clipId, transition) {
  const c = requireClip(p, clipId);
  if (transition) {
    if (!byId(TRANSITIONS, transition.type)) throw new Error(`Unknown transition: ${transition.type}`);
    const prev = previousTouching(p, c);
    if (!prev) throw new Error("A transition needs a clip directly before this one on the same track");
    const room = Math.min(clipLength(prev), clipLength(c));
    transition = { type: transition.type, duration: Math.min(transition.duration ?? 0.5, room * 0.9) };
  }
  return edit(p, (n) => {
    clipById(n, clipId).transition = transition ?? null;
  });
}

export function previousTouching(p, clip) {
  return trackClips(p, clip.trackId).find((x) => x.id !== clip.id && Math.abs(clipEnd(x) - clip.start) < TOUCH) ?? null;
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

// Freeze frame: split at `time` and insert a still (image media already made
// from that frame) for `duration` seconds, pushing the rest of the track.
export function insertFreeze(p, clipId, time, imageMediaId, duration = 3) {
  const c = requireClip(p, clipId);
  let project = splitClip(p, clipId, time).project;
  return edit(project, (n) => {
    shiftAfter(n, c.trackId, time, duration);
    n.clips.push({
      id: uid("c"),
      trackId: c.trackId,
      mediaId: imageMediaId,
      start: time,
      in: 0,
      out: duration,
      transform: { ...c.transform },
      adjust: { ...c.adjust },
      filter: c.filter,
      flipH: c.flipH,
      flipV: c.flipV,
      crop: { ...c.crop },
    });
  });
}

// Point a clip at different media (e.g. a reversed render of its range).
export function replaceClipMedia(p, clipId, mediaId, { in: inn, out, reverseKeyframes = false } = {}) {
  const c = requireClip(p, clipId);
  return edit(p, (n) => {
    const k = clipById(n, clipId);
    const len = clipLength(c);
    k.mediaId = mediaId;
    k.in = inn ?? 0;
    k.out = out ?? k.in + (c.out - c.in);
    if (reverseKeyframes) k.keyframes = k.keyframes.map((f) => ({ ...f, t: len - f.t })).sort((a, b) => a.t - b.t);
  });
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

export function addMarkers(p, items) {
  return edit(p, (n) => {
    for (const m of items) n.markers.push({ id: uid("mk"), label: "", color: "amber", ...m });
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

export function setSettings(p, patch) {
  return edit(p, (n) => Object.assign(n.settings, patch));
}

// Run after an edit: closes main-track gaps when the magnet setting is on.
export function settle(p) {
  return p.settings?.magnet ? compactTrack(p, mainTrack(p).id) : p;
}

export function rename(p, name) {
  return edit(p, (n) => {
    n.name = name;
  });
}

// Map source-time ranges of one media item (e.g. detected silences) to the
// timeline ranges where clips actually play them.
export function sourceRangesToTimeline(p, mediaId, ranges) {
  const out = [];
  for (const c of p.clips) {
    if (c.mediaId !== mediaId) continue;
    const speed = c.speed || 1;
    for (const [a, b] of ranges) {
      const s = Math.max(a, c.in);
      const e = Math.min(b, c.out);
      if (e - s > EPS) out.push([c.start + (s - c.in) / speed, c.start + (e - c.in) / speed]);
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

// Adjustment layer: a media-less clip on the top video track whose color and
// effects apply to everything beneath it while it's on the timeline.
export function addAdjustment(p, { start = 0, duration = 5 } = {}) {
  let project = p;
  let track = p.tracks.find((t) => t.kind === "video" && !overlaps(p, t.id, start, start + duration) && p.tracks.indexOf(t) === p.tracks.findIndex((x) => x.kind === "video"));
  if (!track) ({ project, track } = addTrack(p, "video", "Adjustment"));
  const clip = { id: uid("c"), trackId: track.id, adjustment: true, start, in: 0, out: duration };
  project = edit(project, (n) => n.clips.push(clip));
  return { project, clip: clipById(project, clip.id) };
}

// Roll edit: move the cut between two touching clips by `delta` timeline
// seconds; the left clip gets longer as the right one gets shorter.
export function rollEdit(p, leftId, rightId, delta) {
  const a = requireClip(p, leftId);
  const b = requireClip(p, rightId);
  if (a.trackId !== b.trackId || Math.abs(clipEnd(a) - b.start) > TOUCH) throw new Error("Roll needs two touching clips on one track");
  const ma = hasMedia(a) ? mediaById(p, a.mediaId) : null;
  const maxA = ma && ma.kind !== "image" && ma.duration > 0 ? (ma.duration - a.out) / a.speed : Infinity;
  const maxB = hasMedia(b) ? b.in / b.speed : Infinity;
  let dd = Math.min(delta, clipLength(b) - 0.05); // b keeps at least 0.05 s
  dd = Math.max(dd, -(clipLength(a) - 0.05)); // so does a
  dd = Math.min(dd, maxA); // a can only grow into source it has
  dd = Math.max(dd, -maxB); // b likewise, backwards
  return edit(p, (n) => {
    const A = clipById(n, leftId);
    const B = clipById(n, rightId);
    A.out += dd * (hasMedia(A) ? A.speed : 1);
    if (hasMedia(B)) B.in += dd * B.speed;
    else B.out -= dd;
    B.start += dd;
  });
}

// Slip: show a different part of the source without moving the clip.
export function slipClip(p, id, delta) {
  const c = requireClip(p, id);
  if (!hasMedia(c)) return p;
  const m = mediaById(p, c.mediaId);
  const max = m.kind !== "image" && m.duration > 0 ? m.duration - c.out : Infinity;
  const d = Math.max(-c.in, Math.min(max, delta));
  return edit(p, (n) => {
    const k = clipById(n, id);
    k.in += d;
    k.out += d;
  });
}

// Split the clips that play `mediaId` at the given source times (e.g. detected
// scene changes).
export function splitAtSourceTimes(p, mediaId, times) {
  let project = p;
  for (const t of times) {
    for (const c of project.clips) {
      if (c.mediaId !== mediaId || t <= c.in + 0.05 || t >= c.out - 0.05) continue;
      project = splitClip(project, c.id, c.start + (t - c.in) / c.speed).project;
      break;
    }
  }
  return project;
}

// Open a gap of `len` seconds at `at` on every track (clips spanning `at` are
// split; everything after moves right) so an insert edit keeps sync.
export function insertGap(p, at, len) {
  const split = splitAt(p, at);
  return edit(split, (n) => {
    for (const c of n.clips) if (c.start >= at - EPS) c.start += len;
    for (const b of n.bleeps) {
      if (b.start >= at) {
        b.start += len;
        b.end += len;
      }
    }
    for (const m of n.markers) {
      if (m.time >= at) {
        m.time += len;
        if (m.end != null) m.end += len;
      }
    }
  });
}

// Remove whatever sits in [a, b) on one track, leaving a gap.
export function clearTrackRange(p, trackId, a, b) {
  const split = splitAt(splitAt(p, a, { trackIds: [trackId] }), b, { trackIds: [trackId] });
  return edit(split, (n) => {
    n.clips = n.clips.filter((c) => !(c.trackId === trackId && c.start >= a - EPS && clipEnd(c) <= b + EPS));
  });
}

// Three-point editing from the source monitor. mode: insert (ripple all
// tracks), overwrite (replace what's there), append (end of the track) or
// top (a free video track above, at `at`).
export function placeSource(p, { mediaId, in: inn, out, at = 0, mode = "insert", trackId } = {}) {
  const m = mediaById(p, mediaId);
  if (!m) throw new Error(`No media ${mediaId}`);
  const kind = m.hasVideo ? "video" : "audio";
  const track = trackId ? trackById(p, trackId) : kind === "video" ? mainTrack(p) : p.tracks.find((t) => t.kind === "audio");
  const len = out - inn;
  if (!(len > EPS)) throw new Error("Set an In point before the Out point");
  if (mode === "append") {
    const end = track ? trackClips(p, track.id).reduce((e, c) => Math.max(e, clipEnd(c)), 0) : 0;
    return addClip(p, { mediaId, trackId: track?.id, start: end, in: inn, out });
  }
  if (mode === "top") {
    let project = p;
    let top = p.tracks.find((t) => t.kind === kind && t !== track && !overlaps(p, t.id, at, at + len) && (kind !== "video" || t.id !== mainTrack(p).id));
    if (!top) ({ project, track: top } = addTrack(p, kind));
    return addClip(project, { mediaId, trackId: top.id, start: at, in: inn, out });
  }
  let project = p;
  if (!track) ({ project } = addTrack(p, kind));
  const target = track ?? project.tracks.find((t) => t.kind === kind);
  project = mode === "overwrite" ? clearTrackRange(project, target.id, at, at + len) : insertGap(project, at, len);
  const clip = { id: uid("c"), trackId: target.id, mediaId, start: at, in: inn, out };
  project = edit(project, (n) => n.clips.push(clip));
  return { project, clip: clipById(project, clip.id) };
}

// Close every gap on every track (each track keeps its own clip order).
export function closeGaps(p) {
  let project = p;
  for (const t of p.tracks) project = compactTrack(project, t.id);
  return project;
}

// Speed ramp presets: the clip becomes several pieces whose speeds follow a
// curve (an easy stand-in for retime curves / time remapping).
export const SPEED_RAMPS = {
  "ramp-up": { label: "Ramp up (slow → fast)", speeds: [0.5, 0.75, 1, 1.5, 2, 3] },
  "ramp-down": { label: "Ramp down (fast → slow)", speeds: [3, 2, 1.5, 1, 0.75, 0.5] },
  montage: { label: "Montage (fast, slow middle)", speeds: [3, 2, 0.6, 0.6, 2, 3] },
  hero: { label: "Hero moment (normal, slow-mo, normal)", speeds: [1, 1, 0.3, 0.3, 1, 1] },
  bullet: { label: "Bullet time (fast, very slow, fast)", speeds: [2.5, 1, 0.25, 0.25, 1, 2.5] },
};

export function speedRamp(p, clipId, preset) {
  const def = SPEED_RAMPS[preset];
  if (!def) throw new Error(`Unknown speed ramp: ${preset}`);
  const c = requireClip(p, clipId);
  if (!hasMedia(c)) throw new Error("Speed ramps need a video or audio clip");
  const parts = def.speeds.length;
  const srcLen = (c.out - c.in) / parts;
  const pieces = def.speeds.map((speed, i) => ({ in: c.in + i * srcLen, out: c.in + (i + 1) * srcLen, speed }));
  return edit(p, (n) => {
    const base = clipById(n, clipId);
    n.clips = n.clips.filter((k) => k.id !== clipId);
    let t = base.start;
    const total = pieces.reduce((s, x) => s + (x.out - x.in) / x.speed, 0);
    const delta = total - clipLength(base);
    // Later clips on the track move by the change in length.
    for (const k of n.clips) if (k.trackId === base.trackId && k.start >= clipEnd(base) - EPS) k.start += delta;
    pieces.forEach((x, i) => {
      n.clips.push({
        ...structuredClone(base),
        id: i === 0 ? base.id : uid("c"),
        start: t,
        in: x.in,
        out: x.out,
        speed: x.speed,
        keyframes: [],
        transition: i === 0 ? base.transition : null,
        animIn: i === 0 ? base.animIn : null,
        animOut: i === parts - 1 ? base.animOut : null,
        fadeIn: i === 0 ? base.fadeIn : 0,
        fadeOut: i === parts - 1 ? base.fadeOut : 0,
      });
      t += (x.out - x.in) / x.speed;
    });
  });
}

export function setTranscript(p, mediaId, transcript) {
  return edit(p, (n) => {
    n.transcripts[mediaId] = transcript;
  });
}

export function setDeliver(p, jobs) {
  return edit(p, (n) => {
    n.deliver = jobs;
  });
}

export { projectDuration };
