// Every pro feature at once, rendered through real FFmpeg.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { detectBeats } from "../core/analysis.js";
import { captionLines } from "../core/captions.js";
import { clipEnd, clipLength, createProject, evaluateClip, projectDuration } from "../core/model.js";
import * as ops from "../core/ops.js";
import { buildRenderPlan } from "../core/render.js";
import { availableEncoders, renderAudio, renderFrame, renderProject } from "../node/exporter.js";
import { extractFrame, filmstrip, makeReversed, probe } from "../node/media.js";
import { A, B, ensureMedia, GREEN, OUT } from "./fixtures.js";

before(ensureMedia);

async function base() {
  let p = createProject({ name: "features", canvas: "720p" });
  const add = async (path) => {
    const r = ops.addMedia(p, await probe(path));
    p = r.project;
    return r.media;
  };
  const a = await add(A);
  const b = await add(B);
  const g = await add(GREEN);
  ({ project: p } = ops.addClip(p, { mediaId: a.id, in: 0, out: 3 }));
  ({ project: p } = ops.addClip(p, { mediaId: b.id, in: 0.5, out: 3.5 }));
  return { p, a, b, g };
}

test("speed changes the timeline length and keeps later clips clear", async () => {
  let { p } = await base();
  const first = p.clips.find((c) => c.start === 0);
  p = ops.setClip(p, first.id, { speed: 2 });
  const f2 = p.clips.find((c) => c.id === first.id);
  assert.ok(Math.abs(clipLength(f2) - 1.5) < 1e-6);
  const second = p.clips.find((c) => c.id !== first.id);
  assert.ok(Math.abs(second.start - 3) < 1e-6, "later clip keeps its place when the first gets shorter");
  p = ops.setClip(p, first.id, { speed: 0.5 });
  const after = p.clips.find((c) => c.id !== first.id);
  assert.ok(after.start >= clipEnd(p.clips.find((c) => c.id === first.id)) - 1e-6, "slowing down pushes the next clip");
});

test("magnetic main track, delete left/right, transitions", async () => {
  let { p } = await base();
  const [c1, c2] = [...p.clips].sort((x, y) => x.start - y.start);
  p = ops.trimToTime(p, [c1.id], 1, "left", { ripple: true });
  const main = p.clips.filter((c) => c.trackId === "v1").sort((x, y) => x.start - y.start);
  assert.ok(Math.abs(main[0].start) < 1e-6 && Math.abs(main[1].start - 2) < 1e-6, JSON.stringify(main.map((c) => c.start)));
  p = ops.insertOnTrack(p, main[1].id, 0, "v1");
  const order = p.clips.filter((c) => c.trackId === "v1").sort((x, y) => x.start - y.start);
  assert.equal(order[0].id, main[1].id, "magnetic insert reorders");
  p = ops.setTransition(p, order[1].id, { type: "dissolve", duration: 0.6 });
  assert.equal(p.clips.find((c) => c.id === order[1].id).transition.type, "dissolve");
  assert.throws(() => ops.setTransition(p, order[0].id, { type: "dissolve" }), /directly before/);
});

test("animations and motion effects evaluate as expected", () => {
  let p = createProject({ canvas: "720p" });
  p = ops.addText(p, { text: "hi", start: 0, duration: 2 }).project;
  const c = { ...p.clips[0], animIn: { type: "zoom-in", duration: 0.5 }, effects: [{ id: "shake", intensity: 100 }] };
  assert.ok(evaluateClip(c, 0).scale < 0.6, "starts small");
  assert.ok(Math.abs(evaluateClip(c, 1).scale - 1.045) < 1e-6, "rests at shake's crop zoom");
  assert.equal(evaluateClip(c, 0).opacity, 0);
});

