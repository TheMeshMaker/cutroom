// Transcripts on the timeline: map a media item's word timings (source
// seconds) through the clips that play it, for text-based editing and
// captions. Words in parts that were cut out simply disappear.

import { clipEnd } from "./model.js";

// Pure hesitation sounds (not words that also carry meaning).
export const FILLERS = new Set(["um", "umm", "ummm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "mmm", "ah", "eh", "امم", "اممم", "ام", "ااا", "اه", "ممم", "إمم"]);

const clean = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
export const isFiller = (w) => FILLERS.has(clean(w));

export function timelineWords(project, mediaId, words) {
  const clips = project.clips.filter((c) => c.mediaId === mediaId).sort((a, b) => a.start - b.start);
  const out = [];
  words.forEach((w, i) => {
    const mid = (w.s + w.e) / 2;
    const c = clips.find((k) => mid >= k.in && mid < k.out);
    if (!c) return;
    const at = (s) => c.start + (Math.min(Math.max(s, c.in), c.out) - c.in) / (c.speed || 1);
    out.push({ i, start: at(w.s), end: Math.min(at(w.e), clipEnd(c)), text: w.w.trim(), clip: c.id, filler: isFiller(w.w) });
  });
  return out.sort((a, b) => a.start - b.start);
}

// Timeline ranges covering the given words, padded a little and merged, ready
// for removeRanges.
export function wordRanges(words, { pad = 0.04 } = {}) {
  const r = words.map((w) => [Math.max(0, w.start - pad), w.end + pad]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of r) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 0.12) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Flatten transcribe() segments into the stored word list.
export function wordsFromSegments(segments) {
  const words = [];
  for (const seg of segments) {
    const list = seg.words?.length ? seg.words : [{ start: seg.start, end: seg.end, word: seg.text }];
    for (const w of list) if (w.word?.trim()) words.push({ s: w.start, e: w.end, w: w.word.trim() });
  }
  return words;
}
