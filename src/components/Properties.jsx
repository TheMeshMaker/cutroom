import { useEffect, useMemo, useRef, useState } from "react";
import { ADJUST_KEYS, ANIMATIONS, EFFECTS, FILTERS, FONTS, TEXT_STYLES, TRANSITIONS, VOICE_EFFECTS, byId } from "../../core/catalog.js";
import { CANVAS_PRESETS, clipById, clipLength, formatTime, isText, mediaById, projectDuration, transformAt } from "../../core/model.js";
import * as ops from "../../core/ops.js";
import { EMPTY_SELECTION, useEditor } from "../editor.js";
import { PUNCH_DEFAULTS } from "../presets.js";
import { api, mediaUrl, playhead, useStore } from "../state.js";
import Icon from "./icons.jsx";

export default function Properties() {
  const { project, selection } = useEditor();
  const clip = selection.clips.length === 1 ? clipById(project, selection.clips[0]) : null;
  let kind = "draft";
  let tabs = [["draft", "Draft"]];
  const marker = selection.markers.length === 1 ? project.markers.find((m) => m.id === selection.markers[0]) : null;
  if (selection.transition && clipById(project, selection.transition)) {
    kind = "transition";
    tabs = [["transition", "Transition"]];
  } else if (marker) {
    kind = "marker";
    tabs = [["marker", "Marker"]];
  } else if (clip?.adjustment) {
    kind = "adjustment";
    tabs = [["adjust", "Adjust"], ["layerfx", "Effects"]];
  } else if (clip && isText(clip)) {
    kind = "text";
    tabs = [["text", "Text"], ["animation", "Animation"]];
  } else if (clip) {
    const m = mediaById(project, clip.mediaId);
    kind = m.hasVideo ? "video" : "audio";
    tabs = m.hasVideo ? [["video", "Video"], ...(m.hasAudio ? [["audio", "Audio"]] : []), ...(m.kind !== "image" ? [["speed", "Speed"]] : []), ["animation", "Animation"], ["adjust", "Adjust"]] : [["audio", "Audio"], ["speed", "Speed"]];
  } else if (selection.bleep) {
    kind = "bleep";
    tabs = [["bleep", "Bleep"]];
  }
  const [tab, setTab] = useState(tabs[0][0]);
  const active = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  useEffect(() => setTab(tabs[0][0]), [kind]);
  return (
    <aside className="panel properties">
      <nav className="prop-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`prop-tab ${active === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
        {selection.clips.length > 1 && <span className="multi">{selection.clips.length} clips</span>}
      </nav>
      <div className="panel-body">
        {active === "draft" && <DraftPanel />}
        {active === "transition" && <TransitionPanel clip={clipById(project, selection.transition)} />}
        {active === "bleep" && <BleepPanel />}
        {active === "marker" && marker && <MarkerPanel marker={marker} />}
        {clip && active === "layerfx" && <LayerEffectsPanel clip={clip} />}
        {clip && active === "video" && <VideoPanel clip={clip} />}
        {clip && active === "audio" && <AudioPanel clip={clip} />}
        {clip && active === "speed" && <SpeedPanel clip={clip} />}
        {clip && active === "animation" && <AnimationPanel clip={clip} />}
        {clip && active === "adjust" && <AdjustPanel clip={clip} />}
        {clip && active === "text" && <TextPanel clip={clip} />}
      </div>
    </aside>
  );
}

// ---- controls

function Group({ title, children, right }) {
  return (
    <section className="group">
      {title && (
        <h4>
          <span>{title}</span>
          {right}
        </h4>
      )}
      {children}
    </section>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, format = (v) => v, kf, unit = "" }) {
  return (
    <div className="slider-row">
      <span className="sr-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(min < 0 ? 0 : min)} />
      <NumberBox value={value} step={step} onCommit={onChange} format={format} unit={unit} />
      {kf}
    </div>
  );
}

