import { useState } from "react";
import { CANVAS_PRESETS } from "../../core/model.js";
import Icon from "./icons.jsx";

export default function Welcome({ onNew, onOpen, onImportCapcut }) {
  const [name, setName] = useState("My edit");
  const [canvas, setCanvas] = useState("1080p");
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand big">
          <span className="brand-mark" />
          Cutroom
        </div>
        <p className="muted">A fast editor for long recordings: light cuts, punch-ins, bleeps and Shorts, with projects your AI agent can edit live.</p>
        <div className="welcome-new">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
          <select value={canvas} onChange={(e) => setCanvas(e.target.value)}>
            {Object.entries(CANVAS_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {k} · {v.width}×{v.height} · {v.fps} fps
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => onNew({ name, canvas })}>
            <Icon name="plus" /> New project
          </button>
        </div>
        <div className="welcome-row">
          <button onClick={onOpen}>
            <Icon name="folder" /> Open project
          </button>
          <button onClick={onImportCapcut}>
            <Icon name="capcut" /> Import a CapCut project
          </button>
        </div>
      </div>
    </div>
  );
}
