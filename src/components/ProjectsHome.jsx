import { useEffect, useMemo, useState } from "react";
import { CANVAS_PRESETS, formatTime } from "../../core/model.js";
import { api, mediaUrl } from "../state.js";
import Icon from "./icons.jsx";

const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
};

// Project manager: recent projects with thumbnails, plus new / open / import.
export default function ProjectsHome({ current, onOpen, onBack, notify }) {
  const [projects, setProjects] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("My edit");
  const [canvas, setCanvas] = useState("1080p");

  const refresh = () =>
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => notify(e.message, "error"));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!projects) return;
    let alive = true;
    (async () => {
      for (const p of projects) {
        if (p.missing || p.broken || !p.duration || thumbs[p.path]) continue;
        try {
          const file = await api.projectThumb(p.path);
          if (alive && file) setThumbs((t) => ({ ...t, [p.path]: `${mediaUrl(file)}?v=${p.modified}` }));
        } catch {
          // no thumbnail; the card shows a placeholder
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [projects]);

  const run = async (fn) => {
    try {
      const opened = await fn();
      if (opened) onOpen(opened);
    } catch (e) {
      notify(e.message, "error");
    }
  };
  const shown = useMemo(() => (projects ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase())), [projects, query]);

  return (
    <div className="home">
      <header className="home-top">
        <div className="brand">
          <span className="brand-mark" />
          Cutroom
        </div>
        <div className="home-search">
          <Icon name="search" />
          <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {onBack && (
          <button className="ghost" onClick={onBack}>
            Back to editor
          </button>
        )}
      </header>
      <div className="home-body">
        <section className="home-actions">
          <button className="home-new primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={22} />
            <span>New project</span>
          </button>
          <button className="home-tile" onClick={() => run(() => api.openProject())}>
            <Icon name="folder" size={20} />
            <span>Open…</span>
          </button>
          <button className="home-tile" onClick={() => run(() => api.importCapcut())}>
            <Icon name="capcut" size={20} />
            <span>Import CapCut</span>
          </button>
        </section>
        <h3 className="home-h">Projects {projects && <span className="muted">({projects.length})</span>}</h3>
        {projects && !projects.length && <p className="muted">No projects yet. Create one, or import a CapCut project.</p>}
        <div className="project-grid">
          {shown.map((p) => (
            <div key={p.path} className={`project-card ${p.path === current ? "current" : ""} ${p.missing || p.broken ? "missing" : ""}`} onDoubleClick={() => !p.missing && run(() => api.openProject(p.path))}>
              <button className="project-thumb" onClick={() => !p.missing && run(() => api.openProject(p.path))} title={p.path}>
                {thumbs[p.path] ? <img src={thumbs[p.path]} alt="" /> : <Icon name="film" size={26} />}
                {p.duration > 0 && <span className="dur">{formatTime(p.duration).replace(/:\d\d$/, "")}</span>}
                {p.path === current && <span className="added">Open</span>}
              </button>
              <div className="project-meta">
                <div className="project-name">{p.name}</div>
                <div className="muted small">{p.missing ? "File not found" : p.broken ? "Can't read" : `${ago(p.modified)} · ${p.canvas?.width}×${p.canvas?.height}`}</div>
              </div>
              <div className="project-menu">
                <button className="ghost icon-only tiny" title="Show in folder" onClick={() => api.reveal(p.path)} disabled={p.missing}>
                  <Icon name="folder" size={13} />
                </button>
                <button className="ghost icon-only tiny" title="Remove from list (keeps the file)" onClick={() => api.forgetProject(p.path).then(refresh)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {creating && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setCreating(false)}>
          <div className="modal new-modal">
            <div className="modal-head">
              <h3>New project</h3>
              <button className="ghost icon-only" onClick={() => setCreating(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              <span className="field-label">Format</span>
              <div className="format-grid">
                {Object.entries(CANVAS_PRESETS).map(([k, v]) => (
                  <button key={k} className={`format ${canvas === k ? "active" : ""}`} onClick={() => setCanvas(k)}>
                    <span className="format-shape" style={{ aspectRatio: `${v.width} / ${v.height}` }} />
                    <b>{k}</b>
                    <small>
                      {v.width}×{v.height} · {v.fps} fps
                    </small>
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="primary" onClick={() => (setCreating(false), run(() => api.newProject({ name, canvas })))}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
