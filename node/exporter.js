// Runs the FFmpeg render described by core/render.js.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRenderPlan, f } from "../core/render.js";
import { FFMPEG, run } from "./media.js";

const ENCODERS = {
  x264: ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"],
  nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-pix_fmt", "yuv420p"],
  qsv: ["-c:v", "h264_qsv", "-global_quality", "20", "-pix_fmt", "nv12"],
  amf: ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21"],
};

export async function availableEncoders() {
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-encoders"]);
  const has = (name) => new RegExp(`\\s${name}\\s`).test(stdout);
  return Object.entries({ x264: "libx264", nvenc: "h264_nvenc", qsv: "h264_qsv", amf: "h264_amf" })
    .filter(([, enc]) => has(enc))
    .map(([id]) => id);
}

function writeGraph(plan) {
  const dir = join(tmpdir(), "cutroom");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `graph-${process.pid}-${Date.now()}.txt`);
  writeFileSync(file, plan.graph);
  return file;
}

/**
 * Render a project to a video file.
 * @returns {Promise<{ path: string, duration: number, seconds: number }>}
 */
export async function renderProject(project, { outPath, preset, range, background, encoder = "x264", onProgress, signal } = {}) {
  if (!outPath) throw new Error("outPath is required");
  const plan = buildRenderPlan(project, { preset, range, background });
  const graphFile = writeGraph(plan);
  mkdirSync(dirname(outPath), { recursive: true });
  const args = [
    "-hide_banner", "-y",
    ...plan.inputs.flat(),
    "-/filter_complex", graphFile,
    "-map", `[${plan.video}]`,
    ...(plan.audio ? ["-map", `[${plan.audio}]`] : []),
    ...(ENCODERS[encoder] ?? ENCODERS.x264),
    "-r", f(plan.fps),
    ...(plan.audio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-t", f(plan.duration),
    "-movflags", "+faststart",
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
    rmSync(graphFile, { force: true });
  }
  onProgress?.(1);
  return { path: outPath, duration: plan.duration, seconds: (Date.now() - began) / 1000 };
}

// Render the composed frame at timeline `time` to a PNG (or JPEG) file.
export async function renderFrame(project, time, outPath, { preset = "landscape", background } = {}) {
  const fps = project.canvas.fps;
  const plan = buildRenderPlan(project, { preset, background, range: [time, time + 1 / fps], audio: false });
  const graphFile = writeGraph(plan);
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    const { code, stderr } = await run(FFMPEG, [
      "-hide_banner", "-y", ...plan.inputs.flat(), "-/filter_complex", graphFile, "-map", `[${plan.video}]`, "-frames:v", "1", outPath,
    ]);
    if (code !== 0) throw new Error(`Frame render failed: ${stderr.trim().split("\n").slice(-4).join("\n")}`);
  } finally {
    rmSync(graphFile, { force: true });
  }
  return outPath;
}
