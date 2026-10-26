import { useEffect, useState } from "react";
import { captionsTrack } from "../../core/captions.js";
import { formatTime, projectDuration } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { api, playhead } from "../state.js";
import Icon from "./icons.jsx";
import Player from "./Player.jsx";

// Render presets for the queue.
const PRESETS = {
  youtube: { label: "YouTube 1080p", preset: "landscape", codec: "h264", resolution: 1080, loudness: -14, suffix: "" },
  youtube4k: { label: "YouTube 4K (HEVC)", preset: "landscape", codec: "hevc", resolution: 2160, loudness: -14, suffix: " 4K" },
  shorts: { label: "Shorts / TikTok (square panel)", preset: "shorts-square", codec: "h264", resolution: 1080, loudness: -14, suffix: " Shorts" },
  vertical: { label: "Vertical crop", preset: "vertical-fill", codec: "h264", resolution: 1080, loudness: -14, suffix: " Vertical" },
  master: { label: "ProRes master", preset: "landscape", codec: "prores", resolution: null, loudness: null, suffix: " Master" },
};

// YouTube chapters from named markers ("0:00 Intro" is added if missing).
function chaptersText(project) {
  const fmt = (t) => {
    const s = Math.floor(t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  const marks = project.markers.filter((m) => m.end == null && m.label && m.label !== "beat").sort((a, b) => a.time - b.time);
  const lines = marks.map((m) => `${fmt(m.time)} ${m.label}`);
  if (!marks.length || marks[0].time > 0.5) lines.unshift("0:00 Intro");
  return lines.join("\n");
}

export default function DeliverPage() {
  const { project, apply, notify } = useEditor();
  const [folder, setFolder] = useState(null);
  const [status, setStatus] = useState({}); // job id -> { state, p, path, error }
  const [running, setRunning] = useState(false);
  const [sidecar, setSidecar] = useState(true);
  const hasCaptions = !!captionsTrack(project);
  const jobs = project.deliver;
  useEffect(() => api.on("export:progress", ({ p }) => setStatus((s) => {
    const id = Object.keys(s).find((k) => s[k].state === "running");
    return id ? { ...s, [id]: { ...s[id], p } } : s;
  })), []);

  const add = (key) => {
    const pr = PRESETS[key];
    apply((p) => ops.setDeliver(p, [...p.deliver, { id: `j_${Date.now()}`, name: `${p.name}${pr.suffix}`, kind: key, preset: pr.preset, codec: pr.codec, resolution: pr.resolution, loudness: pr.loudness }]));
  };
  const remove = (id) => apply((p) => ops.setDeliver(p, p.deliver.filter((j) => j.id !== id)));
  const renderAll = async () => {
    let dir = folder;
    if (!dir) dir = await api.chooseFolder("Render queue output folder");
    if (!dir) return;
    setFolder(dir);
    setRunning(true);
    for (const j of jobs) {
      setStatus((s) => ({ ...s, [j.id]: { state: "running", p: 0 } }));
      try {
        const ext = j.codec === "prores" ? "mov" : "mp4";
        const base = `${dir}\\${j.name.replace(/[\\/:*?"<>|]/g, "_")}`;
        const r = await api.exportStart(project, { outPath: `${base}.${ext}`, preset: j.preset, codec: j.codec, resolution: j.resolution ?? undefined, loudness: j.loudness ?? null });
        if (sidecar && hasCaptions) await api.saveCaptions(project, `${base}.srt`);
        setStatus((s) => ({ ...s, [j.id]: { state: "done", p: 1, path: r.path } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [j.id]: { state: "error", error: e.message } }));
      }
    }
    setRunning(false);
    notify("Render queue finished");
  };

  return (
    <div className="deliver-page">
      <section className="panel queue-panel">
        <div className="panel-head">
          <span>Render queue</span>
          <button className="primary small" disabled={!jobs.length || running} onClick={renderAll}>
            <Icon name="export" size={14} /> Render all ({jobs.length})
          </button>
        </div>
        <div className="panel-body">
          <div className="preset-list">
            {Object.entries(PRESETS).map(([k, pr]) => (
              <button key={k} className="small" onClick={() => add(k)}>
                <Icon name="plus" size={12} /> {pr.label}
              </button>
            ))}
          </div>
          {!jobs.length && <p className="muted small">Add the versions you need. They render one after another, so one click makes the main video and the Shorts.</p>}
          {jobs.map((j) => {
            const st = status[j.id];
            return (
              <div key={j.id} className="job-row">
                <input value={j.name} onChange={(e) => apply((p) => ops.setDeliver(p, p.deliver.map((x) => (x.id === j.id ? { ...x, name: e.target.value } : x))), { coalesce: `job-${j.id}` })} disabled={running} />
                <span className="muted small">{PRESETS[j.kind]?.label ?? j.preset}</span>
                <span className="small">{st?.state === "running" ? `${Math.round((st.p ?? 0) * 100)}%` : st?.state === "done" ? "Done" : st?.state === "error" ? "Failed" : "Queued"}</span>
                <button className="ghost icon-only tiny" onClick={() => remove(j.id)} disabled={running}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
            );
          })}
          <label className="check-row" title="A subtitle file with the same name, ready to upload to YouTube">
            <input type="checkbox" checked={sidecar && hasCaptions} disabled={!hasCaptions || running} onChange={(e) => setSidecar(e.target.checked)} />
            <span className="small">Save captions (.srt) next to each video{hasCaptions ? "" : " (no captions yet)"}</span>
          </label>
          {folder && <div className="muted small">Output: {folder}</div>}
        </div>
      </section>
      <Player />
      <section className="panel extras-panel">
        <div className="panel-head">
          <span>Extras</span>
        </div>
        <div className="panel-body">
          <h4>YouTube chapters</h4>
          <textarea readOnly rows={8} value={chaptersText(project)} />
          <button className="small" onClick={() => navigator.clipboard.writeText(chaptersText(project)).then(() => notify("Chapters copied"))}>Copy chapters</button>
          <p className="muted small">Add named markers (M) on the timeline to build chapters.</p>
          <h4>Subtitles</h4>
          <button className="small" disabled={!hasCaptions} onClick={() => api.saveCaptions(project).then((f) => f && notify(`Saved ${f}`)).catch((e) => notify(e.message, "error"))}>
            Save captions as .srt
          </button>
          <h4>Thumbnail</h4>
          <button className="small" onClick={() => api.saveFrame(project, playhead.get()).then((f) => f && notify(`Saved ${f}`)).catch((e) => notify(e.message, "error"))}>
            Save still at playhead
          </button>
          <div className="muted small">Duration {formatTime(projectDuration(project), project.canvas.fps)}</div>
        </div>
      </section>
    </div>
  );
}
