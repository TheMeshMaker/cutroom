// Builds one FFmpeg invocation (inputs + filter graph) that renders a project.
// Pure: returns data; the Node exporter writes the graph/text files and spawns
// ffmpeg.
//
// Layout of the graph:
//   each track  -> [clip piece | gap] items, pieces joined by xfade/acrossfade
//                  where a transition sits, exactly `total` long
//   video       -> every layer (transparent outside its clips) over black,
//                  text drawn on top, then the export preset frame and size
//   audio       -> every unmuted track mixed, bleeps mute the mix + add a tone

import { ANIMATIONS, EFFECTS, FILTERS, TRANSITIONS, VOICE_EFFECTS, byId, fontFile } from "./catalog.js";
import { clipEnd, clipLength, effectiveAdjust, evaluateClip, hasMedia, isAdjustment, mediaById, videoLayers } from "./model.js";

export const EXPORT_PRESETS = {
  landscape: { label: "Project canvas" },
  "shorts-square": { label: "Shorts: square gameplay panel (1080x1920)", width: 1080, height: 1920 },
  "vertical-fill": { label: "Vertical: center crop (1080x1920)", width: 1080, height: 1920 },
};

const EPS = 1e-6;
const TOUCH = 0.02;
const SAMPLE_RATE = 48000;

// Format a number for an ffmpeg expression without exponent notation.
export function f(x) {
  const s = (Math.round(x * 1e6) / 1e6).toFixed(6);
  return s.replace(/\.?0+$/, "") || "0";
}

// Quote a file path for use as a filter option value.
export function filterPath(p) {
  return `'${p.replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:")}'`;
}

const hexColor = (hex, alpha = 1) => {
  const h = (hex ?? "#ffffff").replace("#", "");
  const rgb = h.slice(0, 6).padEnd(6, "f");
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `0x${rgb}${Math.round(Math.min(1, a * alpha) * 255).toString(16).padStart(2, "0")}`;
};

/**
 * @param {object} project normalized project
 * @param {object} [opts]
 * @param {keyof EXPORT_PRESETS} [opts.preset]
 * @param {[number, number]} [opts.range] timeline window to render
 * @param {"blur"|"black"} [opts.background] shorts-square backdrop
 * @param {boolean} [opts.audio] include an audio graph (default true)
 * @param {boolean} [opts.video] include a video graph (default true)
 * @param {number} [opts.outShortSide] scale the output so its short side is this
 * @param {number} [opts.previewWidth] scale the output to this width (stills)
 * @param {string} [opts.tmpDir] where text files go (required for text clips)
 * @param {(m: object) => string} [opts.pathFor] media path to read (proxy, etc.)
 */
