// Preview audio routing: element -> gain -> pan -> analyser -> master ->
// master analyser -> speakers. Gives live meters and lets the preview play
// volumes above 100%, pan, solo and ducking like the export does.

let ctx = null;
let master = null;
let masterAn = null;
let tone = null;
const nodes = new Map(); // HTMLMediaElement -> { gain, pan, an, trackId }

export function audioContext() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    masterAn = ctx.createAnalyser();
    masterAn.fftSize = 1024;
    master.connect(masterAn).connect(ctx.destination);
    const osc = ctx.createOscillator();
    tone = ctx.createGain();
    osc.frequency.value = 1000;
    tone.gain.value = 0;
    osc.connect(tone).connect(master);
    osc.start();
  }
  return ctx;
}

export function route(el, trackId) {
  if (nodes.has(el)) return nodes.get(el);
  const c = audioContext();
  const src = c.createMediaElementSource(el);
  const gain = c.createGain();
  const pan = c.createStereoPanner();
  const an = c.createAnalyser();
  an.fftSize = 512;
  src.connect(gain).connect(pan).connect(an).connect(master);
  const n = { gain, pan, an, trackId };
  nodes.set(el, n);
  return n;
}

// Forget an element that left the page (its nodes stop feeding the meters).
export function unroute(el) {
  const n = nodes.get(el);
  if (!n) return;
  try {
    n.an.disconnect();
  } catch {
    // already disconnected
  }
  nodes.delete(el);
}

export function setLevels(el, gain, panValue) {
  const n = nodes.get(el);
  if (!n) return;
  n.gain.gain.setTargetAtTime(gain, ctx.currentTime, 0.015);
  n.pan.pan.setTargetAtTime(panValue, ctx.currentTime, 0.015);
}

export function setBleep(on) {
  if (tone) tone.gain.setTargetAtTime(on ? 0.12 : 0, ctx.currentTime, 0.005);
}

export function resume() {
  audioContext().resume();
}

const buf = new Float32Array(1024);
const peakOf = (an) => {
  an.getFloatTimeDomainData(buf.subarray(0, an.fftSize));
  let m = 0;
  for (let i = 0; i < an.fftSize; i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
};

// Peak level (0..1+) per track id, plus "master".
export function readMeters() {
  const out = {};
  for (const n of nodes.values()) out[n.trackId] = Math.max(out[n.trackId] ?? 0, peakOf(n.an));
  if (masterAn) out.master = peakOf(masterAn);
  return out;
}
