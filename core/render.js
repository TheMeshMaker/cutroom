// Builds one FFmpeg invocation (inputs + filter graph) that renders a project.
// Pure: returns data; the Node exporter writes the graph file and spawns ffmpeg.
//
// Layout of the graph:
//   each track  -> concat of [clip segment | gap] pieces, exactly `total` long
//   video       -> layers overlaid bottom to top, then the export preset frame
//   audio       -> every unmuted track mixed, bleeps mute the mix + add a tone

import { clipEnd, clipLength, mediaById, videoLayers } from "./model.js";

export const EXPORT_PRESETS = {
  landscape: { label: "Project canvas" },
  "shorts-square": { label: "Shorts: square gameplay panel (1080x1920)", width: 1080, height: 1920 },
  "vertical-fill": { label: "Vertical: center crop (1080x1920)", width: 1080, height: 1920 },
};

const EPS = 1e-6;
const SAMPLE_RATE = 48000;

// Format a number for an ffmpeg expression without exponent notation.
export function f(x) {
  const s = (Math.round(x * 1e6) / 1e6).toFixed(6);
  return s.replace(/\.?0+$/, "") || "0";
}

/**
 * @param {object} project normalized project
 * @param {object} [opts]
 * @param {keyof EXPORT_PRESETS} [opts.preset]
 * @param {[number, number]} [opts.range] timeline window to render
 * @param {"blur"|"black"} [opts.background] shorts-square backdrop
 * @param {boolean} [opts.audio] include an audio graph (default true)
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

  const inputs = []; // each entry is the arg list for one -i
  const chains = [];
  let label = 0;
  const next = (p) => `${p}${label++}`;

  // Clip pieces of one track inside the render window, with timeline offsets
  // already shifted so the window starts at 0.
  const segmentsOf = (track) =>
    project.clips
      .filter((c) => c.trackId === track.id)
      .map((c) => {
        const s = Math.max(c.start, r0);
        const e = Math.min(clipEnd(c), r1);
        if (e - s <= EPS) return null;
        const offset = s - c.start; // seconds into the clip
        return { clip: c, media: mediaById(project, c.mediaId), at: s - r0, dur: e - s, offset };
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);

  const inputIndex = new Map(); // clip.id -> ffmpeg input index
  const inputFor = (seg) => {
    if (inputIndex.has(seg.clip.id)) return inputIndex.get(seg.clip.id);
    const src = seg.clip.in + seg.offset;
    const args =
      seg.media.kind === "image"
        ? ["-loop", "1", "-framerate", f(fps), "-t", f(seg.dur + 0.5), "-i", pathFor(seg.media)]
        : ["-ss", f(src), "-t", f(seg.dur + 0.5), "-i", pathFor(seg.media)];
    inputs.push(args);
    inputIndex.set(seg.clip.id, inputs.length - 1);
    return inputs.length - 1;
  };

  // Walk a track's timeline, emitting gap/segment pieces that tile [0, total].
  const tile = (segs, gap, piece) => {
    const pieces = [];
    let t = 0;
    for (const seg of segs) {
      const at = Math.max(seg.at, t);
      if (at - t > 1 / fps / 2) pieces.push(gap(at - t));
      const dur = seg.at + seg.dur - at;
      if (dur > EPS) pieces.push(piece(seg, at - seg.at, dur));
      t = at + Math.max(0, dur);
    }
    if (total - t > 1 / fps / 2) pieces.push(gap(total - t));
    return pieces;
  };

  const concat = (pieces, kind) => {
    const out = next(kind === "v" ? "tv" : "ta");
    if (pieces.length === 1) chains.push(`[${pieces[0]}]${kind === "v" ? "null" : "anull"}[${out}]`);
    else chains.push(`${pieces.map((p) => `[${p}]`).join("")}concat=n=${pieces.length}:v=${kind === "v" ? 1 : 0}:a=${kind === "v" ? 0 : 1}[${out}]`);
    return out;
  };

  // ---- video
  const layers = videoLayers(project).filter((t) => !t.hidden);
  const trackStreams = [];
  layers.forEach((track, i) => {
    const segs = segmentsOf(track).filter((s) => s.media.hasVideo);
    if (!segs.length && i > 0) return;
    const alpha = trackStreams.length > 0;
    const pix = alpha ? "yuva420p" : "yuv420p";
    const gap = (d) => {
      const l = next("g");
      chains.push(`color=c=black${alpha ? "@0" : ""}:s=${W}x${H}:r=${f(fps)}:d=${f(d)},format=${pix},setsar=1[${l}]`);
      return l;
    };
    const piece = (seg, skip, dur) => {
      const l = next("v");
      const idx = inputFor(seg);
      const persp = perspectiveFor(seg.clip, seg.offset + skip, fps);
      chains.push(
        `[${idx}:v]fps=${f(fps)},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black${alpha ? "@0" : ""},setsar=1,format=${pix}` +
          (persp ? `,${persp}` : "") +
          `,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f(dur)},setpts=PTS-STARTPTS[${l}]`,
      );
      return l;
    };
    trackStreams.push(concat(tile(segs, gap, piece), "v"));
  });
  let comp;
  if (!trackStreams.length) {
    comp = next("bg");
    chains.push(`color=c=black:s=${W}x${H}:r=${f(fps)}:d=${f(total)},format=yuv420p,setsar=1[${comp}]`);
  } else {
    comp = trackStreams[0];
    for (const upper of trackStreams.slice(1)) {
      const l = next("ov");
      chains.push(`[${comp}][${upper}]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[${l}]`);
      comp = l;
    }
  }
  const out = presetFrame(preset, comp, opts.background ?? "blur");
  chains.push(...out.chains.map((c) => c));
  const videoLabel = out.label;

  // ---- audio
  let audioLabel = null;
  if (withAudio) {
    const silence = (d) => {
      const l = next("s");
      chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${f(d)}[${l}]`);
      return l;
    };
    const mixInputs = [];
    for (const track of project.tracks) {
      if (track.muted || (track.kind === "video" && track.hidden)) continue;
      const segs = segmentsOf(track).filter((s) => s.media.hasAudio && !s.clip.muted && s.clip.volume > 0);
      if (!segs.length) continue;
      const piece = (seg, skip, dur) => {
        const l = next("a");
        const idx = inputFor(seg);
        const c = seg.clip;
        const into = seg.offset + skip; // seconds into the clip where this piece starts
        const fades = [];
        if (c.fadeIn > into + EPS) fades.push(`afade=t=in:st=0:d=${f(c.fadeIn - into)}`);
        const fadeOutAt = clipLength(c) - c.fadeOut - into;
        if (c.fadeOut > EPS && fadeOutAt < dur) fades.push(`afade=t=out:st=${f(Math.max(0, fadeOutAt))}:d=${f(c.fadeOut)}`);
        chains.push(
          `[${idx}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${f(c.volume)}` +
            (fades.length ? `,${fades.join(",")}` : "") +
            `,apad,atrim=duration=${f(dur)},asetpts=PTS-STARTPTS[${l}]`,
        );
        return l;
      };
      mixInputs.push(concat(tile(segs, silence, piece), "a"));
    }
    let mix;
    if (!mixInputs.length) mix = silence(total);
    else if (mixInputs.length === 1) mix = mixInputs[0];
    else {
      mix = next("mix");
      chains.push(`${mixInputs.map((m) => `[${m}]`).join("")}amix=inputs=${mixInputs.length}:duration=longest:normalize=0[${mix}]`);
    }
    const bleeps = project.bleeps
      .map((b) => [Math.max(b.start, r0) - r0, Math.min(b.end, r1) - r0])
      .filter(([a, b]) => b - a > EPS);
    if (bleeps.length) {
      const inside = bleeps.map(([a, b]) => `between(t,${f(a)},${f(b)})`).join("+");
      const muted = next("bm");
      const tone = next("bt");
      audioLabel = next("aout");
      chains.push(`[${mix}]volume=volume=0:enable='${inside}'[${muted}]`);
      chains.push(
        `sine=frequency=1000:sample_rate=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=0.3,volume=volume=0:enable='not(${inside})',atrim=duration=${f(total)}[${tone}]`,
      );
      chains.push(`[${muted}][${tone}]amix=inputs=2:duration=first:normalize=0[${audioLabel}]`);
    } else {
      audioLabel = next("aout");
      chains.push(`[${mix}]atrim=duration=${f(total)}[${audioLabel}]`);
    }
  }

  return {
    inputs,
    graph: chains.join(";\n"),
    video: videoLabel,
    audio: audioLabel,
    duration: total,
    width: out.width ?? W,
    height: out.height ?? H,
    fps,
  };
}

function presetFrame(preset, comp, background) {
  if (preset === "landscape") return { label: comp, chains: [] };
  const W = 1080;
  const H = 1920;
  if (preset === "vertical-fill") {
    return {
      label: "vout",
      width: W,
      height: H,
      chains: [`[${comp}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[vout]`],
    };
  }
  // shorts-square: the centered square of the frame, full width, over a
  // blurred (or black) fill of the same footage.
  const square = `crop='min(iw,ih)':'min(iw,ih)',scale=${W}:${W},setsar=1`;
  if (background === "black") {
    return {
      label: "vout",
      width: W,
      height: H,
      chains: [`[${comp}]${square},pad=${W}:${H}:0:(oh-ih)/2:color=black,format=yuv420p[vout]`],
    };
  }
  return {
    label: "vout",
    width: W,
    height: H,
    chains: [
      `[${comp}]split=2[sq0][bg0]`,
      `[sq0]${square}[sq]`,
      `[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.12,setsar=1[bg]`,
      `[bg][sq]overlay=0:(H-h)/2,format=yuv420p[vout]`,
    ],
  };
}

// perspective filter that applies the clip's zoom/pan. `startAt` is how many
// seconds into the clip the rendered piece begins (frame 0 of the piece).
function perspectiveFor(clip, startAt, fps) {
  const frames = clip.keyframes;
  const T = `(in/${f(fps)}+${f(startAt)})`;
  let Z, X, Y, evalMode;
  if (frames.length) {
    Z = kfExpr(frames, "scale", T);
    X = kfExpr(frames, "x", T);
    Y = kfExpr(frames, "y", T);
    evalMode = "frame";
  } else {
    const { scale, x, y } = clip.transform;
    if (Math.abs(scale - 1) < EPS && Math.abs(x) < EPS && Math.abs(y) < EPS) return null;
    Z = f(scale);
    X = f(x);
    Y = f(y);
    evalMode = "init";
  }
  // Canvas point P shows source point (P - C - T*size) / Z + C.
  const left = `W/2+(-W/2-(${X})*W)/(${Z})`;
  const right = `W/2+(W/2-(${X})*W)/(${Z})`;
  const top = `H/2+(-H/2-(${Y})*H)/(${Z})`;
  const bottom = `H/2+(H/2-(${Y})*H)/(${Z})`;
  return (
    `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':` +
    `x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:sense=source:eval=${evalMode}`
  );
}

// Piecewise keyframe interpolation as an ffmpeg expression of T.
function kfExpr(frames, key, T) {
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
