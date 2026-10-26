// Draws build/icon.png (512x512): a rounded teal-to-violet tile with a white
// play triangle split by a diagonal cut. Rendered with 4x4 supersampling and
// encoded to PNG by ffmpeg.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const S = 512;
const SS = 4;
const px = Buffer.alloc(S * S * 4);
const lerp = (a, b, t) => a + (b - a) * t;
const teal = [24, 197, 211];
const violet = [124, 92, 255];

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const side = (ax, ay, bx, by, x, y) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
const inTri = (x, y) => {
  const [a, b, c] = [[200, 150], [200, 362], [372, 256]];
  const d1 = side(...a, ...b, x, y);
  const d2 = side(...b, ...c, x, y);
  const d3 = side(...c, ...a, x, y);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
// The cut: a 16px band along the line from (150,330) to (390,190).
const inCut = (x, y) => Math.abs(side(150, 330, 390, 190, x, y)) / Math.hypot(240, -140) < 9;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (!inRoundRect(fx, fy, 24, 24, 488, 488, 104)) continue;
        const t = (fx + fy) / (2 * S);
        let c = [lerp(teal[0], violet[0], t), lerp(teal[1], violet[1], t), lerp(teal[2], violet[2], t)];
        if (inTri(fx, fy) && !inCut(fx, fy)) c = [255, 255, 255];
        r += c[0];
        g += c[1];
        b += c[2];
        a += 255;
      }
    }
    const n = SS * SS;
    const i = (y * S + x) * 4;
    const cov = a / 255;
    px[i] = cov ? r / cov : 0;
    px[i + 1] = cov ? g / cov : 0;
    px[i + 2] = cov ? b / cov : 0;
    px[i + 3] = a / n;
  }
}

mkdirSync(new URL("../build/", import.meta.url), { recursive: true });
const out = new URL("../build/icon.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const r = spawnSync(process.env.CUTROOM_FFMPEG || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${S}x${S}`, "-i", "-", "-frames:v", "1", out], { input: px });
if (r.status !== 0) throw new Error(r.stderr?.toString());
console.log(out);
