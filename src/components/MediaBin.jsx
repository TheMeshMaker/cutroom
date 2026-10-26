import { formatTime } from "../../core/model.js";
import Icon from "./icons.jsx";

export default function MediaBin({ project, proxies, onImport, onAdd }) {
  const used = new Set(project.clips.map((c) => c.mediaId));
  return (
    <aside className="panel media-bin">
      <div className="panel-head">
        <span>Media</span>
        <button className="small" onClick={onImport} title="Import media (Ctrl+I)">
          <Icon name="plus" /> Import
        </button>
      </div>
      <div className="panel-body">
        {!project.media.length && (
          <button className="drop-hint" onClick={onImport}>
            <Icon name="film" size={28} />
            <span>Import recordings, music or images</span>
          </button>
        )}
        {project.media.map((m) => {
          const proxy = proxies[m.id];
          const progress = proxy && typeof proxy === "object" ? proxy : null;
          return (
            <div
              key={m.id}
              className={`media-item ${used.has(m.id) ? "used" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-cutroom-media", m.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => onAdd(m.id)}
              title={`${m.path}\nDouble-click or drag to the timeline`}
            >
              <div className={`media-icon ${m.kind}`}>
                <Icon name={m.kind === "audio" ? "music" : m.kind === "image" ? "image" : "film"} size={18} />
              </div>
              <div className="media-meta">
                <div className="media-name">{m.name}</div>
                <div className="media-sub">
                  {formatTime(m.duration, 30).replace(/\.\d+$/, "")}
                  {m.width ? ` · ${m.width}×${m.height}` : ""}
                  {m.fps ? ` · ${Math.round(m.fps)}fps` : ""}
                </div>
                {progress && !progress.error && (
                  <div className="proxy-bar" title="Preparing smooth preview">
                    <div style={{ width: `${Math.round((progress.progress ?? 0) * 100)}%` }} />
                  </div>
                )}
                {progress?.error && <div className="media-error">Preview failed</div>}
              </div>
              <button className="small icon-only add" onClick={() => onAdd(m.id)} title="Add to timeline">
                <Icon name="plus" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
