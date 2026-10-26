import { useEffect, useRef, useState } from "react";
import { ADJUST_KEYS, FILTERS } from "../../core/catalog.js";
import { DEFAULT_CURVE, clipById, clipLength, formatTime, hasMedia, mediaById } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { wheelRgb } from "../../core/render.js";
import { EMPTY_SELECTION, useEditor } from "../editor.js";
import { api, gradeBypass, playhead, useStore } from "../state.js";
import Icon from "./icons.jsx";
import { Thumb } from "./Library.jsx";
import Player from "./Player.jsx";
import Scopes from "./Scopes.jsx";

const ZERO = { x: 0, y: 0, l: 0 };

export default function ColorPage() {
  const ed = useEditor();
  const { project, selection, setSelection, apply, strips, actions } = ed;
  const bypass = useStore(gradeBypass);
  const [target] = ed.targetClips(["video"]);
  const clip = target && (hasMedia(target) || target.adjustment) ? target : null;
  const video = project.clips.filter((c) => (hasMedia(c) && mediaById(project, c.mediaId)?.hasVideo) || c.adjustment).sort((a, b) => a.start - b.start);
  const [refId, setRefId] = useState("");
  const set = (patch, key) => clip && apply((p) => ops.setClip(p, clip.id, patch), key ? { coalesce: `${key}-${clip.id}` } : undefined);
  const setWheel = (name, v, final) => set({ color: { [name]: v } }, final ? undefined : `wheel-${name}`);

  return (
    <div className="color-page">
      <div className="color-top">
        <Player />
        <section className="panel scopes-panel">
          <div className="panel-head">
            <span>Scopes</span>
          </div>
          <Scopes />
        </section>
      </div>
      <div className="clip-strip">
        {video.map((c, i) => (
          <button
            key={c.id}
            className={`strip-clip ${clip?.id === c.id ? "active" : ""} ${selection.clips.includes(c.id) ? "picked" : ""}`}
            onClick={(e) => {
              if (e.shiftKey || e.ctrlKey) return setSelection((s) => ({ ...EMPTY_SELECTION, clips: s.clips.includes(c.id) ? s.clips.filter((x) => x !== c.id) : [...s.clips, c.id] }));
              setSelection({ ...EMPTY_SELECTION, clips: [c.id] });
              playhead.set(c.start + Math.min(clipLength(c) / 2, 1));
            }}
            title={c.adjustment ? "Adjustment layer" : mediaById(project, c.mediaId)?.name}
          >
            {c.adjustment ? <div className="thumb adj-thumb">ADJ</div> : <Thumb media={mediaById(project, c.mediaId)} strips={strips} at={c.in + (c.out - c.in) / 2} />}
            <span>
              {String(i + 1).padStart(2, "0")} · {formatTime(c.start, project.canvas.fps).replace(/:\d\d$/, "")}
            </span>
            {(c.filter || Object.values(c.adjust).some(Boolean) || ["lift", "gamma", "gain", "offset"].some((w) => c.color[w].x || c.color[w].y || c.color[w].l)) && <i className="graded" />}
          </button>
        ))}
      </div>
      {!clip ? (
        <div className="color-empty muted">Select a clip (or move the playhead over one) to grade it.</div>
      ) : (
        <div className="color-bottom">
          <section className="panel wheels-panel">
            <div className="panel-head">
              <span>Primaries · Color wheels</span>
              <button className="link" onClick={() => set({ color: { lift: ZERO, gamma: ZERO, gain: ZERO, offset: ZERO } })}>
                Reset wheels
              </button>
            </div>
            <div className="wheels">
              {[["lift", "Lift"], ["gamma", "Gamma"], ["gain", "Gain"], ["offset", "Offset"]].map(([k, label]) => (
                <Wheel key={`${clip.id}-${k}`} label={label} value={clip.color[k]} onChange={(v, final) => setWheel(k, v, final)} />
              ))}
            </div>
          </section>
          <section className="panel curves-panel">
            <div className="panel-head">
              <span>Curve</span>
              <button className="link" onClick={() => set({ color: { curve: DEFAULT_CURVE } })}>
                Reset
              </button>
            </div>
            <CurveEditor key={clip.id} points={clip.color.curve} onChange={(pts, final) => set({ color: { curve: pts } }, final ? undefined : "curve")} />
          </section>
          <section className="panel basic-panel">
            <div className="panel-head">
              <span>Basic</span>
              <button className="link" onClick={() => set({ adjust: Object.fromEntries(Object.keys(ADJUST_KEYS).map((k) => [k, 0])), filter: null, lut: null, color: { lift: ZERO, gamma: ZERO, gain: ZERO, offset: ZERO, curve: DEFAULT_CURVE } })}>
                Reset grade
              </button>
            </div>
            <div className="panel-body">
              <div className="button-row wrap">
                <button className={`small ${bypass === clip.id ? "active" : ""}`} onClick={actions.toggleBypass} title="Compare with the grade switched off">
                  <Icon name="compare" size={14} /> {bypass === clip.id ? "Showing before" : "Before / after"}
                </button>
                <button className="small" onClick={actions.copyGrade} title="Copy this clip's grade">
                  <Icon name="copy" size={14} /> Copy grade
                </button>
                <button className="small" onClick={actions.pasteGrade} title="Paste the copied grade on the selected clips (Shift/Ctrl-click clips in the strip)">
                  <Icon name="paste" size={14} /> Paste
                </button>
              </div>
              <div className="button-row">
                <button className="primary small" onClick={actions.autoColor}>
                  <Icon name="wand" size={14} /> Auto color
                </button>
                <select value={refId} onChange={(e) => setRefId(e.target.value)} title="Reference clip for matching">
                  <option value="">Match to clip…</option>
                  {video.filter((c) => c.id !== clip.id && !c.adjustment).map((c, i) => (
                    <option key={c.id} value={c.id}>
                      Clip at {formatTime(c.start, project.canvas.fps).replace(/:\d\d$/, "")}
                    </option>
                  ))}
                </select>
                <button className="small" disabled={!refId} onClick={() => actions.matchColor(refId)}>
                  Match
                </button>
              </div>
              {["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "vignette"].map((k) => {
                const [lo, hi] = ADJUST_KEYS[k];
                return (
                  <div key={k} className="slider-row">
                    <span className="sr-label">{k[0].toUpperCase() + k.slice(1)}</span>
                    <input type="range" min={lo} max={hi} value={clip.adjust[k]} onChange={(e) => set({ adjust: { [k]: Number(e.target.value) } }, `adj-${k}`)} onDoubleClick={() => set({ adjust: { [k]: 0 } })} />
                    <span className="value">{clip.adjust[k]}</span>
                    <span />
                  </div>
                );
              })}
              <div className="row-2">
                <select value={clip.filter?.id ?? ""} onChange={(e) => set({ filter: e.target.value ? { id: e.target.value, intensity: clip.filter?.intensity ?? 100 } : null })}>
                  <option value="">Look: none</option>
                  {FILTERS.map((f) => <option key={f.id} value={f.id}>Look: {f.name}</option>)}
                </select>
                <input type="range" min="0" max="100" disabled={!clip.filter} value={clip.filter?.intensity ?? 100} onChange={(e) => set({ filter: { ...clip.filter, intensity: Number(e.target.value) } }, "look")} title="Look intensity" />
              </div>
              <button className="small" onClick={async () => {
                const file = await api.chooseLut().catch(() => null);
                if (file) set({ lut: file });
              }}>
                {clip.lut ? `LUT: ${clip.lut.split(/[\\/]/).pop()}` : "Import .cube LUT…"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// A color wheel: drag the puck to push color into a tonal range; the slider
// under it sets that range's brightness. Double-click resets.
function Wheel({ label, value, onChange }) {
  const ref = useRef(null);
  const bg = useRef(null);
  const R = 62;
  useEffect(() => {
    const c = bg.current;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(2 * R, 2 * R);
    for (let y = 0; y < 2 * R; y++) {
      for (let x = 0; x < 2 * R; x++) {
        const dx = (x - R) / R;
        const dy = (R - y) / R;
        const d = Math.hypot(dx, dy);
        const i = (y * 2 * R + x) * 4;
        if (d > 1) continue;
        const rgb = wheelRgb({ x: dx, y: dy });
        const m = Math.max(Math.abs(rgb.r), Math.abs(rgb.g), Math.abs(rgb.b), 1e-6);
        const k = Math.min(1, d) * 0.55;
        img.data[i] = 128 + (rgb.r / m) * 127 * k;
        img.data[i + 1] = 128 + (rgb.g / m) * 127 * k;
        img.data[i + 2] = 128 + (rgb.b / m) * 127 * k;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);
  const drag = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const move = (ev, final = false) => {
      let x = (ev.clientX - rect.left - R) / R;
      let y = (R - (ev.clientY - rect.top)) / R;
      const d = Math.hypot(x, y);
      if (d > 1) {
        x /= d;
        y /= d;
      }
      // Fine control: the puck moves at half speed near the center.
      onChange({ ...value, x: Math.round(x * 0.5 * 1000) / 1000, y: Math.round(y * 0.5 * 1000) / 1000 }, final);
    };
    move(e);
    const mv = (ev) => move(ev);
    const up = (ev) => {
      move(ev, true);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const puckX = R + value.x * 2 * R;
  const puckY = R - value.y * 2 * R;
  return (
    <div className="wheel">
      <div className="wheel-label">{label}</div>
      <div className="wheel-disc" ref={ref} style={{ width: 2 * R, height: 2 * R }} onPointerDown={drag} onDoubleClick={() => onChange({ ...value, x: 0, y: 0 }, true)}>
        <canvas ref={bg} width={2 * R} height={2 * R} />
        <span className="wheel-cross" />
        <span className="wheel-puck" style={{ left: puckX, top: puckY }} />
      </div>
      <input type="range" min="-100" max="100" value={Math.round(value.l * 100)} onChange={(e) => onChange({ ...value, l: Number(e.target.value) / 100 }, false)} onDoubleClick={() => onChange({ ...value, l: 0 }, true)} />
      <div className="wheel-vals">
        {(() => {
          const rgb = wheelRgb(value);
          return `${(rgb.r * 0.25).toFixed(2)} ${(rgb.g * 0.25).toFixed(2)} ${(rgb.b * 0.25).toFixed(2)} · ${value.l.toFixed(2)}`;
        })()}
      </div>
    </div>
  );
}

// Luma curve: click to add a point, drag to shape, double-click a point to remove.
function CurveEditor({ points, onChange }) {
  const S = 200;
  const ref = useRef(null);
  const toXY = ([x, y]) => [x * S, S - y * S];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const path = (() => {
    const p = sorted.map(toXY);
    if (p.length < 3) return `M${p.map((q) => q.join(",")).join(" L")}`;
    let d = `M${p[0][0]},${p[0][1]}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1.join(",")} ${c2.join(",")} ${p2.join(",")}`;
    }
    return d;
  })();
  const pos = (e) => {
    const r = ref.current.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const dragPoint = (e, index) => {
    e.stopPropagation();
    let pts = sorted.map((q) => [...q]);
    const move = (ev, final = false) => {
      const [x, y] = pos(ev);
      const isEnd = index === 0 || index === pts.length - 1;
      const lo = index > 0 ? pts[index - 1][0] + 0.02 : 0;
      const hi = index < pts.length - 1 ? pts[index + 1][0] - 0.02 : 1;
      pts[index] = [isEnd ? pts[index][0] : Math.min(hi, Math.max(lo, x)), y];
      onChange(pts.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]), final);
    };
    const mv = (ev) => move(ev);
    const up = (ev) => {
      move(ev, true);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="curve-wrap">
      <svg
        ref={ref}
        className="curve"
        viewBox={`0 0 ${S} ${S}`}
        onPointerDown={(e) => {
          const [x, y] = pos(e);
          if (sorted.some(([px]) => Math.abs(px - x) < 0.03)) return;
          const pts = [...sorted, [x, y]].sort((a, b) => a[0] - b[0]);
          onChange(pts, true);
        }}
      >
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line x1={v * S} y1="0" x2={v * S} y2={S} />
            <line x1="0" y1={v * S} x2={S} y2={v * S} />
          </g>
        ))}
        <line className="diag" x1="0" y1={S} x2={S} y2="0" />
        <path d={path} />
        {sorted.map((q, i) => {
          const [x, y] = toXY(q);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r="5"
              onPointerDown={(e) => dragPoint(e, i)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (i > 0 && i < sorted.length - 1) onChange(sorted.filter((_, k) => k !== i), true);
              }}
            />
          );
        })}
      </svg>
      <div className="muted small">Click to add a point · drag · double-click to remove</div>
    </div>
  );
}
