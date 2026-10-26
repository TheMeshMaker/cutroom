// FFmpeg-backed media helpers (Node only): probe, preview proxies, waveform
// peaks, silence detection.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export const FFMPEG = process.env.CUTROOM_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.CUTROOM_FFPROBE || "ffprobe";
export const CACHE_DIR = process.env.CUTROOM_CACHE || join(homedir(), ".cutroom", "cache");

const PLAYABLE_AUDIO = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);

// Run a command; resolve with { code, stdout, stderr }. `onStdout` gets chunks.
export function run(cmd, args, { onStdout, onStderr, signal, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => {
      if (onStdout) onStdout(d);
      else out.push(d);
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
      onStderr?.(d.toString());
    });
    child.on("error", (e) =>
      reject(e.code === "ENOENT" ? new Error(`${cmd} was not found. Install FFmpeg or set CUTROOM_FFMPEG / CUTROOM_FFPROBE.`) : e),
    );
    child.on("close", (code) => {
      const buf = Buffer.concat(out);
      resolve({ code, stdout: binary ? buf : buf.toString(), stderr: err });
    });
    signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
}

function cacheKey(path, salt) {
  const st = statSync(path);
  return createHash("sha1").update(`${path}|${st.size}|${st.mtimeMs}|${salt}`).digest("hex").slice(0, 20);
}

export async function probe(path) {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const ext = extname(path).toLowerCase();
  const { code, stdout, stderr } = await run(FFPROBE, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${stderr.trim().split("\n").pop()}`);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = info.streams.find((s) => s.codec_type === "audio");
  const isImage = IMAGE.has(ext) && v && !a;
  const rate = v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v?.r_frame_rate;
  const [n, d] = (rate ?? "0/1").split("/").map(Number);
  const duration = Number(info.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  return {
    path,
    name: basename(path),
    duration: isImage ? 5 : duration,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: d ? Math.round((n / d) * 1000) / 1000 : 0,
    hasVideo: !!v,
    hasAudio: !!a,
    kind: isImage ? "image" : v ? "video" : "audio",
  };
}

// A small, seek-friendly H.264 copy for smooth timeline preview. Returns the
// path of a ready proxy (cached by source path/size/mtime), or the source
// itself when the browser can already play it (images, common audio).
export async function ensureProxy(media, { onProgress, signal } = {}) {
  const ext = extname(media.path).toLowerCase();
  if (media.kind === "image") return media.path;
  if (!media.hasVideo && PLAYABLE_AUDIO.has(ext)) return media.path;
  mkdirSync(CACHE_DIR, { recursive: true });
  const out = join(CACHE_DIR, `${cacheKey(media.path, "proxy-v2")}.${media.hasVideo ? "mp4" : "m4a"}`);
  if (existsSync(out)) return out;
  const tmp = `${out}.part${media.hasVideo ? ".mp4" : ".m4a"}`;
  const args = ["-hide_banner", "-y", "-i", media.path];
  if (media.hasVideo)
    args.push("-map", "0:v:0", "-vf", "scale=-2:540:flags=bilinear", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "27", "-g", "15", "-pix_fmt", "yuv420p");
  if (media.hasAudio) args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", tmp);
  const { code, stderr } = await run(FFMPEG, args, {
    signal,
    onStdout: (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && media.duration) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / media.duration));
    },
  });
  if (code !== 0) throw new Error(`Proxy failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`);
  renameSync(tmp, out);
  return out;
}

// Peak envelope: one byte (0-255) per 1/100 s of the first audio stream.
export async function waveform(media, { perSecond = 100 } = {}) {
  if (!media.hasAudio) return { perSecond, peaks: [] };
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${cacheKey(media.path, `wave-${perSecond}`)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const rate = 8000;
  const bucket = Math.max(1, Math.round(rate / perSecond));
  const peaks = [];
  let carry = Buffer.alloc(0);
  let max = 0;
  let count = 0;
  const { code, stderr } = await run(FFMPEG, ["-hide_banner", "-i", media.path, "-map", "0:a:0", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], {
    onStdout: (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++count === bucket) {
          peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
          max = 0;
          count = 0;
        }
      }
      carry = buf.subarray(usable);
    },
  });
  if (code !== 0) throw new Error(`Waveform failed: ${stderr.trim().split("\n").pop()}`);
  const result = { perSecond, peaks };
  writeFileSync(file, JSON.stringify(result));
  return result;
}

// Thumbnail sprite for timeline filmstrips: `count` tiles, one every
// `interval` source seconds, laid out `cols` per row.
export async function filmstrip(media, { source } = {}) {
  if (media.kind === "image") return { image: media.path, cols: 1, rows: 1, count: 1, interval: Infinity, tileW: 96, tileH: 54 };
  if (!media.hasVideo || !(media.duration > 0)) return null;
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(media.path, "strip-v1");
  const meta = join(CACHE_DIR, `${key}-strip.json`);
  if (existsSync(meta)) return JSON.parse(readFileSync(meta, "utf8"));
  const count = Math.min(240, Math.max(1, Math.ceil(media.duration / 2)));
  const interval = media.duration / count;
  const cols = Math.min(count, 16);
  const rows = Math.ceil(count / cols);
  const tileH = 54;
  const tileW = Math.max(2, Math.round((tileH * (media.width || 16)) / (media.height || 9) / 2) * 2);
  const image = join(CACHE_DIR, `${key}-strip.jpg`);
  // tpad guarantees the grid fills even if the source ends a little early.
  const { code, stderr } = await run(FFMPEG, [
    "-hide_banner", "-y", "-i", source ?? media.path, "-an",
    "-vf", `fps=${f6(1 / interval)},scale=${tileW}:${tileH},tpad=stop_mode=clone:stop=${cols * rows},tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "5", image,
  ]);
  if (code !== 0) throw new Error(`Thumbnails failed: ${stderr.trim().split("\n").pop()}`);
  const result = { image, cols, rows, count, interval, tileW, tileH };
  writeFileSync(meta, JSON.stringify(result));
  return result;
}