export function buildRenderPlan(project, opts = {}) {
  const preset = opts.preset ?? "landscape";
  if (!EXPORT_PRESETS[preset]) throw new Error(`Unknown export preset: ${preset}`);
  const { width: W, height: H, fps } = project.canvas;
  const projectEnd = project.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  const [r0, r1] = opts.range ?? [0, projectEnd];
  const total = r1 - r0;
  if (!(total > EPS)) throw new Error("Nothing to render: the timeline (or range) is empty");
  const pathFor = opts.pathFor ?? ((m) => m.path);
  const withAudio = opts.audio !== false;
  const withVideo = opts.video !== false;

  const inputs = [];
  const chains = [];
  const files = [];
  let label = 0;
  const next = (p) => `${p}${label++}`;

  // Clip pieces of one track inside the render window. `at` is the window
  // position, `offset` how far into the clip (timeline seconds) the piece
  // starts, `pre`/`post` extra handle seconds rendered for transitions.
  const segmentsOf = (track) => {
    const segs = project.clips
      .filter((c) => c.trackId === track.id && hasMedia(c))
      .map((c) => {
        const s = Math.max(c.start, r0);
        const e = Math.min(clipEnd(c), r1);
        if (e - s <= EPS) return null;
        return { clip: c, media: mediaById(project, c.mediaId), at: s - r0, dur: e - s, offset: s - c.start, pre: 0, post: 0, trans: null };
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
    // Resolve transitions: centered on the cut, using source handles.
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1];
      const b = segs[i];
      const t = b.clip.transition;
      if (!t || !byId(TRANSITIONS, t.type)) continue;
      const touching = Math.abs(a.at + a.dur - b.at) < TOUCH && b.offset < EPS && Math.abs(a.offset + a.dur - clipLength(a.clip)) < TOUCH;
      if (!touching) continue;
      const handleAfter = a.media.kind === "image" ? Infinity : (a.media.duration - a.clip.out) / a.clip.speed;
      const handleBefore = b.media.kind === "image" ? Infinity : b.clip.in / b.clip.speed;
      // Capped by the clips themselves (not the render window), so a range
      // render shows the same transition as the full export.
      const d = Math.min(t.duration, clipLength(a.clip) * 0.9, clipLength(b.clip) * 0.9, 2 * handleAfter, 2 * handleBefore);
      if (d < 0.05) continue;
      a.post = d / 2;
      b.pre = d / 2;
      b.trans = { xfade: byId(TRANSITIONS, t.type).xfade, d };
      // If the window cuts b short, render more of b so xfade has enough frames
      // (the extra is past the window end and gets trimmed by the overlay).
      const bLen = b.pre + b.dur + b.post;
      if (bLen < d + 1 / project.canvas.fps) b.post += d + 1 / project.canvas.fps - bLen;
    }
    return segs;
  };

  const inputIndex = new Map();
  const inputFor = (seg) => {
    if (inputIndex.has(seg.clip.id)) return inputIndex.get(seg.clip.id);
    const speed = seg.clip.speed;
    const len = (seg.pre + seg.dur + seg.post) * speed + 0.5;
    const args =
      seg.media.kind === "image"
        ? ["-loop", "1", "-framerate", f(fps), "-t", f(seg.pre + seg.dur + seg.post + 0.5), "-i", pathFor(seg.media)]
        : ["-ss", f(Math.max(0, seg.clip.in + (seg.offset - seg.pre) * speed)), "-t", f(len), "-i", pathFor(seg.media)];
    inputs.push(args);
    inputIndex.set(seg.clip.id, inputs.length - 1);
    return inputs.length - 1;
  };

  // Tile [0, total] with gaps and transition-joined runs of pieces.
  const tile = (segs, gap, piece, join, kind) => {
    const items = [];
    let t = 0;
    let run = null;
    for (const seg of segs) {
      const at = Math.max(seg.at, t);
      if (seg.trans && run) {
        const l = piece(seg);
        const out = next(kind === "v" ? "xf" : "xa");
        chains.push(`[${run.label}][${l}]${join(seg.trans, run.len)}[${out}]`);
        run = { label: out, len: run.len + seg.pre + seg.dur + seg.post - seg.trans.d };
      } else {
        if (run) items.push(run.label);
        if (at - t > 1 / fps / 2) items.push(gap(at - t));
        run = { label: piece(seg), len: seg.pre + seg.dur + seg.post };
      }
      t = at + seg.dur;
    }
    if (run) items.push(run.label);
    if (total - t > 1 / fps / 2) items.push(gap(total - t));
    const out = next(kind === "v" ? "tv" : "ta");
    if (items.length === 1) chains.push(`[${items[0]}]${kind === "v" ? "null" : "anull"}[${out}]`);
    else chains.push(`${items.map((p) => `[${p}]`).join("")}concat=n=${items.length}:v=${kind === "v" ? 1 : 0}:a=${kind === "v" ? 0 : 1}[${out}]`);
    return out;
  };

  // ---- video
  let videoLabel = null;
  let outW = W;
  let outH = H;
  if (withVideo) {
    let comp = next("base");
    const bg = project.settings?.background;
    chains.push(`color=c=${bg && bg !== "blur" ? hexColor(bg).slice(0, 8) : "black"}:s=${W}x${H}:r=${f(fps)}:d=${f(total)},format=yuv420p,setsar=1[${comp}]`);
    const mainId = videoLayers(project)[0]?.id;
    for (const track of videoLayers(project).filter((t) => !t.hidden)) {
      // Adjustment layers on this track grade everything composited so far.
      const adjustments = project.clips
        .filter((c) => c.trackId === track.id && isAdjustment(c))
        .map((c) => ({ c, a: Math.max(c.start, r0) - r0, b: Math.min(clipEnd(c), r1) - r0 }))
        .filter((x) => x.b - x.a > EPS);
      if (adjustments.length) {
        const filters = adjustments.flatMap(({ c, a, b }) => clipLookFilters(c, { timeline: true }).map((flt) => withEnable(flt, `between(t,${f(a)},${f(b)})`)));
        if (filters.length) {
          const l = next("adj");
          chains.push(`[${comp}]${filters.join(",")},format=yuv420p[${l}]`);
          comp = l;
        }
      }
      const segs = segmentsOf(track).filter((s) => s.media.hasVideo);
      if (!segs.length) continue;
      const gap = (d) => {
        const l = next("g");
        chains.push(`color=c=black@0:s=${W}x${H}:r=${f(fps)}:d=${f(d)},format=yuva420p,setsar=1[${l}]`);
        return l;
      };
      const piece = (seg) => {
        const l = next("v");
        const full = seg.pre + seg.dur + seg.post;
        const tail = `tpad=stop_mode=clone:stop_duration=2,trim=duration=${f(full)},setpts=PTS-STARTPTS,format=yuva420p`;
        if (bg === "blur" && track.id === mainId) {
          // Canvas blur: the same footage, filled and blurred, behind the clip.
          const [a, b, back, front] = [next("s"), next("s"), next("bg"), next("fg")];
          const speed = Math.abs(seg.clip.speed - 1) > EPS ? `setpts=(PTS-STARTPTS)/${f(seg.clip.speed)}` : "setpts=PTS-STARTPTS";
          chains.push(`[${inputFor(seg)}:v]split[${a}][${b}]`);
          chains.push(`[${b}]${speed},fps=${f(fps)},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.08,format=yuva420p,setsar=1[${back}]`);
          chains.push(`[${a}]${videoFilters(seg, { W, H, fps, next })}[${front}]`);
          chains.push(`[${back}][${front}]overlay=0:0:format=auto,${tail}[${l}]`);
        } else chains.push(`[${inputFor(seg)}:v]${videoFilters(seg, { W, H, fps, next })},${tail}[${l}]`);
        return l;
      };
      const join = (tr, runLen) => `xfade=transition=${tr.xfade}:duration=${f(tr.d)}:offset=${f(runLen - tr.d)},format=yuva420p`;
      const layer = tile(segs, gap, piece, join, "v");
      const l = next("ov");
      chains.push(`[${comp}][${layer}]overlay=0:0:format=auto,format=yuv420p[${l}]`);
      comp = l;
    }
    // Text, bottom text row first.
    const drawn = [];
    for (const track of project.tracks.filter((t) => t.kind === "text" && !t.hidden).reverse()) {
      for (const c of project.clips.filter((k) => k.trackId === track.id).sort((a, b) => a.start - b.start)) {
        const s = Math.max(c.start, r0);
        const e = Math.min(clipEnd(c), r1);
        if (e - s <= EPS || !c.text.trim()) continue;
        if (!opts.tmpDir) throw new Error("tmpDir is required to render text");
        const file = `${opts.tmpDir.replace(/\\/g, "/")}/text-${files.length}.txt`;
        files.push({ path: file, content: c.text });
        drawn.push(drawtextFor(c, file, { W, H, start: c.start - r0, from: s - r0, to: e - r0 }));
      }
    }
    if (drawn.length) {
      const l = next("txt");
      chains.push(`[${comp}]${drawn.join(",")}[${l}]`);
      comp = l;
    }
    const framed = presetFrame(preset, comp, opts.background ?? "blur", next);
    chains.push(...framed.chains);
    videoLabel = framed.label;
    outW = framed.width ?? W;
    outH = framed.height ?? H;
    let scale = null;
    if (opts.previewWidth) scale = [opts.previewWidth, Math.round((outH * opts.previewWidth) / outW / 2) * 2];
    else if (opts.outShortSide && opts.outShortSide !== Math.min(outW, outH)) {
      const k = opts.outShortSide / Math.min(outW, outH);
      scale = [Math.round((outW * k) / 2) * 2, Math.round((outH * k) / 2) * 2];
    }
    if (scale) {
      const l = next("sz");
      chains.push(`[${videoLabel}]scale=${scale[0]}:${scale[1]}:flags=lanczos,setsar=1[${l}]`);
      videoLabel = l;
      [outW, outH] = scale;
    }
  }

  // ---- audio
  let audioLabel = null;
  if (withAudio) {
    const silence = (d) => {
      const l = next("s");
      chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${f(d)}[${l}]`);
      return l;
    };
    const streams = []; // { label, track }
    const soloing = project.tracks.some((t) => t.solo && t.kind !== "text");
    for (const track of project.tracks) {
      if (track.kind === "text" || track.muted || (track.kind === "video" && track.hidden)) continue;
      if (soloing && !track.solo) continue;
      if (track.volume <= 0) continue;
      const segs = segmentsOf(track);
      if (!segs.some((s) => s.media.hasAudio && !s.clip.muted && s.clip.volume > 0)) continue;
      const piece = (seg) => {
        const l = next("a");
        const full = seg.pre + seg.dur + seg.post;
        if (!seg.media.hasAudio || seg.clip.muted || seg.clip.volume <= 0) {
          chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${f(full)}[${l}]`);
          return l;
        }
        chains.push(`[${inputFor(seg)}:a]${audioFilters(seg)},apad,atrim=duration=${f(full)},asetpts=PTS-STARTPTS[${l}]`);
        return l;
      };
      const join = (tr) => `acrossfade=d=${f(tr.d)}:c1=tri:c2=tri`;
      let label = tile(segs, silence, piece, join, "a");
      // Track fader and pan.
      const strip = [];
      if (Math.abs(track.volume - 1) > EPS) strip.push(`volume=${f(track.volume)}`);
      if (Math.abs(track.pan) > EPS) {
        const l = Math.min(1, 1 - track.pan);
        const r = Math.min(1, 1 + track.pan);
        strip.push(`pan=stereo|c0=${f(l)}*c0|c1=${f(r)}*c1`);
      }
      if (strip.length) {
        const out = next("trk");
        chains.push(`[${label}]${strip.join(",")}[${out}]`);
        label = out;
      }
      streams.push({ label, track });
    }
    // Auto-ducking: tracks with duck on are compressed by the dialogue mix.
    const ducked = streams.filter((s) => s.track.duck.enabled && s.track.role !== "dialogue");
    const dialogue = streams.filter((s) => s.track.role === "dialogue");
    if (ducked.length && dialogue.length) {
      const keys = [];
      for (const s of dialogue) {
        const [keep, key] = [next("dl"), next("dk")];
        chains.push(`[${s.label}]asplit=2[${keep}][${key}]`);
        s.label = keep;
        keys.push(key);
      }
      let side = keys[0];
      if (keys.length > 1) {
        side = next("dmix");
        chains.push(`${keys.map((k) => `[${k}]`).join("")}amix=inputs=${keys.length}:duration=longest:normalize=0[${side}]`);
      }
      const sides = ducked.map(() => next("sc"));
      chains.push(sides.length > 1 ? `[${side}]asplit=${sides.length}${sides.map((x) => `[${x}]`).join("")}` : `[${side}]anull[${sides[0]}]`);
      ducked.forEach((s, i) => {
        const out = next("duck");
        const ratio = 2 + (18 * s.track.duck.amount) / 100;
        chains.push(`[${s.label}][${sides[i]}]sidechaincompress=threshold=0.03:ratio=${f(ratio)}:attack=20:release=400:makeup=1[${out}]`);
        s.label = out;
      });
    }
    const mixInputs = streams.map((s) => s.label);
    let mix;
    if (!mixInputs.length) mix = silence(total);
    else if (mixInputs.length === 1) mix = mixInputs[0];
    else {
      mix = next("mix");
      chains.push(`${mixInputs.map((m) => `[${m}]`).join("")}amix=inputs=${mixInputs.length}:duration=longest:normalize=0[${mix}]`);
    }
    // Master loudness target (e.g. -14 LUFS for YouTube).
    if (opts.loudness) {
      const l = next("loud");
      chains.push(`[${mix}]loudnorm=I=${f(opts.loudness)}:TP=-1:LRA=11,aresample=${SAMPLE_RATE}[${l}]`);
      mix = l;
    }
    const bleeps = project.bleeps.map((b) => [Math.max(b.start, r0) - r0, Math.min(b.end, r1) - r0]).filter(([a, b]) => b - a > EPS);
    audioLabel = next("aout");
    if (bleeps.length) {
      const inside = bleeps.map(([a, b]) => `between(t,${f(a)},${f(b)})`).join("+");
      const muted = next("bm");
      const tone = next("bt");
      chains.push(`[${mix}]volume=volume=0:enable='${inside}'[${muted}]`);
      chains.push(`sine=frequency=1000:sample_rate=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.3,volume=volume=0:enable='not(${inside})',atrim=duration=${f(total)}[${tone}]`);
      chains.push(`[${muted}][${tone}]amix=inputs=2:duration=first:normalize=0[${audioLabel}]`);
    } else chains.push(`[${mix}]atrim=duration=${f(total)}[${audioLabel}]`);
  }

  return { inputs, graph: chains.join(";\n"), files, video: videoLabel, audio: audioLabel, duration: total, width: outW, height: outH, fps };
}

