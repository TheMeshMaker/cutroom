// Everything users pick from a library: fonts, text styles, looks (filters),
// effects, transitions, animations, voice effects and export settings.
// Pure data + small expression builders shared by the UI preview and the
// FFmpeg renderer, so both agree on what each item does.

export const FONT_DIR = "C:/Windows/Fonts";
export const FONTS = [
  { family: "Segoe UI", file: "segoeui.ttf", bold: "segoeuib.ttf" },
  { family: "Segoe UI Black", file: "seguibl.ttf" },
  { family: "Arial", file: "arial.ttf", bold: "arialbd.ttf" },
  { family: "Impact", file: "impact.ttf" },
  { family: "Bahnschrift", file: "bahnschrift.ttf" },
  { family: "Tahoma", file: "tahoma.ttf", bold: "tahomabd.ttf" },
  { family: "Calibri", file: "calibri.ttf", bold: "calibrib.ttf" },
  { family: "Georgia", file: "georgia.ttf", bold: "georgiab.ttf" },
  { family: "Verdana", file: "verdana.ttf", bold: "verdanab.ttf" },
  { family: "Trebuchet MS", file: "trebuc.ttf", bold: "trebucbd.ttf" },
  { family: "Times New Roman", file: "times.ttf", bold: "timesbd.ttf" },
  { family: "Comic Sans MS", file: "comic.ttf", bold: "comicbd.ttf" },
  { family: "Consolas", file: "consola.ttf", bold: "consolab.ttf" },
];

export function fontFile(family, bold) {
  const f = FONTS.find((x) => x.family === family) ?? FONTS[0];
  return `${FONT_DIR}/${bold && f.bold ? f.bold : f.file}`;
}

export const DEFAULT_TEXT_STYLE = {
  font: "Segoe UI",
  size: 72, // px at 1080p canvas height
  color: "#ffffff",
  bold: true,
  strokeColor: "#000000",
  strokeWidth: 0,
  bg: null, // "#rrggbbaa" box behind the text
  shadow: false,
  align: "center",
};

export const TEXT_STYLES = [
  { id: "classic", name: "Classic", style: { strokeWidth: 4 } },
  { id: "subtitle", name: "Subtitle", style: { size: 54, bold: false, bg: "#000000a6" } },
  { id: "impact", name: "Meme", style: { font: "Impact", size: 96, bold: false, strokeWidth: 6 } },
  { id: "yellow", name: "Yellow pop", style: { color: "#ffd400", strokeWidth: 5, size: 84 } },
  { id: "boxed", name: "Boxed", style: { color: "#ffffff", bg: "#e5484dff", size: 64 } },
  { id: "neon", name: "Neon", style: { color: "#39ff14", shadow: true, font: "Bahnschrift", size: 80 } },
  { id: "horror", name: "Horror", style: { color: "#c1121f", font: "Georgia", size: 88, shadow: true, strokeColor: "#000000", strokeWidth: 3 } },
  { id: "clean", name: "Clean", style: { bold: false, font: "Segoe UI", size: 64, shadow: true } },
  { id: "black", name: "Heavy", style: { font: "Segoe UI Black", bold: false, size: 92, strokeWidth: 0, shadow: true } },
  { id: "arabic", name: "عربي", style: { font: "Tahoma", size: 76, strokeWidth: 4 } },
];

