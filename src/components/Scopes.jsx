import { useEffect, useRef, useState } from "react";
import { videoLayers } from "../../core/model.js";
import { loadImage } from "../colorTools.js";
import { useEditor } from "../editor.js";
import { mediaElements, playing, stillFrame, useStore } from "../state.js";

const KINDS = [
  ["waveform", "Waveform"],
  ["parade", "Parade"],
  ["vector", "Vectorscope"],
  ["histogram", "Histogram"],
];
const SW = 240; // analysis width

// Video scopes. Paused: the exact export frame; playing: the live preview.
export default function Scopes() {
  const { project } = useEditor();
  const [kind, setKind] = useState("waveform");
  const canvas = useRef(null);
  const work = useRef(null);
  const still = useStore(stillFrame);
  const isPlaying = useStore(playing);

  const draw = (source, w, h) => {
    if (!work.current) work.current = document.createElement("canvas");
    const wc = work.current;
    const sh = Math.max(1, Math.round((h * SW) / w));
    wc.width = SW;
    wc.height = sh;
    const ctx = wc.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, SW, sh);
    render(canvas.current, ctx.getImageData(0, 0, SW, sh), kind);
  };

  // Paused: analyze the exact still.
  useEffect(() => {
    if (isPlaying || !still) return;
    let alive = true;
    loadImage(still)
      .then((img) => alive && draw(img, img.naturalWidth, img.naturalHeight))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [still, isPlaying, kind]);

  // Playing: sample the top visible video element a few times a second.
  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => {
      for (const track of [...videoLayers(project)].reverse()) {
        const el = mediaElements.get(track.id);
        if (el && el.style.visibility === "visible" && el.videoWidth) {
          try {
            draw(el, el.videoWidth, el.videoHeight);
          } catch {
            // frame not readable yet
          }
          return;
        }
      }
    }, 120);
    return () => clearInterval(timer);
  }, [isPlaying, project, kind]);

  return (
    <div className="scopes">
      <div className="seg scope-tabs">
        {KINDS.map(([k, l]) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
            {l}
          </button>
        ))}
      </div>
      <canvas ref={canvas} className={`scope-canvas ${kind}`} width={kind === "vector" ? 300 : 512} height={kind === "vector" ? 300 : 256} />
      {!still && !isPlaying && <div className="muted small scope-empty">Scopes appear once a frame is shown (pause with Exact on, or play).</div>}
    </div>
  );
}

function render(canvas, img, kind) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, W, H);
  const { data, width, height } = img;
  const out = ctx.createImageData(W, H);
  const add = (x, y, r, g, b, k = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (Math.floor(y) * W + Math.floor(x)) * 4;
    out.data[i] = Math.min(255, out.data[i] + r * k);
    out.data[i + 1] = Math.min(255, out.data[i + 1] + g * k);
    out.data[i + 2] = Math.min(255, out.data[i + 2] + b * k);
    out.data[i + 3] = 255;
  };
  const gain = Math.max(2, Math.round((80 * 256 * W) / (width * height * 4)));
  if (kind === "waveform" || kind === "parade") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (kind === "waveform") {
          const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          add((x / width) * W, H - 1 - (Y / 255) * (H - 1), 40, 70, 40, gain / 6);
        } else {
          const third = W / 3;
          const px = (x / width) * third;
          add(px, H - 1 - (r / 255) * (H - 1), 90, 10, 10, gain / 6);
          add(third + px, H - 1 - (g / 255) * (H - 1), 10, 90, 10, gain / 6);
          add(2 * third + px, H - 1 - (b / 255) * (H - 1), 10, 30, 110, gain / 6);
        }
      }
    }
  } else if (kind === "vector") {
    const c = W / 2;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
      const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
      add(c + cb * W * 0.9, c - cr * H * 0.9, 50 + r * 120, 50 + g * 120, 50 + b * 120, gain / 30);
    }
  } else {
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      hr[data[i]]++;
      hg[data[i + 1]]++;
      hb[data[i + 2]]++;
    }
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, hr[i], hg[i], hb[i]);
    for (let i = 0; i < 256; i++) {
      const x = Math.floor((i / 255) * (W - 1));
      for (const [h, col] of [[hr, [120, 20, 20]], [hg, [20, 120, 20]], [hb, [20, 40, 140]]]) {
        const top = H - Math.min(H, (h[i] / max) * H);
        for (let y = H - 1; y >= top; y--) for (let dx = 0; dx < 2; dx++) add(x + dx, y, ...col, 1);
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  // Graticule
  ctx.strokeStyle = "#ffffff22";
  ctx.lineWidth = 1;
  if (kind === "vector") {
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W * 0.45, 0, Math.PI * 2);
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    // skin tone line (~123 degrees)
    ctx.strokeStyle = "#f2b33d55";
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(W / 2 - Math.cos(0.58) * W * 0.45, H / 2 - Math.sin(0.58) * H * 0.45);
    ctx.stroke();
  } else {
    for (const v of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, H * v);
      ctx.lineTo(W, H * v);
      ctx.stroke();
    }
  }
}
