import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CANVAS_PRESETS, clipEnd, clipLength, evaluateClip, formatTime, isText, mediaById, projectDuration, sourceAt, videoLayers } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { useEditor } from "../editor.js";
import { cropPath, cssFilter, vignetteOf } from "../look.js";
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
      <span className="tc-now">{formatTime(t, fps)}</span>
      <span className="muted"> / {formatTime(duration, fps)}</span>
    </div>
  );
}

function TextLayer({ project, stage }) {
  const t = useStore(playhead);
  const k = stage.h / 1080;
  const tracks = project.tracks.filter((x) => x.kind === "text" && !x.hidden).reverse();
  return tracks.flatMap((track) =>
    project.clips
      .filter((c) => c.trackId === track.id && c.start <= t && clipEnd(c) > t)
      .map((c) => {
        const v = evaluateClip(c, t - c.start);
        const st = c.style;
        return (
          <div
            key={c.id}
            className="text-overlay"
            style={{
              left: `${(0.5 + v.x) * 100}%`,
              top: `${(0.5 + v.y) * 100}%`,
              opacity: v.opacity,
              fontFamily: `"${st.font}"`,
              fontWeight: st.bold ? 700 : 400,
              fontSize: `${st.size * k * c.transform.scale}px`,
              color: st.color,
              WebkitTextStroke: st.strokeWidth ? `${st.strokeWidth * k * 2}px ${st.strokeColor}` : undefined,
              background: st.bg ? `#${st.bg.slice(1)}` : undefined,
              padding: st.bg ? `${st.size * 0.3 * k}px` : undefined,
              textShadow: st.shadow ? `${4 * k}px ${4 * k}px 0 #000b` : undefined,
            }}
          >
            {c.text}
          </div>
        );
      }),
  );
}