// Animated title templates (Essential Graphics-style, made of one styled text
// clip each): text, look, position and in/out animation in one click.
export const TITLE_TEMPLATES = [
  { id: "lower-third", name: "Lower third", text: "Your Name\nWhat you do", duration: 4, x: -0.27, y: 0.33, style: { size: 50, bg: "#000000b3", bold: true }, animIn: { type: "slide-right", duration: 0.45 }, animOut: { type: "fade", duration: 0.4 } },
  { id: "big-title", name: "Big title", text: "TITLE", duration: 3, x: 0, y: 0, style: { font: "Segoe UI Black", size: 150, bold: false, shadow: true }, animIn: { type: "zoom-in", duration: 0.5 }, animOut: { type: "fade", duration: 0.5 } },
  { id: "chapter", name: "Chapter card", text: "Chapter 1", duration: 3, x: 0, y: -0.05, style: { font: "Georgia", size: 96, strokeWidth: 0, shadow: true }, animIn: { type: "fade", duration: 0.6 }, animOut: { type: "fade", duration: 0.6 } },
  { id: "subscribe", name: "Subscribe", text: "SUBSCRIBE ▶", duration: 3, x: 0.28, y: 0.36, style: { size: 56, bg: "#e5484dff", bold: true }, animIn: { type: "pop", duration: 0.35 }, animOut: { type: "slide-right", duration: 0.35 } },
  { id: "location", name: "Location tag", text: "📍 Somewhere", duration: 3, x: -0.33, y: -0.38, style: { size: 40, bg: "#00000099", bold: false }, animIn: { type: "slide-down", duration: 0.4 }, animOut: { type: "fade", duration: 0.3 } },
  { id: "callout", name: "Callout", text: "WAIT FOR IT…", duration: 2.5, x: 0, y: 0.3, style: { color: "#ffd400", size: 80, strokeWidth: 6 }, animIn: { type: "pop", duration: 0.3 }, animOut: { type: "zoom-out", duration: 0.3 } },
  { id: "end-card", name: "End card", text: "Thanks for watching!", duration: 5, x: 0, y: -0.25, style: { size: 84, shadow: true }, animIn: { type: "slide-up", duration: 0.5 }, animOut: { type: "fade", duration: 0.5 } },
  { id: "arabic-title", name: "عنوان", text: "العنوان", duration: 3, x: 0, y: 0.3, style: { font: "Tahoma", size: 88, strokeWidth: 5 }, animIn: { type: "fade", duration: 0.4 }, animOut: { type: "fade", duration: 0.4 } },
];

// Color adjustment keys and ranges (all default 0).
export const ADJUST_KEYS = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  exposure: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  fade: [0, 100],
  sharpen: [0, 100],
  vignette: [0, 100],
  grain: [0, 100],
};

// Looks: adjustment presets scaled by intensity, plus optional extra filters.
export const FILTERS = [
  { id: "warm", name: "Warm", adjust: { temperature: 35, saturation: 10 } },
  { id: "cool", name: "Cool", adjust: { temperature: -40, tint: 5 } },
  { id: "vivid", name: "Vivid", adjust: { saturation: 35, contrast: 15 } },
  { id: "cinematic", name: "Cinematic", adjust: { contrast: 15, saturation: -10, temperature: -10, highlights: -15, shadows: 10, vignette: 25 } },
  { id: "teal-orange", name: "Teal & Orange", adjust: { saturation: 10, contrast: 8 }, extra: (i) => `colorbalance=rs=${-0.15 * i}:bs=${0.15 * i}:rh=${0.12 * i}:bh=${-0.12 * i}` },
  { id: "faded", name: "Faded", adjust: { contrast: -20, fade: 35, saturation: -15 } },
  { id: "vintage", name: "Vintage", adjust: { temperature: 25, saturation: -25, fade: 25, vignette: 35, grain: 25 } },
  { id: "noir", name: "Noir", adjust: { saturation: -100, contrast: 30, vignette: 30 } },
  { id: "sepia", name: "Sepia", adjust: {}, extra: (i) => sepia(i) },
  { id: "horror", name: "Horror", adjust: { saturation: -55, tint: -12, contrast: 25, brightness: -8, vignette: 55 } },
  { id: "night-vision", name: "Night vision", adjust: { saturation: -100, contrast: 25, grain: 40, vignette: 50 }, extra: (i) => `colorchannelmixer=rr=${1 - 0.7 * i}:gg=1:bb=${1 - 0.7 * i}` },
  { id: "dreamy", name: "Dreamy", adjust: { brightness: 8, contrast: -12, saturation: 15, highlights: 10 } },
];

function sepia(i) {
  const m = (a, b) => (a * i + b * (1 - i)).toFixed(4);
  return `colorchannelmixer=rr=${m(0.393, 1)}:rg=${m(0.769, 0)}:rb=${m(0.189, 0)}:gr=${m(0.349, 0)}:gg=${m(0.686, 1)}:gb=${m(0.168, 0)}:br=${m(0.272, 0)}:bg=${m(0.534, 0)}:bb=${m(0.131, 1)}`;
}

