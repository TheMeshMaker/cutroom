import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./icons.jsx";

// Type what you want to do; Enter runs it.
export default function CommandPalette({ commands, onClose }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  }, [q, commands]);
  useEffect(() => setI(0), [q]);
  const run = (c) => {
    onClose();
    c?.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="Search actions… (split, auto color, export, Premiere shortcuts…)"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(list.length - 1, x + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
              if (e.key === "Enter") run(list[i]);
            }}
          />
        </div>
        <div className="palette-list">
          {list.map((c, k) => (
            <button key={c.id} className={`palette-item ${k === i ? "active" : ""}`} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
              <span>{c.label}</span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </button>
          ))}
          {!list.length && <div className="muted small palette-empty">No matching action</div>}
        </div>
      </div>
    </div>
  );
}
