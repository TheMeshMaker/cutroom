// Auto color and shot matching from frame statistics. Results are ordinary
// adjustment values, so they stay editable (and undoable) afterwards.
import { clipLength } from "../core/model.js";
import { api, mediaUrl } from "./state.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read the frame"));
    img.src = url;
  });
}

export function pixelsOf(img, width = 320) {
  const h = Math.max(1, Math.round((img.naturalHeight * width) / img.naturalWidth));
  const c = document.createElement("canvas");
  c.width = width;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, h);
  return ctx.getImageData(0, 0, width, h);
}

// Mean RGB, luma mean/std/percentiles and mean saturation of an image.
export function statsOf({ data }) {
  let r = 0, g = 0, b = 0, y = 0, y2 = 0, sat = 0, n = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] / 255, G = data[i + 1] / 255, B = data[i + 2] / 255;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    r += R; g += G; b += B; y += Y; y2 += Y * Y;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    sat += mx > 0 ? (mx - mn) / mx : 0;
    hist[Math.round(Y * 255)]++;
    n++;
  }
  const pct = (q) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) if ((acc += hist[i]) >= q * n) return i / 255;
    return 1;
  };
  const mean = y / n;
  return { r: r / n, g: g / n, b: b / n, mean, std: Math.sqrt(Math.max(0, y2 / n - mean * mean)), sat: sat / n, p2: pct(0.02), p98: pct(0.98) };
}

async function clipStats(project, clip) {
  const file = await api.previewFrame(project, clip.start + clipLength(clip) / 2, 320);
  return statsOf(pixelsOf(await loadImage(`${mediaUrl(file)}?v=${Date.now()}`)));
}

// Balance exposure, contrast and white balance (gray world).
export async function autoColor(project, clip) {
  const s = await clipStats(project, clip);
  const a = { ...clip.adjust };
  const m = Math.max(0.05, s.mean);
  a.exposure = clamp(a.exposure + ((0.46 - s.mean) / 0.46) * 70, -80, 80);
  a.contrast = clamp(a.contrast + (0.85 - (s.p98 - s.p2)) * 70, -40, 50);
  a.temperature = clamp(a.temperature + ((s.b - s.r) / m) * 60, -60, 60);
  a.tint = clamp(a.tint + ((s.g - (s.r + s.b) / 2) / m) * 80, -50, 50);
  return roundAll(a);
}

// Move this clip's look toward a reference clip's.
export async function matchColor(project, clip, ref) {
  if (!ref) throw new Error("Pick a reference clip");
  const [s, t] = await Promise.all([clipStats(project, clip), clipStats(project, ref)]);
  const a = { ...clip.adjust };
  const m = Math.max(0.05, s.mean);
  a.exposure = clamp(a.exposure + ((t.mean - s.mean) / m) * 60, -80, 80);
  a.contrast = clamp(a.contrast + (t.std / Math.max(0.02, s.std) - 1) * 60, -60, 60);
  a.temperature = clamp(a.temperature + (((s.b - s.r) - (t.b - t.r)) / m) * 60, -70, 70);
  a.tint = clamp(a.tint + (((s.g - (s.r + s.b) / 2) - (t.g - (t.r + t.b) / 2)) / m) * 80, -60, 60);
  a.saturation = clamp(a.saturation + ((t.sat - s.sat) / Math.max(0.05, s.sat)) * 60, -100, 100);
  return roundAll(a);
}

const roundAll = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Math.round(v)]));
