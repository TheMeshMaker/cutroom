// Smoke driver: seek to SEEK seconds, select the first main-track clip, open a
// library tab and a properties tab. Run with electron . --smoke --smoke-js=<this>.
(async () => {
  const SEEK = Number(window.__seek ?? 1.6);
  const LIB = window.__lib ?? "Effects";
  const PROP = window.__prop ?? null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = [...document.querySelectorAll(".lib-tab")].find((b) => b.textContent.includes(LIB));
  tab?.click();
  const ruler = document.querySelector(".tl-ruler");
  const r = ruler.getBoundingClientRect();
  const ticks = [...document.querySelectorAll(".tick")];
  const step = parseFloat(ticks[1].style.left) - parseFloat(ticks[0].style.left);
  // Tick labels are mm:ss or mm:ss:ff (frames at 30 fps).
  const seconds = (el) => {
    const [m, s, f = 0] = el.textContent.split(":").map(Number);
    return m * 60 + s + f / 30;
  };
  const a = seconds(ticks[0]);
  const secs = seconds(ticks[1]) - a || 1;
  const x = r.left + parseFloat(ticks[0].style.left) + ((SEEK - a) * step) / secs;
  ruler.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: r.top + 5, bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(300);
  const clip = document.querySelector(window.__clipSelector ?? ".track-row.main .clip");
  const cr = clip.getBoundingClientRect();
  clip.dispatchEvent(new PointerEvent("pointerdown", { clientX: cr.left + Math.min(200, cr.width / 2), clientY: cr.top + 30, bubbles: true, button: 0 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(300);
  if (PROP) [...document.querySelectorAll(".prop-tab")].find((b) => b.textContent.includes(PROP))?.click();
  return "ok";
})();
