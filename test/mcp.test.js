// Drives the MCP server through a real stdio client, the way an agent would.
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as ops from "../core/ops.js";
import { loadProject } from "../node/store.js";
import { ensureMedia, OUT } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(OUT, "mcp.cutroom.json");
let client;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const json = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);

before(async () => {
  await ensureMedia();
  rmSync(PROJECT, { force: true });
  // Isolate the server's "last project" state from the user's real one.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "mcp", "server.mjs")],
    env: { ...process.env, USERPROFILE: join(OUT, "home"), HOME: join(OUT, "home") },
  });
  client = new Client({ name: "cutroom-test", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

test("lists the editing tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["project_status", "media_import", "punch_in", "bleep_add", "ranges_cut", "pauses_find", "capcut_import", "frame_render", "export_video"]) assert.ok(names.includes(n), n);
});

test("agent workflow: import, find pauses, cut, punch-in, bleep, look, export", { timeout: 180000 }, async () => {
  await call("project_create", { path: PROJECT, name: "Agent edit", canvas: "720p" });
  let s = json(await call("media_import", { paths: [join(OUT, "a.mp4"), join(OUT, "b.mp4")], addToTimeline: true }));
  assert.equal(s.project.tracks.find((t) => t.kind === "video").clips.length, 2);

  const pauses = json(await call("pauses_find", { noiseDb: -40, minSeconds: 1, keepSeconds: 0.25 }));
  assert.equal(pauses.count, 1);
  s = json(await call("ranges_cut", { ranges: pauses.ranges }));
  assert.ok(Math.abs(s.project.duration - (12 - pauses.totalSeconds)) < 0.05, `duration ${s.project.duration}`);

  s = json(await call("punch_in", { time: 1, scale: 1.5, hold: 0.8 }));
  const kf = s.project.tracks.flatMap((t) => t.clips).find((c) => c.keyframes);
  assert.equal(kf.keyframes.length, 4);
  s = json(await call("bleep_add", { start: 0.5, end: 0.9 }));
  assert.equal(s.project.bleeps.length, 1);

  const frame = await call("frame_render", { time: 1.3 });
  assert.equal(frame.content[0].type, "image");
  assert.ok(frame.content[0].data.length > 1000);

  const out = join(OUT, "mcp-export.mp4");
  const ex = json(await call("export_video", { outPath: out, range: [0, 2] }));
  assert.ok(existsSync(ex.path));
  assert.ok(Math.abs(ex.durationSeconds - 2) < 0.01);
});

test("agent uses the pro features", { timeout: 180000 }, async () => {
  const cat = json(await call("catalog_list"));
  assert.ok(cat.transitions.length >= 20 && cat.effects.some((e) => e.id === "shake"));
  let s = json(await call("project_status"));
  const main = s.tracks.find((t) => t.kind === "video" && t.layer === 0).clips;
  s = json(await call("clip_set", { clipId: main[0].id, speed: 1.25, filter: { id: "horror" }, effects: [{ id: "vhs" }], animIn: { type: "zoom-in" }, adjust: { contrast: 20 }, audio: { enhance: true, voice: "deep" } }));
  const edited = s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === main[0].id);
  assert.equal(edited.speed, 1.25);
  assert.equal(edited.filter.id, "horror");
  assert.equal(edited.audio.voice, "deep");
  const second = s.project.tracks.find((t) => t.kind === "video" && t.layer === 0).clips[1];
  s = json(await call("transition_set", { clipId: second.id, type: "circle-open", duration: 0.4 }));
  s = json(await call("text_add", { text: "Agent title", start: 0, duration: 1.5, styleId: "yellow" }));
  assert.ok(s.project.tracks.some((t) => t.kind === "text" && t.clips.length === 1));
  const frame = await call("frame_render", { time: 0.8 });
  assert.equal(frame.content[0].type, "image");
  const ex = json(await call("export_video", { outPath: join(OUT, "mcp-pro.mp4"), codec: "hevc", range: [0, 2], resolution: 720 }));
  assert.ok(existsSync(ex.path), JSON.stringify(ex));
});