// ---------------------------------------------------------------- video ---

function videoFilters(seg, { W, H, fps, next }) {
  const c = seg.clip;
  const out = [];
  if (Math.abs(c.speed - 1) > EPS) out.push(`setpts=(PTS-STARTPTS)/${f(c.speed)}`);
  else out.push("setpts=PTS-STARTPTS");
  out.push(`fps=${f(fps)}`);
  if (c.stabilize.enabled) {
    // deshake's search radius must be a multiple of 16 (16..64).
    const r = 16 * Math.min(4, Math.max(1, Math.round(1 + (3 * c.stabilize.strength) / 100)));
    out.push(`deshake=rx=${r}:ry=${r}:edge=mirror`);
  }
  if (c.flipH) out.push("hflip");
  if (c.flipV) out.push("vflip");
  out.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`);
  out.push(...clipLookFilters(c, { next }));
  out.push("format=yuva420p");
  if (c.chroma.enabled) out.push(`chromakey=color=${hexColor(c.chroma.color).slice(0, 8)}:similarity=${f(c.chroma.similarity)}:blend=${f(c.chroma.blend)}`);
  if (c.mask) out.push(maskFilter(c.mask));
  out.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`, "setsar=1");
  const { l, t, r, b } = c.crop;
  if (l + t + r + b > EPS) {
    const cw = Math.max(2, Math.round(W * (1 - l - r)));
    const ch = Math.max(2, Math.round(H * (1 - t - b)));
    out.push(`crop=${cw}:${ch}:${Math.round(W * l)}:${Math.round(H * t)}`, `pad=${W}:${H}:${Math.round(W * l)}:${Math.round(H * t)}:color=black@0`);
  }
  if (c.opacity < 1 - EPS) out.push(`colorchannelmixer=aa=${f(c.opacity)}`, "format=yuva420p");
  out.push(...transformFilters(seg, { W, H, fps }));
  out.push(...fadeFilters(seg, { W, H, fps, next }));
  return out.join(",");
}