function NumberBox({ value, onCommit, step = 1, format = (v) => v, unit = "" }) {
  const [draft, setDraft] = useState(null);
  return (
    <span className="numbox">
      <input
        value={draft ?? format(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number.parseFloat(draft);
          if (draft != null && Number.isFinite(n)) onCommit(n);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            onCommit(Number(value) + (e.key === "ArrowUp" ? step : -step));
          }
        }}
      />
      {unit && <i>{unit}</i>}
    </span>
  );
}

function Toggle({ label, checked, onChange, children }) {
  return (
    <div className="toggle-row">
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </label>
      <span className="tr-label">{label}</span>
      {children}
    </div>
  );
}

function Choice({ items, value, onPick, none = "None" }) {
  return (
    <div className="choice-grid">
      {none && (
        <button className={`choice ${!value ? "active" : ""}`} onClick={() => onPick(null)}>
          {none}
        </button>
      )}
      {items.map((x) => (
        <button key={x.id} className={`choice ${value === x.id ? "active" : ""}`} onClick={() => onPick(x.id)}>
          {x.name}
        </button>
      ))}
    </div>
  );
}

const pct = (v) => Math.round(v);

// ---- clip panels

function VideoPanel({ clip }) {
  const { apply, actions } = useEditor();
  const t = useStore(playhead);
  const len = clipLength(clip);
  const at = Math.min(Math.max(t - clip.start, 0), len);
  const inside = t >= clip.start && t <= clip.start + len;
  const tr = transformAt(clip, at);
  const set = (patch, key) => apply((p) => ops.setClip(p, clip.id, patch), key ? { coalesce: `${key}-${clip.id}` } : undefined);
  const setTr = (key, value) => {
    if (clip.keyframes.length && key !== "rotation") apply((p) => ops.setKeyframe(p, clip.id, at, { ...tr, [key]: value }), { coalesce: `kf-${clip.id}-${key}` });
    else set({ transform: { [key]: value } }, `tr-${key}`);
  };
  const hasKf = clip.keyframes.some((k) => Math.abs(k.t - at) < 1e-3);
  const kfBtn = (
    <button className={`kf-btn ${hasKf ? "on" : ""} ${clip.keyframes.length ? "has" : ""}`} disabled={!inside} title={hasKf ? "Remove keyframe" : "Add keyframe at playhead"} onClick={() => apply((p) => (hasKf ? ops.removeKeyframe(p, clip.id, at) : ops.setKeyframe(p, clip.id, at, tr)))}>
      <Icon name="diamond" size={11} />
    </button>
  );
  const [hold, setHold] = useState(PUNCH_DEFAULTS.hold);
  const fxList = clip.effects;
  const look = clip.filter && byId(FILTERS, clip.filter.id);
  return (
    <>
      <Group title="Basic" right={<button className="link small" onClick={() => apply((p) => ops.setClip(ops.clearKeyframes(p, clip.id), clip.id, { transform: { scale: 1, x: 0, y: 0, rotation: 0 }, opacity: 1, flipH: false, flipV: false }))}>Reset</button>}>
        <Slider label="Scale" value={pct(tr.scale * 100)} min={10} max={400} onChange={(v) => setTr("scale", v / 100)} unit="%" kf={kfBtn} />
        <Slider label="X" value={pct(tr.x * 100)} min={-100} max={100} onChange={(v) => setTr("x", v / 100)} unit="%" kf={kfBtn} />
        <Slider label="Y" value={pct(tr.y * 100)} min={-100} max={100} onChange={(v) => setTr("y", v / 100)} unit="%" kf={kfBtn} />
        <Slider label="Rotate" value={Math.round(clip.transform.rotation)} min={-180} max={180} onChange={(v) => setTr("rotation", v)} unit="°" />
        <Slider label="Opacity" value={pct(clip.opacity * 100)} min={0} max={100} onChange={(v) => set({ opacity: v / 100 }, "op")} unit="%" />
        <div className="button-row">
          <button className={`small ${clip.flipH ? "active" : ""}`} onClick={() => set({ flipH: !clip.flipH })}><Icon name="mirror" size={14} /> Flip H</button>
          <button className={`small ${clip.flipV ? "active" : ""}`} onClick={() => set({ flipV: !clip.flipV })}><Icon name="mirror" size={14} className="rot90" /> Flip V</button>
        </div>
        {clip.keyframes.length > 0 && <div className="muted small">{clip.keyframes.length} keyframes · edits at the playhead update the keyframe there</div>}
      </Group>
      <Group title="Punch-in zoom">
        <div className="button-row wrap">
          <button className="small" disabled={!inside} onClick={() => actions.punchIn({ ...PUNCH_DEFAULTS, hold })}>Quick 1.3×</button>
          <button className="small" disabled={!inside} onClick={() => actions.punchIn({ scale: 1.6, ramp: 0.1, hold, release: 0.2 })}>Big 1.6×</button>
          <button className="small" disabled={!inside} onClick={() => actions.punchIn({ scale: 1.15, ramp: 1.5, hold: null })}>Slow push</button>
        </div>
        <Slider label="Hold" value={hold} min={0} max={5} step={0.1} onChange={setHold} unit="s" format={(v) => v.toFixed(1)} />
      </Group>
      <Group title="Crop" right={<button className="link small" onClick={() => set({ crop: { l: 0, t: 0, r: 0, b: 0 } })}>Reset</button>}>
        {["l", "t", "r", "b"].map((k) => (
          <Slider key={k} label={{ l: "Left", t: "Top", r: "Right", b: "Bottom" }[k]} value={pct(clip.crop[k] * 100)} min={0} max={45} onChange={(v) => set({ crop: { [k]: v / 100 } }, `crop-${k}`)} unit="%" />
        ))}
      </Group>
      <Group title="Chroma key">
        <Toggle label="Remove a color" checked={clip.chroma.enabled} onChange={(v) => set({ chroma: { enabled: v } })}>
          <input type="color" value={clip.chroma.color} onChange={(e) => set({ chroma: { color: e.target.value } }, "chroma-c")} />
        </Toggle>
        {clip.chroma.enabled && (
          <>
            <Slider label="Strength" value={pct(clip.chroma.similarity * 100)} min={1} max={100} onChange={(v) => set({ chroma: { similarity: v / 100 } }, "chroma-s")} />
            <Slider label="Edge" value={pct(clip.chroma.blend * 100)} min={0} max={100} onChange={(v) => set({ chroma: { blend: v / 100 } }, "chroma-b")} />
          </>
        )}
      </Group>
      <Group title="Clean up">
        <Toggle label="Reduce camera shake" checked={clip.stabilize.enabled} onChange={(v) => set({ stabilize: { enabled: v } })} />
        {clip.stabilize.enabled && <Slider label="Level" value={clip.stabilize.strength} min={0} max={100} onChange={(v) => set({ stabilize: { strength: v } }, "stab")} />}
        <Toggle label="Reduce video noise (grain, low light)" checked={clip.videoDenoise > 0} onChange={(v) => set({ videoDenoise: v ? 40 : 0 })} />
        {clip.videoDenoise > 0 && <Slider label="Strength" value={clip.videoDenoise} min={1} max={100} onChange={(v) => set({ videoDenoise: v }, "vdn")} />}
      </Group>
      <Group title="Effects">
        {!fxList.length && <div className="muted small">Add from the Effects tab.</div>}
        {fxList.map((fx) => (
          <div key={fx.id} className="applied">
            <span>{byId(EFFECTS, fx.id)?.name}</span>
            <input type="range" min="0" max="100" value={fx.intensity} onChange={(e) => set({ effects: fxList.map((x) => (x.id === fx.id ? { ...x, intensity: Number(e.target.value) } : x)) }, `fx-${fx.id}`)} />
            <button className="ghost icon-only tiny" onClick={() => set({ effects: fxList.filter((x) => x.id !== fx.id) })}><Icon name="trash" size={12} /></button>
          </div>
        ))}
      </Group>
      <Group title="Filter">
        {!look && <div className="muted small">Pick one in the Filters tab.</div>}
        {look && (
          <div className="applied">
            <span>{look.name}</span>
            <input type="range" min="0" max="100" value={clip.filter.intensity} onChange={(e) => set({ filter: { ...clip.filter, intensity: Number(e.target.value) } }, "filter")} />
            <button className="ghost icon-only tiny" onClick={() => set({ filter: null })}><Icon name="trash" size={12} /></button>
          </div>
        )}
      </Group>
    </>
  );
}