export default function Player() {
  const { project, proxies, range, apply } = useEditor();
  const wrapRef = useRef(null);
  const els = useRef(new Map());
  const refCache = useRef(new Map());
  const [stage, setStage] = useState({ w: 640, h: 360 });
  const [waiting, setWaiting] = useState(false);
  const [exact, setExact] = useState(true);
  const [still, setStill] = useState(null); // { url, key }
  const [ratioOpen, setRatioOpen] = useState(false);
  const isPlaying = useStore(playing);
  const t = useStore(playhead);
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

  const sync = (now, force) => {
    const { project: p, proxies: px } = latest.current;
    const live = playing.get();
    let missing = false;
    let bleeping = false;
    for (const b of p.bleeps) if (now >= b.start && now < b.end) bleeping = true;
    const layers = videoLayers(p);
    for (const track of p.tracks) {
      if (track.kind === "text") continue;
      const slot = els.current.get(track.id);
      if (!slot) continue;
      const clip = p.clips.find((c) => c.trackId === track.id && c.start <= now + 1e-6 && clipEnd(c) > now + 1e-6);
      const media = clip && !isText(clip) && mediaById(p, clip.mediaId);
      const visible = media && !(track.kind === "video" && track.hidden);
      const el = slot.video;
      const hideAll = () => {
        if (el) {
          el.style.visibility = "hidden";
          if (!el.paused) el.pause();
        }
        if (slot.img) slot.img.style.visibility = "hidden";
        if (slot.vig) slot.vig.style.opacity = "0";
      };
      if (!visible) {
        hideAll();
        continue;
      }
      const ready = typeof px[media.id] === "string" ? px[media.id] : DIRECT.test(media.path) ? media.path : null;
      if (!ready) {
        missing = true;
        hideAll();
        continue;
      }
      const v = evaluateClip(clip, now - clip.start);
      const css = `translate(${v.x * 100}%, ${v.y * 100}%) rotate(${v.rotation}deg) scale(${v.scale}) scale(${clip.flipH ? -1 : 1}, ${clip.flipV ? -1 : 1})`;
      const crop = clip.flipH || clip.flipV ? cropPath({ crop: { l: clip.flipH ? clip.crop.r : clip.crop.l, r: clip.flipH ? clip.crop.l : clip.crop.r, t: clip.flipV ? clip.crop.b : clip.crop.t, b: clip.flipV ? clip.crop.t : clip.crop.b } }) : cropPath(clip);
      const z = String(layers.findIndex((l) => l.id === track.id) + 1);
      const look = (node) => {
        node.style.transform = css;
        node.style.zIndex = z;
        node.style.opacity = String(v.opacity);
        node.style.filter = cssFilter(clip);
        node.style.clipPath = crop;
      };
      if (slot.vig) {
        slot.vig.style.opacity = String(vignetteOf(clip));
        slot.vig.style.zIndex = z;
      }
      if (media.kind === "image") {
        if (el) el.style.visibility = "hidden";
        if (slot.img) {
          const url = mediaUrl(ready);
          if (slot.img.dataset.src !== url) {
            slot.img.src = url;
            slot.img.dataset.src = url;
          }
          slot.img.style.visibility = "visible";
          look(slot.img);
        }
        continue;
      }
      if (slot.img) slot.img.style.visibility = "hidden";
      const url = mediaUrl(ready);
      const want = sourceAt(clip, now);
      if (el.dataset.src !== url) {
        el.src = url;
        el.dataset.src = url;
        el.dataset.pending = String(want);
      } else if (el.readyState >= 1) {
        const drift = Math.abs(el.currentTime - want);
        if (force || drift > (live ? 0.3 : 0.02)) el.currentTime = want;
      } else el.dataset.pending = String(want);
      el.playbackRate = Math.min(16, Math.max(0.0625, clip.speed));
      const gain = track.muted || clip.muted || bleeping ? 0 : clip.volume * fadeGain(clip, now);
      el.volume = Math.min(1, gain);
      el.muted = gain <= 0;
      if (track.kind === "video") {
        el.style.visibility = "visible";
        look(el);
      }
      if (live && el.paused) el.play().catch(() => {});
      if (!live && !el.paused) el.pause();
    }
    setWaiting(missing);
    if (tone.current) tone.current.gain.setTargetAtTime(live && bleeping ? 0.12 : 0, audioCtx.current.currentTime, 0.005);
  };

  useEffect(() => playhead.subscribe(() => sync(playhead.get(), !playing.get())), []);
  useEffect(() => sync(playhead.get(), true), [project, proxies]);

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

  // Exact preview: when paused, show the real FFmpeg render of this frame.
  const stillKey = `${project.revision}:${t.toFixed(3)}:${stage.w}`;
  useEffect(() => {
    if (!exact || isPlaying || !project.clips.length || t >= duration) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const file = await window.cutroom.previewFrame(project, t, Math.min(1600, Math.round(stage.w * (window.devicePixelRatio || 1) / 2) * 2));
        if (!cancelled) setStill({ url: `${mediaUrl(file)}?v=${Date.now()}`, key: stillKey });
      } catch {
        // live preview stays visible
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stillKey, exact, isPlaying]);

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
  const onMeta = (e) => {
    const want = Number(e.currentTarget.dataset.pending);
    if (Number.isFinite(want)) e.currentTarget.currentTime = want;
    delete e.currentTarget.dataset.pending;
  };
  const showStill = exact && !isPlaying && still && still.key === stillKey;

  return (
    <section className="panel player">
      <div className="panel-head">
        <span>Player</span>
        <span className="head-meta">{W}×{H} · {fps} fps</span>
      </div>
      <div className="player-stage-wrap" ref={wrapRef}>
        <div className="player-stage" style={{ width: stage.w, height: stage.h }}>
          {project.tracks.map((track) =>
            track.kind === "video" ? (
              <div key={track.id} className="layer">
                <video ref={bind(track.id, "video")} playsInline preload="auto" onLoadedMetadata={onMeta} />
                <img ref={bind(track.id, "img")} alt="" />
                <div ref={bind(track.id, "vig")} className="vignette" />
              </div>
            ) : track.kind === "audio" ? (
              <audio key={track.id} ref={bind(track.id, "video")} preload="auto" onLoadedMetadata={onMeta} />
            ) : null,
          )}
          <div className="text-layer">
            <TextLayer project={project} stage={stage} />
          </div>
          {showStill && <img className="exact-still" src={still.url} alt="" />}
          {!project.clips.length && <div className="stage-empty">Import media and drag it to the timeline</div>}
          {waiting && <div className="stage-badge">Preparing smooth preview…</div>}
        </div>
      </div>
      <div className="transport">
        <Timecode fps={fps} duration={duration} />
        <div className="transport-center">
          <button className="ghost icon-only" onClick={() => step(-1 / fps)} title="Previous frame (←)">
            <Icon name="stepBack" />
          </button>
          <button className="play" onClick={() => playing.set(!isPlaying)} title="Play / pause (Space)">
            <Icon name={isPlaying ? "pause" : "play"} size={18} />
          </button>
          <button className="ghost icon-only" onClick={() => step(1 / fps)} title="Next frame (→)">
            <Icon name="stepFwd" />
          </button>
        </div>
        <div className="transport-right">
          <button className={`ghost small ${exact ? "active" : ""}`} onClick={() => setExact(!exact)} title="When paused, show the exact export render of the frame">
            Exact
          </button>
          <div className="menu">
            <button className="ghost small" onClick={() => setRatioOpen(!ratioOpen)} title="Canvas / ratio">
              <Icon name="aspect" /> Ratio
            </button>
            {ratioOpen && (
              <div className="menu-pop up right">
                {Object.entries(CANVAS_PRESETS).map(([k, v]) => (
                  <button key={k} onClick={() => (apply((p) => ops.setCanvas(p, v)), setRatioOpen(false))}>
                    {k} · {v.width}×{v.height} · {v.fps}fps
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="ghost icon-only" onClick={() => wrapRef.current?.requestFullscreen?.()} title="Full screen">
            <Icon name="fullscreen" />
          </button>
        </div>
      </div>
    </section>
  );
}