// A shape mask on the alpha of the fitted clip (before it's placed on the canvas).
// M is 1 inside the shape, fading to 0 over `feather`.
export function maskFilter({ type, x, y, w, h, feather, invert }) {
  const fe = f(Math.max(0.005, feather));
  // Offsets in clip halves; distances in the clip's short side, so a circle stays round.
  const dx = `((X-W*${f(0.5 + x / 2)})/min(W,H))`;
  const dy = `((Y-H*${f(0.5 + y / 2)})/min(W,H))`;
  const d = {
    circle: `hypot(${dx}/${f(w / 2)},${dy}/${f(h / 2)})`,
    rectangle: `max(abs(${dx})/${f(w / 2)},abs(${dy})/${f(h / 2)})`,
    mirror: `abs(${dy})/${f(h / 2)}`,
  }[type];
  // linear: everything above the line at y shows, softened over `feather`.
  const m = type === "linear" ? `clip(0.5-${dy}/${fe},0,1)` : `clip((1-${d})/${fe},0,1)`;
  return `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${invert ? `(1-${m})` : m}'`;
}

// Effects whose filters can be switched on for part of the timeline (needed
// by adjustment layers, which use `enable`).
const TIMELINE_EFFECTS = new Set(["blur", "grain", "rgb-split", "bw", "invert", "sketch"]);

