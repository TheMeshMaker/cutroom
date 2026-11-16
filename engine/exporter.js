// Runs the FFmpeg render described by core/render.js (see engine/media.js for
// what `host` provides; this also uses host.tmpDir and host.mkdtemp).

import { buildRenderPlan, f } from "../core/render.js";
import { progressOf } from "./media.js";

// NVENC at its best: constant quality only (no bitrate cap), lookahead,
// adaptive quantisation and multipass.
const NVENC_HQ = ["-tune", "hq", "-multipass", "fullres", "-rc-lookahead", "32", "-b:v", "0"];
const NVENC_AQ = ["-spatial-aq", "1", "-temporal-aq", "1"];

// [encoder name, args by quality, extra args]
const ENCODERS = {
  h264: {
    cpu: ["libx264", { high: ["-preset", "slow", "-crf", "15"], recommended: ["-preset", "medium", "-crf", "18"], compact: ["-preset", "fast", "-crf", "23"] }, ["-pix_fmt", "yuv420p"]],
    nvenc: ["h264_nvenc", { high: ["-preset", "p7", "-rc", "vbr", "-cq", "16"], recommended: ["-preset", "p6", "-rc", "vbr", "-cq", "19"], compact: ["-preset", "p5", "-rc", "vbr", "-cq", "25"] }, ["-pix_fmt", "yuv420p", ...NVENC_HQ, ...NVENC_AQ, "-bf", "3"]],
    qsv: ["h264_qsv", { high: ["-global_quality", "18"], recommended: ["-global_quality", "22"], compact: ["-global_quality", "27"] }, ["-pix_fmt", "nv12"]],
    amf: ["h264_amf", { high: ["-rc", "cqp", "-qp_i", "17", "-qp_p", "19"], recommended: ["-rc", "cqp", "-qp_i", "20", "-qp_p", "22"], compact: ["-rc", "cqp", "-qp_i", "25", "-qp_p", "27"] }, []],
  },
  hevc: {
    cpu: ["libx265", { high: ["-preset", "slow", "-crf", "18"], recommended: ["-preset", "medium", "-crf", "22"], compact: ["-preset", "medium", "-crf", "27"] }, ["-pix_fmt", "yuv420p", "-tag:v", "hvc1"]],
    nvenc: ["hevc_nvenc", { high: ["-preset", "p7", "-rc", "vbr", "-cq", "18"], recommended: ["-preset", "p6", "-rc", "vbr", "-cq", "21"], compact: ["-preset", "p5", "-rc", "vbr", "-cq", "27"] }, ["-pix_fmt", "yuv420p", "-tag:v", "hvc1", ...NVENC_HQ, ...NVENC_AQ]],
    qsv: ["hevc_qsv", { high: ["-global_quality", "20"], recommended: ["-global_quality", "24"], compact: ["-global_quality", "29"] }, ["-pix_fmt", "nv12", "-tag:v", "hvc1"]],
    amf: ["hevc_amf", { high: ["-rc", "cqp", "-qp_i", "19", "-qp_p", "21"], recommended: ["-rc", "cqp", "-qp_i", "22", "-qp_p", "24"], compact: ["-rc", "cqp", "-qp_i", "27", "-qp_p", "29"] }, ["-tag:v", "hvc1"]],
  },
  av1: {
    nvenc: ["av1_nvenc", { high: ["-preset", "p7", "-rc", "vbr", "-cq", "22"], recommended: ["-preset", "p6", "-rc", "vbr", "-cq", "28"], compact: ["-preset", "p5", "-rc", "vbr", "-cq", "36"] }, ["-pix_fmt", "yuv420p", ...NVENC_HQ]],
  },
  prores: {
    cpu: ["prores_ks", { high: ["-profile:v", "3"], recommended: ["-profile:v", "3"], compact: ["-profile:v", "2"] }, ["-pix_fmt", "yuv422p10le", "-vendor", "apl0"]],
  },
};

const tail = (text, n) => text.trim().split("\n").slice(-n).join("\n");

