import { useMemo, useState } from "react";
import { CANVAS_PRESETS, clipLength, formatTime, projectDuration, transformAt } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { PUNCH_DEFAULTS } from "../presets.js";
import { api, playhead, useStore } from "../state.js";
import Icon from "./icons.jsx";

const PUNCHES = [
  { label: "Quick 1.3×", opts: PUNCH_DEFAULTS },
  { label: "Big 1.6×", opts: { scale: 1.6, ramp: 0.1, hold: 0.9, release: 0.2 } },
  { label: "Slow push", opts: { scale: 1.15, ramp: 1.5, hold: null } },
];

export default function Inspector(props) {
  const { clip, bleep } = props;
  return (
    <aside className="panel inspector">
      <div className="panel-head">
        <span>{clip ? "Clip" : bleep ? "Bleep" : "Project"}</span>
      </div>
      <div className="panel-body">
        {clip ? <ClipPanel {...props} /> : bleep ? <BleepPanel {...props} /> : <ProjectPanel {...props} />}
      </div>
    </aside>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function Slider({ value, min, max, step, onChange, format = (v) => v }) {
  return (
    <>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="value">{format(value)}</span>
    </>
  );
}

function NumberInput({ value, onCommit, step = 0.1, min, max }) {
  const [draft, setDraft] = useState(null);
  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft ?? Number(value.toFixed(3))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null && draft !== "" && Number.isFinite(Number(draft))) onCommit(Number(draft));
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

function ClipPanel({ project, clip, apply, onPunchIn, mediaOf }) {
  const t = useStore(playhead);
  const media = mediaOf(clip.mediaId);
  const len = clipLength(clip);
  const rel = t - clip.start;
  const inside = rel >= 0 && rel <= len;
  const at = Math.min(Math.max(rel, 0), len);
  const tr = transformAt(clip, at);
  const fps = project.canvas.fps;
  const [hold, setHold] = useState(PUNCH_DEFAULTS.hold);

  const setTransform = (key, value) => {
    if (clip.keyframes.length) apply((p) => ops.setKeyframe(p, clip.id, at, { ...tr, [key]: value }), { coalesce: `kf-${clip.id}-${key}` });
    else apply((p) => ops.setClip(p, clip.id, { transform: { [key]: value } }), { coalesce: `tr-${clip.id}-${key}` });
  };

  return (
    <>
      <div className="clip-title">
        <Icon name={media.kind === "audio" ? "music" : media.kind === "image" ? "image" : "film"} />
        <span title={media.path}>{media.name}</span>
      </div>
      <div className="facts">
        <div>
          <span>Start</span>
          {formatTime(clip.start, fps)}
        </div>
        <div>
          <span>Length</span>
          {len.toFixed(2)} s
        </div>
        <div>
          <span>Source</span>
          {formatTime(clip.in, fps)} → {formatTime(clip.out, fps)}
        </div>
      </div>

      {media.hasAudio && (
        <section className="group">
          <h4>Audio</h4>
          <Field label="Volume">
            <Slider value={Math.round(clip.volume * 100)} min={0} max={200} step={1} format={(v) => `${v}%`} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { volume: v / 100 }), { coalesce: `vol-${clip.id}` })} />
          </Field>
          <div className="row-2">
            <Field label="Fade in (s)">
              <NumberInput value={clip.fadeIn} min={0} onCommit={(v) => apply((p) => ops.setClip(p, clip.id, { fadeIn: Math.max(0, v) }))} />
            </Field>
            <Field label="Fade out (s)">
              <NumberInput value={clip.fadeOut} min={0} onCommit={(v) => apply((p) => ops.setClip(p, clip.id, { fadeOut: Math.max(0, v) }))} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={clip.muted} onChange={(e) => apply((p) => ops.setClip(p, clip.id, { muted: e.target.checked }))} /> Mute this clip
          </label>
        </section>
      )}

      {media.hasVideo && (
        <section className="group">
          <h4>
            Framing {clip.keyframes.length > 0 && <span className="pill">{clip.keyframes.length} keyframes</span>}
          </h4>
          <Field label="Zoom">
            <Slider value={Math.round(tr.scale * 100)} min={50} max={300} step={1} format={(v) => `${v}%`} onChange={(v) => setTransform("scale", v / 100)} />
          </Field>
          <Field label="Pan X">
            <Slider value={Math.round(tr.x * 100)} min={-50} max={50} step={1} format={(v) => `${v}%`} onChange={(v) => setTransform("x", v / 100)} />
          </Field>
          <Field label="Pan Y">
            <Slider value={Math.round(tr.y * 100)} min={-50} max={50} step={1} format={(v) => `${v}%`} onChange={(v) => setTransform("y", v / 100)} />
          </Field>
          <div className="button-row">
            <button className="small" disabled={!inside} onClick={() => apply((p) => ops.setKeyframe(p, clip.id, at, tr))} title="Keyframe the current framing at the playhead">
              <Icon name="diamond" size={12} /> Keyframe here
            </button>
            <button className="small" onClick={() => apply((p) => ops.setClip(ops.clearKeyframes(p, clip.id), clip.id, { transform: { scale: 1, x: 0, y: 0 } }))}>
              Reset
            </button>
          </div>
          {clip.keyframes.length > 0 && (
            <ul className="kf-list">
              {clip.keyframes.map((k) => (
                <li key={k.t}>
                  <button className="link" onClick={() => playhead.set(clip.start + k.t)}>
                    {formatTime(clip.start + k.t, fps)}
                  </button>
                  <span>{Math.round(k.scale * 100)}%</span>
                  <button className="ghost icon-only tiny" onClick={() => apply((p) => ops.removeKeyframe(p, clip.id, k.t))} title="Remove keyframe">
                    <Icon name="trash" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h4 className="sub">Punch-in at playhead</h4>
          <div className="button-row wrap">
            {PUNCHES.map((x) => (
              <button key={x.label} className="small" disabled={!inside} onClick={() => onPunchIn({ ...x.opts, hold: x.opts.hold == null ? null : hold })}>
                {x.label}
              </button>
            ))}
          </div>
          <Field label="Hold (s)" hint="How long a punch-in stays zoomed before easing back.">
            <NumberInput value={hold} min={0} onCommit={(v) => setHold(Math.max(0, v))} />
          </Field>
        </section>
      )}
    </>
  );
}

function BleepPanel({ project, bleep, apply, setSelection }) {
  const fps = project.canvas.fps;
  return (
    <section className="group">
      <h4>Bleep</h4>
      <p className="muted small">Mutes every track and plays a 1 kHz tone.</p>
      <div className="row-2">
        <Field label="Start (s)">
          <NumberInput value={bleep.start} onCommit={(v) => apply((p) => ops.setBleep(p, bleep.id, { start: Math.min(v, bleep.end - 0.05) }))} />
        </Field>
        <Field label="End (s)">
          <NumberInput value={bleep.end} onCommit={(v) => apply((p) => ops.setBleep(p, bleep.id, { end: Math.max(v, bleep.start + 0.05) }))} />
        </Field>
      </div>
      <div className="facts">
        <div>
          <span>At</span>
          {formatTime(bleep.start, fps)}
        </div>
        <div>
          <span>Length</span>
          {(bleep.end - bleep.start).toFixed(2)} s
        </div>
      </div>
      <button
        className="small danger"
        onClick={() => {
          apply((p) => ops.removeBleep(p, bleep.id));
          setSelection({ clips: [], bleep: null, markers: [] });
        }}
      >
        <Icon name="trash" size={12} /> Remove bleep
      </button>
    </section>
  );
}

function ProjectPanel({ project, apply, notify, selection, setSelection }) {
  const [noise, setNoise] = useState(-35);
  const [minDur, setMinDur] = useState(2.5);
  const [pad, setPad] = useState(0.35);
  const [busy, setBusy] = useState(false);
  const audible = useMemo(() => {
    const used = new Set(project.clips.map((c) => c.mediaId));
    return project.media.filter((m) => used.has(m.id) && m.hasAudio);
  }, [project]);
  const [source, setSource] = useState(null);
  const sourceId = source ?? (audible.find((m) => !m.hasVideo) ?? audible[0])?.id;
  const pauses = project.markers.filter((m) => m.end != null);
  const pauseTotal = pauses.reduce((s, m) => s + (m.end - m.time), 0);
  const selected = pauses.filter((m) => selection.markers.includes(m.id));
  const canvasKey = Object.entries(CANVAS_PRESETS).find(([, v]) => v.width === project.canvas.width && v.height === project.canvas.height && v.fps === project.canvas.fps)?.[0] ?? "custom";

  const findPauses = async () => {
    const media = project.media.find((m) => m.id === sourceId);
    if (!media) return;
    setBusy(true);
    try {
      const raw = await api.silence(media, { noise, minDuration: minDur });
      const shrunk = raw.map(([a, b]) => [a + pad, b - pad]).filter(([a, b]) => b - a > 0.2);
      const ranges = ops.sourceRangesToTimeline(project, media.id, shrunk);
      apply((p) => {
        let next = ops.removeMarkers(p, p.markers.filter((m) => m.end != null).map((m) => m.id));
        for (const [a, b] of ranges) next = ops.addMarker(next, a, { end: b, label: "pause", color: "pause" });
        return next;
      });
      const total = ranges.reduce((s, [a, b]) => s + b - a, 0);
      notify(ranges.length ? `Found ${ranges.length} pauses (${total.toFixed(1)} s). Review them on the Pauses lane.` : "No pauses that long were found.");
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const cut = (list) => {
    apply((p) => ops.removeRanges(p, list.map((m) => [m.time, m.end])));
    setSelection({ clips: [], bleep: null, markers: [] });
    notify(`Cut ${list.length} pause${list.length === 1 ? "" : "s"}`);
  };

  return (
    <>
      <section className="group">
        <h4>Project</h4>
        <Field label="Name">
          <input defaultValue={project.name} key={project.name} onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && apply((p) => ({ ...p, name: e.target.value.trim(), revision: p.revision + 1 }))} />
        </Field>
        <Field label="Canvas">
          <select value={canvasKey} onChange={(e) => apply((p) => ops.setCanvas(p, CANVAS_PRESETS[e.target.value]))}>
            {canvasKey === "custom" && (
              <option value="custom">
                {project.canvas.width}×{project.canvas.height} · {project.canvas.fps} fps
              </option>
            )}
            {Object.entries(CANVAS_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {k} · {v.width}×{v.height} · {v.fps} fps
              </option>
            ))}
          </select>
        </Field>
        <div className="facts">
          <div>
            <span>Duration</span>
            {formatTime(projectDuration(project), project.canvas.fps)}
          </div>
          <div>
            <span>Clips</span>
            {project.clips.length}
          </div>
          <div>
            <span>Bleeps</span>
            {project.bleeps.length}
          </div>
        </div>
      </section>

      <section className="group">
        <h4>Find long pauses</h4>
        <p className="muted small">Marks stretches where the chosen audio stays quiet, so you can review and cut only the real stalls.</p>
        <Field label="Listen to">
          <select value={sourceId ?? ""} onChange={(e) => setSource(e.target.value)} disabled={!audible.length}>
            {audible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row-3">
          <Field label="Quiet below (dB)">
            <NumberInput value={noise} step={1} onCommit={setNoise} />
          </Field>
          <Field label="Longer than (s)">
            <NumberInput value={minDur} onCommit={(v) => setMinDur(Math.max(0.3, v))} />
          </Field>
          <Field label="Keep (s)">
            <NumberInput value={pad} step={0.05} onCommit={(v) => setPad(Math.max(0, v))} />
          </Field>
        </div>
        <button className="small" onClick={findPauses} disabled={busy || !audible.length}>
          <Icon name="pause2" size={12} /> {busy ? "Listening…" : "Find pauses"}
        </button>
        {pauses.length > 0 && (
          <div className="pause-actions">
            <div className="muted small">
              {pauses.length} pauses · {pauseTotal.toFixed(1)} s. Click one on the Pauses lane (Shift to add) to cut only those.
            </div>
            <div className="button-row wrap">
              {selected.length > 0 && (
                <button className="small primary" onClick={() => cut(selected)}>
                  Cut {selected.length} selected
                </button>
              )}
              <button className="small" onClick={() => cut(pauses)}>
                Cut all ({pauseTotal.toFixed(1)} s)
              </button>
              <button className="small ghost" onClick={() => apply((p) => ops.removeMarkers(p, pauses.map((m) => m.id)))}>
                Clear
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="group shortcuts">
        <h4>Shortcuts</h4>
        <dl>
          <dt>Space</dt>
          <dd>Play / pause</dd>
          <dt>S</dt>
          <dd>Split at playhead</dd>
          <dt>Del / Shift+Del</dt>
          <dd>Delete / ripple delete</dd>
          <dt>P</dt>
          <dd>Punch-in zoom</dd>
          <dt>B</dt>
          <dd>Bleep (playhead or I–O)</dd>
          <dt>I / O / X</dt>
          <dd>Range in / out / clear</dd>
          <dt>M</dt>
          <dd>Marker</dd>
          <dt>← → (Shift)</dt>
          <dd>Frame (1 s) step</dd>
          <dt>Ctrl+Z / Ctrl+Y</dt>
          <dd>Undo / redo</dd>
          <dt>Ctrl+wheel</dt>
          <dd>Zoom timeline</dd>
        </dl>
      </section>
    </>
  );
}
