// Draw a selection box from empty timeline space across clips (not released,
// so the screenshot shows the box), then report what got selected.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lanes = [...document.querySelectorAll(".track-row .tl-lane")];
  const lane = lanes[lanes.length - 1];
  const r = lane.getBoundingClientRect();
  const visibleRight = document.querySelector(".tl-scroll").getBoundingClientRect().right;
  const x0 = Math.min(r.right, visibleRight) - 20;
  const y0 = r.top + r.height / 2;
  lane.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y0, bubbles: true, button: 0 }));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 - i * 90, clientY: y0 - i * 14, bubbles: true }));
    await sleep(30);
  }
  await sleep(200);
  console.error("SELECTED " + document.querySelectorAll(".clip.selected").length + " BOX " + !!document.querySelector(".marquee"));
  return "ok";
})();
