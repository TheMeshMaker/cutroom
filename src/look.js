// Live-preview approximations of color work (CSS filters). Paused frames use
// the exact FFmpeg render instead, so these only need to feel right in motion.
import { effectiveAdjust } from "../core/model.js";

export function cssFilter(clip) {
  const a = effectiveAdjust(clip);
  const parts = [];
  const bright = 1 + (a.brightness / 100) * 0.25 + (a.exposure / 100) * 0.6;
  if (Math.abs(bright - 1) > 0.001) parts.push(`brightness(${bright.toFixed(3)})`);
  if (a.contrast) parts.push(`contrast(${(1 + (a.contrast / 100) * 0.6).toFixed(3)})`);
  if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100).toFixed(3)})`);
  if (a.temperature > 0) parts.push(`sepia(${((a.temperature / 100) * 0.35).toFixed(3)})`);
  if (a.temperature < 0) parts.push(`hue-rotate(${((a.temperature / 100) * 14).toFixed(1)}deg)`);
  if (a.tint) parts.push(`hue-rotate(${((a.tint / 100) * -10).toFixed(1)}deg)`);
  if (a.fade) parts.push(`contrast(${(1 - (a.fade / 100) * 0.25).toFixed(3)})`);
  if (clip.filter?.id === "sepia") parts.push(`sepia(${(clip.filter.intensity / 100).toFixed(2)})`);
  for (const fx of clip.effects) {
    const i = fx.intensity / 100;
    if (fx.id === "blur") parts.push(`blur(${(1 + 8 * i).toFixed(1)}px)`);
    if (fx.id === "bw") parts.push("grayscale(1)");
    if (fx.id === "invert") parts.push("invert(1)");
    if (fx.id === "glow") parts.push(`brightness(${(1 + 0.2 * i).toFixed(2)}) saturate(${(1 + 0.2 * i).toFixed(2)})`);
  }
  return parts.join(" ");
}

export const vignetteOf = (clip) => effectiveAdjust(clip).vignette / 100;

// Flips + crop as CSS on the media element (crop is in canvas space).
export function cropPath(clip) {
  const { l, t, r, b } = clip.crop;
  return l + t + r + b > 0 ? `inset(${t * 100}% ${r * 100}% ${b * 100}% ${l * 100}%)` : "none";
}
