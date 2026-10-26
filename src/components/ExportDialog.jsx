import { useEffect, useState } from "react";
import { formatTime, projectDuration } from "../../core/model.js";
import { EXPORT_PRESETS } from "../../core/render.js";
import { api } from "../state.js";
import Icon from "./icons.jsx";

const ENCODER_LABELS = { x264: "x264 (CPU, best quality)", nvenc: "NVIDIA NVENC (fast)", qsv: "Intel Quick Sync (fast)", amf: "AMD AMF (fast)" };

export default function ExportDialog({ project, range, onClose, notify }) {
  const hasRange = range.in != null && range.out != null && range.out > range.in;
  const [preset, setPreset] = useState("landscape");
  const [background, setBackground] = useState("blur");
  const [useRange, setUseRange] = useState(false);
  const [encoders, setEncoders] = useState(["x264"]);
  const [encoder, setEncoder] = useState("x264");
  const [state, setState] = useState({ phase: "idle" });

  useEffect(() => {
    api.encoders().then(setEncoders).catch(() => {});
  }, []);
  useEffect(() => api.on("export:progress", ({ p }) => setState((s) => (s.phase === "running" ? { ...s, p } : s))), []);

  const dur = useRange && hasRange ? range.out - range.in : projectDuration(project);

  const start = async () => {
    setState({ phase: "running", p: 0 });
    try {
      const r = await api.exportStart(project, { preset, background, encoder, range: useRange && hasRange ? [range.in, range.out] : undefined });
      if (!r) setState({ phase: "idle" });
      else {
        setState({ phase: "done", result: r });
        notify(`Exported in ${r.seconds.toFixed(0)} s`);
      }
    } catch (e) {
      setState({ phase: "error", error: e.message });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && state.phase !== "running" && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>Export</h3>
          <button className="ghost icon-only" onClick={onClose} disabled={state.phase === "running"}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="preset-grid">
            {Object.entries(EXPORT_PRESETS).map(([k, v]) => (
              <button key={k} className={`preset ${preset === k ? "active" : ""}`} onClick={() => setPreset(k)} disabled={state.phase === "running"}>
                <span className={`preset-shape ${k}`} />
                <span>{k === "landscape" ? `Landscape · ${project.canvas.width}×${project.canvas.height}` : v.label}</span>
              </button>
            ))}
          </div>
          {preset === "shorts-square" && (
            <label className="field">
              <span className="field-label">Behind the panel</span>
              <select value={background} onChange={(e) => setBackground(e.target.value)}>
                <option value="blur">Blurred footage</option>
                <option value="black">Black</option>
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">Encoder</span>
            <select value={encoder} onChange={(e) => setEncoder(e.target.value)}>
              {encoders.map((x) => (
                <option key={x} value={x}>
                  {ENCODER_LABELS[x] ?? x}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={useRange && hasRange} disabled={!hasRange} onChange={(e) => setUseRange(e.target.checked)} />
            Only the I–O range {hasRange ? `(${formatTime(range.in)} → ${formatTime(range.out)})` : "(set with I and O)"}
          </label>
          <div className="muted small">Length {formatTime(dur, project.canvas.fps)} · H.264 MP4 · AAC 192k</div>

          {state.phase === "running" && (
            <div className="export-progress">
              <div className="bar">
                <div style={{ width: `${Math.round((state.p ?? 0) * 100)}%` }} />
              </div>
              <span>{Math.round((state.p ?? 0) * 100)}%</span>
            </div>
          )}
          {state.phase === "done" && (
            <div className="export-done">
              Saved <code>{state.result.path}</code>
              <button className="small" onClick={() => api.reveal(state.result.path)}>
                Show in folder
              </button>
            </div>
          )}
          {state.phase === "error" && <pre className="export-error">{state.error}</pre>}
        </div>
        <div className="modal-foot">
          {state.phase === "running" ? (
            <button onClick={() => api.exportCancel()}>Cancel</button>
          ) : (
            <>
              <button className="ghost" onClick={onClose}>
                Close
              </button>
              <button className="primary" onClick={start} disabled={!project.clips.length}>
                <Icon name="export" /> Export video
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
