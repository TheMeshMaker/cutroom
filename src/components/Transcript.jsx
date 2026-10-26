import { useEffect, useMemo, useRef, useState } from "react";
import { mediaById } from "../../core/model.js";
import { timelineWords } from "../../core/transcript.js";
import { useEditor } from "../editor.js";
import { playhead, playing } from "../state.js";
import Icon from "./icons.jsx";

const LANGS = [["auto", "Auto-detect"], ["en", "English"], ["ar", "Arabic"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["tr", "Turkish"], ["ur", "Urdu"], ["hi", "Hindi"], ["id", "Indonesian"], ["ru", "Russian"], ["pt", "Portuguese"]];
const PAUSE = 1.0; // seconds of silence that show up as a pause chip

// Text-based editing: the transcript follows the edit; select words (or
// pauses) and delete them to cut those moments from every track.
export default function TranscriptTab() {
  const { project, jobs, actions } = useEditor();
  const audible = useMemo(() => {
    const used = new Set(project.clips.map((c) => c.mediaId));
    return project.media.filter((m) => used.has(m.id) && m.hasAudio);
  }, [project]);
  const [sourceSel, setSourceSel] = useState(null);
  const sourceId = sourceSel ?? (audible.find((m) => project.transcripts[m.id]) ?? audible.find((m) => !m.hasVideo) ?? audible[0])?.id;
  const [lang, setLang] = useState("auto");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState({ a: null, b: null }); // item index range
  const nodes = useRef([]);
  const body = useRef(null);
  const dragging = useRef(false);
  const transcript = sourceId ? project.transcripts[sourceId] : null;
  const running = Object.keys(jobs).some((k) => k === `transcribe:${sourceId}`);

  // Words on the timeline, plus pause chips between them.
  const items = useMemo(() => {
    if (!transcript) return [];
    const words = timelineWords(project, sourceId, transcript.words);
    const out = [];
    words.forEach((w, i) => {
      const prev = words[i - 1];
      if (prev && prev.clip === w.clip && w.start - prev.end >= PAUSE) out.push({ kind: "gap", start: prev.end + 0.12, end: w.start - 0.12, text: `${(w.start - prev.end).toFixed(1)}s` });
      out.push({ kind: "word", ...w });
    });
    return out;
  }, [project, transcript, sourceId]);

  const [lo, hi] = sel.a == null ? [null, null] : [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
  const selected = lo == null ? [] : items.slice(lo, hi + 1);
  const fillers = items.filter((x) => x.kind === "word" && x.filler);
  const pauses = items.filter((x) => x.kind === "gap");
  const q = query.trim().toLowerCase();

  // Highlight the word under the playhead without re-rendering everything.
  useEffect(() => {
    let last = -1;
    const update = () => {
      const t = playhead.get();
      let i = -1;
      for (let k = 0; k < items.length; k++) {
        if (items[k].start <= t && items[k].end > t) {
          i = k;
          break;
        }
      }
      if (i === last) return;
      nodes.current[last]?.classList.remove("current");
      if (i >= 0) {
        const el = nodes.current[i];
        el?.classList.add("current");
        if (el && playing.get() && body.current) {
          const r = el.getBoundingClientRect();
          const b = body.current.getBoundingClientRect();
          if (r.top < b.top || r.bottom > b.bottom) el.scrollIntoView({ block: "center" });
        }
      }
      last = i;
    };
    update();
    return playhead.subscribe(update);
  }, [items]);

  useEffect(() => setSel({ a: null, b: null }), [project.revision]);

  const del = (list) => {
    if (!list.length) return;
    actions.removeWords(list);
    setSel({ a: null, b: null });
  };

  return (
    <section className="lib-section transcript">
      <div className="lib-section-head">
        <h4>Transcript</h4>
        {transcript && <span className="muted small">{transcript.language || "?"} · {items.filter((x) => x.kind === "word").length} words</span>}
      </div>
      <div className="row-2">
        <select value={sourceId ?? ""} onChange={(e) => setSourceSel(e.target.value)} disabled={!audible.length}>
          {audible.map((m) => <option key={m.id} value={m.id}>{m.name}{project.transcripts[m.id] ? " ✓" : ""}</option>)}
        </select>
        <select value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {running ? (
        <div className="job"><div className="bar indeterminate"><div /></div><span>Transcribing locally with Whisper… (first run loads the model)</span></div>
      ) : (
        <button className={transcript ? "small wide" : "primary wide"} disabled={!sourceId} onClick={() => actions.transcribe({ mediaId: sourceId, language: lang })}>
          <Icon name="transcript" /> {transcript ? "Transcribe again" : "Transcribe to edit by text"}
        </button>
      )}
      {!audible.length && <p className="muted small">Add a clip with speech to the timeline first.</p>}
      {transcript && (
        <>
          <div className="transcript-tools">
            <div className="home-search small-search">
              <Icon name="search" size={13} />
              <input placeholder="Find a word" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="small" disabled={!fillers.length} onClick={() => del(fillers)} title="Cut every um / uh / hmm">
              Remove fillers ({fillers.length})
            </button>
            <button className="small" disabled={!pauses.length} onClick={() => del(pauses)} title={`Cut every pause of ${PAUSE}s or more`}>
              Remove pauses ({pauses.length})
            </button>
          </div>
          <div className="transcript-sel">
            {selected.length ? (
              <>
                <span className="small">{selected.length} selected · {(selected[selected.length - 1].end - selected[0].start).toFixed(1)} s</span>
                <button className="small danger" onClick={() => del(selected)}>
                  <Icon name="trash" size={12} /> Delete from video
                </button>
                <button className="small ghost" onClick={() => setSel({ a: null, b: null })}>Clear</button>
              </>
            ) : (
              <span className="muted small">Click a word to jump · drag to select · Delete cuts it</span>
            )}
          </div>
          <div
            className="transcript-body"
            ref={body}
            tabIndex={0}
            data-keys="own"
            onKeyDown={(e) => {
              if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
                e.preventDefault();
                del(selected);
              }
              if (e.key === "Escape") setSel({ a: null, b: null });
            }}
            onPointerUp={() => (dragging.current = false)}
            onPointerLeave={() => (dragging.current = false)}
          >
            {items.map((it, i) => (
              <span
                key={i}
                ref={(n) => (nodes.current[i] = n)}
                className={`${it.kind === "gap" ? "t-gap" : "t-word"} ${it.filler ? "filler" : ""} ${lo != null && i >= lo && i <= hi ? "sel" : ""} ${q && it.kind === "word" && it.text.toLowerCase().includes(q) ? "hit" : ""}`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  body.current?.focus();
                  dragging.current = true;
                  if (e.shiftKey && sel.a != null) setSel({ a: sel.a, b: i });
                  else setSel({ a: i, b: i });
                  playhead.set(it.start);
                }}
                onPointerEnter={() => dragging.current && setSel((s) => ({ a: s.a, b: i }))}
                title={`${it.start.toFixed(2)}s`}
              >
                {it.kind === "gap" ? `⏸ ${it.text}` : it.text}{" "}
              </span>
            ))}
            {!items.length && <p className="muted small">No words on the timeline from this source (were they cut?).</p>}
          </div>
          <button className="small ghost wide" onClick={() => actions.autoCaptions({ mediaId: sourceId, language: lang, styleId: "subtitle" })}>
            <Icon name="captions" /> Make captions from this transcript
          </button>
          <p className="muted small">Source: {mediaById(project, sourceId)?.name}</p>
        </>
      )}
    </section>
  );
}