// Everything that changes a clip's picture (not its geometry): denoise, color
// wheels and curve, adjustments, look, LUT, effects.
function clipLookFilters(c, { next, timeline = false } = {}) {
  const out = [];
  if (c.videoDenoise > 0) {
    const s = c.videoDenoise / 100;
    out.push(`hqdn3d=${f(1 + 5 * s)}:${f(1 + 4 * s)}:${f(2 + 8 * s)}:${f(2 + 6 * s)}`);
  }
  out.push(...colorFilters(c.color));
  out.push(...adjustFilters(effectiveAdjust(c)));
  const look = c.filter && byId(FILTERS, c.filter.id);
  if (look?.extra) out.push(look.extra(c.filter.intensity / 100));
  if (c.lut) out.push(`lut3d=file=${filterPath(c.lut)}:interp=tetrahedral`);
  for (const fx of c.effects) {
    const def = byId(EFFECTS, fx.id);
    if (!def?.chain || (timeline && !TIMELINE_EFFECTS.has(fx.id))) continue;
    out.push(def.chain(fx.intensity / 100, next?.("fx") ?? "fx"));
  }
  return out;
}

// Wheel puck (x, y) is a push toward a hue on the color wheel; convert it to
// an RGB shift (like moving U/V).
export function wheelRgb({ x, y }) {
  return { r: 1.402 * y, g: -0.344 * x - 0.714 * y, b: 1.772 * x };
}

// Primary wheels -> colorbalance (lift = shadows, gamma = midtones, gain =
// highlights, offset = all), wheel luminance + custom curve -> curves.
export function colorFilters(col) {
  const out = [];
  if (!col) return out;
  const k = 0.25;
  const L = wheelRgb(col.lift);
  const G = wheelRgb(col.gamma);
  const H = wheelRgb(col.gain);
  const O = wheelRgb(col.offset);
  const parts = [];
  const add = (key, v) => Math.abs(v) > 1e-4 && parts.push(`${key}=${f(Math.max(-1, Math.min(1, v * k)))}`);
  for (const ch of ["r", "g", "b"]) {
    add(`${ch}s`, L[ch] + O[ch]);
    add(`${ch}m`, G[ch] + O[ch]);
    add(`${ch}h`, H[ch] + O[ch]);
  }
  if (parts.length) out.push(`colorbalance=${parts.join(":")}`);
  const { lift, gamma, gain, offset } = col;
  if ([lift.l, gamma.l, gain.l, offset.l].some((v) => Math.abs(v) > 1e-4)) {
    const lo = Math.max(0, Math.min(0.4, 0.2 * lift.l + 0.15 * offset.l));
    const hi = Math.max(0.6, Math.min(1, 1 + 0.25 * gain.l + 0.15 * offset.l));
    const mid = Math.max(lo + 0.02, Math.min(hi - 0.02, lo + (hi - lo) * (0.5 + 0.18 * gamma.l)));
    out.push(`curves=master='0/${f(lo)} 0.5/${f(mid)} 1/${f(hi)}'`);
  }
  const curve = col.curve ?? [];
  const identity = curve.length === 2 && curve[0][0] === 0 && curve[0][1] === 0 && curve[1][0] === 1 && curve[1][1] === 1;
  if (curve.length >= 2 && !identity) out.push(`curves=master='${curve.map(([x, y]) => `${f(x)}/${f(y)}`).join(" ")}'`);
  return out;
}

// Add `enable` (timeline window) to one filter string.
function withEnable(filter, expr) {
  return filter.includes("=") ? `${filter}:enable='${expr}'` : `${filter}=enable='${expr}'`;
}