// Effects. `chain(i, label)` returns filters applied to the picture (may use
// unique labels for split/blend). `motion` adds camera movement that the
// transform stage evaluates both in the preview (js) and in FFmpeg (expr, in
// terms of T = seconds into the clip and I = intensity 0..1).
export const EFFECTS = [
  { id: "shake", name: "Camera shake", motion: {
    x: { js: (T, I) => 0.008 * I * Math.sin(T * 41) + 0.006 * I * Math.sin(T * 23), expr: "0.008*I*sin(T*41)+0.006*I*sin(T*23)" },
    y: { js: (T, I) => 0.008 * I * Math.cos(T * 37) + 0.005 * I * Math.sin(T * 19), expr: "0.008*I*cos(T*37)+0.005*I*sin(T*19)" },
    scale: { js: (T, I) => 1 + 0.045 * I, expr: "1+0.045*I" },
  } },
  { id: "pulse", name: "Zoom pulse", motion: {
    scale: { js: (T, I) => 1 + 0.06 * I * Math.abs(Math.sin(T * Math.PI * 2)), expr: "1+0.06*I*abs(sin(T*PI*2))" },
  } },
  { id: "blur", name: "Blur", chain: (i) => `gblur=sigma=${(2 + 18 * i).toFixed(2)}` },
  { id: "glow", name: "Glow", chain: (i, L) => `split[${L}a][${L}b];[${L}b]gblur=sigma=18[${L}c];[${L}a][${L}c]blend=all_mode=screen:all_opacity=${(0.25 + 0.5 * i).toFixed(2)}` },
  { id: "grain", name: "Film grain", chain: (i) => `noise=alls=${Math.round(8 + 32 * i)}:allf=t+u` },
  { id: "vhs", name: "VHS", chain: (i) => `rgbashift=rh=${-Math.round(2 + 5 * i)}:bh=${Math.round(2 + 5 * i)},noise=alls=${Math.round(10 + 20 * i)}:allf=t,eq=saturation=${(1 + 0.3 * i).toFixed(2)}:contrast=1.05,boxblur=1:1` },
  { id: "rgb-split", name: "RGB split", chain: (i) => `rgbashift=rh=${-Math.round(3 + 12 * i)}:bh=${Math.round(3 + 12 * i)}:gv=${Math.round(2 * i)}` },
  { id: "pixelate", name: "Pixelate", chain: (i) => { const n = Math.round(6 + 34 * i); return `scale=trunc(iw/${n}):trunc(ih/${n}):flags=neighbor,scale=iw*${n}:ih*${n}:flags=neighbor`; } },
  { id: "bw", name: "Black & white", chain: () => "hue=s=0" },
  { id: "invert", name: "Invert", chain: () => "negate" },
  { id: "sketch", name: "Sketch", chain: () => "edgedetect=mode=colormix:high=0.2:low=0.05" },
  { id: "strobe", name: "Flash strobe", chain: (i) => `eq=brightness='${(0.35 * i).toFixed(2)}*gt(sin(t*18),0.92)':eval=frame` },
];

export const TRANSITIONS = [
  { id: "dissolve", name: "Dissolve", xfade: "fade" },
  { id: "fade-black", name: "Fade to black", xfade: "fadeblack" },
  { id: "fade-white", name: "Flash white", xfade: "fadewhite" },
  { id: "blur", name: "Blur", xfade: "hblur" },
  { id: "zoom", name: "Zoom in", xfade: "zoomin" },
  { id: "wipe-left", name: "Wipe left", xfade: "wipeleft" },
  { id: "wipe-right", name: "Wipe right", xfade: "wiperight" },
  { id: "wipe-up", name: "Wipe up", xfade: "wipeup" },
  { id: "wipe-down", name: "Wipe down", xfade: "wipedown" },
  { id: "slide-left", name: "Slide left", xfade: "slideleft" },
  { id: "slide-right", name: "Slide right", xfade: "slideright" },
  { id: "slide-up", name: "Slide up", xfade: "slideup" },
  { id: "slide-down", name: "Slide down", xfade: "slidedown" },
  { id: "smooth-left", name: "Smooth left", xfade: "smoothleft" },
  { id: "smooth-right", name: "Smooth right", xfade: "smoothright" },
  { id: "circle-open", name: "Circle open", xfade: "circleopen" },
  { id: "circle-close", name: "Circle close", xfade: "circleclose" },
  { id: "radial", name: "Radial", xfade: "radial" },
  { id: "pixelize", name: "Pixelize", xfade: "pixelize" },
  { id: "squeeze", name: "Squeeze", xfade: "squeezeh" },
  { id: "noise", name: "Noise dissolve", xfade: "dissolve" },
  { id: "distance", name: "Distance", xfade: "distance" },
];

