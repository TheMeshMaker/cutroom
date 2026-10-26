// Drives the MCP server through a real stdio client, the way an agent would.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
