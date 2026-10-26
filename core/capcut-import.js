// Import a CapCut desktop draft (draft_content.json) into a Cutroom project,
// for interoperability with the user's own existing projects.
//
// Observed draft layout (CapCut 9.x): times are integer microseconds; `tracks`
// hold `segments` that point at `materials.*` by `material_id`, with extra
// per-segment materials (fades, speed, ...) referenced by `extra_material_refs`.
// Transform keyframes live in `segment.common_keyframes` as one list per
// property (KFTypeScaleX, KFTypePositionX, ...).
//
// Inferred, not documented by CapCut: position values are normalized so that
// 1.0 moves the frame by half the canvas, with +y pointing up. Cutroom uses
// canvas fractions with +y down, hence the x/2 and -y/2 conversions below.

import { normalizeProject, uid } from "./model.js";

const US = 1e6;

export function importCapcutDraft(draft, { name } = {}) {
  const warnings = [];
  const mats = draft.materials ?? {};
  const byId = new Map();
  for (const list of Object.values(mats)) if (Array.isArray(list)) for (const m of list) if (m?.id) byId.set(m.id, m);

  const media = [];
  const mediaFor = new Map(); // material id -> cutroom media id
  const addMedia = (m, kind) => {
    if (mediaFor.has(m.id)) return mediaFor.get(m.id);
    if (!m.path) return null;
    const existing = media.find((x) => x.path === m.path);
    if (existing) {
      mediaFor.set(m.id, existing.id);
      return existing.id;
    }
    const id = uid("m");
    const isImage = m.type === "photo";
    media.push({
      id,
      path: m.path,
      name: m.material_name || m.name || m.path.split(/[\\/]/).pop(),
      duration: (m.duration ?? 0) / US,
      width: m.width ?? 0,
      height: m.height ?? 0,
      hasVideo: kind === "video",
      hasAudio: kind === "audio" ? true : m.has_audio !== false && !isImage,
      kind: isImage ? "image" : kind,
    });
    mediaFor.set(m.id, id);
    return id;
  };

  const tracks = [];
  const clips = [];
  let videoCount = 0;
  let audioCount = 0;
  const skipped = {};
  // CapCut lists the main (bottom) video track first; Cutroom stores tracks
  // top row first, so video tracks are reversed when collected.
  const videoTracks = [];
  for (const t of draft.tracks ?? []) {
    if (t.type !== "video" && t.type !== "audio") {
      skipped[t.type] = (skipped[t.type] ?? 0) + (t.segments?.length ?? 0);
      continue;
    }
    const kind = t.type;
    const track = {
      id: uid(kind[0]),
      kind,
      name: kind === "video" ? `Video ${++videoCount}` : `Audio ${++audioCount}`,
      muted: (t.attribute ?? 0) === 1,
      hidden: false,
    };
    for (const s of t.segments ?? []) {
      const m = byId.get(s.material_id);
      if (!m) {
        warnings.push(`Segment ${s.id}: material ${s.material_id} not found`);
        continue;
      }
      const mediaId = addMedia(m, kind);
      if (!mediaId) {
        warnings.push(`Segment ${s.id}: material has no file path (online/template material?)`);
        continue;
      }
      const speed = s.speed ?? 1;
      if (Math.abs(speed - 1) > 1e-3) warnings.push(`Segment ${s.id}: speed ${speed}x is not supported yet; imported at 1x`);
      const start = (s.target_timerange?.start ?? 0) / US;
      const dur = (s.target_timerange?.duration ?? 0) / US;
      const inn = (s.source_timerange?.start ?? 0) / US;
      let fadeIn = 0;
      let fadeOut = 0;
      for (const ref of s.extra_material_refs ?? []) {
        const x = byId.get(ref);
        if (x?.type === "audio_fade") {
          fadeIn = (x.fade_in_duration ?? 0) / US;
          fadeOut = (x.fade_out_duration ?? 0) / US;
        }
      }
      const clip = s.clip ?? {};
      const transform = {
        scale: clip.scale?.x ?? 1,
        x: (clip.transform?.x ?? 0) / 2,
        y: -(clip.transform?.y ?? 0) / 2,
      };
      clips.push({
        id: uid("c"),
        trackId: track.id,
        mediaId,
        start,
        in: inn,
        out: inn + dur,
        volume: s.volume ?? 1,
        fadeIn,
        fadeOut,
        muted: false,
        transform,
        keyframes: keyframesOf(s, transform),
      });
    }
    if (kind === "video") videoTracks.push(track);
    else tracks.push(track);
  }
  for (const [type, n] of Object.entries(skipped)) warnings.push(`Skipped ${n} ${type} segment(s): not supported yet`);

  const canvas = draft.canvas_config ?? {};
  const project = normalizeProject({
    name: name ?? draft.name ?? "Imported from CapCut",
    canvas: { width: canvas.width || 1920, height: canvas.height || 1080, fps: draft.fps || 30 },
    media,
    tracks: [...videoTracks.reverse(), ...tracks],
    clips,
  });
  return { project, warnings };
}

function keyframesOf(segment, base) {
  const byTime = new Map();
  const map = {
    KFTypeScaleX: ["scale", (v) => v],
    KFTypePositionX: ["x", (v) => v / 2],
    KFTypePositionY: ["y", (v) => -v / 2],
  };
  for (const list of segment.common_keyframes ?? []) {
    const target = map[list.property_type];
    if (!target) continue;
    const [key, conv] = target;
    for (const k of list.keyframe_list ?? []) {
      const t = (k.time_offset ?? 0) / US;
      const slot = byTime.get(t) ?? { t, ease: k.curveType === "Line" ? "linear" : "smooth" };
      slot[key] = conv(k.values?.[0] ?? (key === "scale" ? 1 : 0));
      byTime.set(t, slot);
    }
  }
  const frames = [...byTime.values()].sort((a, b) => a.t - b.t);
  // Properties a keyframe does not set carry the previous value (or the base).
  let prev = { ...base };
  return frames.map((fr) => {
    const full = { t: fr.t, scale: fr.scale ?? prev.scale, x: fr.x ?? prev.x, y: fr.y ?? prev.y, ease: fr.ease };
    prev = full;
    return full;
  });
}