// In/out animations. Each maps eased progress e (0 = off-screen/hidden state,
// 1 = resting) to a transform change, in js and as an expression of E.
export const ANIMATIONS = [
  { id: "fade", name: "Fade", fade: true },
  { id: "zoom-in", name: "Zoom in", fade: true, scale: { js: (e) => 0.5 + 0.5 * e, expr: "(0.5+0.5*E)" } },
  { id: "zoom-out", name: "Zoom out", fade: true, scale: { js: (e) => 1.6 - 0.6 * e, expr: "(1.6-0.6*E)" } },
  { id: "pop", name: "Pop", fade: true, scale: { js: (e) => (e < 0.7 ? 0.3 + (e / 0.7) * 0.82 : 1.12 - (0.12 * (e - 0.7)) / 0.3), expr: "if(lt(E,0.7),0.3+E/0.7*0.82,1.12-0.12*(E-0.7)/0.3)" } },
  { id: "slide-left", name: "Slide left", x: { js: (e) => 1 - e, expr: "(1-E)" } },
  { id: "slide-right", name: "Slide right", x: { js: (e) => e - 1, expr: "(E-1)" } },
  { id: "slide-up", name: "Slide up", y: { js: (e) => 1 - e, expr: "(1-E)" } },
  { id: "slide-down", name: "Slide down", y: { js: (e) => e - 1, expr: "(E-1)" } },
  { id: "spin", name: "Spin", fade: true, scale: { js: (e) => 0.4 + 0.6 * e, expr: "(0.4+0.6*E)" }, rotation: { js: (e) => -180 * (1 - e), expr: "(-180*(1-E))" } },
];

export const VOICE_EFFECTS = [
  { id: "chipmunk", name: "Chipmunk", chain: "rubberband=pitch=1.6" },
  { id: "deep", name: "Deep", chain: "rubberband=pitch=0.72" },
  { id: "monster", name: "Monster", chain: "rubberband=pitch=0.55,aecho=0.6:0.6:40:0.3" },
  { id: "robot", name: "Robot", chain: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75" },
  { id: "echo", name: "Echo", chain: "aecho=0.8:0.85:120|240:0.35|0.2" },
  { id: "cave", name: "Cave", chain: "aecho=0.8:0.9:500|1000:0.3|0.2" },
  { id: "telephone", name: "Telephone", chain: "highpass=f=400,lowpass=f=3200,acompressor=threshold=-20dB:ratio=4" },
  { id: "radio", name: "Radio", chain: "highpass=f=250,lowpass=f=5000,acompressor=threshold=-18dB:ratio=3,volume=1.2" },
  { id: "megaphone", name: "Megaphone", chain: "highpass=f=600,lowpass=f=4000,acrusher=bits=10:mode=log:aa=1,volume=1.3" },
];

export const EXPORT_RESOLUTIONS = { "720p": 720, "1080p": 1080, "1440p": 1440, "4K": 2160 };
export const EXPORT_FPS = [24, 25, 30, 50, 60];
export const EXPORT_CODECS = {
  h264: { label: "H.264", ext: "mp4" },
  hevc: { label: "HEVC (H.265)", ext: "mp4" },
  av1: { label: "AV1 (NVIDIA)", ext: "mp4" },
  prores: { label: "ProRes 422 HQ", ext: "mov" },
};
export const EXPORT_QUALITY = { high: "Higher", recommended: "Recommended", compact: "Smaller file" };

export const byId = (list, id) => list.find((x) => x.id === id);
