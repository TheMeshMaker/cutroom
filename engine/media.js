// FFmpeg-backed media helpers: probe, preview proxies, waveform peaks,
// filmstrips, reverse, freeze frames, scene and silence detection, and pulling
// each audio track out of multi-track recordings (OBS).
//
// Everything that touches files or processes goes through `host`, so the same
// code runs under Node (MCP server, tests) and inside the Rust app (Tauri):
//   ffmpeg, ffprobe, cacheDir: strings
//   run(cmd, args, { onStdout(text), signal, env }) -> { code, stdout, stderr }
//   peaks(path, { perSecond, stream }) -> 0..255 values, one per 1/perSecond s
//   stat(path) -> { size, mtimeMs } | null, mkdir, readText, writeText, rename,
//   rm (recursive, force), sha1(text) -> hex, join/basename/extname/dirname (sync)

const PLAYABLE_AUDIO = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const f6 = (x) => x.toFixed(6);
const lastLines = (text, n = 1) => text.trim().split("\n").slice(-n).join(" ");

export function createMedia(host) {
  const { join, basename, extname } = host;

  async function cacheKey(path, salt) {
    const st = await host.stat(path);
    if (!st) throw new Error(`File not found: ${path}`);
    return (await host.sha1(`${path}|${st.size}|${st.mtimeMs}|${salt}`)).slice(0, 20);
  }
  const cached = async (file) => (await host.stat(file)) != null;
  const ffmpeg = async (args, what, opts) => {
    const r = await host.run(host.ffmpeg, ["-hide_banner", ...args], opts);
    if (r.code !== 0) throw new Error(`${what} failed: ${lastLines(r.stderr, 3)}`);
    return r;
  };

  async function probe(path) {
    if (!(await host.stat(path))) throw new Error(`File not found: ${path}`);
    const ext = extname(path).toLowerCase();
    const { code, stdout, stderr } = await host.run(host.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
    if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${lastLines(stderr)}`);
    const info = JSON.parse(stdout);
    const v = info.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
    const audio = info.streams.filter((s) => s.codec_type === "audio");
    const a = audio[0];
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
      // OBS can record each source to its own track ("Track 1 Mic", …).
      ...(audio.length > 1 ? { audioTracks: audio.map((s, i) => s.tags?.title || s.tags?.handler_name?.trim() || `Track ${i + 1}`) } : {}),
      kind: isImage ? "image" : v ? "video" : "audio",
    };
  }

  // A small, seek-friendly H.264 copy for smooth timeline preview, or the
  // source itself when the webview can already play it (images, common audio).
  async function ensureProxy(media, { onProgress, signal } = {}) {
    const ext = extname(media.path).toLowerCase();
    if (media.kind === "image") return media.path;
    if (!media.hasVideo && PLAYABLE_AUDIO.has(ext)) return media.path;
    await host.mkdir(host.cacheDir);
    const out = join(host.cacheDir, `${await cacheKey(media.path, "proxy-v3")}.${media.hasVideo ? "mp4" : "m4a"}`);
    if (await cached(out)) return out;
    const tmp = `${out}.part${media.hasVideo ? ".mp4" : ".m4a"}`;
    const args = ["-y", "-i", media.path];
    if (media.hasVideo) args.push("-map", "0:v:0", "-vf", "scale=-2:'min(720,ih)':flags=bicubic", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "23", "-g", "15", "-pix_fmt", "yuv420p");
    if (media.hasAudio) args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
    args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", tmp);
    await ffmpeg(args, "Proxy", { signal, onStdout: progressOf(media.duration, onProgress) });
    await host.rename(tmp, out);
    return out;
  }

  // Peak envelope: one value (0-255) per 1/perSecond s of an audio stream.
  async function waveform(media, { perSecond = 100, stream = 0 } = {}) {
    if (!media.hasAudio) return { perSecond, peaks: [] };
    await host.mkdir(host.cacheDir);
    const file = join(host.cacheDir, `${await cacheKey(media.path, `wave-${perSecond}${stream ? `-a${stream}` : ""}`)}.json`);
    if (await cached(file)) return JSON.parse(await host.readText(file));
    const result = { perSecond, peaks: Array.from(await host.peaks(media.path, { perSecond, stream })) };
    await host.writeText(file, JSON.stringify(result));
    return result;
  }

  // Thumbnail sprite for timeline filmstrips: `count` tiles, one every
  // `interval` source seconds, laid out `cols` per row.
  async function filmstrip(media, { source } = {}) {
    if (media.kind === "image") return { image: media.path, cols: 1, rows: 1, count: 1, interval: Infinity, tileW: 96, tileH: 54 };
    if (!media.hasVideo || !(media.duration > 0)) return null;
    await host.mkdir(host.cacheDir);
    const key = await cacheKey(media.path, "strip-v1");
    const meta = join(host.cacheDir, `${key}-strip.json`);
    if (await cached(meta)) return JSON.parse(await host.readText(meta));
    const count = Math.min(240, Math.max(1, Math.ceil(media.duration / 2)));
    const interval = media.duration / count;
    const cols = Math.min(count, 16);
    const rows = Math.ceil(count / cols);
    const tileH = 54;
    const tileW = Math.max(2, Math.round((tileH * (media.width || 16)) / (media.height || 9) / 2) * 2);
    const image = join(host.cacheDir, `${key}-strip.jpg`);
    // tpad guarantees the grid fills even if the source ends a little early.
    await ffmpeg(["-y", "-i", source ?? media.path, "-an", "-vf", `fps=${f6(1 / interval)},scale=${tileW}:${tileH},tpad=stop_mode=clone:stop=${cols * rows},tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "5", image], "Thumbnails");
    const result = { image, cols, rows, count, interval, tileW, tileH };
    await host.writeText(meta, JSON.stringify(result));
    return result;
  }

  // A reversed copy of source range [inn, out], rendered in short chunks so it
  // never needs the whole clip in memory. Returns the new file's probe info.
  async function makeReversed(media, inn, out, { onProgress } = {}) {
    await host.mkdir(host.cacheDir);
    const key = await cacheKey(media.path, `rev-${f6(inn)}-${f6(out)}`);
    const file = join(host.cacheDir, `${key}-reversed.mp4`);
    if (!(await cached(file))) {
      const work = join(host.cacheDir, `${key}-rev-parts`);
      await host.mkdir(work);
      const parts = [];
      const CHUNK = 3;
      for (let e = out, i = 0; e > inn + 1e-3; e -= CHUNK, i++) {
        const s = Math.max(inn, e - CHUNK);
        const part = join(work, `p${String(i).padStart(4, "0")}.mp4`);
        const args = ["-y", "-ss", f6(s), "-t", f6(e - s), "-i", media.path, "-vf", "reverse", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"];
        if (media.hasAudio) args.push("-af", "areverse", "-c:a", "aac", "-b:a", "192k");
        else args.push("-an");
        await ffmpeg([...args, part], "Reverse");
        parts.push(part);
        onProgress?.(Math.min(0.99, (out - s) / (out - inn)));
      }
      const list = join(work, "list.txt");
      await host.writeText(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
      const tmp = `${file}.part.mp4`;
      await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp], "Reverse join");
      await host.rename(tmp, file);
      await host.rm(work);
    }
    onProgress?.(1);
    return { ...(await probe(file)), name: `${media.name} (reversed)`, derivedFrom: media.id };
  }

  // One source frame as a PNG (for freeze frames).
  async function extractFrame(media, time) {
    await host.mkdir(host.cacheDir);
    const file = join(host.cacheDir, `${await cacheKey(media.path, `frame-${f6(time)}`)}.png`);
    if (!(await cached(file))) {
      await ffmpeg(["-y", "-ss", f6(Math.max(0, time)), "-i", media.path, "-frames:v", "1", file], "Frame grab");
      if (!(await cached(file))) throw new Error("Frame grab failed: no frame at that time");
    }
    return { ...(await probe(file)), name: `Freeze ${media.name}` };
  }

  // Each audio track of a multi-track recording (OBS) as its own WAV, so every
  // source (game, mic, Discord…) gets its own clip and fader.
  async function splitAudioTracks(media, { onProgress } = {}) {
    const titles = media.audioTracks ?? (media.hasAudio ? ["Audio"] : []);
    await host.mkdir(host.cacheDir);
    const out = [];
    for (const [i, title] of titles.entries()) {
      const file = join(host.cacheDir, `${await cacheKey(media.path, `track-${i}`)}-track${i + 1}.wav`);
      if (!(await cached(file))) {
        const tmp = `${file}.part.wav`;
        await ffmpeg(["-y", "-i", media.path, "-map", `0:a:${i}`, "-vn", "-c:a", "pcm_s16le", "-progress", "pipe:1", "-nostats", tmp], `Track ${i + 1}`, {
          onStdout: progressOf(media.duration, (p) => onProgress?.((i + p) / titles.length)),
        });
        await host.rename(tmp, file);
      }
      out.push({ ...(await probe(file)), name: `${title} (${media.name})`, derivedFrom: media.id, role: guessRole(title) });
    }
    onProgress?.(1);
    return out;
  }

  // Source times where the picture changes shot (scene cuts). Runs on a small
  // downscaled copy for speed; `source` may be a proxy of the same media.
  async function detectScenes(media, { threshold = 0.35, minGap = 1, source } = {}) {
    if (!media.hasVideo || media.kind === "image") return [];
    const { stderr } = await ffmpeg(["-nostats", "-i", source ?? media.path, "-an", "-vf", `scale=320:-2,select='gt(scene,${f6(threshold)})',showinfo`, "-f", "null", "-"], "Scene detection");
    const times = [];
    for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
      const t = Number(m[1]);
      if (!times.length || t - times[times.length - 1] >= minGap) times.push(t);
    }
    return times;
  }

  // Ranges (source seconds) quieter than `noise` dB for at least `minDuration`.
  async function detectSilence(media, { noise = -35, minDuration = 2 } = {}) {
    if (!media.hasAudio) return [];
    const { stderr } = await ffmpeg(["-nostats", "-i", media.path, "-map", "0:a:0", "-af", `silencedetect=noise=${noise}dB:d=${minDuration}`, "-f", "null", "-"], "Silence detection");
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

  return { cacheKey, probe, ensureProxy, waveform, filmstrip, makeReversed, extractFrame, splitAudioTracks, detectScenes, detectSilence };
}

// FFmpeg `-progress pipe:1` output -> 0..1 of `duration` seconds.
export function progressOf(duration, onProgress) {
  return (text) => {
    const m = /out_time_us=(\d+)/.exec(text);
    if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
  };
}

// A sound role from an OBS track name, so the mixer starts out sensible.
export function guessRole(title) {
  const t = title.toLowerCase();
  if (/mic|voice|vo\b|talk|commentary|discord|chat|صوت|مايك/.test(t)) return "dialogue";
  if (/music|song|spotify|bgm|موسيق/.test(t)) return "music";
  if (/game|desktop|system|sfx|لعب/.test(t)) return "sfx";
  return null;
}
