// Generated test media shared by the test files (created once, then reused).
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG, run } from "../node/media.js";

export const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
export const A = join(OUT, "a.mp4"); // 8 s bars + tone, silent from 3 s to 6 s
export const B = join(OUT, "b.mp4"); // 4 s HD bars + tone
export const GREEN = join(OUT, "green.mp4"); // 4 s green screen with a red square

async function make(path, args) {
  if (existsSync(path)) return;
  const tmp = path.replace(/\.mp4$/, `.${process.pid}.tmp.mp4`);
  const { code, stderr } = await run(FFMPEG, ["-y", ...args, tmp]);
  if (code !== 0) throw new Error(stderr);
  const { renameSync } = await import("node:fs");
  if (!existsSync(path)) renameSync(tmp, path);
}

export async function ensureMedia() {
  mkdirSync(OUT, { recursive: true });
  await make(A, ["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-af", "volume=enable='between(t,3,6)':volume=0", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest"]);
  await make(B, ["-f", "lavfi", "-i", "smptehdbars=s=1920x1080:r=30:d=4", "-f", "lavfi", "-i", "sine=f=880:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest"]);
  await make(GREEN, ["-f", "lavfi", "-i", "color=c=0x00FF00:s=640x360:r=30:d=4,drawbox=x=220:y=100:w=200:h=160:color=red:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-an"]);
}
