// Select a clip, delete it (toast with Undo), and hover a toolbar button (tooltip).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = document.querySelectorAll(".track-row.main .clip")[0];
  const r = clip.getBoundingClientRect();
  clip.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 30, clientY: r.top + 20, bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(300);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
  await sleep(400);
  const btn = document.querySelector(".tool-group.tools button:nth-child(2)");
  btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  await sleep(700);
  console.error("TOAST " + document.querySelector(".toast")?.textContent + " TIP " + document.querySelector(".tooltip")?.textContent);
  return "ok";
})();
