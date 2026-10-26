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