export function adjustFilters(a) {
  const out = [];
  const eq = [];
  if (a.brightness) eq.push(`brightness=${f((a.brightness / 100) * 0.25)}`);
  if (a.contrast) eq.push(`contrast=${f(1 + (a.contrast / 100) * 0.6)}`);
  if (a.saturation) eq.push(`saturation=${f(Math.max(0, 1 + a.saturation / 100))}`);
  if (eq.length) out.push(`eq=${eq.join(":")}`);
  if (a.exposure) out.push(`exposure=exposure=${f((a.exposure / 100) * 1.5)}`);
  if (a.temperature) out.push(`colortemperature=temperature=${Math.round(6500 - a.temperature * 30)}`);
  if (a.tint) {
    const k = a.tint / 100;
    out.push(`colorbalance=rm=${f(0.08 * k)}:gm=${f(-0.25 * k)}:bm=${f(0.08 * k)}`);
  }
  if (a.highlights || a.shadows || a.fade) {
    const lift = (a.fade / 100) * 0.15;
    const s = Math.min(0.95, Math.max(0.02, 0.25 + (a.shadows / 100) * 0.12));
    const h = Math.min(0.98, Math.max(s + 0.02, 0.75 + (a.highlights / 100) * 0.12));
    out.push(`curves=master='0/${f(lift)} 0.25/${f(Math.max(lift, s))} 0.75/${f(h)} 1/1'`);
  }
  if (a.sharpen) out.push(`unsharp=5:5:${f((a.sharpen / 100) * 1.5)}`);
  if (a.vignette) out.push(`vignette=angle=${f(0.25 + (a.vignette / 100) * 0.9)}`);
  if (a.grain) out.push(`noise=alls=${Math.round((a.grain / 100) * 40)}:allf=t+u`);
  return out;
}

// Zoom / pan / rotation, static or animated (keyframes, animations, motion
// effects). Animated transforms run in a transparent margin wide enough that
// zooming out or panning never smears edge pixels.
function transformFilters(seg, { W, H, fps }) {
  const c = seg.clip;
  const len = clipLength(c);
  const motion = c.effects.some((e) => byId(EFFECTS, e.id)?.motion);
  const animated = c.keyframes.length > 0 || motion || [c.animIn, c.animOut].some((a) => a && hasTransform(a));
  const { scale, x, y, rotation } = c.transform;
  if (!animated) {
    const out = [];
    if (Math.abs(rotation) > EPS) out.push(`rotate=a=${f((rotation * Math.PI) / 180)}:c=black@0:ow=iw:oh=ih`);
    if (Math.abs(scale - 1) > EPS || Math.abs(x) > EPS || Math.abs(y) > EPS) out.push(perspective(f(scale), f(x), f(y), W, H, "init"));
    return marginWrap(out, staticMargin({ scale, x, y, rotation }, W, H), W, H);
  }
  // Sample the motion to size the margin.
  let minScale = Infinity;
  let maxX = 0;
  let maxY = 0;
  let maxRot = 0;
  for (let i = 0; i <= 80; i++) {
    const v = evaluateClip(c, (len * i) / 80);
    minScale = Math.min(minScale, v.scale);
    maxX = Math.max(maxX, Math.abs(v.x));
    maxY = Math.max(maxY, Math.abs(v.y));
    maxRot = Math.max(maxRot, Math.abs(v.rotation));
  }
  const T = `(in/${f(fps)}+${f(seg.offset - seg.pre)})`;
  const Tn = `(n/${f(fps)}+${f(seg.offset - seg.pre)})`;
  const ex = exprs(c, T, len);
  const out = [];
  if (maxRot > 0.01) out.push(`rotate=a='(${exprs(c, Tn, len).rotation})*PI/180':c=black@0:ow=iw:oh=ih`);
  out.push(perspective(ex.scale, ex.x, ex.y, W, H, "frame"));
  return marginWrap(out, staticMargin({ scale: minScale, x: maxX, y: maxY, rotation: maxRot }, W, H), W, H);
}

const hasTransform = (a) => {
  const def = byId(ANIMATIONS, a.type);
  return !!(def && (def.scale || def.x || def.y || def.rotation));
};

function staticMargin({ scale, x, y, rotation }, W, H) {
  const s = Math.max(0.05, scale);
  let mx = Math.max(0, (W / 2 + Math.abs(x) * W) / s - W / 2);
  let my = Math.max(0, (H / 2 + Math.abs(y) * H) / s - H / 2);
  if (Math.abs(rotation) > 0.01) {
    const half = Math.hypot(W, H) / 2 / s;
    mx = Math.max(mx, half - W / 2 + Math.abs(x) * W / s);
    my = Math.max(my, half - H / 2 + Math.abs(y) * H / s);
  }
  // Keep work bounded: at most a canvas-sized margin on each side.
  return [Math.min(W, Math.ceil(mx / 2) * 2), Math.min(H, Math.ceil(my / 2) * 2)];
}

function marginWrap(filters, [mx, my], W, H) {
  if (!filters.length) return [];
  if (!mx && !my) return filters;
  return [`pad=${W + 2 * mx}:${H + 2 * my}:${mx}:${my}:color=black@0`, ...filters, `crop=${W}:${H}:${mx}:${my}`];
}

// perspective that shows canvas point P from source (P - C - T*canvas)/Z + C.
// W/H inside the expression are the (possibly padded) frame; CW/CH the canvas.
function perspective(Z, X, Y, CW, CH, evalMode) {
  const left = `W/2+(-W/2-(${X})*${CW})/(${Z})`;
  const right = `W/2+(W/2-(${X})*${CW})/(${Z})`;
  const top = `H/2+(-H/2-(${Y})*${CH})/(${Z})`;
  const bottom = `H/2+(H/2-(${Y})*${CH})/(${Z})`;
  return `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:sense=source:eval=${evalMode}`;
}