function AudioPanel({ clip }) {
  const { apply, project, notify } = useEditor();
  const set = (patch, key) => apply((p) => ops.setClip(p, clip.id, patch), key ? { coalesce: `${key}-${clip.id}` } : undefined);
  const a = clip.audio;
  const [busy, setBusy] = useState(false);
  const player = useRef(null);
  const hear = async () => {
    const start = Math.max(clip.start, Math.min(playhead.get(), clip.start + clipLength(clip) - 0.5));
    setBusy(true);
    try {
      const file = await api.audioSnippet(project, [start, Math.min(start + 6, clip.start + clipLength(clip))]);
      player.current.src = `${mediaUrl(file)}?v=${Date.now()}`;
      player.current.play();
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Group title="Basic">
        <Slider label="Volume" value={pct(clip.volume * 100)} min={0} max={400} onChange={(v) => set({ volume: v / 100 }, "vol")} unit="%" />
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={Math.min(10, clipLength(clip))} step={0.1} onChange={(v) => set({ fadeIn: v }, "fi")} unit="s" format={(v) => v.toFixed(1)} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={Math.min(10, clipLength(clip))} step={0.1} onChange={(v) => set({ fadeOut: v }, "fo")} unit="s" format={(v) => v.toFixed(1)} />
        <Toggle label="Mute this clip" checked={clip.muted} onChange={(v) => set({ muted: v })} />
      </Group>
      <Group title="Clean up">
        <Toggle label="Reduce noise" checked={a.denoise > 0} onChange={(v) => set({ audio: { denoise: v ? 50 : 0 } })} />
        {a.denoise > 0 && <Slider label="Strength" value={a.denoise} min={1} max={100} onChange={(v) => set({ audio: { denoise: v } }, "dn")} />}
        <Toggle label="Enhance voice" checked={a.enhance} onChange={(v) => set({ audio: { enhance: v } })} />
        <Toggle label="Normalize loudness (-16 LUFS)" checked={a.normalize} onChange={(v) => set({ audio: { normalize: v } })} />
      </Group>
      <Group title="Voice changer">
        <Choice items={VOICE_EFFECTS} value={a.voice} onPick={(id) => set({ audio: { voice: id } })} />
        <Slider label="Pitch" value={a.pitch} min={-12} max={12} onChange={(v) => set({ audio: { pitch: v } }, "pitch")} unit="st" />
      </Group>
      <button className="wide" onClick={hear} disabled={busy}>
        <Icon name="headphones" /> {busy ? "Rendering…" : "Hear processed audio (6 s)"}
      </button>
      <audio ref={player} />
    </>
  );
}

function SpeedPanel({ clip }) {
  const { apply, actions } = useEditor();
  const toPos = (s) => Math.round((Math.log10(s) + 1) * 50); // 0.1..10 -> 0..100
  const fromPos = (v) => Math.round(10 ** (v / 50 - 1) * 100) / 100;
  const set = (speed) => apply((p) => ops.setClip(p, clip.id, { speed }), { coalesce: `speed-${clip.id}` });
  return (
    <>
      <Group title="Normal speed">
        <div className="slider-row">
          <span className="sr-label">Speed</span>
          <input type="range" min="0" max="100" value={toPos(clip.speed)} onChange={(e) => set(fromPos(Number(e.target.value)))} />
          <NumberBox value={clip.speed} step={0.1} onCommit={(v) => set(Math.min(10, Math.max(0.1, v)))} format={(v) => v.toFixed(2)} unit="×" />
        </div>
        <div className="button-row wrap">
          {[0.25, 0.5, 1, 1.5, 2, 4].map((s) => (
            <button key={s} className={`small ${Math.abs(clip.speed - s) < 1e-3 ? "active" : ""}`} onClick={() => set(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="facts">
          <div><span>Duration</span>{clipLength(clip).toFixed(2)} s</div>
          <div><span>Source</span>{(clip.out - clip.in).toFixed(2)} s</div>
        </div>
        <div className="muted small">Pitch is kept when you change speed.</div>
      </Group>
      <Group title="Speed ramp">
        <p className="muted small">Splits the clip into pieces whose speed follows a curve.</p>
        <div className="choice-grid two">
          {Object.entries(ops.SPEED_RAMPS).map(([k, r]) => (
            <button key={k} className="choice" onClick={() => actions.speedRamp(k)} title={r.label}>
              {r.label.split(" (")[0]}
            </button>
          ))}
        </div>
      </Group>
      <Group title="Tools">
        <div className="button-row wrap">
          <button className="small" onClick={actions.reverse}><Icon name="reverse" size={14} /> Reverse</button>
          <button className="small" onClick={actions.freeze}><Icon name="freeze" size={14} /> Freeze frame</button>
          <button className="small" onClick={actions.scenes}><Icon name="scenes" size={14} /> Split at scenes</button>
        </div>
      </Group>
    </>
  );
}

function AnimationPanel({ clip }) {
  const { apply } = useEditor();
  const [slot, setSlot] = useState("animIn");
  const cur = clip[slot];
  const list = isText(clip) ? ANIMATIONS.filter((a) => a.fade || a.x || a.y || a.scale) : ANIMATIONS;
  return (
    <Group>
      <div className="seg">
        {[["animIn", "In"], ["animOut", "Out"]].map(([k, l]) => (
          <button key={k} className={slot === k ? "active" : ""} onClick={() => setSlot(k)}>
            {l} {clip[k] && <i className="dot" />}
          </button>
        ))}
      </div>
      <Choice items={list} value={cur?.type} onPick={(type) => apply((p) => ops.setClip(p, clip.id, { [slot]: type ? { type, duration: cur?.duration ?? 0.5 } : null }))} />
      {cur && <Slider label="Duration" value={cur.duration} min={0.1} max={Math.min(5, clipLength(clip))} step={0.1} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { [slot]: { ...cur, duration: v } }), { coalesce: `an-${clip.id}` })} unit="s" format={(v) => v.toFixed(1)} />}
      {isText(clip) && <div className="muted small">Text zoom/spin animations render as fades.</div>}
    </Group>
  );
}

const ADJUST_LABELS = { brightness: "Brightness", contrast: "Contrast", saturation: "Saturation", exposure: "Exposure", temperature: "Temperature", tint: "Tint", highlights: "Highlights", shadows: "Shadows", fade: "Fade", sharpen: "Sharpen", vignette: "Vignette", grain: "Grain" };

function AdjustPanel({ clip }) {
  const { apply, notify } = useEditor();
  return (
    <>
      <Group title="Adjust" right={<button className="link small" onClick={() => apply((p) => ops.setClip(p, clip.id, { adjust: Object.fromEntries(Object.keys(ADJUST_KEYS).map((k) => [k, 0])) }))}>Reset</button>}>
        {Object.entries(ADJUST_KEYS).map(([k, [lo, hi]]) => (
          <Slider key={k} label={ADJUST_LABELS[k]} value={clip.adjust[k]} min={lo} max={hi} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { adjust: { [k]: v } }), { coalesce: `adj-${k}-${clip.id}` })} />
        ))}
      </Group>
      <Group title="LUT">
        {clip.lut ? (
          <div className="applied">
            <span title={clip.lut}>{clip.lut.split(/[\\/]/).pop()}</span>
            <button className="ghost icon-only tiny" onClick={() => apply((p) => ops.setClip(p, clip.id, { lut: null }))}><Icon name="trash" size={12} /></button>
          </div>
        ) : (
          <button className="small" onClick={async () => {
            try {
              const file = await api.chooseLut();
              if (file) apply((p) => ops.setClip(p, clip.id, { lut: file }));
            } catch (e) {
              notify(e.message, "error");
            }
          }}>Import .cube LUT…</button>
        )}
      </Group>
    </>
  );
}