const f6 = (x) => x.toFixed(6);

// A reversed copy of source range [inn, out], rendered in short chunks so it
// never needs the whole clip in memory. Returns the new file's probe info.
export async function makeReversed(media, inn, out, { onProgress } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(media.path, `rev-${f6(inn)}-${f6(out)}`);
  const file = join(CACHE_DIR, `${key}-reversed.mp4`);
  if (!existsSync(file)) {
    const work = join(CACHE_DIR, `${key}-rev-parts`);
    mkdirSync(work, { recursive: true });
    const parts = [];
    const CHUNK = 3;
    for (let e = out, i = 0; e > inn + 1e-3; e -= CHUNK, i++) {
      const s = Math.max(inn, e - CHUNK);
      const part = join(work, `p${String(i).padStart(4, "0")}.mp4`);
      const args = ["-hide_banner", "-y", "-ss", f6(s), "-t", f6(e - s), "-i", media.path, "-vf", "reverse", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"];
      if (media.hasAudio) args.push("-af", "areverse", "-c:a", "aac", "-b:a", "192k");
      else args.push("-an");
      args.push(part);
      const r = await run(FFMPEG, args);
      if (r.code !== 0) throw new Error(`Reverse failed: ${r.stderr.trim().split("\n").pop()}`);
      parts.push(part);
      onProgress?.(Math.min(0.99, (out - s) / (out - inn)));
    }
    const list = join(work, "list.txt");
    writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
    const tmp = `${file}.part.mp4`;
    const r = await run(FFMPEG, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp]);
    if (r.code !== 0) throw new Error(`Reverse join failed: ${r.stderr.trim().split("\n").pop()}`);
    renameSync(tmp, file);
    for (const p of [...parts, list]) rmSync(p, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
  onProgress?.(1);
  return { ...(await probe(file)), name: `${media.name} (reversed)`, derivedFrom: media.id };
}

// One source frame as a PNG (for freeze frames).
export async function extractFrame(media, time) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${cacheKey(media.path, `frame-${f6(time)}`)}.png`);
  if (!existsSync(file)) {
    const r = await run(FFMPEG, ["-hide_banner", "-y", "-ss", f6(Math.max(0, time)), "-i", media.path, "-frames:v", "1", file]);
    if (r.code !== 0 || !existsSync(file)) throw new Error(`Frame grab failed: ${r.stderr.trim().split("\n").pop()}`);
  }
  return { ...(await probe(file)), name: `Freeze ${media.name}` };
}

// Source times where the picture changes shot (scene cuts). Runs on a small
// downscaled copy for speed; `source` may be a proxy of the same media.
export async function detectScenes(media, { threshold = 0.35, minGap = 1, source } = {}) {
  if (!media.hasVideo || media.kind === "image") return [];
  const { code, stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", source ?? media.path, "-an",
    "-vf", `scale=320:-2,select='gt(scene,${f6(threshold)})',showinfo`, "-f", "null", "-",
  ]);
  if (code !== 0) throw new Error(`Scene detection failed: ${stderr.trim().split("\n").pop()}`);
  const times = [];
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(m[1]);
    if (!times.length || t - times[times.length - 1] >= minGap) times.push(t);
  }
  return times;
}

// Ranges (source seconds) quieter than `noise` dB for at least `minDuration`.
export async function detectSilence(media, { noise = -35, minDuration = 2 } = {}) {
  if (!media.hasAudio) return [];
  const { code, stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", media.path, "-map", "0:a:0", "-af", `silencedetect=noise=${noise}dB:d=${minDuration}`, "-f", "null", "-",
  ]);
  if (code !== 0) throw new Error(`Silence detection failed: ${stderr.trim().split("\n").pop()}`);
  const ranges = [];
  let start = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start != null) {
      ranges.push([start, Number(e[1])]);
      start = null;
    }
  }
  if (start != null) ranges.push([start, media.duration || start]);
  return ranges;
}
