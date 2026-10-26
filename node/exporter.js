// Runs the FFmpeg render described by core/render.js.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRenderPlan, f } from "../core/render.js";
import { FFMPEG, run } from "./media.js";

// [encoder name, args by quality]
const ENCODERS = {
  h264: {
    cpu: ["libx264", { high: ["-preset", "slow", "-crf", "16"], recommended: ["-preset", "fast", "-crf", "19"], compact: ["-preset", "fast", "-crf", "24"] }, ["-pix_fmt", "yuv420p"]],
    nvenc: ["h264_nvenc", { high: ["-preset", "p6", "-rc", "vbr", "-cq", "17"], recommended: ["-preset", "p5", "-rc", "vbr", "-cq", "21"], compact: ["-preset", "p5", "-rc", "vbr", "-cq", "27"] }, ["-pix_fmt", "yuv420p"]],
    qsv: ["h264_qsv", { high: ["-global_quality", "18"], recommended: ["-global_quality", "22"], compact: ["-global_quality", "27"] }, ["-pix_fmt", "nv12"]],
    amf: ["h264_amf", { high: ["-rc", "cqp", "-qp_i", "17", "-qp_p", "19"], recommended: ["-rc", "cqp", "-qp_i", "20", "-qp_p", "22"], compact: ["-rc", "cqp", "-qp_i", "25", "-qp_p", "27"] }, []],
  },
  hevc: {
    cpu: ["libx265", { high: ["-preset", "slow", "-crf", "18"], recommended: ["-preset", "medium", "-crf", "22"], compact: ["-preset", "medium", "-crf", "27"] }, ["-pix_fmt", "yuv420p", "-tag:v", "hvc1"]],
    nvenc: ["hevc_nvenc", { high: ["-preset", "p6", "-rc", "vbr", "-cq", "19"], recommended: ["-preset", "p5", "-rc", "vbr", "-cq", "23"], compact: ["-preset", "p5", "-rc", "vbr", "-cq", "29"] }, ["-pix_fmt", "yuv420p", "-tag:v", "hvc1"]],
    qsv: ["hevc_qsv", { high: ["-global_quality", "20"], recommended: ["-global_quality", "24"], compact: ["-global_quality", "29"] }, ["-pix_fmt", "nv12", "-tag:v", "hvc1"]],
    amf: ["hevc_amf", { high: ["-rc", "cqp", "-qp_i", "19", "-qp_p", "21"], recommended: ["-rc", "cqp", "-qp_i", "22", "-qp_p", "24"], compact: ["-rc", "cqp", "-qp_i", "27", "-qp_p", "29"] }, ["-tag:v", "hvc1"]],
  },
  av1: {
    nvenc: ["av1_nvenc", { high: ["-preset", "p6", "-rc", "vbr", "-cq", "24"], recommended: ["-preset", "p5", "-rc", "vbr", "-cq", "30"], compact: ["-preset", "p5", "-rc", "vbr", "-cq", "38"] }, ["-pix_fmt", "yuv420p"]],
  },
  prores: {
    cpu: ["prores_ks", { high: ["-profile:v", "3"], recommended: ["-profile:v", "3"], compact: ["-profile:v", "2"] }, ["-pix_fmt", "yuv422p10le", "-vendor", "apl0"]],
  },
};

let encoderCache = null;
export async function availableEncoders() {
  if (encoderCache) return encoderCache;
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-encoders"]);
  const names = new Set([...stdout.matchAll(/^\s*V\S*\s+(\S+)/gm)].map((m) => m[1]));
  const out = {};
  for (const [codec, hw] of Object.entries(ENCODERS)) out[codec] = Object.keys(hw).filter((k) => names.has(hw[k][0]));
  // NVENC is listed even without an NVIDIA GPU; probe it once.
  for (const codec of Object.keys(out)) {
    if (!out[codec].includes("nvenc")) continue;
    const enc = ENCODERS[codec].nvenc[0];
    const probe = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1", "-c:v", enc, "-f", "null", "-"]);
    if (probe.code !== 0) out[codec] = out[codec].filter((x) => x !== "nvenc");
  }
  encoderCache = out;
  return out;
}

async function pickEncoder(codec, hardware) {
  const avail = await availableEncoders();
  const list = avail[codec] ?? [];
  if (!list.length) throw new Error(`No ${codec} encoder is available in this FFmpeg build`);
  const choice = hardware && hardware !== "auto" ? hardware : list.includes("nvenc") ? "nvenc" : list.includes("cpu") ? "cpu" : list[0];
  if (!list.includes(choice)) throw new Error(`${codec} encoder "${choice}" is not available (have: ${list.join(", ")})`);
  return ENCODERS[codec][choice];
}

function prepare(plan) {
  const dir = mkdtempSync(join(tmpdir(), "cutroom-"));
  for (const file of plan.files) writeFileSync(file.path, file.content);
  const graphFile = join(dir, "graph.txt");
  writeFileSync(graphFile, plan.graph);
  return { dir, graphFile };
}

