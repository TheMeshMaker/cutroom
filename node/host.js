// The engine host for Node (MCP server, tests): processes and files via
// node:child_process / node:fs. The desktop app has a Rust host instead
// (native/src/engine.rs).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EDIT_VENV = join(homedir(), ".cache", "edit-venv", "Scripts", "python.exe");

// Run a command; resolve with { code, stdout, stderr }. `onStdout` gets chunks.
export function run(cmd, args, { onStdout, onStderr, signal, binary = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
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
    child.on("error", (e) => reject(e.code === "ENOENT" ? new Error(`${cmd} was not found. Install FFmpeg or set CUTROOM_FFMPEG / CUTROOM_FFPROBE.`) : e));
    child.on("close", (code) => {
      const buf = Buffer.concat(out);
      resolve({ code, stdout: binary ? buf : buf.toString(), stderr: err });
    });
    signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
}

const python = process.env.CUTROOM_PYTHON || "python";

export const nodeHost = {
  ffmpeg: process.env.CUTROOM_FFMPEG || "ffmpeg",
  ffprobe: process.env.CUTROOM_FFPROBE || "ffprobe",
  cacheDir: process.env.CUTROOM_CACHE || join(homedir(), ".cutroom", "cache"),
  tmpDir: join(tmpdir(), "cutroom"),
  python,
  // Stem separation needs torch + demucs; a dedicated venv is common.
  stemPython: process.env.CUTROOM_STEM_PYTHON || (existsSync(EDIT_VENV) ? EDIT_VENV : python),
  stemModels: process.env.CUTROOM_STEM_MODELS || null,
  whisperModel: process.env.CUTROOM_WHISPER_MODEL || null,
  scriptsDir: join(dirname(fileURLToPath(import.meta.url)), "..", "scripts"),
  join,
  basename,
  extname,
  dirname,
  run: (cmd, args, opts = {}) => run(cmd, args, { ...opts, onStdout: opts.onStdout && ((d) => opts.onStdout(d.toString())) }),
  async peaks(path, { perSecond, stream = 0 }) {
    const rate = 8000;
    const bucket = Math.max(1, Math.round(rate / perSecond));
    const peaks = [];
    let carry = Buffer.alloc(0);
    let max = 0;
    let count = 0;
    const { code, stderr } = await run(nodeHost.ffmpeg, ["-hide_banner", "-i", path, "-map", `0:a:${stream}`, "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], {
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
    return peaks;
  },
  stat: (path) => fsp.stat(path).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs }), () => null),
  mkdir: (path) => fsp.mkdir(path, { recursive: true }),
  readText: (path) => fsp.readFile(path, "utf8"),
  writeText: (path, text) => fsp.writeFile(path, text),
  rename: (from, to) => fsp.rename(from, to),
  rm: (path) => fsp.rm(path, { recursive: true, force: true }),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  sha1: async (text) => createHash("sha1").update(text).digest("hex"),
};
