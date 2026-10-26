import Icon from "./icons.jsx";

export default function TopBar({ project, path, saveState, canUndo, canRedo, onUndo, onRedo, onNew, onOpen, onImportCapcut, onExport }) {
  const status = { saved: "Saved", saving: "Saving…", error: "Save failed" }[saveState];
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        Cutroom
      </div>
      <nav className="topbar-actions">
        <button className="ghost" onClick={onNew} title="New project">
          <Icon name="file" /> New
        </button>
        <button className="ghost" onClick={onOpen} title="Open project">
          <Icon name="folder" /> Open
        </button>
        <button className="ghost" onClick={onImportCapcut} title="Import a CapCut draft">
          <Icon name="capcut" /> Import CapCut
        </button>
        <span className="divider" />
        <button className="ghost icon-only" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Icon name="undo" />
        </button>
        <button className="ghost icon-only" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          <Icon name="redo" />
        </button>
      </nav>
      <div className="project-title" title={path}>
        <strong>{project.name}</strong>
        <span className={`save-state ${saveState}`}>{status}</span>
      </div>
      <button className="primary" onClick={onExport} title="Export (Ctrl+E)">
        <Icon name="export" /> Export
      </button>
    </header>
  );
}
