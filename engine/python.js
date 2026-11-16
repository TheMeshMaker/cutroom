// Local AI jobs that run Python scripts from scripts/: speech to text
// (transcribe.py, faster-whisper) and voice / effects / music separation
// (separate.py, CDX23 models). Scripts print JSON lines: {"progress": 0..1}
// while working, {"note": ..} for information, then one result object.
// Besides the media host (see engine/media.js) this needs host.python,
// host.stemPython, host.scriptsDir and optionally host.stemModels.

const STEMS = [
  ["speech", "Voice", "dialogue"],
  ["sfx", "Game & effects", "sfx"],
  ["music", "Music", "music"],
];

export function createPython(host, media) {
  const { join } = host;

  async function runScript(python, script, args, { onProgress, signal } = {}) {
    let buf = "";
    let result = null;
    // PYTHONSAFEPATH keeps the working directory off sys.path (a planted module
    // there can't shadow imports) while user site-packages stay available.
    const r = await host.run(python, [join(host.scriptsDir, script), ...args], {
      signal,
      env: { PYTHONIOENCODING: "utf-8", PYTHONSAFEPATH: "1" },
      onStdout: (text) => {
        buf += text;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.progress != null) onProgress?.(msg.progress);
            else if (msg.note == null) result = msg;
          } catch {
            // non-JSON output from libraries
          }
        }
      },
    });
    if (signal?.aborted) throw new Error("Cancelled");
    if (!result) throw new Error(`${script} failed (${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
    return result;
  }

  /**
   * Speech to text, cached per file, model and language.
   * @returns {Promise<{ language: string, segments: { start: number, end: number, text: string, words: object[] }[] }>}
   */
  async function transcribe(m, { language = "auto", model = host.whisperModel || "large-v3", fillers = false, onProgress, signal } = {}) {
    if (!m.hasAudio) throw new Error(`${m.name} has no audio`);
    await host.mkdir(host.cacheDir);
    // Same key as before the engine split, so existing transcripts stay cached.
    const cache = join(host.cacheDir, `${await media.cacheKey(m.path, `${model}|${language}|${fillers ? "f" : ""}`)}-captions.json`);
    if (await host.stat(cache)) return JSON.parse(await host.readText(cache));
    const result = await runScript(host.python, "transcribe.py", [m.path, "--model", model, "--language", language, ...(fillers ? ["--fillers"] : [])], { onProgress, signal });
    await host.writeText(cache, JSON.stringify(result));
    return result;
  }

  /**
   * Split a media item's sound into voice, game/effects and music, each a WAV
   * as long as the source (so clips line up with the original). Cached.
   * @returns {Promise<object[]>} probe info per stem, with `stem`, `role` and a name
   */
  async function separateStems(m, { onProgress, signal } = {}) {
    if (!m.hasAudio) throw new Error(`${m.name} has no audio`);
    const dir = join(host.cacheDir, `${await media.cacheKey(m.path, "stems-cdx23-v1")}-stems`);
    const files = STEMS.map(([key]) => join(dir, `${key}.wav`));
    const have = await Promise.all(files.map((f) => host.stat(f)));
    if (have.some((s) => !s)) {
      await host.mkdir(dir);
      const input = join(dir, "input.wav");
      const conv = await host.run(host.ffmpeg, ["-hide_banner", "-y", "-i", m.path, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", input], { signal });
      if (conv.code !== 0) throw new Error(`Audio conversion failed: ${conv.stderr.trim().split("\n").pop()}`);
      onProgress?.(0.03);
      try {
        await runScript(host.stemPython, "separate.py", [input, dir, ...(host.stemModels ? ["--models", host.stemModels] : [])], { signal, onProgress: (p) => onProgress?.(0.03 + 0.97 * p) });
      } finally {
        await host.rm(input);
      }
    }
    onProgress?.(1);
    return Promise.all(STEMS.map(async ([stem, label, role], i) => ({ ...(await media.probe(files[i])), name: `${label} (${m.name})`, derivedFrom: m.id, stem, role })));
  }

  return { transcribe, separateStems };
}
