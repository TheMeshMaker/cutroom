// Builds test/out/demo.cutroom.json from the generated test media.
// Usage: node test/make-demo.mjs
import { join } from "node:path";
import { createProject } from "../core/model.js";
import * as ops from "../core/ops.js";
import { probe } from "../node/media.js";
import { saveProject } from "../node/store.js";
import { A, B, ensureMedia, GREEN, OUT } from "./fixtures.js";

await ensureMedia();
let p = createProject({ name: "Demo edit", canvas: "1080p" });
const ids = [];
for (const f of [A, B, GREEN]) {
  const r = ops.addMedia(p, await probe(f));
  p = r.project;
  ids.push(r.media.id);
}
p = ops.addClip(p, { mediaId: ids[0] }).project;
p = ops.addClip(p, { mediaId: ids[1] }).project;
const [first, second] = [...p.clips].sort((a, b) => a.start - b.start);
p = ops.punchIn(p, first.id, 1, { scale: 1.4, hold: 1.5 });
p = ops.setClip(p, first.id, { filter: { id: "cinematic", intensity: 80 }, effects: [{ id: "grain", intensity: 40 }] });
p = ops.setTransition(p, second.id, { type: "dissolve", duration: 0.6 });
p = ops.setClip(p, second.id, { speed: 1.5, animOut: { type: "fade", duration: 0.5 } });
const { project: withTrack, track } = ops.addTrack(p, "video");
p = ops.addClip(withTrack, { mediaId: ids[2], trackId: track.id, start: 4, in: 0, out: 3 }).project;
const pip = p.clips.find((c) => c.mediaId === ids[2]);
p = ops.setClip(p, pip.id, { transform: { scale: 0.35, x: 0.3, y: -0.28 }, chroma: { enabled: true } });
p = ops.addText(p, { text: "Cutroom", start: 0.5, duration: 3, style: { size: 96, strokeWidth: 5 } }).project;
p = ops.addBleep(p, 2.2, 2.7);
p = ops.addMarker(p, 3.2, { end: 5.8, label: "pause", color: "pause" });
const path = join(OUT, "demo.cutroom.json");
saveProject(path, p);
console.log(path);
