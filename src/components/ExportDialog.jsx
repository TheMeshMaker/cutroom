import { useEffect, useState } from "react";
import { EXPORT_CODECS, EXPORT_FPS, EXPORT_QUALITY, EXPORT_RESOLUTIONS } from "../../core/catalog.js";
import { formatTime, projectDuration } from "../../core/model.js";
import { EXPORT_PRESETS } from "../../core/render.js";
import { useEditor } from "../editor.js";
import { api, mediaUrl } from "../state.js";
import Icon from "./icons.jsx";

const HW_LABELS = { auto: "Auto (GPU when available)", cpu: "CPU (best compression)", nvenc: "NVIDIA NVENC", qsv: "Intel Quick Sync", amf: "AMD AMF" };
const LAYOUTS = { landscape: "Same as project", "shorts-square": "Shorts · square panel", "vertical-fill": "Vertical · center crop" };

function Row({ label, children }) {
  return (
    <label className="ex-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

export default function ExportDialog({ onClose }) {
  const { project, range, notify } = useEditor();
  const hasRange = range.in != null && range.out != null && range.out > range.in;
  const shortSide = Math.min(project.canvas.width, project.canvas.height);
  const [name, setName] = useState(project.name);
  const [layout, setLayout] = useState("landscape");
  const [background, setBackground] = useState("blur");
  const [resolution, setResolution] = useState(Object.entries(EXPORT_RESOLUTIONS).find(([, v]) => v === shortSide)?.[0] ?? "1080p");
  const [quality, setQuality] = useState("recommended");
  const [codec, setCodec] = useState("h264");
  const [fps, setFps] = useState(project.canvas.fps);
  const [hardware, setHardware] = useState("auto");
  const [useRange, setUseRange] = useState(false);
  const [encoders, setEncoders] = useState({ h264: ["cpu"] });
  const [cover, setCover] = useState(null);
  const [state, setState] = useState({ phase: "idle" });

  useEffect(() => {
    api.encoders().then(setEncoders).catch(() => {});
    const t = Math.min(projectDuration(project) / 3, 5);
    if (project.clips.length) api.previewFrame(project, t, 480).then((f) => setCover(`${mediaUrl(f)}?v=${Date.now()}`)).catch(() => {});
  }, []);
  useEffect(() => api.on("export:progress", ({ p }) => setState((s) => (s.phase === "running" ? { ...s, p } : s))), []);
  const hwList = ["auto", ...(encoders[codec] ?? [])];
  useEffect(() => {
    if (!hwList.includes(hardware)) setHardware("auto");
  }, [codec, encoders]);

  const dur = useRange && hasRange ? range.out - range.in : projectDuration(project);
  const start = async () => {
    setState({ phase: "running", p: 0, began: Date.now() });
    try {
      const r = await api.exportStart(project, {
        name,
        preset: layout,
        background,
        resolution: EXPORT_RESOLUTIONS[resolution],
        quality,
        codec,
        fps,
        hardware,
        range: useRange && hasRange ? [range.in, range.out] : undefined,
      });
      if (!r) setState({ phase: "idle" });
      else {
        setState({ phase: "done", result: r });
        notify(`Exported in ${r.seconds.toFixed(0)} s (${r.encoder})`);
      }
    } catch (e) {
      setState({ phase: "error", error: e.message });
    }
  };
  const running = state.phase === "running";
  const eta = running && state.p > 0.02 ? ((Date.now() - state.began) / state.p) * (1 - state.p) / 1000 : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal export-modal">
        <div className="modal-head">
          <h3>Export</h3>
          <button className="ghost icon-only" onClick={onClose} disabled={running}>✕</button>
        </div>
        <div className="export-body">
          <div className="export-cover">
            {cover ? <img src={cover} alt="" /> : <div className="cover-empty" />}
            <input className="ex-name" value={name} onChange={(e) => setName(e.target.value)} disabled={running} />
            <div className="muted small">{formatTime(dur, project.canvas.fps)} · {codec === "prores" ? "MOV" : "MP4"}</div>
          </div>
          <div className="export-settings">
            <h4>Video</h4>
            <Row label="Layout">
              <select value={layout} onChange={(e) => setLayout(e.target.value)} disabled={running}>
                {Object.keys(EXPORT_PRESETS).map((k) => <option key={k} value={k}>{LAYOUTS[k]}</option>)}
              </select>
            </Row>
            {layout === "shorts-square" && (
              <Row label="Behind panel">
                <select value={background} onChange={(e) => setBackground(e.target.value)} disabled={running}>
                  <option value="blur">Blurred footage</option>
                  <option value="black">Black</option>
                </select>
              </Row>
            )}
            <Row label="Resolution">
              <select value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={running}>
                {Object.keys(EXPORT_RESOLUTIONS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Row>
            <Row label="Quality">
              <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={running}>
                {Object.entries(EXPORT_QUALITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Row>
            <Row label="Codec">
              <select value={codec} onChange={(e) => setCodec(e.target.value)} disabled={running}>
                {Object.entries(EXPORT_CODECS).filter(([k]) => encoders[k]?.length).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Row>
            <Row label="Frame rate">
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))} disabled={running}>
                {[...new Set([...EXPORT_FPS, project.canvas.fps])].sort((a, b) => a - b).map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </Row>
            <Row label="Encoder">
              <select value={hardware} onChange={(e) => setHardware(e.target.value)} disabled={running}>
                {hwList.map((h) => <option key={h} value={h}>{HW_LABELS[h] ?? h}</option>)}
              </select>
            </Row>
            <label className="check">
              <input type="checkbox" checked={useRange && hasRange} disabled={!hasRange || running} onChange={(e) => setUseRange(e.target.checked)} />
              Only the I–O range {hasRange ? `(${formatTime(range.in)} → ${formatTime(range.out)})` : "(set with I and O)"}
            </label>
            <h4>Audio</h4>
            <div className="muted small">{codec === "prores" ? "PCM 16-bit" : "AAC 192 kbps"} · 48 kHz stereo</div>
          </div>
        </div>
        {running && (
          <div className="export-progress">
            <div className="bar"><div style={{ width: `${Math.round((state.p ?? 0) * 100)}%` }} /></div>
            <span>{Math.round((state.p ?? 0) * 100)}%{eta != null ? ` · ${Math.ceil(eta)} s left` : ""}</span>
          </div>
        )}
        {state.phase === "done" && (
          <div className="export-done">
            <Icon name="check" /> Saved <code>{state.result.path}</code>
            <button className="small" onClick={() => api.reveal(state.result.path)}>Open folder</button>
          </div>
        )}
        {state.phase === "error" && <pre className="export-error">{state.error}</pre>}
        <div className="modal-foot">
          {running ? (
            <button onClick={() => api.exportCancel()}>Cancel</button>
          ) : (
            <>
              <button className="ghost" onClick={onClose}>Close</button>
              <button className="primary" onClick={start} disabled={!project.clips.length}>
                <Icon name="export" /> Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
