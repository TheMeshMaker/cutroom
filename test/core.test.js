import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { importCapcutDraft } from "../core/capcut-import.js";
import { clipEnd, createProject, projectDuration, transformAt } from "../core/model.js";
import * as ops from "../core/ops.js";
import { renderFrame, renderProject } from "../node/exporter.js";
import { detectSilence, probe } from "../node/media.js";
import { A, B, ensureMedia, OUT } from "./fixtures.js";

before(ensureMedia);

async function build() {
  let p = createProject({ name: "test", canvas: "720p" });
  let r = ops.addMedia(p, await probe(A));
  p = r.project;
  const a = r.media;
  r = ops.addMedia(p, await probe(B));
  p = r.project;
  const b = r.media;
  ({ project: p } = ops.addClip(p, { mediaId: a.id }));
  ({ project: p } = ops.addClip(p, { mediaId: b.id }));
  return { p, a, b };
}

test("probe reads duration and streams", async () => {
  const m = await probe(A);
  assert.ok(Math.abs(m.duration - 8) < 0.1, `duration ${m.duration}`);
  assert.equal(m.hasVideo, true);
  assert.equal(m.hasAudio, true);
  assert.equal(m.width, 1280);
});

test("edit operations keep the timeline consistent", async () => {
  let { p } = await build();
  assert.equal(p.clips.length, 2);
  assert.ok(Math.abs(projectDuration(p) - 12) < 0.1);

  p = ops.splitAt(p, 2);
  assert.equal(p.clips.length, 3);

  // Cut 3..6 everywhere: the silent stretch of clip a.
  p = ops.removeRanges(p, [[3, 6]]);
  assert.ok(Math.abs(projectDuration(p) - 9) < 0.1, `duration ${projectDuration(p)}`);
  const sorted = [...p.clips].sort((x, y) => x.start - y.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(Math.abs(sorted[i].start - clipEnd(sorted[i - 1])) < 1e-6, "no gaps after ripple cut");

  const last = sorted[sorted.length - 1];
  p = ops.punchIn(p, last.id, last.start + 0.5, { scale: 1.5, hold: 1 });
  const k = p.clips.find((c) => c.id === last.id);
  assert.equal(k.keyframes.length, 4);
  assert.ok(Math.abs(transformAt(k, 1.0).scale - 1.5) < 1e-6);
  assert.ok(Math.abs(transformAt(k, 0.0).scale - 1) < 1e-6);

  p = ops.addBleep(p, 1, 1.5);
  p = ops.deleteClips(p, [sorted[0].id], { ripple: true });
  assert.ok(Math.abs(Math.min(...p.clips.map((c) => c.start))) < 1e-6, "ripple delete closes the gap");
});

test("silence detection finds the quiet stretch", async () => {
  const ranges = await detectSilence(await probe(A), { noise: -40, minDuration: 1 });
  assert.equal(ranges.length, 1);
  assert.ok(Math.abs(ranges[0][0] - 3) < 0.2 && Math.abs(ranges[0][1] - 6) < 0.2, JSON.stringify(ranges));
});

test("renders landscape, shorts and a frame", { timeout: 180000 }, async () => {
  let { p } = await build();
  const v = p.clips.find((c) => c.start === 0);
  p = ops.punchIn(p, v.id, 1, { scale: 1.4, x: 0.1, hold: 1 });
  p = ops.setClip(p, v.id, { fadeIn: 0.5 });
  p = ops.addBleep(p, 2, 2.5);
  p = ops.removeRanges(p, [[3, 6]]);

  const land = await renderProject(p, { outPath: join(OUT, "landscape.mp4") });
  const lm = await probe(land.path);
  assert.ok(Math.abs(lm.duration - 9) < 0.15, `landscape duration ${lm.duration}`);
  assert.equal(lm.width, 1280);
  assert.equal(lm.height, 720);
  assert.equal(lm.hasAudio, true);

  const sh = await renderProject(p, { outPath: join(OUT, "shorts.mp4"), preset: "shorts-square", range: [0, 3] });
  const sm = await probe(sh.path);
  assert.equal(sm.width, 1080);
  assert.equal(sm.height, 1920);
  assert.ok(Math.abs(sm.duration - 3) < 0.15, `shorts duration ${sm.duration}`);

  const png = await renderFrame(p, 1.5, join(OUT, "frame.png"));
  assert.ok(existsSync(png));
});

test("imports a CapCut-style draft", () => {
  const US = 1e6;
  const draft = {
    name: "cc",
    fps: 30,
    canvas_config: { width: 1920, height: 1080 },
    materials: {
      videos: [{ id: "V", type: "video", path: A, duration: 8 * US, width: 1280, height: 720, has_audio: true }],
      audios: [{ id: "AU", type: "extract_music", path: B, duration: 4 * US }],
      audio_fades: [{ id: "F", type: "audio_fade", fade_in_duration: 0.5 * US, fade_out_duration: 0 }],
    },
    tracks: [
      {
        type: "video",
        segments: [
          {
            id: "s1", material_id: "V", target_timerange: { start: 0, duration: 2 * US }, source_timerange: { start: 1 * US, duration: 2 * US },
            speed: 1, volume: 0.5, clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
            common_keyframes: [
              { property_type: "KFTypeScaleX", keyframe_list: [{ time_offset: 0, curveType: "Line", values: [1] }, { time_offset: 1 * US, curveType: "Line", values: [1.3] }] },
            ],
          },
        ],
      },
      { type: "audio", segments: [{ id: "s2", material_id: "AU", target_timerange: { start: 0, duration: 4 * US }, source_timerange: { start: 0, duration: 4 * US }, volume: 1, extra_material_refs: ["F"] }] },
      { type: "text", segments: [{ id: "t" }] },
    ],
  };
  const { project, warnings } = importCapcutDraft(draft);
  assert.equal(project.clips.length, 2);
  const v = project.clips.find((c) => c.in === 1);
  assert.equal(v.volume, 0.5);
  assert.equal(v.keyframes.length, 2);
  assert.ok(Math.abs(v.keyframes[1].scale - 1.3) < 1e-6);
  assert.equal(project.clips.find((c) => c.fadeIn === 0.5)?.fadeIn, 0.5);
  assert.ok(warnings.some((w) => w.includes("text")));
});