// Expressions (of T = seconds into the clip) for the full evaluated motion.
// Kept in step with evaluateClip() in model.js.
function exprs(c, T, len) {
  const smooth = (u) => `(${u})*(${u})*(3-2*(${u}))`;
  let scale = kfExpr(c, "scale", T);
  let x = kfExpr(c, "x", T);
  let y = kfExpr(c, "y", T);
  let rotation = f(c.transform.rotation);
  const anim = (a, u) => {
    const def = byId(ANIMATIONS, a.type);
    if (!def) return;
    const E = smooth(`clip(${u},0,1)`);
    const sub = (s) => s.replace(/\bE\b/g, E);
    if (def.scale) scale = `(${scale})*${sub(def.scale.expr)}`;
    if (def.x) x = `(${x})+${sub(def.x.expr)}`;
    if (def.y) y = `(${y})+${sub(def.y.expr)}`;
    if (def.rotation) rotation = `(${rotation})+${sub(def.rotation.expr)}`;
  };
  if (c.animIn) anim(c.animIn, `${T}/${f(c.animIn.duration)}`);
  if (c.animOut) anim(c.animOut, `(${f(len)}-${T})/${f(c.animOut.duration)}`);
  for (const fx of c.effects) {
    const def = byId(EFFECTS, fx.id);
    if (!def?.motion) continue;
    const sub = (s) => s.replace(/\bT\b/g, T).replace(/\bI\b/g, f(fx.intensity / 100));
    if (def.motion.scale) scale = `(${scale})*(${sub(def.motion.scale.expr)})`;
    if (def.motion.x) x = `(${x})+(${sub(def.motion.x.expr)})`;
    if (def.motion.y) y = `(${y})+(${sub(def.motion.y.expr)})`;
  }
  return { scale, x, y, rotation };
}

// Piecewise keyframe interpolation as an ffmpeg expression of T.
function kfExpr(c, key, T) {
  const frames = c.keyframes;
  if (!frames.length) return f(c.transform[key]);
  const last = frames[frames.length - 1];
  let expr = f(last[key]);
  for (let i = frames.length - 2; i >= 0; i--) {
    const a = frames[i];
    const b = frames[i + 1];
    const dv = b[key] - a[key];
    let seg;
    if (Math.abs(dv) < EPS || a.ease === "hold") seg = f(a[key]);
    else {
      const u = `clip((${T}-${f(a.t)})/${f(Math.max(EPS, b.t - a.t))},0,1)`;
      const e = a.ease === "smooth" ? `(${u})*(${u})*(3-2*(${u}))` : u;
      seg = `${f(a[key])}+${f(dv)}*${e}`;
    }
    expr = `if(lt(${T},${f(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${T},${f(frames[0].t)}),${f(frames[0][key])},${expr})`;
}

// Alpha fades for animations that fade. FFmpeg's fade can't start before the
// piece does, so the fade runs on a white mask stream that begins `lead`
// seconds early (at the clip's true start), is trimmed back, and multiplies
// the piece's alpha. Exact at any offset, including one-frame renders.
function fadeFilters(seg, { W, H, fps, next }) {
  const c = seg.clip;
  const len = clipLength(c);
  const full = seg.pre + seg.dur + seg.post;
  const zero = seg.pre - seg.offset; // piece-local time of clip t=0
  const fades = [];
  if (c.animIn && byId(ANIMATIONS, c.animIn.type)?.fade && zero + c.animIn.duration > 0) fades.push(["in", zero, c.animIn.duration]);
  if (c.animOut && byId(ANIMATIONS, c.animOut.type)?.fade) {
    const st = zero + len - c.animOut.duration;
    if (st < full) fades.push(["out", st, c.animOut.duration]);
  }
  if (!fades.length) return [];
  const lead = Math.max(0, ...fades.map(([, st]) => -st));
  const [pa, pb, al, mask, am] = [next("fa"), next("fa"), next("fa"), next("fm"), next("fa")];
  const mfades = fades.map(([t, st, d]) => `fade=t=${t}:st=${f(st + lead)}:d=${f(d)}`).join(",");
  return [
    `split[${pa}][${pb}];[${pb}]alphaextract[${al}];` +
      `color=c=white:s=${W}x${H}:r=${f(fps)}:d=${f(full + lead + 1)},format=gray,${mfades},trim=start=${f(lead)},setpts=PTS-STARTPTS[${mask}];` +
      `[${al}][${mask}]blend=all_mode=multiply:shortest=1[${am}];[${pa}][${am}]alphamerge`,
  ];
}

// ------------------------------------------------------------------ text ---

function drawtextFor(c, file, { W, H, start, from, to }) {
  const st = c.style;
  const k = H / 1080;
  const T = `(t-${f(start)})`;
  const len = clipLength(c);
  let x = f(c.transform.x);
  let y = f(c.transform.y);
  let alpha = f(c.opacity);
  const anim = (a, u) => {
    const def = byId(ANIMATIONS, a.type);
    if (!def) return;
    const U = `clip(${u},0,1)`;
    const E = `(${U})*(${U})*(3-2*(${U}))`;
    if (def.x) x = `(${x})+${def.x.expr.replace(/\bE\b/g, E)}`;
    if (def.y) y = `(${y})+${def.y.expr.replace(/\bE\b/g, E)}`;
    // Text can't scale or spin in drawtext; those animations fade instead.
    if (def.fade || def.scale || def.rotation) alpha = `(${alpha})*${U}`;
  };
  if (c.animIn) anim(c.animIn, `${T}/${f(c.animIn.duration)}`);
  if (c.animOut) anim(c.animOut, `(${f(len)}-${T})/${f(c.animOut.duration)}`);
  const parts = [
    `fontfile=${filterPath(fontFile(st.font, st.bold))}`,
    `textfile=${filterPath(file)}`,
    `fontsize=${Math.max(4, Math.round(st.size * k * c.transform.scale))}`,
    `fontcolor=${hexColor(st.color)}`,
    "text_align=C",
    `x='${W}*(0.5+(${x}))-text_w/2'`,
    `y='${H}*(0.5+(${y}))-text_h/2'`,
    `alpha='${alpha}'`,
    `enable='between(t,${f(from)},${f(to)})'`,
  ];
  if (st.strokeWidth > 0) parts.push(`borderw=${Math.max(1, Math.round(st.strokeWidth * k))}`, `bordercolor=${hexColor(st.strokeColor)}`);
  if (st.bg) parts.push("box=1", `boxcolor=${hexColor(st.bg)}`, `boxborderw=${Math.round(st.size * 0.3 * k)}`);
  if (st.shadow) parts.push(`shadowx=${Math.max(1, Math.round(4 * k))}`, `shadowy=${Math.max(1, Math.round(4 * k))}`, "shadowcolor=0x000000b3");
  return `drawtext=${parts.join(":")}`;
}

// ----------------------------------------------------------------- audio ---

function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  while (s > 100) {
    out.push("atempo=100");
    s /= 100;
  }
  if (Math.abs(s - 1) > EPS) out.push(`atempo=${f(s)}`);
  return out;
}

