import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CANVAS_PRESETS, clipEnd, clipLength, evaluateClip, formatTime, hasMedia, mediaById, projectDuration, sourceAt, videoLayers } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { readMeters, resume, route, setBleep, setLevels, unroute } from "../audioGraph.js";
import { useEditor } from "../editor.js";
import { cropPath, cssFilter, vignetteOf } from "../look.js";
import { gradeBypass, mediaElements, mediaUrl, meters, playhead, playing, sourceControl, stillFrame, useStore } from "../state.js";
import Icon from "./icons.jsx";

const DIRECT = /\.(mp4|m4v|webm|mov|mp3|wav|m4a|aac|ogg|opus|flac|png|jpe?g|webp)$/i;
const NO_GRADE = { adjust: {}, color: undefined, filter: null, lut: null, effects: [] };

function fadeGain(clip, t) {
  const rel = t - clip.start;
  let g = 1;
  if (clip.fadeIn > 0 && rel < clip.fadeIn) g *= rel / clip.fadeIn;
  const left = clipLength(clip) - rel;
  if (clip.fadeOut > 0 && left < clip.fadeOut) g *= left / clip.fadeOut;
  return Math.max(0, g);
}

// Project with one clip's grade removed (before/after compare).
function withoutGrade(project, clipId) {
  if (!clipId) return project;
  return { ...project, clips: project.clips.map((c) => (c.id === clipId ? { ...c, ...NO_GRADE, adjust: Object.fromEntries(Object.keys(c.adjust).map((k) => [k, 0])), color: { ...c.color, lift: { x: 0, y: 0, l: 0 }, gamma: { x: 0, y: 0, l: 0 }, gain: { x: 0, y: 0, l: 0 }, offset: { x: 0, y: 0, l: 0 }, curve: [[0, 0], [1, 1]] } } : c)) };
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
  const { project, source, viewer, setViewer } = useEditor();
  const { width: W, height: H, fps } = project.canvas;
  return (
    <section className="panel player">
      <div className="panel-head">
        <div className="viewer-tabs">
          {source && (
            <button className={viewer === "source" ? "active" : ""} onClick={() => setViewer("source")}>
              <Icon name="source" size={13} /> Source
            </button>
          )}
          <button className={viewer !== "source" || !source ? "active" : ""} onClick={() => setViewer("timeline")}>
            <Icon name="film" size={13} /> Timeline
          </button>
        </div>
        <span className="head-meta">
          {W}×{H} · {fps} fps
        </span>
      </div>
      {viewer === "source" && source ? <SourceView key={source.mediaId} /> : <TimelineView />}
    </section>
  );
}

