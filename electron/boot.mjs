// Entry point. In a packaged build, point Cutroom at the bundled FFmpeg
// (resources/ffmpeg) before the main process loads the media helpers, which
// read CUTROOM_FFMPEG / CUTROOM_FFPROBE when they are imported. An explicit
// environment setting always wins.
import { existsSync } from "node:fs";
import { join } from "node:path";

const bundled = process.resourcesPath ? join(process.resourcesPath, "ffmpeg") : null;
if (bundled && existsSync(join(bundled, "ffmpeg.exe"))) {
  process.env.CUTROOM_FFMPEG ??= join(bundled, "ffmpeg.exe");
  process.env.CUTROOM_FFPROBE ??= join(bundled, "ffprobe.exe");
}

await import("./main.mjs");