test("renders every feature together", { timeout: 300000 }, async () => {
  let { p, g } = await base();
  const [c1, c2] = [...p.clips].sort((x, y) => x.start - y.start);
  p = ops.setClip(p, c1.id, {
    adjust: { contrast: 20, saturation: 30, temperature: 30, vignette: 40, sharpen: 30 },
    filter: { id: "cinematic", intensity: 80 },
    effects: [{ id: "glow", intensity: 50 }, { id: "shake", intensity: 60 }],
    animIn: { type: "zoom-in", duration: 0.5 },
    crop: { l: 0.05, r: 0.05 },
    stabilize: { enabled: true, strength: 40 },
    audio: { denoise: 40, enhance: true, normalize: true },
  });
  p = ops.setClip(p, c2.id, { speed: 1.5, transform: { rotation: 8 }, audio: { voice: "robot", pitch: 3 }, animOut: { type: "fade", duration: 0.4 } });
  p = ops.setTransition(p, c2.id, { type: "slide-left", duration: 0.5 });
  // Picture-in-picture with a chroma key on a new video track.
  const { project: p2, track } = ops.addTrack(p, "video");
  p = ops.addClip(p2, { mediaId: g.id, trackId: track.id, start: 0.5, in: 0, out: 2 }).project;
  const pip = p.clips.find((c) => c.mediaId === g.id);
  p = ops.setClip(p, pip.id, { transform: { scale: 0.4, x: 0.25, y: -0.2 }, chroma: { enabled: true, color: "#00ff00", similarity: 0.25 }, opacity: 0.9, flipH: true });
  p = ops.addText(p, { text: "Cutroom سلام", start: 0.2, duration: 2, style: { color: "#ffd400", strokeWidth: 4 } }).project;
  const t = p.clips.find((c) => c.text);
  p = ops.setClip(p, t.id, { animIn: { type: "slide-up", duration: 0.4 }, animOut: { type: "fade", duration: 0.3 } });
  p = ops.addBleep(p, 1.2, 1.5);

  const plan = buildRenderPlan(p, { tmpDir: OUT });
  assert.match(plan.graph, /xfade=transition=slideleft/);
  assert.match(plan.graph, /acrossfade/);
  assert.match(plan.graph, /drawtext=/);
  assert.match(plan.graph, /chromakey=/);
  assert.match(plan.graph, /deshake=/);
  assert.match(plan.graph, /rubberband=/);

  const out = await renderProject(p, { outPath: join(OUT, "features.mp4"), codec: "h264", hardware: "cpu", quality: "compact" });
  const m = await probe(out.path);
  assert.ok(Math.abs(m.duration - projectDuration(p)) < 0.15, `duration ${m.duration} vs ${projectDuration(p)}`);
  assert.equal(m.width, 1280);
  for (const [time, name] of [[0.15, "feat-zoomin"], [1.0, "feat-pip"], [3.0, "feat-transition"]]) await renderFrame(p, time, join(OUT, `${name}.jpg`), { previewWidth: 640 });

  const shorts = await renderProject(p, { outPath: join(OUT, "features-shorts.mp4"), preset: "shorts-square", resolution: 720, range: [0, 2], hardware: "cpu" });
  const sm = await probe(shorts.path);
  assert.equal(sm.width, 720);
  assert.equal(sm.height, 1280);

  const snippet = await renderAudio(p, [2, 4], join(OUT, "features-audio.m4a"));
  assert.ok((await probe(snippet)).hasAudio);
});

test("hardware and alternative codecs export", { timeout: 300000 }, async () => {
  const { p } = await base();
  const avail = await availableEncoders();
  for (const codec of ["hevc", "av1", "prores"]) {
    if (!avail[codec]?.length) continue;
    const r = await renderProject(p, { outPath: join(OUT, `codec-${codec}.${codec === "prores" ? "mov" : "mp4"}`), codec, range: [0, 1.5], resolution: codec === "prores" ? 720 : 1080 });
    assert.ok(existsSync(r.path), codec);
  }
});

test("reverse, freeze frame, filmstrip, beats, caption lines", { timeout: 120000 }, async () => {
  let { p, a } = await base();
  const c1 = [...p.clips].sort((x, y) => x.start - y.start)[0];
  const rev = await makeReversed(a, c1.in, c1.out);
  assert.ok(Math.abs(rev.duration - 3) < 0.2, `reversed ${rev.duration}`);
  const r = ops.addMedia(p, rev);
  p = ops.replaceClipMedia(r.project, c1.id, r.media.id, { in: 0, out: rev.duration });
  const still = await extractFrame(a, 1);
  const s = ops.addMedia(p, still);
  const before = projectDuration(s.project);
  p = ops.insertFreeze(s.project, c1.id, 1, s.media.id, 2);
  assert.ok(Math.abs(projectDuration(p) - before - 2) < 0.05);
  const strip = await filmstrip(a);
  assert.ok(existsSync(strip.image) && strip.count > 0);
  const beats = detectBeats({ perSecond: 100, peaks: Array.from({ length: 400 }, (_, i) => (i % 50 < 3 ? 220 : 20)) });
  assert.ok(beats.length >= 7 && beats.length <= 8, `beats ${beats.length}`);
  // Caption mapping follows clips that play the media: words in the trimmed-away
  // part (source 3 s onward) are dropped.
  const fresh = await base();
  const lines = captionLines(fresh.p, fresh.a.id, [{ start: 0, end: 4, text: "x", words: [{ start: 0.1, end: 0.4, word: "hello" }, { start: 0.5, end: 0.9, word: "there" }, { start: 3.2, end: 3.5, word: "gone" }] }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "hello there");
});
