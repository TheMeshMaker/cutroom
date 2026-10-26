import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clipEnd, clipLength, formatTime, mediaById, projectDuration, transformAt, videoLayers } from "../../core/model.js";
import { mediaUrl, playhead, playing, useStore } from "../state.js";
import Icon from "./icons.jsx";

const DIRECT = /\.(mp4|m4v|webm|mov|mp3|wav|m4a|aac|ogg|opus|flac|png|jpe?g|webp)$/i;

function fadeGain(clip, t) {
  const rel = t - clip.start;
  let g = 1;
  if (clip.fadeIn > 0 && rel < clip.fadeIn) g *= rel / clip.fadeIn;
  const left = clipLength(clip) - rel;
  if (clip.fadeOut > 0 && left < clip.fadeOut) g *= left / clip.fadeOut;
  return Math.max(0, g);
}

function Timecode({ fps, duration }) {
  const t = useStore(playhead);
  return (
    <div className="timecode">
      <span>{formatTime(t, fps)}</span>
      <span className="muted"> / {formatTime(duration, fps)}</span>
    </div>
  );
}

export default function Player({ project, proxies, range }) {
  const wrapRef = useRef(null);
  const els = useRef(new Map()); // trackId -> { video, img }
  const [stage, setStage] = useState({ w: 640, h: 360 });
  const [waiting, setWaiting] = useState(false);
  const isPlaying = useStore(playing);
  const refCache = useRef(new Map());
  const audioCtx = useRef(null);
  const tone = useRef(null);
  const latest = useRef({ project, proxies });
  latest.current = { project, proxies };
  const duration = projectDuration(project);
  const { width: W, height: H, fps } = project.canvas;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      const s = Math.min(el.clientWidth / W, el.clientHeight / H);
      setStage({ w: Math.floor(W * s), h: Math.floor(H * s) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // Bring every track's media element in line with time `now`.
  const sync = (now, force) => {
    const { project: p, proxies: px } = latest.current;
    const live = playing.get();
    let missing = false;
    let bleeping = false;
    for (const b of p.bleeps) if (now >= b.start && now < b.end) bleeping = true;
    const layers = videoLayers(p);
    for (const track of p.tracks) {
      const slot = els.current.get(track.id);
      if (!slot) continue;
      const clip = p.clips.find((c) => c.trackId === track.id && c.start <= now + 1e-6 && clipEnd(c) > now + 1e-6);
      const media = clip && mediaById(p, clip.mediaId);
      const visible = clip && !(track.kind === "video" && track.hidden);
      const el = slot.video;
      if (!visible || !media) {
        if (el) {
          el.style.visibility = "hidden";
          if (!el.paused) el.pause();
        }
        if (slot.img) slot.img.style.visibility = "hidden";
        continue;
      }
      const ready = typeof px[media.id] === "string" ? px[media.id] : DIRECT.test(media.path) ? media.path : null;
      if (!ready) {
        missing = true;
        if (el) el.style.visibility = "hidden";
        continue;
      }
      const tr = transformAt(clip, now - clip.start);
      const css = `translate(${tr.x * 100}%, ${tr.y * 100}%) scale(${tr.scale})`;
      const z = String(layers.findIndex((l) => l.id === track.id) + 1);
      if (media.kind === "image") {
        if (el) el.style.visibility = "hidden";
        const img = slot.img;
        if (img) {
          const url = mediaUrl(ready);
          if (img.dataset.src !== url) {
            img.src = url;
            img.dataset.src = url;
          }
          img.style.visibility = "visible";
          img.style.transform = css;
          img.style.zIndex = z;
        }
        continue;
      }
      if (slot.img) slot.img.style.visibility = "hidden";
      const url = mediaUrl(ready);
      const want = clip.in + (now - clip.start);
      if (el.dataset.src !== url) {
        el.src = url;
        el.dataset.src = url;
        el.dataset.pending = String(want);
      } else if (el.readyState >= 1) {
        const drift = Math.abs(el.currentTime - want);
        if (force || drift > (live ? 0.3 : 0.02)) el.currentTime = want;
      } else el.dataset.pending = String(want);
      const gain = track.muted || clip.muted || bleeping ? 0 : clip.volume * fadeGain(clip, now);
      el.volume = Math.min(1, gain);
      el.muted = gain <= 0;
      if (track.kind === "video") {
        el.style.visibility = "visible";
        el.style.transform = css;
        el.style.zIndex = z;
      }
      if (live && el.paused) el.play().catch(() => {});
      if (!live && !el.paused) el.pause();
    }
    setWaiting(missing);
    if (tone.current) tone.current.gain.setTargetAtTime(live && bleeping ? 0.12 : 0, audioCtx.current.currentTime, 0.005);
  };

  useEffect(() => playhead.subscribe(() => sync(playhead.get(), !playing.get())), []);
  useEffect(() => sync(playhead.get(), true), [project, proxies]);

  // Playback clock.
  useEffect(() => {
    if (!isPlaying) {
      sync(playhead.get(), true);
      return;
    }
    if (!audioCtx.current) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1000;
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      audioCtx.current = ctx;
      tone.current = gain;
    }
    audioCtx.current.resume();
    const t0 = performance.now();
    const p0 = playhead.get();
    const end = range.in != null && range.out != null && range.out > p0 ? range.out : projectDuration(latest.current.project);
    let raf;
    const tick = () => {
      const now = p0 + (performance.now() - t0) / 1000;
      if (now >= end) {
        playhead.set(end);
        playing.set(false);
        return;
      }
      playhead.set(now);
      raf = requestAnimationFrame(tick);
    };
    sync(p0, true);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // Stable ref callbacks so re-renders don't detach media elements.
  const bind = (trackId, kind) => {
    const key = `${trackId}:${kind}`;
    if (!refCache.current.has(key))
      refCache.current.set(key, (node) => {
        const slot = els.current.get(trackId) ?? {};
        slot[kind] = node;
        if (node) els.current.set(trackId, slot);
        else if (!slot.video && !slot.img) els.current.delete(trackId);
      });
    return refCache.current.get(key);
  };

  const step = (d) => {
    playing.set(false);
    playhead.set(Math.min(Math.max(0, playhead.get() + d), duration));
  };

  return (
    <section className="panel player">
      <div className="player-stage-wrap" ref={wrapRef}>
        <div className="player-stage" style={{ width: stage.w, height: stage.h }}>
          {project.tracks.map((track) =>
            track.kind === "video" ? (
              <div key={track.id} className="layer">
                <video
                  ref={bind(track.id, "video")}
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    const want = Number(e.currentTarget.dataset.pending);
                    if (Number.isFinite(want)) e.currentTarget.currentTime = want;
                    delete e.currentTarget.dataset.pending;
                  }}
                />
                <img ref={bind(track.id, "img")} alt="" />
              </div>
            ) : (
              <audio
                key={track.id}
                ref={bind(track.id, "video")}
                preload="auto"
                onLoadedMetadata={(e) => {
                  const want = Number(e.currentTarget.dataset.pending);
                  if (Number.isFinite(want)) e.currentTarget.currentTime = want;
                  delete e.currentTarget.dataset.pending;
                }}
              />
            ),
          )}
          {!project.clips.length && <div className="stage-empty">Import a recording to start</div>}
          {waiting && <div className="stage-badge">Preparing smooth preview…</div>}
        </div>
      </div>
      <div className="transport">
        <button className="ghost icon-only" onClick={() => step(-1 / fps)} title="Previous frame (←)">
          <Icon name="stepBack" />
        </button>
        <button className="play" onClick={() => playing.set(!isPlaying)} title="Play / pause (Space)">
          <Icon name={isPlaying ? "pause" : "play"} size={18} />
        </button>
        <button className="ghost icon-only" onClick={() => step(1 / fps)} title="Next frame (→)">
          <Icon name="stepFwd" />
        </button>
        <Timecode fps={fps} duration={duration} />
        <div className="canvas-tag">
          {W}×{H} · {fps} fps
        </div>
      </div>
    </section>
  );
}
