// Resolve/Premiere-inspired features: color wheels, adjustment layers, mixer,
// ducking, loudness, scene detection, roll/slip trims, text-based editing.
import assert from "node:assert/strict";
import { join } from "node:path";
import { before, test } from "node:test";
import { clipEnd, createProject, projectDuration } from "../core/model.js";
import * as ops from "../core/ops.js";
import { buildRenderPlan, colorFilters, wheelRgb } from "../core/render.js";
import { parseSubtitles, toSrt } from "../core/captions.js";
import { isFiller, timelineWords, wordRanges } from "../core/transcript.js";
import { renderFrame, renderProject } from "../node/exporter.js";
import { detectScenes, probe } from "../node/media.js";
import { A, B, ensureMedia, MUSIC, OUT } from "./fixtures.js";

before(ensureMedia);

async function base() {
  let p = createProject({ name: "pro", canvas: "720p" });
  const add = async (path) => {
    const r = ops.addMedia(p, await probe(path));
    p = r.project;
    return r.media;
  };
  const a = await add(A);
  const b = await add(B);
  ({ project: p } = ops.addClip(p, { mediaId: a.id, in: 0, out: 3 }));
  ({ project: p } = ops.addClip(p, { mediaId: b.id, in: 0.5, out: 3.5 }));
  return { p, a, b };
}

test("color wheels map to colorbalance and curves", () => {
  assert.ok(wheelRgb({ x: 0, y: 1 }).r > 1, "pushing up reddens");
  const f = colorFilters({ lift: { x: 0.5, y: 0, l: 0.3 }, gamma: { x: 0, y: 0, l: 0 }, gain: { x: 0, y: 0, l: 0 }, offset: { x: 0, y: 0, l: 0 }, curve: [[0, 0], [0.5, 0.6], [1, 1]] });
  assert.match(f.join(","), /colorbalance=.*bs=/);
  assert.equal(f.filter((x) => x.startsWith("curves")).length, 2);
});

test("roll and slip edits", async () => {
  let { p } = await base();
  const [l, r] = [...p.clips].sort((x, y) => x.start - y.start);
  p = ops.rollEdit(p, l.id, r.id, 0.4);
  const L = p.clips.find((c) => c.id === l.id);
  const R = p.clips.find((c) => c.id === r.id);
  assert.ok(Math.abs(clipEnd(L) - 3.4) < 1e-6 && Math.abs(R.start - 3.4) < 1e-6 && Math.abs(R.in - 0.9) < 1e-6);
  assert.ok(Math.abs(projectDuration(p) - 6) < 1e-6, "roll keeps total length");
  p = ops.slipClip(p, R.id, -0.3);
  const S = p.clips.find((c) => c.id === r.id);
  assert.ok(Math.abs(S.in - 0.6) < 1e-6 && Math.abs(S.start - 3.4) < 1e-6);
});

test("text-based editing maps words through the edit and cuts them", async () => {
  let { p, a } = await base();
  const words = [
    { s: 0.2, e: 0.5, w: "hello" },
    { s: 0.6, e: 0.8, w: "um" },
    { s: 0.9, e: 1.3, w: "world" },
    { s: 3.5, e: 3.8, w: "trimmed" }, // outside the clip (source 0-3)
  ];
  p = ops.setTranscript(p, a.id, { language: "en", words });
  const tl = timelineWords(p, a.id, p.transcripts[a.id].words);
  assert.deepEqual(tl.map((w) => w.text), ["hello", "um", "world"]);
  assert.ok(isFiller("Um,") && !isFiller("world"));
  const before = projectDuration(p);
  p = ops.removeRanges(p, wordRanges(tl.filter((w) => w.filler)));
  assert.ok(projectDuration(p) < before - 0.2);
  const after = timelineWords(p, a.id, p.transcripts[a.id].words).map((w) => w.text);
  assert.deepEqual(after, ["hello", "world"]);
});

