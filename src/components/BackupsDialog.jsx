import { useEffect, useState } from "react";
import { formatTime } from "../../core/model.js";
import { api } from "../state.js";
import Icon from "./icons.jsx";

// Earlier versions of the project, saved automatically every few minutes.
export default function BackupsDialog({ path, onClose, onRestored, notify }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    api.listBackups(path).then(setList).catch((e) => notify(e.message, "error"));
  }, [path]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal backups-modal">
        <div className="modal-head">
          <h3>Restore an earlier version</h3>
          <button className="ghost icon-only" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted small">Cutroom keeps a copy of your project every 5 minutes while you edit (the last 30). Restoring backs up the current version first, so nothing is lost.</p>
          {list && !list.length && <p className="muted">No earlier versions yet. They appear after a few minutes of editing.</p>}
          <div className="backup-list">
            {list?.map((b) => (
              <div key={b.file} className="backup-row">
                <Icon name="history" />
                <div className="backup-meta">
                  <b>{new Date(b.time).toLocaleString()}</b>
                  <span className="muted small">{b.clips != null ? `${b.clips} clips · ${formatTime(b.duration ?? 0).replace(/:\d\d$/, "")}` : "unreadable"}</span>
                </div>
                <button className="small" onClick={() => api.restoreBackup(path, b.file).then(onRestored).catch((e) => notify(e.message, "error"))}>Restore</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
