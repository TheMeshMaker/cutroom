// Select the second main-track clip so the Properties sliders show.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = document.querySelectorAll(".track-row.main .clip")[1];
  const r = clip.getBoundingClientRect();
  clip.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 60, clientY: r.top + r.height / 2, bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(400);
  return "ok";
})();
