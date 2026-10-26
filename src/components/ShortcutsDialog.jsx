import { useEffect, useMemo, useRef, useState } from "react";
import { KEYMAPS } from "../keymaps.js";
import Icon from "./icons.jsx";

// What each action is called, and where it's listed.
const ACTIONS = {
  play: ["Play / pause", "Playback"],
  pause: ["Pause", "Playback"],
  back5: ["Back 5 seconds", "Playback"],
  prevFrame: ["Previous frame", "Playback"],
  nextFrame: ["Next frame", "Playback"],
  prevSecond: ["Back 1 second", "Playback"],
  nextSecond: ["Forward 1 second", "Playback"],
  start: ["Go to start", "Playback"],
  end: ["Go to end", "Playback"],
  markIn: ["Mark In", "Marks"],
  markOut: ["Mark Out", "Marks"],
  clearRange: ["Clear In/Out", "Marks"],
  marker: ["Add marker", "Marks"],
  nextMarker: ["Next marker", "Marks"],
  prevMarker: ["Previous marker", "Marks"],
  split: ["Split at playhead", "Edit"],
  splitAll: ["Split all tracks", "Edit"],
  deleteLeft: ["Delete left of playhead", "Edit"],
  deleteRight: ["Delete right of playhead", "Edit"],
  remove: ["Delete", "Edit"],
  rippleRemove: ["Ripple delete", "Edit"],
  copy: ["Copy", "Edit"],
  paste: ["Paste at playhead", "Edit"],
  duplicate: ["Duplicate", "Edit"],
  nudgeLeft: ["Nudge one frame left", "Edit"],
  nudgeRight: ["Nudge one frame right", "Edit"],
  punchIn: ["Punch-in zoom", "Edit"],
  bleep: ["Bleep", "Edit"],
  sourceInsert: ["Insert from source", "Edit"],
  sourceOverwrite: ["Overwrite from source", "Edit"],
  selectAll: ["Select all", "Select"],
  deselect: ["Deselect all", "Select"],
  selectAtPlayhead: ["Select clip at playhead", "Select"],
  toolSelect: ["Selection tool", "Tools"],
  toolBlade: ["Split (blade) tool", "Tools"],
  toolRoll: ["Roll tool", "Tools"],
  toolSlip: ["Slip tool", "Tools"],
  snap: ["Snapping on/off", "Tools"],
  zoomIn: ["Zoom in", "View"],
  zoomOut: ["Zoom out", "View"],
  fit: ["Fit timeline", "View"],
  undo: ["Undo", "App"],
  redo: ["Redo", "App"],
  import: ["Import media", "App"],
  export: ["Export", "App"],
  palette: ["Search actions", "App"],
  shortcuts: ["This list", "App"],
  escape: ["Deselect / close", "App"],
};
const GROUPS = ["Playback", "Edit", "Select", "Marks", "Tools", "View", "App"];
const NAMES = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", space: "Space", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", delete: "Del", backspace: "⌫", escape: "Esc", home: "Home", end: "End" };

function Keys({ combo }) {
  if (combo === "shift+/") return <kbd>?</kbd>;
  return combo.split("+").map((k, i) => <kbd key={i}>{NAMES[k] ?? k.toUpperCase()}</kbd>);
}

export default function ShortcutsDialog({ keymap, onClose }) {
  const [q, setQ] = useState("");
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);
  const groups = useMemo(() => {
    const byAction = new Map();
    for (const [combo, action] of Object.entries((KEYMAPS[keymap] ?? KEYMAPS.capcut).keys)) {
      if (!ACTIONS[action]) continue;
      byAction.set(action, [...(byAction.get(action) ?? []), combo]);
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return GROUPS.map((g) => ({
      name: g,
      rows: [...byAction]
        .filter(([a]) => ACTIONS[a][1] === g)
        .filter(([a, combos]) => words.every((w) => ACTIONS[a][0].toLowerCase().includes(w) || combos.some((c) => c.includes(w))))
        .map(([a, combos]) => ({ action: a, label: ACTIONS[a][0], combos })),
    })).filter((g) => g.rows.length);
  }, [keymap, q]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-modal" data-keys="own" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3>
            <Icon name="keyboard" size={18} /> Keyboard shortcuts <span className="muted small">· {(KEYMAPS[keymap] ?? KEYMAPS.capcut).label} preset</span>
          </h3>
          <button className="ghost icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div className="home-search small-search shortcut-search">
            <Icon name="search" />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a shortcut…" />
          </div>
          <div className="shortcut-cols">
            {groups.map((g) => (
              <section key={g.name} className="shortcut-group">
                <h4>{g.name}</h4>
                {g.rows.map((r) => (
                  <div key={r.action} className="shortcut-row">
                    <span>{r.label}</span>
                    <span className="shortcut-keys">
                      {r.combos.map((c, i) => (
                        <span key={c} className="combo">
                          {i > 0 && <i>or</i>}
                          <Keys combo={c} />
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
            {!groups.length && <p className="muted">No shortcut matches “{q}”.</p>}
          </div>
          <p className="muted small shortcut-foot">Change the preset under Menu → Keyboard shortcuts. Shortcuts follow the physical key, so they work with any keyboard layout.</p>
        </div>
      </div>
    </div>
  );
}
