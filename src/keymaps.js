// Keyboard presets so people coming from another editor keep their muscle
// memory. Keys are matched by physical key (e.code), so shortcuts work the
// same with any keyboard layout (Arabic included).

const COMMON = {
  space: "play",
  "ctrl+z": "undo",
  "ctrl+shift+z": "redo",
  "ctrl+y": "redo",
  "ctrl+c": "copy",
  "ctrl+v": "paste",
  "ctrl+i": "import",
  "ctrl+shift+p": "palette",
  i: "markIn",
  o: "markOut",
  m: "marker",
  p: "punchIn",
  "shift+b": "bleep",
  arrowleft: "prevFrame",
  arrowright: "nextFrame",
  "shift+arrowleft": "prevSecond",
  "shift+arrowright": "nextSecond",
  home: "start",
  end: "end",
  escape: "escape",
  j: "back5",
  k: "pause",
  l: "play",
  ",": "sourceInsert",
  ".": "sourceOverwrite",
  "shift+m": "nextMarker",
  "ctrl+shift+m": "prevMarker",
};

export const KEYMAPS = {
  capcut: {
    label: "CapCut",
    keys: {
      ...COMMON,
      "ctrl+b": "split",
      q: "deleteLeft",
      w: "deleteRight",
      delete: "remove",
      backspace: "remove",
      "shift+delete": "rippleRemove",
      a: "toolSelect",
      b: "toolBlade",
      n: "snap",
      x: "clearRange",
      "shift+z": "fit",
      "ctrl+=": "zoomIn",
      "ctrl+-": "zoomOut",
      "ctrl+e": "export",
    },
  },
  premiere: {
    label: "Premiere Pro",
    keys: {
      ...COMMON,
      "ctrl+k": "split",
      "ctrl+shift+k": "splitAll",
      q: "deleteLeft",
      w: "deleteRight",
      delete: "remove",
      backspace: "remove",
      "alt+backspace": "rippleRemove",
      "shift+delete": "rippleRemove",
      v: "toolSelect",
      c: "toolBlade",
      n: "toolRoll",
      y: "toolSlip",
      s: "snap",
      d: "selectAtPlayhead",
      "\\": "fit",
      "=": "zoomIn",
      "-": "zoomOut",
      "ctrl+m": "export",
      "ctrl+shift+x": "clearRange",
    },
  },
  resolve: {
    label: "DaVinci Resolve",
    keys: {
      ...COMMON,
      "ctrl+b": "split",
      "ctrl+\\": "splitAll",
      "ctrl+shift+[": "deleteLeft",
      "ctrl+shift+]": "deleteRight",
      backspace: "remove",
      delete: "rippleRemove",
      a: "toolSelect",
      b: "toolBlade",
      t: "toolRoll",
      n: "snap",
      "alt+x": "clearRange",
      "shift+z": "fit",
      "ctrl+=": "zoomIn",
      "ctrl+-": "zoomOut",
      "ctrl+e": "export",
    },
  },
};

const CODE_KEYS = { Space: "space", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Equal: "=", Minus: "-", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Backquote: "`", NumpadAdd: "=", NumpadSubtract: "-" };

export function comboOf(e) {
  let key = CODE_KEYS[e.code];
  if (!key) {
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else key = e.key.toLowerCase();
  }
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  return [...mods, key].join("+");
}

export function actionFor(e, keymap) {
  return (KEYMAPS[keymap] ?? KEYMAPS.capcut).keys[comboOf(e)] ?? null;
}

// Shortcut label for an action in a keymap (first binding), for menus.
export function shortcutFor(action, keymap) {
  const entry = Object.entries((KEYMAPS[keymap] ?? KEYMAPS.capcut).keys).find(([, a]) => a === action);
  if (!entry) return "";
  return entry[0]
    .split("+")
    .map((k) => ({ ctrl: "Ctrl", alt: "Alt", shift: "Shift", space: "Space", arrowleft: "←", arrowright: "→", delete: "Del", backspace: "Backspace", escape: "Esc", home: "Home", end: "End" })[k] ?? k.toUpperCase())
    .join("+");
}
