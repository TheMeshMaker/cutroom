// FFmpeg media helpers for Node (MCP server, tests); the logic is in
// engine/media.js and shared with the desktop app.

import { createMedia } from "../engine/media.js";
import { nodeHost, run } from "./host.js";

export { run };
export const FFMPEG = nodeHost.ffmpeg;
export const FFPROBE = nodeHost.ffprobe;
export const CACHE_DIR = nodeHost.cacheDir;
export const media = createMedia(nodeHost);
export const { probe, ensureProxy, waveform, filmstrip, makeReversed, extractFrame, splitAudioTracks, detectScenes, detectSilence } = media;