test("mixer, ducking, loudness and adjustment layers render", { timeout: 180000 }, async () => {
  let { p } = await base();
  // Music on an audio track ducked under the main track (dialogue).
  const song = ops.addMedia(p, await probe(MUSIC));
  const { project: withA, track: music } = ops.addTrack(song.project, "audio", "Music");
  p = ops.addClip(withA, { mediaId: song.media.id, trackId: music.id, start: 0, in: 0, out: 4 }).project;
  const mainId = p.tracks.find((t) => t.kind === "video").id;
  p = ops.setTrack(p, mainId, { role: "dialogue", volume: 1.2 });
  p = ops.setTrack(p, music.id, { role: "music", duck: { enabled: true, amount: 70 }, pan: -0.5 });
  const adj = ops.addAdjustment(p, { start: 1, duration: 2 });
  p = ops.setClip(adj.project, adj.clip.id, { adjust: { saturation: -100 }, color: { gain: { x: 0, y: 0.4, l: 0.2 } } });
  const main = p.clips.find((c) => c.start === 0 && c.trackId === mainId);
  p = ops.setClip(p, main.id, { videoDenoise: 40, color: { lift: { x: -0.3, y: 0.2, l: 0.1 } } });
  const plan = buildRenderPlan(p, { tmpDir: OUT, loudness: -14 });
  assert.match(plan.graph, /sidechaincompress/);
  assert.match(plan.graph, /loudnorm=I=-14/);
  assert.match(plan.graph, /enable='between\(t,1,3\)'/);
  assert.match(plan.graph, /hqdn3d/);
  assert.match(plan.graph, /pan=stereo/);
  const r = await renderProject(p, { outPath: join(OUT, "pro-mix.mp4"), hardware: "cpu", quality: "compact", loudness: -14 });
  const m = await probe(r.path);
  assert.ok(Math.abs(m.duration - projectDuration(p)) < 0.15, `duration ${m.duration}`);
  await renderFrame(p, 2, join(OUT, "pro-adjustment.jpg"), { previewWidth: 480 });
  // Solo leaves only the soloed track.
  const solo = buildRenderPlan(ops.setTrack(p, music.id, { solo: true }), { video: false, tmpDir: OUT });
  assert.doesNotMatch(solo.graph, /sidechaincompress/, "no dialogue left to duck under");
});

test("scene detection finds the hard cut and splits there", { timeout: 120000 }, async () => {
  // a.mp4 then b.mp4 joined into one file = one scene cut at 3 s.
  const { p: two } = await base();
  const joined = join(OUT, "two-scenes.mp4");
  await renderProject(two, { outPath: joined, hardware: "cpu", quality: "compact" });
  const m = await probe(joined);
  const cuts = await detectScenes(m, { threshold: 0.3 });
  assert.ok(cuts.some((t) => Math.abs(t - 3) < 0.2), JSON.stringify(cuts));
  let p = createProject({ canvas: "720p" });
  const r = ops.addMedia(p, m);
  p = ops.addClip(r.project, { mediaId: r.media.id }).project;
  p = ops.splitAtSourceTimes(p, r.media.id, cuts);
  assert.ok(p.clips.length >= 2);
});

test("three-point edits from the source monitor", async () => {
  const { p, b } = await base(); // main: a 0-3, b 3-6
  const mainId = p.tracks.find((t) => t.kind === "video").id;
  const onMain = (x) => x.clips.filter((c) => c.trackId === mainId).sort((m, n) => m.start - n.start);

  // Insert opens room everywhere: the clip at 3 s moves to 4 s.
  const ins = ops.placeSource(p, { mediaId: b.id, in: 0, out: 1, at: 3, mode: "insert" });
  assert.ok(Math.abs(projectDuration(ins.project) - 7) < 1e-6);
  assert.deepEqual(onMain(ins.project).map((c) => c.start), [0, 3, 4]);

  // Overwrite replaces 1-2 s of the first clip and keeps the length.
  const ow = ops.placeSource(p, { mediaId: b.id, in: 0, out: 1, at: 1, mode: "overwrite" });
  assert.ok(Math.abs(projectDuration(ow.project) - 6) < 1e-6);
  assert.deepEqual(onMain(ow.project).map((c) => [c.start, clipEnd(c)]), [[0, 1], [1, 2], [2, 3], [3, 6]]);

  // Append goes after the last clip; top lands on a free track above.
  const app = ops.placeSource(p, { mediaId: b.id, in: 0, out: 2, mode: "append" });
  assert.equal(app.clip.start, 6);
  const top = ops.placeSource(p, { mediaId: b.id, in: 0, out: 1, at: 2, mode: "top" });
  assert.notEqual(top.clip.trackId, mainId);
  assert.equal(top.clip.start, 2);

  // insertGap moves markers and bleeps after the point too.
  let q = ops.addBleep(ops.addMarker(p, 4, { label: "x" }), 4.2, 4.5);
  q = ops.insertGap(q, 3.5, 2);
  assert.equal(q.markers[0].time, 6);
  assert.ok(Math.abs(q.bleeps[0].start - 6.2) < 1e-6);
  assert.throws(() => ops.placeSource(p, { mediaId: b.id, in: 2, out: 1 }), /In point/);
});

test("close gaps, speed ramps and title templates", async () => {
  let { p } = await base();
  const mainId = p.tracks.find((t) => t.kind === "video").id;
  const [first, second] = [...p.clips].sort((m, n) => m.start - n.start);

  const gappy = ops.moveClip(p, second.id, { start: 4.5 });
  assert.ok(Math.abs(projectDuration(gappy) - 7.5) < 1e-6);
  assert.ok(Math.abs(projectDuration(ops.closeGaps(gappy)) - 6) < 1e-6);

  // Hero: 6 equal source pieces, the middle two at 0.3x.
  p = ops.speedRamp(p, first.id, "hero");
  const pieces = p.clips.filter((c) => c.trackId === mainId && c.mediaId === first.mediaId).sort((m, n) => m.start - n.start);
  assert.deepEqual(pieces.map((c) => c.speed), [1, 1, 0.3, 0.3, 1, 1]);
  assert.equal(pieces[0].id, first.id, "the first piece keeps the clip id");
  const rampLen = 0.5 * 4 + (0.5 / 0.3) * 2;
  assert.ok(Math.abs(p.clips.find((c) => c.id === second.id).start - rampLen) < 1e-6, "later clips move by the change");
  assert.throws(() => ops.speedRamp(p, first.id, "nope"), /Unknown speed ramp/);

  const t = ops.addTitle(p, "lower-third", { start: 1, text: "Your Name\nCutroom" });
  assert.equal(t.clip.text, "Your Name\nCutroom");
  assert.ok(t.clip.animIn && t.clip.animOut, "templates animate in and out");
  assert.throws(() => ops.addTitle(p, "missing"), /Unknown title template/);
});