function TextPanel({ clip }) {
  const { apply } = useEditor();
  const st = clip.style;
  const setStyle = (patch, key) => apply((p) => ops.setClip(p, clip.id, { style: patch }), key ? { coalesce: `st-${key}-${clip.id}` } : undefined);
  const setTr = (k, v) => apply((p) => ops.setClip(p, clip.id, { transform: { [k]: v } }), { coalesce: `ttr-${k}-${clip.id}` });
  return (
    <>
      <Group>
        <textarea className="text-input" value={clip.text} dir="auto" onChange={(e) => apply((p) => ops.setClip(p, clip.id, { text: e.target.value }), { coalesce: `text-${clip.id}` })} rows={3} />
        <div className="style-strip">
          {TEXT_STYLES.map((s) => (
            <button key={s.id} className="small" onClick={() => setStyle(s.style)} title={s.name}>{s.name}</button>
          ))}
        </div>
      </Group>
      <Group title="Font">
        <div className="row-2">
          <select value={st.font} onChange={(e) => setStyle({ font: e.target.value })}>
            {FONTS.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
          </select>
          <button className={`small ${st.bold ? "active" : ""}`} onClick={() => setStyle({ bold: !st.bold })}><b>B</b> Bold</button>
        </div>
        <Slider label="Size" value={st.size} min={10} max={300} onChange={(v) => setStyle({ size: v }, "size")} />
        <div className="color-row"><span>Color</span><input type="color" value={st.color.slice(0, 7)} onChange={(e) => setStyle({ color: e.target.value }, "color")} /></div>
      </Group>
      <Group title="Stroke">
        <Slider label="Width" value={st.strokeWidth} min={0} max={20} onChange={(v) => setStyle({ strokeWidth: v }, "sw")} />
        <div className="color-row"><span>Color</span><input type="color" value={st.strokeColor.slice(0, 7)} onChange={(e) => setStyle({ strokeColor: e.target.value }, "sc")} /></div>
      </Group>
      <Group title="Background">
        <Toggle label="Box behind text" checked={!!st.bg} onChange={(v) => setStyle({ bg: v ? "#000000a6" : null })}>
          {st.bg && <input type="color" value={st.bg.slice(0, 7)} onChange={(e) => setStyle({ bg: `${e.target.value}${st.bg.slice(7) || "ff"}` }, "bg")} />}
        </Toggle>
        <Toggle label="Shadow" checked={st.shadow} onChange={(v) => setStyle({ shadow: v })} />
      </Group>
      <Group title="Position">
        <Slider label="X" value={pct(clip.transform.x * 100)} min={-50} max={50} onChange={(v) => setTr("x", v / 100)} unit="%" />
        <Slider label="Y" value={pct(clip.transform.y * 100)} min={-50} max={50} onChange={(v) => setTr("y", v / 100)} unit="%" />
        <Slider label="Scale" value={pct(clip.transform.scale * 100)} min={20} max={400} onChange={(v) => setTr("scale", v / 100)} unit="%" />
        <Slider label="Opacity" value={pct(clip.opacity * 100)} min={0} max={100} onChange={(v) => apply((p) => ops.setClip(p, clip.id, { opacity: v / 100 }), { coalesce: `top-${clip.id}` })} unit="%" />
      </Group>
    </>
  );
}

const MARKER_COLORS = ["amber", "red", "green", "blue", "purple"];

function MarkerPanel({ marker }) {
  const { apply, setSelection, project } = useEditor();
  const set = (patch, key) =>
    apply((p) => ({ ...p, revision: p.revision + 1, markers: p.markers.map((m) => (m.id === marker.id ? { ...m, ...patch } : m)) }), key ? { coalesce: key } : undefined);
  return (
    <Group title={marker.end != null ? "Range marker" : "Marker"}>
      <label className="field">
        <span className="field-label">Name (used for YouTube chapters)</span>
        <input value={marker.label} onChange={(e) => set({ label: e.target.value }, `mk-${marker.id}`)} placeholder="e.g. The jumpscare" />
      </label>
      <div className="swatches">
        {MARKER_COLORS.map((c) => (
          <button key={c} className={`swatch ${c} ${marker.color === c ? "active" : ""}`} onClick={() => set({ color: c })} title={c} />
        ))}
      </div>
      <div className="facts">
        <div>
          <span>At</span>
          {formatTime(marker.time, project.canvas.fps)}
        </div>
        {marker.end != null && (
          <div>
            <span>Length</span>
            {(marker.end - marker.time).toFixed(2)} s
          </div>
        )}
      </div>
      <div className="button-row">
        <button className="small" onClick={() => playhead.set(marker.time)}>Go to marker</button>
        <button className="small danger" onClick={() => (apply((p) => ops.removeMarkers(p, [marker.id])), setSelection(EMPTY_SELECTION))}>
          <Icon name="trash" size={12} /> Delete
        </button>
      </div>
    </Group>
  );
}

// Effects and look on an adjustment layer (applied to everything below it).
function LayerEffectsPanel({ clip }) {
  const { apply } = useEditor();
  const set = (patch, key) => apply((p) => ops.setClip(p, clip.id, patch), key ? { coalesce: `${key}-${clip.id}` } : undefined);
  const allowed = ["blur", "grain", "rgb-split", "bw", "invert", "sketch"];
  return (
    <>
      <Group title="Look">
        <select value={clip.filter?.id ?? ""} onChange={(e) => set({ filter: e.target.value ? { id: e.target.value, intensity: clip.filter?.intensity ?? 100 } : null })}>
          <option value="">None</option>
          {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {clip.filter && <Slider label="Amount" value={clip.filter.intensity} min={0} max={100} onChange={(v) => set({ filter: { ...clip.filter, intensity: v } }, "lk")} />}
      </Group>
      <Group title="Effects on everything below">
        <div className="choice-grid">
          {EFFECTS.filter((e) => allowed.includes(e.id)).map((e) => {
            const on = clip.effects.some((x) => x.id === e.id);
            return (
              <button key={e.id} className={`choice ${on ? "active" : ""}`} onClick={() => set({ effects: on ? clip.effects.filter((x) => x.id !== e.id) : [...clip.effects, { id: e.id, intensity: 60 }] })}>
                {e.name}
              </button>
            );
          })}
        </div>
        {clip.effects.map((fx) => (
          <Slider key={fx.id} label={byId(EFFECTS, fx.id)?.name.split(" ")[0]} value={fx.intensity} min={0} max={100} onChange={(v) => set({ effects: clip.effects.map((x) => (x.id === fx.id ? { ...x, intensity: v } : x)) }, `fx-${fx.id}`)} />
        ))}
      </Group>
      <p className="muted small">Color wheels and curves for this layer are on the Color page.</p>
    </>
  );
}

function TransitionPanel({ clip }) {
  const { apply, setSelection } = useEditor();
  const tr = clip.transition;
  return (
    <Group title="Transition">
      <Choice items={TRANSITIONS} value={tr?.type} none={null} onPick={(type) => apply((p) => ops.setTransition(p, clip.id, { type, duration: tr?.duration ?? 0.5 }))} />
      {tr && <Slider label="Duration" value={tr.duration} min={0.1} max={2} step={0.05} onChange={(v) => apply((p) => ops.setTransition(p, clip.id, { ...tr, duration: v }), { coalesce: `trd-${clip.id}` })} unit="s" format={(v) => v.toFixed(2)} />}
      <button className="small danger" onClick={() => (apply((p) => ops.setTransition(p, clip.id, null)), setSelection(EMPTY_SELECTION))}>
        <Icon name="trash" size={12} /> Remove transition
      </button>
    </Group>
  );
}

function BleepPanel() {
  const { project, selection, apply, setSelection } = useEditor();
  const bleep = project.bleeps.find((b) => b.id === selection.bleep);
  if (!bleep) return null;
  return (
    <Group title="Bleep">
      <p className="muted small">Mutes every track and plays a 1 kHz tone.</p>
      <Slider label="Start" value={Number(bleep.start.toFixed(2))} min={0} max={projectDuration(project)} step={0.01} onChange={(v) => apply((p) => ops.setBleep(p, bleep.id, { start: Math.min(v, bleep.end - 0.05) }), { coalesce: "bs" })} unit="s" />
      <Slider label="End" value={Number(bleep.end.toFixed(2))} min={0} max={projectDuration(project)} step={0.01} onChange={(v) => apply((p) => ops.setBleep(p, bleep.id, { end: Math.max(v, bleep.start + 0.05) }), { coalesce: "be" })} unit="s" />
      <button className="small danger" onClick={() => (apply((p) => ops.removeBleep(p, bleep.id)), setSelection(EMPTY_SELECTION))}>
        <Icon name="trash" size={12} /> Remove bleep
      </button>
    </Group>
  );
}

function DraftPanel() {
  const { project, apply, notify, selection, setSelection } = useEditor();
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
    setSelection(EMPTY_SELECTION);
    notify(`Cut ${list.length} pause${list.length === 1 ? "" : "s"}`);
  };

  return (
    <>
      <Group title="Draft settings">
        <div className="field">
          <span className="field-label">Ratio & frame rate</span>
          <select value={canvasKey} onChange={(e) => apply((p) => ops.setCanvas(p, CANVAS_PRESETS[e.target.value]))}>
            {canvasKey === "custom" && <option value="custom">{project.canvas.width}×{project.canvas.height} · {project.canvas.fps} fps</option>}
            {Object.entries(CANVAS_PRESETS).map(([k, v]) => <option key={k} value={k}>{k} · {v.width}×{v.height} · {v.fps} fps</option>)}
          </select>
        </div>
        <div className="facts">
          <div><span>Duration</span>{formatTime(projectDuration(project), project.canvas.fps)}</div>
          <div><span>Clips</span>{project.clips.length}</div>
          <div><span>Media</span>{project.media.length}</div>
          <div><span>Bleeps</span>{project.bleeps.length}</div>
        </div>
      </Group>
      <Group title="Find long pauses">
        <p className="muted small">Marks stretches where the chosen audio stays quiet, so you can review and cut only the real stalls.</p>
        <div className="field">
          <span className="field-label">Listen to</span>
          <select value={sourceId ?? ""} onChange={(e) => setSource(e.target.value)} disabled={!audible.length}>
            {audible.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <Slider label="Quiet <" value={noise} min={-60} max={-10} onChange={setNoise} unit="dB" />
        <Slider label="Longer" value={minDur} min={0.5} max={15} step={0.5} onChange={setMinDur} unit="s" format={(v) => v.toFixed(1)} />
        <Slider label="Keep" value={pad} min={0} max={1.5} step={0.05} onChange={setPad} unit="s" format={(v) => v.toFixed(2)} />
        <button className="small" onClick={findPauses} disabled={busy || !audible.length}>
          <Icon name="pause2" size={12} /> {busy ? "Listening…" : "Find pauses"}
        </button>
        {pauses.length > 0 && (
          <div className="pause-actions">
            <div className="muted small">{pauses.length} pauses · {pauseTotal.toFixed(1)} s. Click them on the Pauses lane (Shift to add) to cut only those.</div>
            <div className="button-row wrap">
              {selected.length > 0 && <button className="small primary" onClick={() => cut(selected)}>Cut {selected.length} selected</button>}
              <button className="small" onClick={() => cut(pauses)}>Cut all ({pauseTotal.toFixed(1)} s)</button>
              <button className="small ghost" onClick={() => apply((p) => ops.removeMarkers(p, pauses.map((m) => m.id)))}>Clear</button>
            </div>
          </div>
        )}
      </Group>
      <Group title="Shortcuts">
        <dl className="shortcuts">
          {[
            ["Space", "Play / pause"], ["Ctrl+B", "Split"], ["Q / W", "Delete left / right of playhead"], ["Del", "Delete (Shift = ripple)"],
            ["A / B", "Select / split tool"], ["Ctrl+C / V", "Copy / paste clip"], ["P", "Punch-in zoom"], ["Shift+B", "Bleep"],
            ["I / O / X", "Range in / out / clear"], ["M", "Marker"], ["N", "Snapping"], ["Ctrl + / -", "Zoom timeline"], ["Shift+Z", "Fit timeline"],
            ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"], ["Ctrl+E", "Export"],
          ].map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </Group>
    </>
  );
}
