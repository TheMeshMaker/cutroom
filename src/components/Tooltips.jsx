import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Styled tooltips for anything with a `title`. On hover the title moves to
// data-tip, so the browser's own tooltip doesn't show as well.
export default function Tooltips() {
  const [tip, setTip] = useState(null); // { text, x, y, below }
  const [left, setLeft] = useState(0);
  const box = useRef(null);
  const timer = useRef(0);
  const target = useRef(null);

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      target.current = null;
      setTip(null);
    };
    const over = (e) => {
      const el = e.target.closest?.("[title], [data-tip]");
      if (!el || el === target.current) return;
      if (el.hasAttribute("title")) {
        const text = el.getAttribute("title");
        el.removeAttribute("title");
        if (!text) return;
        el.dataset.tip = text;
      }
      clearTimeout(timer.current);
      target.current = el;
      setTip(null);
      timer.current = setTimeout(() => {
        if (target.current !== el || !el.isConnected || !el.dataset.tip) return;
        const r = el.getBoundingClientRect();
        const below = r.top < 70;
        setTip({ text: el.dataset.tip, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
      }, 420);
    };
    const out = (e) => {
      if (target.current && !target.current.contains(e.relatedTarget)) hide();
    };
    window.addEventListener("pointerover", over);
    window.addEventListener("pointerout", out);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", hide);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerout", out);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Keep the bubble inside the window.
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const w = box.current.offsetWidth;
    setLeft(Math.max(8, Math.min(tip.x - w / 2, window.innerWidth - w - 8)));
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className={`tooltip ${tip.below ? "below" : "above"}`} style={{ left, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  );
}