test("agent uses the Premiere / Resolve tools", { timeout: 180000 }, async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["track_set", "settings_set", "adjustment_add", "roll_edit", "clip_slip", "speed_ramp", "title_add", "source_place", "gaps_close", "scenes_split", "transcript_create", "transcript_words", "words_remove", "backups_list", "backup_restore"]) assert.ok(names.includes(n), n);

  let s = json(await call("project_status"));
  const mainId = s.tracks.find((t) => t.kind === "video" && t.layer === 0).id;
  const [mediaA, mediaB] = s.media;
  const clips = () => s.project.tracks.flatMap((t) => t.clips);
  const onMain = () => s.project.tracks.find((t) => t.id === mainId).clips;

  // Mixer and project loudness.
  s = json(await call("track_set", { trackId: mainId, volume: 0.8, pan: -0.25, role: "dialogue" }));
  const track = s.project.tracks.find((t) => t.id === mainId);
  assert.deepEqual([track.volume, track.pan, track.role], [0.8, -0.25, "dialogue"]);
  s = json(await call("settings_set", { loudness: -14 }));
  assert.equal(s.project.settings.loudness, -14);

  // Color wheels merge: lift y, then lift x, keeps both.
  const first = onMain()[0];
  await call("clip_set", { clipId: first.id, color: { lift: { y: 0.2 } } });
  s = json(await call("clip_set", { clipId: first.id, color: { lift: { x: 0.1 } }, videoDenoise: 30 }));
  const graded = clips().find((c) => c.id === first.id);
  assert.deepEqual(graded.color.lift, { x: 0.1, y: 0.2, l: 0 });
  assert.equal(graded.videoDenoise, 30);

  s = json(await call("adjustment_add", { start: 0, duration: 1 }));
  assert.match(s.note, /Adjustment layer/);
  assert.ok(clips().some((c) => c.adjustment));
  s = json(await call("title_add", { templateId: "lower-third", start: 2, text: "Agent\nlower third" }));
  assert.ok(clips().some((c) => c.text === "Agent\nlower third"));

  // Insert from the source keeps sync: everything moves 1 s right.
  const before = s.project.duration;
  s = json(await call("source_place", { mediaId: mediaB.id, in: 0, out: 1, at: 0, mode: "insert" }));
  assert.ok(Math.abs(s.project.duration - before - 1) < 0.01, `${before} -> ${s.project.duration}`);

  const count = onMain().length;
  s = json(await call("speed_ramp", { clipId: onMain()[0].id, preset: "ramp-up" }));
  assert.equal(onMain().length, count + 5);
  const [l, r] = onMain();
  s = json(await call("roll_edit", { leftClipId: l.id, rightClipId: r.id, delta: 0.05 }));
  assert.ok(Math.abs(onMain()[1].start - (r.start + 0.05)) < 0.002, "the cut moved");
  const piece = onMain()[5];
  s = json(await call("clip_slip", { clipId: piece.id, delta: 0.5 }));
  assert.ok(Math.abs(onMain()[5].in - (piece.in + 0.5)) < 0.002, "the source slipped");
  s = json(await call("gaps_close"));

  // Text-based editing on a transcript placed inside the visible part of a.mp4.
  const proj = loadProject(PROJECT);
  const a = proj.clips.filter((c) => c.mediaId === mediaA.id).sort((m, n) => m.start - n.start)[0];
  const w = a.in + 0.1;
  const words = [{ s: w, e: w + 0.2, w: "okay" }, { s: w + 0.3, e: w + 0.5, w: "um" }, { s: w + 0.6, e: w + 0.8, w: "go" }];
  writeFileSync(PROJECT, JSON.stringify(ops.setTranscript(proj, mediaA.id, { language: "en", words })));
  let t = json(await call("transcript_words", { mediaId: mediaA.id }));
  assert.equal(t.text, "okay um go");
  t = json(await call("transcript_words", { mediaId: mediaA.id, fillersOnly: true }));
  assert.deepEqual(t.words.map((x) => x[3]), ["um"]);
  s = json(await call("words_remove", { mediaId: mediaA.id, fillers: true }));
  assert.match(s.note, /Cut 1 word/);
  t = json(await call("transcript_words", { mediaId: mediaA.id }));
  assert.equal(t.text, "okay go");

  // Selections: label, move together, duplicate.
  const pair = onMain().slice(-2).map((c) => c.id);
  s = json(await call("clip_set", { clipId: pair[0], label: "teal" }));
  assert.equal(clips().find((c) => c.id === pair[0]).label, "teal");
  await call("settings_set", { magnet: false }); // the magnet would close the gap again
  const end = s.project.duration;
  s = json(await call("clips_move", { clipIds: pair, delta: 2 }));
  assert.ok(Math.abs(s.project.duration - end - 2) < 0.01, `${end} -> ${s.project.duration}`);
  s = json(await call("clips_duplicate", { clipIds: pair }));
  assert.match(s.note, /Copies: c_/);

  // Subtitles out, and back in on a Captions track.
  const saved = json(await call("captions_save", { outPath: join(OUT, "mcp-captions.srt") }));
  assert.ok(existsSync(saved.path) && saved.lines >= 1, JSON.stringify(saved));
  s = json(await call("captions_import", { path: saved.path, offset: 0.5 }));
  assert.ok(s.project.tracks.some((t) => t.name === "Captions" && t.clips.length === saved.lines));

  // Automatic backups, and going back to one.
  const { backups } = json(await call("backups_list"));
  assert.ok(backups.length >= 1);
  const restored = json(await call("backup_restore", { file: backups[backups.length - 1].file }));
  assert.equal(restored.name, "Agent edit");
  assert.ok(json(await call("backups_list")).backups.some((b) => b.file.includes("before-restore")));
});
