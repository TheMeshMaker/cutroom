// Multi-step edits shared by the native app and the MCP server: render or
// analyse something first, then change the project with ops. Each returns
// the new project (and sometimes a note).

import { captionLines, captionsTrack, parseSubtitles, toSrt } from "../core/captions.js";
import { EFFECTS, FILTERS, TEXT_STYLES, byId } from "../core/catalog.js";
import { detectBeats } from "../core/analysis.js";
import { clipById, clipEnd, isText, mediaById, normalizeProject, sourceAt, trackClips } from "../core/model.js";
import * as ops from "../core/ops.js";

export function createFlows(host, media, python, exporter) {
  const styleOf = (id) => (byId(TEXT_STYLES, id) ?? byId(TEXT_STYLES, "subtitle")).style;

  // Play a clip backwards: render its source range reversed once, then point the clip at it.
  async function reverse(p, clipId, { onProgress } = {}) {
    const c = clipById(p, clipId);
    if (!c || isText(c) || !c.mediaId) throw new Error("Pick a video or audio clip");
    const info = await media.makeReversed(mediaById(p, c.mediaId), c.in, c.out, { onProgress });
    const r = ops.addMedia(p, info);
    return ops.replaceClipMedia(r.project, clipId, r.media.id, { in: 0, out: info.duration, reverseKeyframes: true });
  }

  // Freeze frame: split at a timeline time and hold that frame for `duration` seconds.
  async function freeze(p, clipId, time, { duration = 3 } = {}) {
    const c = clipById(p, clipId);
    if (!c || isText(c) || !c.mediaId) throw new Error("Pick a video clip");
    const still = await media.extractFrame(mediaById(p, c.mediaId), sourceAt(c, time));
    const r = ops.addMedia(p, still);
    return ops.insertFreeze(r.project, clipId, time, r.media.id, duration);
  }

  // Auto captions from local speech recognition, on a new Captions track.
  async function captions(p, { mediaId, language = "auto", styleId = "subtitle", maxChars = 32, onProgress, signal } = {}) {
    const used = new Set(p.clips.map((c) => c.mediaId));
    const audible = p.media.filter((m) => used.has(m.id) && m.hasAudio);
    const m = mediaId ? mediaById(p, mediaId) : (audible.find((x) => !x.hasVideo) ?? audible[0]);
    if (!m) throw new Error("No media with audio on the timeline");
    const result = await python.transcribe(m, { language, onProgress, signal });
    const lines = captionLines(p, m.id, result.segments, { maxChars });
    if (!lines.length) throw new Error("No speech found");
    return { project: ops.addTextTrack(p, lines, { name: "Captions", style: styleOf(styleId) }).project, note: `${lines.length} captions, language ${result.language}` };
  }

  // Subtitles (.srt / .vtt) as caption clips; `offset` shifts every line.
  async function importSubtitles(p, path, { styleId = "subtitle", offset = 0 } = {}) {
    const lines = parseSubtitles(await host.readText(path))
      .map((l) => ({ ...l, start: l.start + offset, end: l.end + offset }))
      .filter((l) => l.end > 0)
      .map((l) => ({ ...l, start: Math.max(0, l.start) }));
    if (!lines.length) throw new Error(`No subtitles found in ${path}`);
    return { project: ops.addTextTrack(p, lines, { name: "Captions", style: styleOf(styleId) }).project, note: `${lines.length} captions` };
  }

  // The captions track (or any text track) as a SubRip file.
  async function saveSubtitles(p, outPath, { trackId } = {}) {
    const srt = toSrt(p, { trackId });
    const path = outPath.toLowerCase().endsWith(".srt") ? outPath : `${outPath}.srt`;
    await host.writeText(path, srt);
    return { path, lines: srt.split("\n\n").length, track: (trackId ? p.tracks.find((t) => t.id === trackId) : captionsTrack(p))?.name };
  }

  // Thumbnails of one frame of a clip under every filter and effect, for the
  // library tiles. Pass a project whose media point at preview proxies. Cached.
  async function lookPreviews(p, clipId, time, { width = 200, onProgress, signal } = {}) {
    const c = clipById(p, clipId);
    const m = c?.mediaId && mediaById(p, c.mediaId);
    if (!m?.hasVideo) throw new Error("Pick a video clip");
    // A frame inside the clip's footage (never past the end of the file, which renders black).
    const src = Math.max(c.in, Math.min(sourceAt(c, Math.min(Math.max(time, c.start), clipEnd(c))), c.out - 0.3, (m.duration || Infinity) - 0.3));
    const dir = host.join(host.cacheDir, "looks", (await host.sha1(`${m.path}|${src.toFixed(2)}|${width}`)).slice(0, 16));
    await host.mkdir(dir);
    const base = { ...p, tracks: [{ id: "v", kind: "video", name: "Main" }], markers: [], bleeps: [] };
    const clip = { id: "c", trackId: "v", mediaId: m.id, start: 0, in: src, out: src + 0.25, transform: c.transform, crop: c.crop, flipH: c.flipH, flipV: c.flipV };
    const items = [...FILTERS.map((f) => ["filter", f.id, { filter: { id: f.id, intensity: 100 } }]), ...EFFECTS.map((e) => ["effect", e.id, { effects: [{ id: e.id, intensity: 70 }] }])];
    const out = { filter: {}, effect: {} };
    for (const [i, [kind, id, patch]] of items.entries()) {
      if (signal?.aborted) throw new Error("Cancelled");
      const file = host.join(dir, `${kind}-${id}.jpg`);
      if (!(await host.stat(file))) await exporter.renderFrame(normalizeProject({ ...base, clips: [{ ...clip, ...patch }] }), 0.05, file, { previewWidth: width });
      out[kind][id] = file;
      onProgress?.((i + 1) / items.length);
    }
    return out;
  }

  // A sticker (a color emoji or a drawn shape) as an image clip on a
  // "Stickers" video track above the footage, at `start`.
  async function addSticker(p, { emoji, shape, text = "", start = 0, duration = 3 } = {}) {
    const kind = emoji ? "emoji" : "shape";
    const value = emoji ?? shape;
    if (!value) throw new Error("Pick a sticker");
    const dir = host.join(host.cacheDir, "stickers");
    await host.mkdir(dir);
    const file = host.join(dir, `${(await host.sha1(`${kind}|${value}|${text}|v1`)).slice(0, 16)}.png`);
    if (!(await host.stat(file))) {
      const { code, stderr } = await host.run(host.python, [host.join(host.scriptsDir, "sticker.py"), file, kind, value, text]);
      if (code !== 0) throw new Error(`Sticker failed: ${stderr.trim().split("\n").pop()}`);
    }
    const r = ops.addMedia(p, { ...(await media.probe(file)), name: `Sticker ${value}` });
    let project = r.project;
    const free = (t) => trackClips(project, t.id).every((c) => clipEnd(c) <= start + 1e-6 || c.start >= start + duration - 1e-6);
    let track = project.tracks.find((t) => t.kind === "video" && t.name.startsWith("Stickers") && free(t));
    if (!track) ({ project, track } = ops.addTrack(project, "video", "Stickers"));
    const added = ops.addClip(project, { mediaId: r.media.id, trackId: track.id, start, in: 0, out: duration });
    return { project: ops.setClip(added.project, added.clip.id, { transform: { scale: 0.4 } }), clip: added.clip };
  }

  // The text-to-speech voices installed in Windows (Settings > Time & language > Speech adds more).
  async function voices() {
    const ps = "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }";
    const { code, stdout } = await host.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    if (code !== 0) return [];
    return stdout.split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture] = l.split("|"); return { name, culture }; });
  }

  // Read text aloud with a Windows voice (on this PC) onto an audio track at `start`.
  async function speak(p, { text, voice, rate = 0, start = 0 } = {}) {
    if (!text?.trim()) throw new Error("Write some text first");
    const dir = host.join(host.cacheDir, "speech");
    await host.mkdir(dir);
    const key = (await host.sha1(`${voice}|${rate}|${text}`)).slice(0, 16);
    const wav = host.join(dir, `${key}.wav`);
    if (!(await host.stat(wav))) {
      const txt = host.join(dir, `${key}.txt`);
      await host.writeText(txt, text);
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voice ? `$s.SelectVoice(${q(voice)}); ` : ""}$s.Rate = ${Math.round(Math.max(-10, Math.min(10, rate)))}; $s.SetOutputToWaveFile(${q(wav)}); $s.Speak([IO.File]::ReadAllText(${q(txt)})); $s.Dispose()`;
      const { code, stderr } = await host.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      if (code !== 0) throw new Error(`Text to speech failed: ${stderr.trim().split("\n").pop()}`);
    }
    const r = ops.addMedia(p, { ...(await media.probe(wav)), name: `Voice: ${text.trim().slice(0, 28)}` });
    return { project: ops.addClip(r.project, { mediaId: r.media.id, start }).project, note: "Voice added" };
  }

  // Markers on the beats of a clip's sound, for cutting to the rhythm.
  async function beats(p, clipId, { sensitivity = 0.5 } = {}) {
    const c = clipById(p, clipId);
    if (!c || isText(c) || !c.mediaId) throw new Error("Pick a clip with audio");
    const wave = await media.waveform(mediaById(p, c.mediaId));
    const times = detectBeats(wave, { sensitivity })
      .filter((t) => t >= c.in && t < c.out)
      .map((t) => c.start + (t - c.in) / c.speed);
    if (!times.length) throw new Error("No beats found in this clip");
    return { project: ops.addMarkers(p, times.map((time) => ({ time, label: "beat", color: "beat" }))), note: `${times.length} beats marked` };
  }

  return { reverse, freeze, captions, importSubtitles, saveSubtitles, lookPreviews, addSticker, voices, speak, beats };
}
