// Smoke driver: open a page / library tab, optionally select a clip and seek.
// Set window.__page ("Color"...), __lib ("Transcript"...), __clip (CSS
// selector of a timeline clip), __strip (index on the Color page strip),
// __seek (seconds) before this runs.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel, text) => [...document.querySelectorAll(sel)].find((b) => !text || b.textContent.includes(text))?.click();
  if (window.__page) {
    click(".page-tab", window.__page);
    await sleep(800);
  }
  if (window.__lib) {
    click(".lib-tab", window.__lib);
    await sleep(300);
  }
  if (window.__clip) {
    const clip = document.querySelector(window.__clip);
    if (clip) {
      const r = clip.getBoundingClientRect();
      clip.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + Math.min(120, r.width / 2), clientY: r.top + r.height / 2, bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      await sleep(300);
    }
  }
  if (window.__strip != null) {
    document.querySelectorAll(".strip-clip")[window.__strip]?.click();
    await sleep(300);
  }
  if (window.__palette) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true }));
    await sleep(300);
    const input = document.querySelector(".palette-input input");
    if (input) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(input, window.__palette);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  if (window.__click) {
    click(window.__click[0], window.__click[1]);
    await sleep(600);
  }
  return "ok";
})();
