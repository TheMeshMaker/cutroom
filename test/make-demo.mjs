// Builds test/out/demo.cutroom.json from the media the core tests generate.
// Usage: node test/make-demo.mjs   (run `npm test` first)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../core/model.js";
import * as ops from "../core/ops.js";
import { probe } from "../node/media.js";
import { saveProject } from "../node/store.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "out");
let p = createProject({ name: "Demo edit", canvas: "1080p" });
for (const f of ["a.mp4", "b.mp4"]) {
  const r = ops.addMedia(p, await probe(join(out, f)));
  p = ops.addClip(r.project, { mediaId: r.media.id }).project;
}
const first = p.clips[0];
p = ops.punchIn(p, first.id, 1, { scale: 1.4, hold: 1.5 });
p = ops.addBleep(p, 2.2, 2.7);
p = ops.addMarker(p, 3.2, { end: 5.8, label: "pause", color: "pause" });
const path = join(out, "demo.cutroom.json");
saveProject(path, p);
console.log(path);
