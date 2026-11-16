// Multi-step edits shared by the native app and the MCP server (engine/flows.js).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { createFlows } from "../engine/flows.js";
import { createProject } from "../core/model.js";
import * as ops from "../core/ops.js";
import { python } from "../node/captions.js";
import { renderFrame } from "../node/exporter.js";
import { nodeHost } from "../node/host.js";
import { FFMPEG, media, probe, run } from "../node/media.js";
import { A, ensureMedia, OUT } from "./fixtures.js";

before(ensureMedia);
const flows = createFlows(nodeHost, media, python, { renderFrame });

async function oneClip() {
  const r = ops.addMedia(createProject({ canvas: "720p" }), await probe(A));
  const p = ops.addClip(r.project, { mediaId: r.media.id, in: 0, out: 4 }).project;
  return { p, clip: p.clips[0] };
}

test("freeze frame and reverse", { timeout: 120000 }, async () => {
  const { p, clip } = await oneClip();
  const frozen = await flows.freeze(p, clip.id, 1, { duration: 2 });
  const still = frozen.media.find((m) => m.kind === "image");
  assert.ok(still, "the frame becomes an image");
  assert.equal(frozen.clips.filter((c) => c.mediaId === still.id).length, 1);

  const reversed = await flows.reverse(p, clip.id);
  const now = reversed.clips.find((c) => c.id === clip.id);
  assert.notEqual(now.mediaId, clip.mediaId, "the clip plays a reversed copy");
  assert.ok(Math.abs(reversed.media.find((m) => m.id === now.mediaId).duration - 4) < 0.2);
});

test("subtitles import and save round trip", async () => {
  const { p } = await oneClip();
  const srt = join(OUT, "flows-in.srt");
  writeFileSync(srt, "1\n00:00:00,500 --> 00:00:02,000\nمرحبا\n\n2\n00:00:02,500 --> 00:00:03,500\nHello\n");
  const { project, note } = await flows.importSubtitles(p, srt);
  assert.match(note, /2 captions/);
  const saved = await flows.saveSubtitles(project, join(OUT, "flows-out"));
  assert.ok(saved.path.endsWith(".srt"));
  const text = readFileSync(saved.path, "utf8");
  assert.match(text, /مرحبا/);
  assert.match(text, /00:00:02,500 --> 00:00:03,500/);
  await assert.rejects(flows.saveSubtitles(p, join(OUT, "none.srt")), /No captions/);
});

test("filter and effect thumbnails", { timeout: 180000 }, async () => {
  const { p, clip } = await oneClip();
  const looks = await flows.lookPreviews(p, clip.id, 1, { width: 120 });
  assert.equal(Object.keys(looks.filter).length, 12);
  assert.equal(Object.keys(looks.effect).length, 12);
  assert.ok(Object.values(looks.filter).every(existsSync), "every thumbnail is on disk");
});

test("masks and canvas blur render", { timeout: 120000 }, async () => {
  let { p, clip } = await oneClip();
  p = ops.setCanvas(p, { width: 720, height: 1280 }); // vertical canvas: the clip doesn't fill it
  p = ops.setSettings(p, { background: "blur" });
  for (const type of ["circle", "rectangle", "linear", "mirror"]) {
    const q = ops.setClip(p, clip.id, { mask: { type, w: 0.5, h: 0.5, feather: 0.2, invert: type === "mirror" } });
    const out = await renderFrame(q, 1, join(OUT, `mask-${type}.jpg`));
    assert.ok(existsSync(out), type);
  }
});

test("stickers, beats and text to speech", { timeout: 180000 }, async () => {
  const { p, clip } = await oneClip();
  const withEmoji = await flows.addSticker(p, { emoji: "🔥", start: 1 });
  const sticker = withEmoji.project.clips.find((c) => c.id === withEmoji.clip.id);
  assert.equal(withEmoji.project.tracks.find((t) => t.id === sticker.trackId).name, "Stickers");
  assert.equal(sticker.transform.scale, 0.4);
  const two = await flows.addSticker(withEmoji.project, { shape: "burst", text: "WOW", start: 2 });
  assert.notEqual(two.project.clips.find((c) => c.id === two.clip.id).trackId, sticker.trackId, "overlapping stickers stack on a new track");

  const clicks = join(OUT, "clicks.wav"); // a click every 0.5 s
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.03),sin(2*PI*880*t),0)':d=4", clicks]);
  const m = ops.addMedia(p, await probe(clicks));
  const withClicks = ops.addClip(m.project, { mediaId: m.media.id, start: 0 });
  const beat = await flows.beats(withClicks.project, withClicks.clip.id);
  assert.ok(beat.project.markers.length >= 6 && beat.project.markers.every((x) => x.label === "beat"), `${beat.project.markers.length} beats`);
  await assert.rejects(flows.beats(p, clip.id), /No beats/, "a steady tone has none");

  const voices = await flows.voices();
  if (voices.length) {
    const spoken = await flows.speak(p, { text: "Hello from Cutroom", voice: voices[0].name, start: 0.5 });
    const audio = spoken.project.media.at(-1);
    assert.ok(audio.hasAudio && !audio.hasVideo && audio.duration > 0.3);
  }
});
