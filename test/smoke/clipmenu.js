// Right-click a main-track clip and open the Speed submenu.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = document.querySelectorAll(".track-row.main .clip")[1];
  const r = clip.getBoundingClientRect();
  clip.dispatchEvent(new MouseEvent("contextmenu", { clientX: r.left + 60, clientY: r.top + 20, bubbles: true, button: 2 }));
  await sleep(250);
  const speed = [...document.querySelectorAll(".ctx-item")].find((b) => b.textContent.includes("Speed"));
  speed?.parentElement.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  speed?.click();
  await sleep(250);
  console.error("MENU " + document.querySelectorAll(".ctx-item").length + " items");
  return "ok";
})();
