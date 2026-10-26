import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./icons.jsx";

// Right-click menu. Items: { label, icon, shortcut, run, danger, disabled,
// items (a submenu) }, "-" for a divider, or { swatches, value, onPick } for a
// row of color dots.
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, opacity: 0 });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)), opacity: 1 });
  }, [x, y]);
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && onClose();
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div className="ctx-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()} role="menu">
      <MenuItems items={items} onClose={onClose} />
    </div>
  );
}

function MenuItems({ items, onClose }) {
  const [open, setOpen] = useState(null);
  return items.filter(Boolean).map((it, i) => {
    if (it === "-") return <hr key={i} />;
    if (it.heading) return <div key={i} className="ctx-heading">{it.heading}</div>;
    if (it.swatches) {
      return (
        <div key={i} className="ctx-swatches" onMouseEnter={() => setOpen(null)}>
          <span>{it.label}</span>
          <div>
            {it.swatches.map((s) => (
              <button key={s ?? "none"} className={`label-dot ${s ?? "none"} ${it.value === s ? "active" : ""}`} title={s ? s[0].toUpperCase() + s.slice(1) : "No label"} onClick={() => (onClose(), it.onPick(s))} />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div key={i} className="ctx-item-wrap" onMouseEnter={() => setOpen(it.items ? i : null)}>
        <button
          className={`ctx-item ${it.danger ? "danger" : ""} ${open === i ? "open" : ""}`}
          disabled={it.disabled}
          role="menuitem"
          onClick={() => {
            if (it.items) return setOpen(i);
            onClose();
            it.run?.();
          }}
        >
          <Icon name={it.checked ? "check" : (it.icon ?? "blank")} size={15} />
          <span className="ctx-label">{it.label}</span>
          {it.shortcut && <kbd>{it.shortcut}</kbd>}
          {it.items && <Icon name="chevronRight" size={13} />}
        </button>
        {it.items && open === i && (
          <div className="ctx-menu sub">
            <MenuItems items={it.items} onClose={onClose} />
          </div>
        )}
      </div>
    );
  });
}