function audioFilters(seg) {
  const c = seg.clip;
  const out = ["asetpts=PTS-STARTPTS", ...atempoChain(c.speed), `aresample=${SAMPLE_RATE}`, "aformat=sample_fmts=fltp:channel_layouts=stereo"];
  const a = c.audio;
  if (a.denoise > 0) out.push(`afftdn=nr=${f(6 + (24 * a.denoise) / 100)}:nf=-40`);
  if (a.enhance) out.push("highpass=f=80", "equalizer=f=200:t=q:w=1:g=-2", "equalizer=f=3500:t=q:w=1.2:g=3.5", "acompressor=threshold=-20dB:ratio=3:attack=5:release=60:makeup=2");
  const voice = a.voice && byId(VOICE_EFFECTS, a.voice);
  if (voice) out.push(voice.chain);
  if (Math.abs(a.pitch) > EPS) out.push(`rubberband=pitch=${f(2 ** (a.pitch / 12))}`);
  if (a.normalize) out.push("loudnorm=I=-16:TP=-1.5:LRA=11", `aresample=${SAMPLE_RATE}`);
  out.push(`volume=${f(c.volume)}`);
  const len = clipLength(c);
  const zero = seg.pre - seg.offset;
  if (c.fadeIn > seg.offset + EPS) out.push(`afade=t=in:st=${f(Math.max(0, zero))}:d=${f(c.fadeIn - Math.max(0, seg.offset - seg.pre))}`);
  if (c.fadeOut > EPS) {
    const st = zero + len - c.fadeOut;
    if (st < seg.pre + seg.dur + seg.post) out.push(`afade=t=out:st=${f(Math.max(0, st))}:d=${f(c.fadeOut)}`);
  }
  return out.join(",");
}

// ---------------------------------------------------------------- frames ---

function presetFrame(preset, comp, background, next) {
  if (preset === "landscape") return { label: comp, chains: [] };
  const W = 1080;
  const H = 1920;
  const out = next("vout");
  if (preset === "vertical-fill") {
    return { label: out, width: W, height: H, chains: [`[${comp}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[${out}]`] };
  }
  const square = `crop='min(iw,ih)':'min(iw,ih)',scale=${W}:${W},setsar=1`;
  if (background === "black") {
    return { label: out, width: W, height: H, chains: [`[${comp}]${square},pad=${W}:${H}:0:(oh-ih)/2:color=black,format=yuv420p[${out}]`] };
  }
  const [a, b, sq, bg] = [next("sq"), next("sq"), next("sq"), next("bg")];
  return {
    label: out,
    width: W,
    height: H,
    chains: [
      `[${comp}]split=2[${a}][${b}]`,
      `[${a}]${square}[${sq}]`,
      `[${b}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.12,setsar=1[${bg}]`,
      `[${bg}][${sq}]overlay=0:(H-h)/2,format=yuv420p[${out}]`,
    ],
  };
}
