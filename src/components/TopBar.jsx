import { useEffect, useRef, useState } from "react";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { KEYMAPS } from "../keymaps.js";
import { api } from "../state.js";
import Icon from "./icons.jsx";

const PAGES = [
  ["edit", "Edit", "film"],
  ["color", "Color", "wheel"],
  ["audio", "Audio", "sliders"],
  ["deliver", "Deliver", "export"],
];

export default function TopBar() {
  const { project, path, saveState, apply, undo, redo, canUndo, canRedo, openExport, openDoc, notify, page, setPage, actions, keymap, setKeymap, openPalette } = useEditor();
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
      <button className="ghost brand-btn" onClick={actions.goHome} title="All projects">
        <span className="brand-mark" />
        <span className="brand-text">Cutroom</span>
      </button>
      <div className="menu" ref={menuRef}>
        <button className="ghost menu-btn" onClick={() => setMenu(!menu)}>
          Menu <Icon name="chevron" size={14} />
        </button>
        {menu && (
          <div className="menu-pop">
            <button onClick={() => (setMenu(false), actions.goHome())}>
              <Icon name="layers" /> Projects…
            </button>
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
            <div className="menu-label">Keyboard shortcuts</div>
            {Object.entries(KEYMAPS).map(([k, v]) => (
              <button key={k} onClick={() => (setKeymap(k), setMenu(false))}>
                <Icon name={keymap === k ? "check" : "blank"} /> {v.label}
              </button>
            ))}
            <hr />
            <button onClick={() => (setMenu(false), api.reveal(path))}>
              <Icon name="folder" /> Show project file
            </button>
          </div>
        )}
      </div>
      <div className="topbar-history">
        <button className="ghost icon-only" onClick={undo} disabled={!canUndo} title="Undo">
          <Icon name="undo" />
        </button>
        <button className="ghost icon-only" onClick={redo} disabled={!canRedo} title="Redo">
          <Icon name="redo" />
        </button>
      </div>
      <nav className="pages">
        {PAGES.map(([id, label, icon]) => (
          <button key={id} className={`page-tab ${page === id ? "active" : ""}`} onClick={() => setPage(id)}>
            <Icon name={icon} size={15} /> {label}
          </button>
        ))}
      </nav>
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
      <button className="ghost search-btn" onClick={openPalette} title="Search actions (Ctrl+Shift+P)">
        <Icon name="search" /> <span>Search</span> <kbd>Ctrl+Shift+P</kbd>
      </button>
      <button className="primary export-btn" onClick={openExport} title="Export">
        <Icon name="export" /> Export
      </button>
    </header>
  );
}
