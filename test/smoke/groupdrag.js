// Box-select the caption clips, then drag one of them: all should move.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lefts = () => [...document.querySelectorAll(".track-row.text .clip")].map((c) => Math.round(c.getBoundingClientRect().left));
  const before = lefts();
  const lane = document.querySelector(".track-row.text .tl-lane");
  const r = lane.getBoundingClientRect();
  lane.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.right - 10, clientY: r.top + 4, bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 5, clientY: r.bottom - 4, bubbles: true }));
  await sleep(50);
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(200);
  const sel = document.querySelectorAll(".clip.selected").length;
  const clip = document.querySelectorAll(".track-row.text .clip")[1];
  const c = clip.getBoundingClientRect();
  clip.dispatchEvent(new PointerEvent("pointerdown", { clientX: c.left + 20, clientY: c.top + 8, bubbles: true, button: 0 }));
  for (let i = 1; i <= 5; i++) {
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: c.left + 20 + i * 12, clientY: c.top + 8, bubbles: true }));
    await sleep(20);
  }
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(400);
  const after = lefts();
  console.error(`SELECTED ${sel} BEFORE ${before.join(",")} AFTER ${after.join(",")}`);
  return "ok";
})();
