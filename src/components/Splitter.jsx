// Drag handle between panels. Reports movement in pixels since the last event.
export default function Splitter({ axis = "x", onDrag }) {
  const down = (e) => {
    e.preventDefault();
    let last = axis === "x" ? e.clientX : e.clientY;
    const move = (ev) => {
      const now = axis === "x" ? ev.clientX : ev.clientY;
      onDrag(now - last);
      last = now;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className={`splitter ${axis}`} onPointerDown={down} />;
}
