import { useEffect, useRef, useState } from "react";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { api } from "../state.js";
import Icon from "./icons.jsx";

export default function TopBar() {
  const { project, path, saveState, apply, undo, redo, canUndo, canRedo, openExport, openDoc, notify } = useEditor();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const run = (fn) => async () => {
    setMenu(false);
    try {
      openDoc(await fn());
    } catch (e) {
      notify(e.message, "error");
    }
  };
  const status = { saved: "Auto-saved", saving: "Saving…", error: "Save failed" }[saveState];
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        Cutroom
      </div>
      <div className="menu" ref={menuRef}>
        <button className="ghost menu-btn" onClick={() => setMenu(!menu)}>
          Menu <Icon name="chevron" size={14} />
        </button>
        {menu && (
          <div className="menu-pop">
            <button onClick={run(() => api.newProject({}))}>
              <Icon name="file" /> New project
            </button>
            <button onClick={run(() => api.openProject())}>
              <Icon name="folder" /> Open project…
            </button>
            <button onClick={run(() => api.importCapcut())}>
              <Icon name="capcut" /> Import CapCut project…
            </button>
            <hr />
            <button onClick={() => (setMenu(false), api.reveal(path))}>
              <Icon name="folder" /> Show project file
            </button>
          </div>
        )}
      </div>
      <div className="topbar-history">
        <button className="ghost icon-only" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Icon name="undo" />
        </button>
        <button className="ghost icon-only" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <Icon name="redo" />
        </button>
      </div>
      <div className="project-title" title={path}>
        <input
          className="title-input"
          defaultValue={project.name}
          key={project.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && apply((p) => ops.rename(p, e.target.value.trim()))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className={`save-state ${saveState}`}>{status}</span>
      </div>
      <button className="primary export-btn" onClick={openExport} title="Export (Ctrl+E)">
        <Icon name="export" /> Export
      </button>
    </header>
  );
}
