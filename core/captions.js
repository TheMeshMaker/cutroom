// Turn transcription words (source time of one media item) into caption lines
// on the timeline, following the clips that actually play that media. Words in
// parts that were cut out are dropped.

import { clipEnd } from "./model.js";

export function captionLines(project, mediaId, segments, { maxChars = 32, maxGap = 0.6 } = {}) {
  const clips = project.clips.filter((c) => c.mediaId === mediaId);
  const words = [];
  for (const seg of segments) {
    const list = seg.words?.length ? seg.words : [{ start: seg.start, end: seg.end, word: seg.text }];
    for (const w of list) {
      const mid = (w.start + w.end) / 2;
      const c = clips.find((k) => mid >= k.in && mid < k.out);
      if (!c) continue;
      const toTimeline = (s) => c.start + (Math.min(Math.max(s, c.in), c.out) - c.in) / (c.speed || 1);
      words.push({ start: toTimeline(w.start), end: Math.min(toTimeline(w.end), clipEnd(c)), text: w.word.trim(), clip: c.id });
    }
  }
  words.sort((a, b) => a.start - b.start);
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (!w.text) continue;
    const joined = cur ? `${cur.text} ${w.text}` : w.text;
    // Break at sentence ends, at commas once a line is half full, on pauses,
    // at clip boundaries, and when the line would get too long.
    const sentenceEnd = cur && /[.!?؟]$/.test(cur.text);
    const comma = cur && /[,،;:]$/.test(cur.text) && cur.text.length > maxChars / 2;
    // A word that ends a clause may run a little long so the clause stays whole.
    const limit = /[.!?؟,،;:]$/.test(w.text) ? maxChars + 8 : maxChars;
    const breakHere = !cur || cur.clip !== w.clip || w.start - cur.end > maxGap || joined.length > limit || sentenceEnd || comma;
    if (breakHere) {
      if (cur) lines.push(cur);
      cur = { start: w.start, end: w.end, text: w.text, clip: w.clip };
    } else {
      cur.text = joined;
      cur.end = w.end;
    }
  }
  if (cur) lines.push(cur);
  // No overlaps, and every line on screen for at least 0.4 s when possible.
  for (let i = 0; i < lines.length; i++) {
    const nextStart = lines[i + 1]?.start ?? Infinity;
    lines[i].end = Math.min(Math.max(lines[i].end, lines[i].start + 0.4), nextStart);
  }
  return lines.filter((l) => l.end - l.start > 0.05).map(({ start, end, text }) => ({ start, end, text }));
}

// ---- subtitle files: save the captions track as SubRip (.srt), read .srt/.vtt.

// The track that holds the captions: one named like captions/subtitles, else
// the text track with the most clips.
export function captionsTrack(project) {
  const count = (t) => project.clips.filter((c) => c.trackId === t.id).length;
  const text = project.tracks.filter((t) => t.kind === "text" && count(t));
  return text.find((t) => /caption|subtitle/i.test(t.name)) ?? text.sort((a, b) => count(b) - count(a))[0] ?? null;
}

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

export function toSrt(project, { trackId } = {}) {
  const track = trackId ? project.tracks.find((t) => t.id === trackId) : captionsTrack(project);
  if (!track) throw new Error("No captions to save yet: generate captions or add text first");
  return project.clips
    .filter((c) => c.trackId === track.id && c.text?.trim())
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(clipEnd(c))}\n${c.text.trim()}\n`)
    .join("\n");
}

// [{start, end, text}] in seconds from .srt or .vtt text. Overlapping lines are
// shortened so they fit on one track.
export function parseSubtitles(src) {
  const time = (s) => {
    const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.exec(s);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : NaN;
  };
  const lines = [];
  for (const block of src.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = rows[at].split("-->");
    const start = time(a);
    const end = time(b);
    const text = rows.slice(at + 1).join("\n").replace(/<[^>]+>/g, "").replace(/\{\[^}]*\}/g, "").trim();
    if (Number.isFinite(start) && end > start && text) lines.push({ start, end, text });
  }
  lines.sort((x, y) => x.start - y.start);
  for (let i = 0; i < lines.length - 1; i++) lines[i].end = Math.min(lines[i].end, lines[i + 1].start);
  return lines.filter((l) => l.end - l.start > 0.05);
}