test("moving and duplicating a selection, and clip labels", async () => {
  let { p, b } = await base(); // main: a 0-3, b 3-6
  const music = ops.addMedia(p, await probe(MUSIC));
  p = ops.addClip(music.project, { mediaId: music.media.id, start: 1, in: 0, out: 2 }).project; // audio 1-3
  const [a, bb] = [...p.clips].filter((c) => c.mediaId !== music.media.id).sort((x, y) => x.start - y.start);
  const song = p.clips.find((c) => c.mediaId === music.media.id);

  // The second main clip and the song move together; each keeps its track.
  const moved = ops.moveClips(p, [bb.id, song.id], 1.5);
  assert.equal(moved.clips.find((c) => c.id === bb.id).start, 4.5);
  assert.equal(moved.clips.find((c) => c.id === song.id).start, 2.5);
  assert.equal(moved.clips.find((c) => c.id === song.id).trackId, song.trackId);
  // Moving left stops at 0 for the earliest clip, and clips in the way block it.
  assert.equal(ops.moveClips(p, [song.id], -5).clips.find((c) => c.id === song.id).start, 0);
  assert.equal(ops.moveClips(p, [a.id, song.id], -5), p, "a group already at 0 stays put");
  assert.throws(() => ops.moveClips(p, [bb.id], -1), /overlaps/);

  // Duplicates keep their spacing and land after the originals.
  const dup = ops.duplicateClips(p, [a.id, song.id], 6);
  assert.equal(dup.ids.length, 2);
  const copies = dup.project.clips.filter((c) => dup.ids.includes(c.id)).sort((x, y) => x.start - y.start);
  assert.deepEqual(copies.map((c) => c.start), [6, 7]);
  assert.equal(copies[0].trackId, a.trackId);

  // Labels: one of the known colors, or none.
  const labeled = ops.setClip(p, a.id, { label: "purple" });
  assert.equal(labeled.clips.find((c) => c.id === a.id).label, "purple");
  assert.equal(ops.setClip(labeled, a.id, { label: "plaid" }).clips.find((c) => c.id === a.id).label, null);
  assert.equal(b.kind, "video");
});

test("cutting a range never leaves a sub-frame sliver that overlaps the next clip", () => {
  let p = createProject({ canvas: "720p" });
  p = ops.addTextTrack(p, [{ start: 0, end: 1.508, text: "title" }, { start: 1.508, end: 3, text: "next" }]).project;
  p = ops.removeRanges(p, [[1, 1.5]]); // leaves 8 ms of "title" after the cut
  const clips = [...p.clips].sort((x, y) => x.start - y.start);
  assert.deepEqual(clips.map((c) => c.text), ["title", "next"]);
  assert.ok(clipEnd(clips[0]) <= clips[1].start + 1e-9, `${clipEnd(clips[0])} > ${clips[1].start}`);
  assert.ok(Math.abs(clips[1].start - 1.008) < 1e-6);
});

test("subtitles: .srt out, .srt/.vtt in", () => {
  let p = createProject({ canvas: "720p" });
  p = ops.addTextTrack(p, [{ start: 0.5, end: 2.25, text: "Hello there" }, { start: 3661.2, end: 3662, text: "مرحبا\nsecond line" }], { name: "Captions" }).project;
  p = ops.addText(p, { text: "Big title", start: 0, duration: 1 }).project; // another text track, not captions
  const srt = toSrt(p);
  assert.equal(srt, "1\n00:00:00,500 --> 00:00:02,250\nHello there\n\n2\n01:01:01,200 --> 01:01:02,000\nمرحبا\nsecond line\n");
  assert.deepEqual(parseSubtitles(srt), [{ start: 0.5, end: 2.25, text: "Hello there" }, { start: 3661.2, end: 3662, text: "مرحبا\nsecond line" }]);
  const vtt = "WEBVTT\r\n\r\nNOTE made elsewhere\r\n\r\n00:01.000 --> 00:04.000 align:start\r\n<i>Overlapping</i> line\r\n\r\n00:03.000 --> 00:05.500\r\nNext\r\n";
  assert.deepEqual(parseSubtitles(vtt), [{ start: 1, end: 3, text: "Overlapping line" }, { start: 3, end: 5.5, text: "Next" }]);
  assert.throws(() => toSrt(createProject()), /No captions/);
});
