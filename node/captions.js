// Auto captions: runs scripts/transcribe.py (faster-whisper) on a media file.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_DIR } from "./media.js";

const PYTHON = process.env.CUTROOM_PYTHON || "python";
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "transcribe.py");

/**
 * @returns {Promise<{ language: string, segments: { start: number, end: number, text: string, words: object[] }[] }>}
 */
export async function transcribe(media, { language = "auto", model = process.env.CUTROOM_WHISPER_MODEL || "large-v3", onProgress, signal } = {}) {
  if (!media.hasAudio) throw new Error(`${media.name} has no audio`);
  mkdirSync(CACHE_DIR, { recursive: true });
  const st = statSync(media.path);
  const key = createHash("sha1").update(`${media.path}|${st.size}|${st.mtimeMs}|${model}|${language}`).digest("hex").slice(0, 20);
  const cache = join(CACHE_DIR, `${key}-captions.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const result = await new Promise((resolve, reject) => {
    // PYTHONSAFEPATH keeps the working directory off sys.path (a planted
    // module there can't shadow imports) while user site-packages, where
    // faster-whisper usually lives, stay available (python -I would drop them).
    const child = spawn(PYTHON, [SCRIPT, media.path, "--model", model, "--language", language], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONSAFEPATH: "1" } });
    let buf = "";
    let err = "";
    let final = null;
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.progress != null) onProgress?.(msg.progress);
          if (msg.segments) final = msg;
        } catch {
          // non-JSON output from libraries; ignore
        }
      }
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 200000) err = err.slice(-100000);
    });
    child.on("error", (e) => reject(e.code === "ENOENT" ? new Error("Python was not found. Install Python with faster-whisper, or set CUTROOM_PYTHON.") : e));
    child.on("close", (code) => {
      if (final) resolve(final);
      else reject(new Error(`Transcription failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
  writeFileSync(cache, JSON.stringify(result));
  return result;
}