const jobDir = () => {
  const base = join(tmpdir(), "cutroom");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "job-"));
};

/**
 * Render a project to a video file.
 * @param {object} opts
 * @param {string} opts.outPath
 * @param {"h264"|"hevc"|"av1"|"prores"} [opts.codec]
 * @param {"auto"|"cpu"|"nvenc"|"qsv"|"amf"} [opts.hardware]
 * @param {"high"|"recommended"|"compact"} [opts.quality]
 * @param {number} [opts.resolution] output short side (720, 1080, 1440, 2160)
 * @param {number} [opts.fps] output frame rate (defaults to the project's)
 * @returns {Promise<{ path: string, duration: number, seconds: number, encoder: string }>}
 */
export async function renderProject(project, opts = {}) {
  const { outPath, preset, range, background, quality = "recommended", resolution, onProgress, signal } = opts;
  if (!outPath) throw new Error("outPath is required");
  // Older callers passed `encoder: x264|nvenc|qsv|amf` for H.264.
  const codec = opts.codec ?? "h264";
  const hardware = opts.hardware ?? (opts.encoder ? (opts.encoder === "x264" ? "cpu" : opts.encoder) : "auto");
  const [encName, byQuality, extra] = await pickEncoder(codec, hardware);
  const tmp = jobDir();
  const plan = buildRenderPlan(project, { preset, range, background, outShortSide: resolution, tmpDir: tmp });
  const { dir, graphFile } = prepare(plan);
  mkdirSync(dirname(outPath), { recursive: true });
  const audioArgs = plan.audio ? (codec === "prores" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "192k"]) : [];
  const args = [
    "-hide_banner", "-y",
    ...plan.inputs.flat(),
    "-/filter_complex", graphFile,
    "-map", `[${plan.video}]`,
    ...(plan.audio ? ["-map", `[${plan.audio}]`] : []),
    "-c:v", encName, ...(byQuality[quality] ?? byQuality.recommended), ...extra,
    "-r", f(opts.fps ?? plan.fps),
    ...audioArgs,
    "-t", f(plan.duration),
    ...(codec === "prores" ? [] : ["-movflags", "+faststart"]),
    "-progress", "pipe:1", "-nostats",
    outPath,
  ];
  const began = Date.now();
  try {
    const { code, stderr } = await run(FFMPEG, args, {
      signal,
      onStdout: (d) => {
        const m = /out_time_us=(\d+)/.exec(d.toString());
        if (m) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / plan.duration));
      },
    });
    if (signal?.aborted) throw new Error("Export cancelled");
    if (code !== 0) throw new Error(`FFmpeg failed (${code}): ${stderr.trim().split("\n").slice(-6).join("\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  onProgress?.(1);
  return { path: outPath, duration: plan.duration, seconds: (Date.now() - began) / 1000, encoder: encName };
}

// Render the composed frame at timeline `time` to an image file. Near a
// transition the window starts early enough to include both clips.
export async function renderFrame(project, time, outPath, { preset = "landscape", background, previewWidth } = {}) {
  const fps = project.canvas.fps;
  let lead = 0;
  for (const c of project.clips) {
    if (c.transition && Math.abs(c.start - time) < c.transition.duration / 2 + 0.05) lead = Math.max(lead, c.transition.duration + 0.1);
  }
  const from = Math.max(0, time - lead);
  const tmp = jobDir();
  const plan = buildRenderPlan(project, { preset, background, range: [from, time + 1 / fps], audio: false, previewWidth, tmpDir: tmp });
  const { dir, graphFile } = prepare(plan);
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    const seek = time - from > 1e-6 ? ["-ss", f(time - from)] : [];
    const { code, stderr } = await run(FFMPEG, ["-hide_banner", "-y", ...plan.inputs.flat(), "-/filter_complex", graphFile, "-map", `[${plan.video}]`, ...seek, "-frames:v", "1", "-q:v", "3", outPath]);
    if (code !== 0) throw new Error(`Frame render failed: ${stderr.trim().split("\n").slice(-4).join("\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  return outPath;
}

// Render just the processed audio of a timeline range (to hear voice effects,
// denoise, etc. exactly as exported).
export async function renderAudio(project, range, outPath) {
  const tmp = jobDir();
  const plan = buildRenderPlan(project, { range, video: false, tmpDir: tmp });
  const { dir, graphFile } = prepare(plan);
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    const { code, stderr } = await run(FFMPEG, ["-hide_banner", "-y", ...plan.inputs.flat(), "-/filter_complex", graphFile, "-map", `[${plan.audio}]`, "-c:a", "aac", "-b:a", "160k", outPath]);
    if (code !== 0) throw new Error(`Audio render failed: ${stderr.trim().split("\n").slice(-4).join("\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  return outPath;
}
