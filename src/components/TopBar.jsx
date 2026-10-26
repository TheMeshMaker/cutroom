import { useEffect, useRef, useState } from "react";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { KEYMAPS, shortcutFor } from "../keymaps.js";
import { api } from "../state.js";
import { ACCENTS } from "../theme.js";
import Icon from "./icons.jsx";

const PAGES = [
  ["edit", "Edit", "film"],
  ["color", "Color", "wheel"],
  ["audio", "Audio", "sliders"],
  ["deliver", "Deliver", "export"],
];

export default function TopBar() {
  const { project, path, saveState, apply, undo, redo, canUndo, canRedo, openExport, openDoc, notify, page, setPage, actions, keymap, setKeymap, openPalette, openShortcuts, accent, setAccent } = useEditor();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    const key = (e) => e.key === "Escape" && setMenu(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  const run = (fn) => async () => {
    setMenu(false);
    try {
      openDoc(await fn());
    } catch (e) {
      notify(e.message, "error");
    }
  };
  const close = (fn) => () => {
    setMenu(false);
    fn();
  };
  const status = { saved: "Saved", saving: "Saving…", error: "Save failed" }[saveState];
  return (
    <header className="topbar">
      <button className="ghost brand-btn" onClick={actions.goHome} title="All projects">
        <span className="brand-mark" />
        <span className="brand-text">Cutroom</span>
      </button>
      <div className="menu" ref={menuRef}>
        <button className={`ghost menu-btn ${menu ? "open" : ""}`} onClick={() => setMenu(!menu)}>
          Menu <Icon name="chevron" size={14} />
        </button>
        {menu && (
          <div className="menu-pop">
            <button onClick={close(actions.goHome)}>
              <Icon name="layers" /> <span>Projects…</span>
            </button>
            <button onClick={run(() => api.newProject({}))}>
              <Icon name="file" /> <span>New project</span>
            </button>
            <button onClick={run(() => api.openProject())}>
              <Icon name="folder" /> <span>Open project…</span>
            </button>
            <button onClick={run(() => api.importCapcut())}>
              <Icon name="capcut" /> <span>Import CapCut project…</span>
            </button>
            <button onClick={close(actions.import)}>
              <Icon name="plus" /> <span>Import media…</span> <kbd>{shortcutFor("import", keymap)}</kbd>
            </button>
            <hr />
            <button onClick={close(actions.restoreBackups)}>
              <Icon name="history" /> <span>Restore an earlier version…</span>
            </button>
            <button onClick={close(() => api.reveal(path))}>
              <Icon name="folder" /> <span>Show project file</span>
            </button>
            <hr />
            <div className="menu-label">Keyboard shortcuts</div>
            {Object.entries(KEYMAPS).map(([k, v]) => (
              <button key={k} onClick={() => (setKeymap(k), setMenu(false))}>
                <Icon name={keymap === k ? "check" : "blank"} /> <span>{v.label}</span>
              </button>
            ))}
            <button onClick={close(openShortcuts)}>
              <Icon name="keyboard" /> <span>Show all shortcuts</span> <kbd>?</kbd>
            </button>
            <hr />
            <div className="menu-label">Theme color</div>
            <div className="accent-row">
              {Object.entries(ACCENTS).map(([k, v]) => (
                <button key={k} className={`accent-dot accent-${k} ${accent === k ? "active" : ""}`} onClick={() => setAccent(k)} title={v} aria-label={v} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="topbar-history">
        <button className="ghost icon-only" onClick={undo} disabled={!canUndo} title={`Undo (${shortcutFor("undo", keymap)})`}>
          <Icon name="undo" />
        </button>
        <button className="ghost icon-only" onClick={redo} disabled={!canRedo} title={`Redo (${shortcutFor("redo", keymap)})`}>
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
          spellCheck={false}
          onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && apply((p) => ops.rename(p, e.target.value.trim()))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className={`save-state ${saveState}`}>
          <i />
          {status}
        </span>
      </div>
      <button className="ghost search-btn" onClick={openPalette} title="Search every action">
        <Icon name="search" /> <span>Search actions</span> <kbd>Ctrl+Shift+P</kbd>
      </button>
      <button className="ghost icon-only" onClick={openShortcuts} title="Keyboard shortcuts (?)">
        <Icon name="keyboard" />
      </button>
      <button className="primary export-btn" onClick={openExport} title={`Export (${shortcutFor("export", keymap)})`}>
        <Icon name="export" /> Export
      </button>
    </header>
  );
}
