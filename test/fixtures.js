// Generated test media shared by the test files (created once, then reused).
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG, run } from "../node/media.js";

export const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
export const A = join(OUT, "a.mp4"); // 8 s bars + tone, silent from 3 s to 6 s
export const B = join(OUT, "b.mp4"); // 4 s HD bars + tone
export const GREEN = join(OUT, "green.mp4"); // 4 s green screen with a red square
export const MUSIC = join(OUT, "music.m4a"); // 6 s audio-only chord
export const OBS = join(OUT, "obs-2track.mkv"); // 3 s 60 fps, audio tracks "Game" (220 Hz) and "Mic" (660 Hz)

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
  await make(MUSIC.replace(/\.m4a$/, ".mp4"), ["-f", "lavfi", "-i", "sine=f=330:d=6", "-f", "lavfi", "-i", "sine=f=495:d=6", "-filter_complex", "amix=inputs=2", "-c:a", "aac", "-vn"]);
  if (!existsSync(MUSIC)) (await import("node:fs")).copyFileSync(MUSIC.replace(/\.m4a$/, ".mp4"), MUSIC);
  await make(OBS, ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=60:d=3", "-f", "lavfi", "-i", "sine=f=220:d=3", "-f", "lavfi", "-i", "sine=f=660:d=3", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-metadata:s:a:0", "title=Game", "-metadata:s:a:1", "title=Mic", "-shortest"]);
  await make(GREEN, ["-f", "lavfi", "-i", "color=c=0x00FF00:s=640x360:r=30:d=4,drawbox=x=220:y=100:w=200:h=160:color=red:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-an"]);
}