export function createExporter(host) {
  let encoderCache = null;

  async function availableEncoders() {
    if (encoderCache) return encoderCache;
    const { stdout } = await host.run(host.ffmpeg, ["-hide_banner", "-encoders"]);
    const names = new Set([...stdout.matchAll(/^\s*V\S*\s+(\S+)/gm)].map((m) => m[1]));
    const out = {};
    for (const [codec, hw] of Object.entries(ENCODERS)) out[codec] = Object.keys(hw).filter((k) => names.has(hw[k][0]));
    // NVENC is listed even without an NVIDIA GPU; probe it once.
    for (const codec of Object.keys(out)) {
      if (!out[codec].includes("nvenc")) continue;
      const enc = ENCODERS[codec].nvenc[0];
      const probe = await host.run(host.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1", "-c:v", enc, "-f", "null", "-"]);
      if (probe.code !== 0) out[codec] = out[codec].filter((x) => x !== "nvenc");
    }
    encoderCache = out;
    return out;
  }

  async function pickEncoder(codec, hardware) {
    const list = (await availableEncoders())[codec] ?? [];
    if (!list.length) throw new Error(`No ${codec} encoder is available in this FFmpeg build`);
    const choice = hardware && hardware !== "auto" ? hardware : list.includes("nvenc") ? "nvenc" : list.includes("cpu") ? "cpu" : list[0];
    if (!list.includes(choice)) throw new Error(`${codec} encoder "${choice}" is not available (have: ${list.join(", ")})`);
    return ENCODERS[codec][choice];
  }

  // Build the plan in a fresh temp folder, write its text files and the
  // filter graph there, run `fn(plan, graphFile)`, then clean up.
  async function withPlan(project, opts, fn) {
    await host.mkdir(host.tmpDir);
    const tmp = await host.mkdtemp(host.join(host.tmpDir, "job-"));
    try {
      const plan = buildRenderPlan(project, { ...opts, tmpDir: tmp });
      for (const file of plan.files) await host.writeText(file.path, file.content);
      const graphFile = host.join(tmp, "graph.txt");
      await host.writeText(graphFile, plan.graph);
      return await fn(plan, graphFile);
    } finally {
      await host.rm(tmp);
    }
  }

  /**
   * Render a project to a video file.
   * @param {object} opts
   * @param {string} opts.outPath
   * @param {"h264"|"hevc"|"av1"|"prores"} [opts.codec]
   * @param {"auto"|"cpu"|"nvenc"|"qsv"|"amf"} [opts.hardware]
   * @param {"high"|"recommended"|"compact"} [opts.quality]
   * @param {number} [opts.resolution] output short side (720, 1080, 1440, 2160)
   * @param {number} [opts.fps] output frame rate (defaults to the project's)
   * @param {number|null} [opts.loudness] master loudness target in LUFS (e.g. -14); null = off, omitted = the project setting
   * @returns {Promise<{ path: string, duration: number, seconds: number, encoder: string }>}
   */
  async function renderProject(project, opts = {}) {
    const { outPath, preset, range, background, quality = "recommended", resolution, loudness, onProgress, signal } = opts;
    if (!outPath) throw new Error("outPath is required");
    // Older callers passed `encoder: x264|nvenc|qsv|amf` for H.264.
    const codec = opts.codec ?? "h264";
    const hardware = opts.hardware ?? (opts.encoder ? (opts.encoder === "x264" ? "cpu" : opts.encoder) : "auto");
    const [encName, byQuality, extra] = await pickEncoder(codec, hardware);
    await host.mkdir(host.dirname(outPath));
    const began = Date.now();
    const duration = await withPlan(project, { preset, range, background, outShortSide: resolution, loudness: (loudness === undefined ? project.settings?.loudness : loudness) ?? undefined }, async (plan, graphFile) => {
      const audioArgs = plan.audio ? (codec === "prores" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "192k"]) : [];
      const args = [
        "-hide_banner", "-y",
        ...plan.inputs.flat(),
        "-/filter_complex", graphFile,
        "-map", `[${plan.video}]`,
        ...(plan.audio ? ["-map", `[${plan.audio}]`] : []),
        "-c:v", encName, ...(byQuality[quality] ?? byQuality.recommended), ...extra,
        "-r", f(opts.fps ?? plan.fps),
        // Recordings and the graph are BT.709; say so, or players may guess wrong colors.
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        ...audioArgs,
        "-t", f(plan.duration),
        ...(codec === "prores" ? [] : ["-movflags", "+faststart"]),
        "-progress", "pipe:1", "-nostats",
        outPath,
      ];
      const { code, stderr } = await host.run(host.ffmpeg, args, { signal, onStdout: progressOf(plan.duration, onProgress) });
      if (signal?.aborted) throw new Error("Export cancelled");
      if (code !== 0) throw new Error(`FFmpeg failed (${code}): ${tail(stderr, 6)}`);
      return plan.duration;
    });
    onProgress?.(1);
    return { path: outPath, duration, seconds: (Date.now() - began) / 1000, encoder: encName };
  }

  // Render the composed frame at timeline `time` to an image file. Near a
  // transition the window starts early enough to include both clips.
  async function renderFrame(project, time, outPath, { preset = "landscape", background, previewWidth } = {}) {
    const fps = project.canvas.fps;
    let lead = 0;
    for (const c of project.clips) {
      if (c.transition && Math.abs(c.start - time) < c.transition.duration / 2 + 0.05) lead = Math.max(lead, c.transition.duration + 0.1);
    }
    const from = Math.max(0, time - lead);
    await host.mkdir(host.dirname(outPath));
    await withPlan(project, { preset, background, range: [from, time + 1 / fps], audio: false, previewWidth }, async (plan, graphFile) => {
      const seek = time - from > 1e-6 ? ["-ss", f(time - from)] : [];
      const { code, stderr } = await host.run(host.ffmpeg, ["-hide_banner", "-y", ...plan.inputs.flat(), "-/filter_complex", graphFile, "-map", `[${plan.video}]`, ...seek, "-frames:v", "1", "-q:v", "3", outPath]);
      if (code !== 0) throw new Error(`Frame render failed: ${tail(stderr, 4)}`);
    });
    return outPath;
  }

  // Render just the processed audio of a timeline range (to hear voice effects,
  // denoise, etc. exactly as exported).
  async function renderAudio(project, range, outPath) {
    await host.mkdir(host.dirname(outPath));
    await withPlan(project, { range, video: false }, async (plan, graphFile) => {
      const { code, stderr } = await host.run(host.ffmpeg, ["-hide_banner", "-y", ...plan.inputs.flat(), "-/filter_complex", graphFile, "-map", `[${plan.audio}]`, "-c:a", "aac", "-b:a", "160k", outPath]);
      if (code !== 0) throw new Error(`Audio render failed: ${tail(stderr, 4)}`);
    });
    return outPath;
  }

  // FFmpeg arguments that stream the composed picture (raw RGBA frames of
  // width x height) or sound (f32le stereo at `rate`) from `from` to the end,
  // for live preview. The caller deletes `dir` when playback stops.
  async function previewStream(project, { from = 0, width = 960, kind = "video", rate = 48000 } = {}) {
    await host.mkdir(host.tmpDir);
    const dir = await host.mkdtemp(host.join(host.tmpDir, "play-"));
    const end = Math.max(...project.clips.map((c) => c.start + (c.out - c.in) / (c.speed || 1)), from + 0.1);
    const plan = buildRenderPlan(project, { range: [from, end], tmpDir: dir, ...(kind === "video" ? { audio: false, previewWidth: width } : { video: false }) });
    if (!(kind === "video" ? plan.video : plan.audio)) {
      await host.rm(dir);
      return null; // nothing to see / hear
    }
    for (const file of plan.files) await host.writeText(file.path, file.content);
    const graphFile = host.join(dir, "graph.txt");
    await host.writeText(graphFile, plan.graph);
    const height = Math.round((plan.height * width) / plan.width / 2) * 2;
    const out = kind === "video" ? ["-map", `[${plan.video}]`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"] : ["-map", `[${plan.audio}]`, "-f", "f32le", "-ar", String(rate), "-ac", "2", "-"];
    return { dir, args: ["-hide_banner", "-nostats", "-loglevel", "error", ...plan.inputs.flat(), "-/filter_complex", graphFile, ...out], width, height, fps: plan.fps, duration: plan.duration };
  }

  return { availableEncoders, renderProject, renderFrame, renderAudio, previewStream };
}