function TimelineView() {
  const { project, proxies, range, apply } = useEditor();
  const wrapRef = useRef(null);
  const els = useRef(new Map());
  const refCache = useRef(new Map());
  const duck = useRef(1);
  const [stage, setStage] = useState({ w: 640, h: 360 });
  const [waiting, setWaiting] = useState(false);
  const [exact, setExact] = useState(true);
  const [still, setStill] = useState(null);
  const [ratioOpen, setRatioOpen] = useState(false);
  const isPlaying = useStore(playing);
  const bypass = useStore(gradeBypass);
  const t = useStore(playhead);
  const latest = useRef({ project, proxies, bypass });
  latest.current = { project, proxies, bypass };
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
    const { project: p, proxies: px, bypass: bp } = latest.current;
    const live = playing.get();
    let missing = false;
    let bleeping = false;
    for (const b of p.bleeps) if (now >= b.start && now < b.end) bleeping = true;
    const layers = videoLayers(p);
    const soloing = p.tracks.some((x) => x.solo && x.kind !== "text");
    // Active adjustment layers grade every layer under them.
    const adjAbove = (layerIndex) =>
      p.clips
        .filter((c) => c.adjustment && c.start <= now && clipEnd(c) > now && layers.findIndex((l) => l.id === c.trackId) > layerIndex)
        .map((c) => (c.id === bp ? "" : cssFilter(c)))
        .join(" ");
    for (const track of p.tracks) {
      if (track.kind === "text") continue;
      const slot = els.current.get(track.id);
      if (!slot) continue;
      const clip = p.clips.find((c) => c.trackId === track.id && hasMedia(c) && c.start <= now + 1e-6 && clipEnd(c) > now + 1e-6);
      const media = clip && mediaById(p, clip.mediaId);
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
      const li = layers.findIndex((l) => l.id === track.id);
      const z = String(li + 1);
      const filter = `${clip.id === bp ? "" : cssFilter(clip)} ${track.kind === "video" ? adjAbove(li) : ""}`.trim();
      const look = (node) => {
        node.style.transform = css;
        node.style.zIndex = z;
        node.style.opacity = String(v.opacity);
        node.style.filter = filter;
        node.style.clipPath = crop;
      };
      if (slot.vig) {
        slot.vig.style.opacity = String(clip.id === bp ? 0 : vignetteOf(clip));
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
      const audible = !track.muted && !(soloing && !track.solo) && !clip.muted && !bleeping;
      const ducked = track.duck.enabled && track.role !== "dialogue" ? duck.current : 1;
      setLevels(el, audible ? clip.volume * track.volume * fadeGain(clip, now) * ducked : 0, track.pan);
      if (track.kind === "video") {
        el.style.visibility = "visible";
        look(el);
      }
      if (live && el.paused) el.play().catch(() => {});
      if (!live && !el.paused) el.pause();
    }
    setWaiting(missing);
    setBleep(live && bleeping);
  };

  useEffect(() => playhead.subscribe(() => sync(playhead.get(), !playing.get())), []);
  useEffect(() => sync(playhead.get(), true), [project, proxies, bypass]);

  // Playback clock + meters + live ducking.
  useEffect(() => {
    if (!isPlaying) {
      sync(playhead.get(), true);
      meters.set({});
      return;
    }
    resume();
    const t0 = performance.now();
    const p0 = playhead.get();
    const end = range.in != null && range.out != null && range.out > p0 ? range.out : projectDuration(latest.current.project);
    let raf;
    let lastMeter = 0;
    const tick = (time) => {
      const now = p0 + (performance.now() - t0) / 1000;
      if (now >= end) {
        playhead.set(end);
        playing.set(false);
        return;
      }
      if (time - lastMeter > 50) {
        lastMeter = time;
        const levels = readMeters();
        meters.set(levels);
        const p = latest.current.project;
        const talk = Math.max(0, ...p.tracks.filter((x) => x.role === "dialogue").map((x) => levels[x.id] ?? 0));
        const amount = Math.max(0, ...p.tracks.filter((x) => x.duck.enabled).map((x) => x.duck.amount)) / 100;
        const target = talk > 0.04 ? 1 - 0.85 * amount : 1;
        duck.current += (target - duck.current) * (target < duck.current ? 0.5 : 0.08);
      }
      playhead.set(now);
      raf = requestAnimationFrame(tick);
    };
    sync(p0, true);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // Exact preview: when paused, show the real FFmpeg render of this frame.
  const stillKey = `${project.revision}:${t.toFixed(3)}:${stage.w}:${bypass ?? ""}`;
  useEffect(() => {
    if (!exact || isPlaying || !project.clips.length || t >= duration) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const file = await window.cutroom.previewFrame(withoutGrade(project, bypass), t, Math.min(1600, Math.round((stage.w * (window.devicePixelRatio || 1)) / 2) * 2));
        if (!cancelled) setStill({ url: `${mediaUrl(file)}?v=${Date.now()}`, key: stillKey });
      } catch {
        // the live preview stays visible
      }
    }, 240);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stillKey, exact, isPlaying]);
  const showStill = exact && !isPlaying && still && still.key === stillKey;
  useEffect(() => {
    stillFrame.set(showStill ? still.url : null);
  }, [showStill, still?.url]);

  const bind = (trackId, kind) => {
    const key = `${trackId}:${kind}`;
    if (!refCache.current.has(key))
      refCache.current.set(key, (node) => {
        const slot = els.current.get(trackId) ?? {};
        const old = slot[kind];
        slot[kind] = node;
        if (node && kind === "video") {
          node.crossOrigin = "anonymous";
          route(node, trackId);
          mediaElements.set(trackId, node);
        }
        if (!node && kind === "video") {
          if (old) unroute(old);
          mediaElements.delete(trackId);
        }
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

  return (
    <>
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
          {bypass && <div className="stage-badge left">Before (grade off)</div>}
          {!project.clips.length && <div className="stage-empty">Import media and drag it to the timeline</div>}
          {waiting && <div className="stage-badge">Preparing smooth preview…</div>}
        </div>
      </div>
      <div className="transport">
        <Timecode fps={fps} duration={duration} />
        <div className="transport-center">
          <button className="ghost icon-only" onClick={() => step(-1 / fps)} title="Previous frame">
            <Icon name="stepBack" />
          </button>
          <button className="play" onClick={() => playing.set(!isPlaying)} title="Play / pause (Space)">
            <Icon name={isPlaying ? "pause" : "play"} size={18} />
          </button>
          <button className="ghost icon-only" onClick={() => step(1 / fps)} title="Next frame">
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
    </>
  );
}

// Source monitor: look through a media file, mark In/Out, then insert,
// overwrite, append or place it on top of the timeline.
function SourceView() {
  const { project, proxies, source, setSource, actions } = useEditor();
  const media = mediaById(project, source.mediaId);
  const ref = useRef(null);
  const bar = useRef(null);
  const [t, setT] = useState(source.t ?? source.in ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const fps = project.canvas.fps;
  const dur = media?.kind === "image" ? 5 : media?.duration || 0;
  const ready = media && (typeof proxies[media.id] === "string" ? proxies[media.id] : DIRECT.test(media.path) ? media.path : null);
  const inn = source.in ?? 0;
  const out = source.out ?? dur;

  useEffect(() => {
    sourceControl.current = {
      toggle: () => {
        const el = ref.current;
        if (!el) return;
        if (el.paused) el.play().catch(() => {});
        else el.pause();
      },
      time: () => ref.current?.currentTime ?? t,
      seek: (x) => {
        if (ref.current) ref.current.currentTime = Math.min(Math.max(0, x), dur);
      },
    };
    return () => {
      sourceControl.current = null;
    };
  }, [dur]);
  useEffect(() => {
    if (ref.current && Number.isFinite(source.t)) ref.current.currentTime = source.t;
  }, [ready]);

  if (!media) return <div className="stage-empty">That media item is gone</div>;
  const seekAt = (clientX) => {
    const r = bar.current.getBoundingClientRect();
    const x = Math.min(Math.max(0, (clientX - r.left) / r.width), 1) * dur;
    if (ref.current) ref.current.currentTime = x;
    setT(x);
  };
  const pct = (x) => `${(x / Math.max(dur, 1e-6)) * 100}%`;
  return (
    <>
      <div className="player-stage-wrap source-wrap">
        {ready ? (
          media.kind === "image" ? (
            <img className="source-media" src={mediaUrl(ready)} alt="" />
          ) : (
            <video
              ref={ref}
              className="source-media"
              src={mediaUrl(ready)}
              crossOrigin="anonymous"
              onTimeUpdate={(e) => {
                setT(e.currentTarget.currentTime);
                setSource((s) => s && { ...s, t: e.currentTarget.currentTime });
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          )
        ) : (
          <div className="stage-empty">Preparing preview…</div>
        )}
      </div>
      <div
        className="source-bar"
        ref={bar}
        onPointerDown={(e) => {
          seekAt(e.clientX);
          const mv = (ev) => seekAt(ev.clientX);
          const up = () => {
            window.removeEventListener("pointermove", mv);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", mv);
          window.addEventListener("pointerup", up);
        }}
      >
        <div className="source-range" style={{ left: pct(inn), width: pct(out - inn) }} />
        <div className="source-head" style={{ left: pct(t) }} />
      </div>
      <div className="transport source-transport">
        <div className="timecode">
          <span className="tc-now">{formatTime(t, fps)}</span>
          <span className="muted"> · In–Out {formatTime(Math.max(0, out - inn), fps)}</span>
        </div>
        <div className="transport-center">
          <button className="ghost small" onClick={() => setSource((s) => ({ ...s, in: t }))} title="Mark In (I)">
            In
          </button>
          <button className="play" onClick={() => sourceControl.current?.toggle()} title="Play / pause (Space)">
            <Icon name={isPlaying ? "pause" : "play"} size={18} />
          </button>
          <button className="ghost small" onClick={() => setSource((s) => ({ ...s, out: t }))} title="Mark Out (O)">
            Out
          </button>
        </div>
        <div className="transport-right source-actions">
          <button className="small" onClick={() => actions.sourcePlace("insert")} title="Insert at the timeline playhead, pushing everything after it (,)">
            <Icon name="insert" size={14} /> Insert
          </button>
          <button className="small" onClick={() => actions.sourcePlace("overwrite")} title="Overwrite at the timeline playhead (.)">
            <Icon name="overwrite" size={14} /> Overwrite
          </button>
          <button className="small" onClick={() => actions.sourcePlace("append")} title="Add to the end of the main track">
            <Icon name="append" size={14} /> Append
          </button>
          <button className="small" onClick={() => actions.sourcePlace("top")} title="Place on a track above, at the playhead">
            <Icon name="layers" size={14} /> On top
          </button>
        </div>
      </div>
    </>
  );
}
