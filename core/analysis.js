// Audio analysis on waveform peak envelopes (pure).

// Beat/onset times (seconds) from a peak envelope: a frame counts as a beat
// when its energy jumps well above the recent average.
export function detectBeats({ peaks, perSecond }, { sensitivity = 0.5, minGap = 0.25 } = {}) {
  const n = peaks.length;
  if (!n) return [];
  const win = Math.max(1, Math.round(perSecond * 0.75));
  const gap = Math.round(perSecond * minGap);
  const ratio = 1.8 - sensitivity; // 0..1 sensitivity -> 1.8..0.8 threshold ratio
  const beats = [];
  let sum = 0;
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    sum += peaks[i];
    if (i >= win) sum -= peaks[i - win];
    const avg = sum / Math.min(i + 1, win);
    const rising = i > 0 && peaks[i] > peaks[i - 1];
    if (rising && peaks[i] > 40 && peaks[i] > avg * ratio && i - last >= gap) {
      beats.push(i / perSecond);
      last = i;
    }
  }
  return beats;
}
