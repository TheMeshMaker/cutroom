import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "./pages.css";

// Sliders draw their filled part from --a to --b (from the left edge, or
// outward from zero on -/+ sliders, with a notch at --z). Keep them current on
// drags, on React updates (undo, a new selection) and for new sliders.
const paint = (el) => {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const span = max - min || 1;
  const pos = (x) => Math.min(100, Math.max(0, ((x - min) / span) * 100));
  const p = pos(Number(el.value));
  let a = 0;
  let b = p;
  if (min < 0 && max > 0) {
    const z = pos(0);
    a = Math.min(z, p);
    b = Math.max(z, p);
    el.dataset.bipolar = "";
    el.style.setProperty("--z", `${z}%`);
  } else delete el.dataset.bipolar;
  el.style.setProperty("--a", `${a}%`);
  el.style.setProperty("--b", `${b}%`);
};
const paintAll = () => document.querySelectorAll('input[type="range"]').forEach(paint);
document.addEventListener("input", (e) => e.target.type === "range" && paint(e.target), true);
new MutationObserver(() => requestAnimationFrame(paintAll)).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["value"] });
setInterval(paintAll, 600);

createRoot(document.getElementById("root")).render(<App />);
