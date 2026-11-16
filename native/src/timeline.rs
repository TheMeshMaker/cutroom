//! The timeline: one GPU-drawn canvas with the ruler, track headers, clips
//! (filmstrips, waveforms, fades, labels), the playhead, and every mouse
//! interaction: scrub, select, box-select, move (one clip or a group), trim,
//! zoom and scroll. It never edits the project; it sends messages.

use std::collections::HashSet;

use iced::mouse::{self, Button, Cursor, ScrollDelta};
use iced::widget::canvas::{self, Event, Frame, Geometry, Path, Program, Stroke, Text};
use iced::{keyboard, Color, Font, Pixels, Point, Rectangle, Renderer, Size, Theme};

use crate::editor::Editor;
use crate::model::{timecode, Clip, Track};
use crate::theme::*;
use crate::Message;

pub const HEADER: f32 = 156.0;
pub const RULER: f32 = 28.0;
const EDGE: f32 = 7.0;
const SNAP_PX: f32 = 8.0;

#[derive(Debug, Clone)]
pub enum TlMsg {
    Seek(f64),
    ClickEmpty(f64),
    Select(Vec<String>),
    Toggle(String),
    Move { ids: Vec<String>, delta: f64, track: Option<String>, pointer: f64 },
    Trim { id: String, left: bool, t: f64 },
    View { pps: f32, scroll: f32 },
    Menu { x: f32, y: f32, clip: Option<String>, t: f64 },
    TrackFlag { id: String, flag: &'static str },
    Drop { t: f64, track: Option<String> },
}

#[derive(Debug, Clone)]
enum Drag {
    Scrub,
    Pending { at: Point, clip: Option<String> },
    Move { ids: Vec<String>, grab: Point, dt: f64, track: Option<String>, guide: Option<f64> },
    Trim { id: String, left: bool, t: f64, guide: Option<f64> },
    Box { from: Point, to: Point, additive: bool },
}

#[derive(Default)]
pub struct State {
    drag: Option<Drag>,
    mods: keyboard::Modifiers,
}

pub struct Timeline<'a> {
    pub ed: &'a Editor,
}

struct Row<'a> {
    track: &'a Track,
    y: f32,
    h: f32,
    main: bool,
}

fn row_height(t: &Track, main: bool) -> f32 {
    match (t.kind.as_str(), main) {
        ("video", true) => 74.0,
        ("video", false) => 58.0,
        ("audio", _) => 48.0,
        _ => 30.0,
    }
}

impl<'a> Timeline<'a> {
    fn rows(&self) -> Vec<Row<'a>> {
        let main = self.ed.p.main_track().map(|t| t.id.clone());
        let mut y = RULER + 4.0;
        self.ed
            .p
            .tracks
            .iter()
            .map(|track| {
                let is_main = main.as_deref() == Some(track.id.as_str());
                let h = row_height(track, is_main);
                let row = Row { track, y, h, main: is_main };
                y += h + 4.0;
                row
            })
            .collect()
    }
    fn x(&self, t: f64) -> f32 {
        HEADER + t as f32 * self.ed.pps - self.ed.scroll
    }
    fn t(&self, x: f32) -> f64 {
        ((x - HEADER + self.ed.scroll) / self.ed.pps).max(0.0) as f64
    }
    fn row_at(&self, y: f32) -> Option<Row<'a>> {
        self.rows().into_iter().find(|r| y >= r.y && y < r.y + r.h)
    }
    fn clip_rect(&self, c: &Clip, row: &Row) -> Rectangle {
        let x0 = self.x(c.start);
        Rectangle::new(Point::new(x0, row.y), Size::new((c.len() as f32 * self.ed.pps).max(2.0), row.h))
    }
    fn clip_at(&self, p: Point) -> Option<(&'a Clip, Rectangle)> {
        let row = self.row_at(p.y)?;
        self.ed.p.clips.iter().filter(|c| c.track_id == row.track.id).map(|c| (c, self.clip_rect(c, &row))).find(|(_, r)| r.contains(p))
    }
    // Nearest clip edge / playhead within a few pixels of `t`.
    fn snap(&self, t: f64, skip: &[String]) -> Option<f64> {
        let limit = (SNAP_PX / self.ed.pps) as f64;
        let mut best: Option<(f64, f64)> = None;
        let mut consider = |x: f64| {
            let d = (x - t).abs();
            if d < limit && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, x));
            }
        };
        consider(0.0);
        consider(self.ed.playhead);
        for c in self.ed.p.clips.iter().filter(|c| !skip.contains(&c.id)) {
            consider(c.start);
            consider(c.end());
        }
        best.map(|(_, x)| x)
    }
}

impl Program<Message> for Timeline<'_> {
    type State = State;

    fn update(&self, state: &mut State, event: &Event, bounds: Rectangle, cursor: Cursor) -> Option<canvas::Action<Message>> {
        let pos = cursor.position_in(bounds);
        let tl = |m: TlMsg| Some(canvas::Action::publish(Message::Timeline(m)).and_capture());
        match event {
            Event::Keyboard(keyboard::Event::ModifiersChanged(m)) => {
                state.mods = *m;
                None
            }
            Event::Mouse(mouse::Event::WheelScrolled { delta }) => {
                let p = pos?;
                let dy = match delta {
                    ScrollDelta::Lines { y, x } => (if x.abs() > y.abs() { -*x } else { *y }) * 60.0,
                    ScrollDelta::Pixels { y, x } => if x.abs() > y.abs() { -*x } else { *y },
                };
                if state.mods.control() {
                    // Zoom around the pointer.
                    let at = self.t(p.x);
                    let pps = (self.ed.pps * if dy > 0.0 { 1.2 } else { 1.0 / 1.2 }).clamp(0.5, 800.0);
                    let scroll = (at as f32 * pps - (p.x - HEADER)).max(0.0);
                    tl(TlMsg::View { pps, scroll })
                } else {
                    tl(TlMsg::View { pps: self.ed.pps, scroll: (self.ed.scroll - dy).max(0.0) })
                }
            }
            Event::Mouse(mouse::Event::ButtonPressed(Button::Right)) => {
                let p = pos?;
                if p.x < HEADER || p.y < RULER {
                    return None;
                }
                let clip = self.clip_at(p).map(|(c, _)| c.id.clone());
                tl(TlMsg::Menu { x: bounds.x + p.x, y: bounds.y + p.y, clip, t: self.t(p.x) })
            }
            Event::Mouse(mouse::Event::ButtonPressed(Button::Left)) => {
                let p = pos?;
                if p.y < RULER && p.x >= HEADER {
                    state.drag = Some(Drag::Scrub);
                    return tl(TlMsg::Seek(self.t(p.x)));
                }
                if p.x < HEADER {
                    // Header buttons: lock / hide / mute, right to left.
                    let row = self.row_at(p.y)?;
                    let slot = ((HEADER - 8.0 - p.x) / 24.0).floor() as i32;
                    let flags: Vec<&'static str> = header_flags(row.track);
                    return flags.get(slot as usize).and_then(|f| tl(TlMsg::TrackFlag { id: row.track.id.clone(), flag: f }));
                }
                if let Some((c, r)) = self.clip_at(p) {
                    if self.ed.p.track(&c.track_id).is_some_and(|t| t.locked) {
                        return None;
                    }
                    if p.x - r.x < EDGE || r.x + r.width - p.x < EDGE {
                        let left = p.x - r.x < EDGE;
                        state.drag = Some(Drag::Trim { id: c.id.clone(), left, t: if left { c.start } else { c.end() }, guide: None });
                        return tl(TlMsg::Select(vec![c.id.clone()]));
                    }
                    state.drag = Some(Drag::Pending { at: p, clip: Some(c.id.clone()) });
                    if state.mods.control() || state.mods.shift() {
                        return tl(TlMsg::Toggle(c.id.clone()));
                    }
                    if !self.ed.selection.contains(&c.id) {
                        return tl(TlMsg::Select(vec![c.id.clone()]));
                    }
                    return Some(canvas::Action::capture());
                }
                state.drag = Some(Drag::Pending { at: p, clip: None });
                Some(canvas::Action::capture())
            }
            Event::Mouse(mouse::Event::CursorMoved { .. }) => {
                let p = cursor.position_in(bounds).unwrap_or_else(|| cursor.position().map(|c| Point::new(c.x - bounds.x, c.y - bounds.y)).unwrap_or_default());
                match state.drag.clone()? {
                    Drag::Scrub => tl(TlMsg::Seek(self.t(p.x))),
                    Drag::Pending { at, clip } => {
                        if at.distance(p) < 4.0 {
                            return None;
                        }
                        state.drag = Some(match clip {
                            Some(id) => {
                                let ids = if self.ed.selection.contains(&id) { self.ed.selection.clone() } else { vec![id] };
                                Drag::Move { ids, grab: at, dt: 0.0, track: None, guide: None }
                            }
                            None => Drag::Box { from: at, to: p, additive: state.mods.control() || state.mods.shift() },
                        });
                        Some(canvas::Action::request_redraw())
                    }
                    Drag::Move { ids, grab, .. } => {
                        let lead = self.ed.p.clip(&ids[0])?.clone();
                        let raw = ((p.x - grab.x) / self.ed.pps) as f64;
                        // Snap the dragged clip's edges.
                        let (mut dt, mut guide) = (raw, None);
                        if let Some(s) = self.snap(lead.start + raw, &ids) {
                            (dt, guide) = (s - lead.start, Some(s));
                        } else if let Some(s) = self.snap(lead.end() + raw, &ids) {
                            (dt, guide) = (s - lead.end(), Some(s));
                        }
                        let min_start = ids.iter().filter_map(|id| self.ed.p.clip(id)).map(|c| c.start).fold(f64::MAX, f64::min);
                        dt = dt.max(-min_start);
                        let kind = self.ed.p.track(&lead.track_id).map(|t| t.kind.clone()).unwrap_or_default();
                        let track = (ids.len() == 1).then(|| self.row_at(p.y)).flatten().filter(|r| r.track.kind == kind).map(|r| r.track.id.clone());
                        state.drag = Some(Drag::Move { ids, grab, dt, track, guide });
                        Some(canvas::Action::request_redraw())
                    }
                    Drag::Trim { id, left, .. } => {
                        let raw = self.t(p.x);
                        let snapped = self.snap(raw, std::slice::from_ref(&id));
                        state.drag = Some(Drag::Trim { id, left, t: snapped.unwrap_or(raw), guide: snapped });
                        Some(canvas::Action::request_redraw())
                    }
                    Drag::Box { from, additive, .. } => {
                        state.drag = Some(Drag::Box { from, to: p, additive });
                        Some(canvas::Action::request_redraw())
                    }
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(Button::Left)) => {
                if let (None, Some(p)) = (&state.drag, pos) {
                    // A drag from the media library ends here.
                    if self.ed.drag_media.is_some() && p.x > HEADER {
                        return tl(TlMsg::Drop { t: self.snap(self.t(p.x), &[]).unwrap_or(self.t(p.x)), track: self.row_at(p.y).map(|r| r.track.id.clone()) });
                    }
                }
                let drag = state.drag.take()?;
                match drag {
                    Drag::Scrub => Some(canvas::Action::capture()),
                    // A plain click on empty space: deselect and move the playhead.
                    Drag::Pending { at, clip: None } => tl(TlMsg::ClickEmpty(self.t(at.x))),
                    Drag::Pending { clip: Some(id), .. } => {
                        if !(state.mods.control() || state.mods.shift()) && self.ed.selection.len() > 1 {
                            return tl(TlMsg::Select(vec![id]));
                        }
                        Some(canvas::Action::capture())
                    }
                    Drag::Move { ids, dt, track, grab, .. } => {
                        if dt.abs() < 1e-6 && track.as_ref().is_none_or(|t| self.ed.p.clip(&ids[0]).is_some_and(|c| &c.track_id == t)) {
                            return Some(canvas::Action::capture());
                        }
                        let pointer = self.t(grab.x) + dt;
                        tl(TlMsg::Move { ids, delta: dt, track, pointer })
                    }
                    Drag::Trim { id, left, t, .. } => tl(TlMsg::Trim { id, left, t }),
                    Drag::Box { from, to, additive } => {
                        let r = rect_of(from, to);
                        let mut ids: Vec<String> = if additive { self.ed.selection.clone() } else { Vec::new() };
                        for row in self.rows() {
                            if row.track.locked {
                                continue;
                            }
                            for c in self.ed.p.clips.iter().filter(|c| c.track_id == row.track.id) {
                                if intersects(&self.clip_rect(c, &row), &r) && !ids.contains(&c.id) {
                                    ids.push(c.id.clone());
                                }
                            }
                        }
                        tl(TlMsg::Select(ids))
                    }
                }
            }
            _ => None,
        }
    }

    fn draw(&self, state: &State, renderer: &Renderer, _theme: &Theme, bounds: Rectangle, cursor: Cursor) -> Vec<Geometry> {
        let mut f = Frame::new(renderer, bounds.size());
        let w = bounds.width;
        f.fill_rectangle(Point::ORIGIN, bounds.size(), BG2);
        let fps = self.ed.p.canvas.fps;
        let rows = self.rows();
        let sel: HashSet<&str> = self.ed.selection.iter().map(String::as_str).collect();

        // Moving clips are drawn where they would land.
        let (moving, dt, to_track) = match &state.drag {
            Some(Drag::Move { ids, dt, track, .. }) => (ids.clone(), *dt, track.clone()),
            _ => (Vec::new(), 0.0, None),
        };

        for row in &rows {
            if row.main {
                f.fill_rectangle(Point::new(HEADER, row.y), Size::new(w - HEADER, row.h), alpha(ACCENT, 0.03));
            }
            f.fill_rectangle(Point::new(HEADER, row.y + row.h + 1.5), Size::new(w - HEADER, 1.0), alpha(Color::WHITE, 0.03));
            for c in self.ed.p.clips.iter().filter(|c| {
                let moved = moving.contains(&c.id);
                (c.track_id == row.track.id && !(moved && to_track.as_ref().is_some_and(|t| t != &row.track.id))) || (moved && to_track.as_deref() == Some(row.track.id.as_str()))
            }) {
                let mut c = c.clone();
                if moving.contains(&c.id) {
                    c.start += dt;
                }
                if let Some(Drag::Trim { id, left, t, .. }) = &state.drag {
                    if id == &c.id {
                        trim_preview(&mut c, *left, *t);
                    }
                }
                let r = self.clip_rect(&c, row);
                if r.x > w || r.x + r.width < HEADER {
                    continue;
                }
                self.draw_clip(&mut f, &c, row, r, sel.contains(c.id.as_str()), moving.contains(&c.id), w);
            }
        }

        // Ruler.
        f.fill_rectangle(Point::ORIGIN, Size::new(w, RULER), PANEL);
        f.fill_rectangle(Point::new(0.0, RULER - 1.0), Size::new(w, 1.0), LINE);
        let steps = [0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1200.0, 3600.0];
        let step = *steps.iter().find(|s| **s as f32 * self.ed.pps >= 90.0).unwrap_or(&3600.0);
        let minor = step / 5.0;
        let t0 = self.t(HEADER);
        let t1 = self.t(w);
        let mut t = (t0 / minor).floor() * minor;
        while t <= t1 + minor {
            let x = self.x(t);
            let major = ((t / step).round() * step - t).abs() < minor * 0.01;
            f.fill_rectangle(Point::new(x, if major { 6.0 } else { RULER - 6.0 }), Size::new(1.0, if major { RULER - 6.0 } else { 5.0 }), alpha(Color::WHITE, if major { 0.22 } else { 0.14 }));
            if major {
                // Between whole seconds, label frames ("15f") instead of repeating the second.
                let frac = t - t.floor();
                let text = if step < 1.0 && frac > 1e-6 && frac < 1.0 - 1e-6 { format!("{}f", (frac * fps as f64).round()) } else { trim_timecode(&timecode(t.round(), fps)) };
                f.fill_text(label(text, Point::new(x + 4.0, 5.0), MUTED, 10.5));
            }
            t += minor;
        }
        for m in self.ed.p.markers.iter().filter(|m| m.end.is_none()) {
            let x = self.x(m.time);
            f.fill(&Path::new(|b| {
                b.move_to(Point::new(x - 5.0, RULER - 12.0));
                b.line_to(Point::new(x + 5.0, RULER - 12.0));
                b.line_to(Point::new(x, RULER - 4.0));
                b.close();
            }), AMBER);
        }
        for b in &self.ed.p.bleeps {
            f.fill_rectangle(Point::new(self.x(b.start), RULER - 4.0), Size::new(((b.end - b.start) as f32 * self.ed.pps).max(2.0), 4.0), DANGER);
        }

        // Track headers.
        f.fill_rectangle(Point::ORIGIN, Size::new(HEADER, bounds.height), PANEL);
        f.fill_rectangle(Point::new(HEADER - 1.0, 0.0), Size::new(1.0, bounds.height), LINE);
        f.fill_text(label(timecode(self.ed.p.duration(), fps), Point::new(10.0, 7.0), MUTED, 11.0));
        for row in &rows {
            if row.main {
                f.fill_rectangle(Point::new(0.0, row.y), Size::new(3.0, row.h), ACCENT);
            }
            let (glyph, tint) = match row.track.kind.as_str() {
                "video" => ("\u{E714}", Color::from_rgb(0.56, 0.83, 0.90)),
                "audio" => ("\u{E8D6}", Color::from_rgb(0.56, 0.90, 0.77)),
                _ => ("\u{E8D2}", Color::from_rgb(0.94, 0.75, 0.56)),
            };
            let cy = row.y + row.h / 2.0;
            f.fill(&Path::rounded_rectangle(Point::new(10.0, cy - 11.0), Size::new(22.0, 22.0), 6.0.into()), alpha(tint, 0.14));
            f.fill_text(Text { content: glyph.into(), position: Point::new(14.0, cy - 7.0), color: tint, size: Pixels(13.0), font: Font::with_name("Segoe Fluent Icons"), ..Text::default() });
            // Default names ("Audio 2", "Captions", "Stickers") read in the chosen language.
            let name = if row.main { crate::i18n::t(self.ed.lang, "Main").to_string() } else { crate::i18n::message(self.ed.lang, &row.track.name) };
            // Shortened with "…" so long names (other languages) stop before the header icons.
            let room = HEADER - 46.0 - 24.0 * header_flags(row.track).len() as f32;
            let max_chars = (room / 6.6).max(3.0) as usize;
            let name = if name.chars().count() > max_chars { format!("{}…", name.chars().take(max_chars - 1).collect::<String>()) } else { name };
            f.fill_text(label(name, Point::new(40.0, cy - 8.0), if row.main { TEXT } else { TEXT2 }, 12.0));
            for (i, flag) in header_flags(row.track).iter().enumerate() {
                let x = HEADER - 8.0 - 24.0 * (i as f32 + 1.0) + 4.0;
                let (glyph, off) = match *flag {
                    "locked" => (if row.track.locked { "\u{E72E}" } else { "\u{E785}" }, row.track.locked),
                    "hidden" => (if row.track.hidden { "\u{ED1A}" } else { "\u{E890}" }, row.track.hidden),
                    _ => (if row.track.muted { "\u{E74F}" } else { "\u{E767}" }, row.track.muted),
                };
                f.fill_text(Text { content: glyph.into(), position: Point::new(x, cy - 7.0), color: if off { Color::from_rgb(1.0, 0.48, 0.5) } else { alpha(MUTED, 0.9) }, size: Pixels(13.0), font: Font::with_name("Segoe Fluent Icons"), ..Text::default() });
            }
        }

        // Overlays: snap guide, box, drop target, playhead.
        let guide = match &state.drag {
            Some(Drag::Move { guide, .. }) | Some(Drag::Trim { guide, .. }) => *guide,
            _ => None,
        };
        if let Some(g) = guide {
            f.fill_rectangle(Point::new(self.x(g) - 0.5, RULER), Size::new(1.0, bounds.height), Color::from_rgb(1.0, 0.82, 0.25));
        }
        if let Some(Drag::Box { from, to, .. }) = &state.drag {
            let r = rect_of(*from, *to);
            f.fill_rectangle(r.position(), r.size(), alpha(ACCENT, 0.12));
            f.stroke(&Path::rectangle(r.position(), r.size()), Stroke::default().with_color(alpha(ACCENT, 0.9)).with_width(1.0));
        }
        if self.ed.drag_media.is_some() {
            if let Some(p) = cursor.position_in(bounds).filter(|p| p.x > HEADER) {
                f.fill_rectangle(Point::new(p.x - 1.0, RULER), Size::new(2.0, bounds.height), ACCENT);
            }
        }
        if self.ed.p.clips.is_empty() {
            let msg = crate::i18n::t(self.ed.lang, "Import media, then drag it here or press + on a media card");
            // Not centered: centered right-to-left text is laid out in an infinite box (Arabic would land at x = ∞).
            f.fill_text(Text { content: msg.into(), position: Point::new(HEADER + 28.0, bounds.height / 2.0 - 8.0), color: MUTED, size: Pixels(13.0), ..Text::default() });
        }
        let px = self.x(self.ed.playhead);
        if px >= HEADER {
            f.fill_rectangle(Point::new(px - 0.75, 0.0), Size::new(1.5, bounds.height), Color::from_rgb(0.96, 0.96, 0.97));
            f.fill(&Path::new(|b| {
                b.move_to(Point::new(px - 7.0, 2.0));
                b.line_to(Point::new(px + 7.0, 2.0));
                b.line_to(Point::new(px + 7.0, 11.0));
                b.line_to(Point::new(px, 18.0));
                b.line_to(Point::new(px - 7.0, 11.0));
                b.close();
            }), ACCENT);
        }
        vec![f.into_geometry()]
    }

    fn mouse_interaction(&self, state: &State, bounds: Rectangle, cursor: Cursor) -> mouse::Interaction {
        match &state.drag {
            Some(Drag::Move { .. }) => return mouse::Interaction::Grabbing,
            Some(Drag::Trim { .. }) => return mouse::Interaction::ResizingHorizontally,
            _ => {}
        }
        let Some(p) = cursor.position_in(bounds) else { return mouse::Interaction::default() };
        if p.y < RULER && p.x > HEADER {
            return mouse::Interaction::Text;
        }
        if p.x < HEADER {
            return if p.x > HEADER - 8.0 - 72.0 { mouse::Interaction::Pointer } else { mouse::Interaction::default() };
        }
        match self.clip_at(p) {
            Some((_, r)) if p.x - r.x < EDGE || r.x + r.width - p.x < EDGE => mouse::Interaction::ResizingHorizontally,
            Some(_) => mouse::Interaction::Grab,
            None => mouse::Interaction::default(),
        }
    }
}

impl Timeline<'_> {
    #[allow(clippy::too_many_arguments)]
    fn draw_clip(&self, f: &mut Frame, c: &Clip, row: &Row, r: Rectangle, selected: bool, ghost: bool, w: f32) {
        let media = c.media_id.as_deref().and_then(|id| self.ed.p.media(id));
        let base = if c.adjustment {
            Color::from_rgb(0.36, 0.25, 0.54)
        } else if c.text.is_some() {
            TEXTCLIP
        } else if media.is_some_and(|m| m.kind == "image") {
            IMAGECLIP
        } else if row.track.kind == "audio" {
            AUDIO
        } else {
            VIDEO
        };
        let inner = Rectangle::new(Point::new(r.x, r.y + 2.0), Size::new(r.width, r.height - 4.0));
        let shape = Path::rounded_rectangle(inner.position(), inner.size(), 6.0.into());
        f.fill(&shape, if ghost { alpha(base, 0.85) } else { base });
        // Only the visible part is drawn in detail.
        let vis_x0 = inner.x.max(HEADER);
        let vis_x1 = (inner.x + inner.width).min(w);
        if vis_x1 <= vis_x0 {
            return;
        }
        let label_h = 18.0;
        if let Some(m) = media {
            if row.track.kind == "video" {
                if let Some(strip) = self.ed.strips.get(&m.id) {
                    let th = inner.height - label_h;
                    let tw = (strip.tile_w as f32 * th / strip.tile_h as f32).max(8.0);
                    let speed = if c.speed > 0.0 { c.speed } else { 1.0 };
                    let mut x = inner.x + ((vis_x0 - inner.x) / tw).floor() * tw;
                    while x < vis_x1 {
                        let t = c.in_ + ((x - inner.x + tw / 2.0) / self.ed.pps) as f64 * speed;
                        let i = if strip.interval.is_finite() && strip.interval > 0.0 { ((t / strip.interval) as usize).min(strip.tiles.len().saturating_sub(1)) } else { 0 };
                        if let Some(tile) = strip.tiles.get(i) {
                            let cell = Rectangle::new(Point::new(x, inner.y + label_h), Size::new(tw, th));
                            let clip_to = intersection(&cell, &inner);
                            if let Some(clip_to) = clip_to {
                                // A clipped frame keeps the parent's coordinates (iced 0.14).
                                f.with_clip(clip_to, |f| f.draw_image(cell, tile));
                            }
                        }
                        x += tw;
                    }
                }
            }
            if m.has_audio {
                if let Some(peaks) = self.ed.waves.get(&m.id) {
                    let audio_row = row.track.kind == "audio";
                    let h = if audio_row { inner.height - label_h - 4.0 } else { (inner.height * 0.26).max(10.0) };
                    let base_y = inner.y + inner.height - 2.0;
                    let speed = if c.speed > 0.0 { c.speed } else { 1.0 };
                    let wave = Path::new(|b| {
                        let mut x = vis_x0.floor();
                        while x < vis_x1 {
                            let t0 = c.in_ + ((x - inner.x) / self.ed.pps) as f64 * speed;
                            let t1 = c.in_ + ((x + 1.0 - inner.x) / self.ed.pps) as f64 * speed;
                            let (i0, i1) = ((t0 * 100.0) as usize, ((t1 * 100.0) as usize).max((t0 * 100.0) as usize + 1));
                            let peak = peaks.get(i0..i1.min(peaks.len())).and_then(|s| s.iter().max()).copied().unwrap_or(0);
                            let bar = (peak as f32 / 255.0 * h).max(1.0);
                            if audio_row {
                                b.rectangle(Point::new(x, base_y - h / 2.0 - bar / 2.0), Size::new(1.0, bar));
                            } else {
                                b.rectangle(Point::new(x, base_y - bar), Size::new(1.0, bar));
                            }
                            x += 1.0;
                        }
                    });
                    let color = if audio_row { alpha(AUDIO_WAVE, if c.muted { 0.25 } else { 0.85 }) } else { alpha(Color::from_rgb(0.84, 0.94, 1.0), if c.muted { 0.2 } else { 0.6 }) };
                    f.fill(&wave, color);
                }
            }
        }
        // Fades: darkened corners.
        let fps_px = |d: f64| (d as f32 * self.ed.pps).min(inner.width);
        if c.fade_in > 0.0 {
            let d = fps_px(c.fade_in);
            f.fill(&Path::new(|b| {
                b.move_to(inner.position());
                b.line_to(Point::new(inner.x + d, inner.y));
                b.line_to(Point::new(inner.x, inner.y + inner.height));
                b.close();
            }), Color::from_rgba(0.0, 0.0, 0.0, 0.5));
        }
        if c.fade_out > 0.0 {
            let d = fps_px(c.fade_out);
            let x1 = inner.x + inner.width;
            f.fill(&Path::new(|b| {
                b.move_to(Point::new(x1, inner.y));
                b.line_to(Point::new(x1 - d, inner.y));
                b.line_to(Point::new(x1, inner.y + inner.height));
                b.close();
            }), Color::from_rgba(0.0, 0.0, 0.0, 0.5));
        }
        // Label strip with the name (and a color label if set).
        if c.text.is_none() {
            f.fill_rectangle(Point::new(vis_x0, inner.y), Size::new(vis_x1 - vis_x0, label_h), Color::from_rgba(0.0, 0.0, 0.0, 0.42));
        }
        if let Some(lab) = &c.label {
            f.fill_rectangle(Point::new(vis_x0, inner.y), Size::new(vis_x1 - vis_x0, 3.0), label_color(lab));
        }
        let name = if let Some(t) = &c.text {
            t.replace('\n', " ")
        } else if c.adjustment {
            crate::i18n::t(self.ed.lang, "Adjustment layer").to_string()
        } else {
            media.map(|m| crate::i18n::message(self.ed.lang, &m.name)).unwrap_or_default()
        };
        let mut info = name;
        if c.media_id.is_some() && (c.speed - 1.0).abs() > 1e-3 {
            info = format!("{info}  {:.2}×", c.speed);
        }
        if c.muted {
            info = format!("🔇 {info}");
        }
        let text_y = if c.text.is_some() { inner.y + inner.height / 2.0 - 7.0 } else { inner.y + 2.0 };
        f.with_clip(Rectangle::new(Point::new(vis_x0, inner.y), Size::new(vis_x1 - vis_x0, inner.height)), |f| {
            f.fill_text(label(info, Point::new(inner.x.max(HEADER) + 7.0, text_y), TEXT, 11.0));
        });
        // Selection ring and trim grips.
        if selected {
            f.stroke(&shape, Stroke::default().with_color(ACCENT).with_width(2.0));
            for x in [inner.x + 3.0, inner.x + inner.width - 6.0] {
                if x >= HEADER && x <= w {
                    f.fill(&Path::rounded_rectangle(Point::new(x, inner.y + inner.height / 2.0 - 9.0), Size::new(3.0, 18.0), 1.5.into()), Color::WHITE);
                }
            }
        } else {
            f.stroke(&shape, Stroke::default().with_color(alpha(Color::WHITE, 0.10)).with_width(1.0));
        }
        // Keyframes: small diamonds along the bottom edge.
        let ky = inner.y + inner.height - 7.0;
        for k in &c.keyframes {
            let x = self.x(c.start + k.t);
            if x >= HEADER && x <= w {
                let d = Path::new(|b| {
                    b.move_to(Point::new(x, ky - 5.0));
                    b.line_to(Point::new(x + 5.0, ky));
                    b.line_to(Point::new(x, ky + 5.0));
                    b.line_to(Point::new(x - 5.0, ky));
                    b.close();
                });
                f.fill(&d, if selected { ACCENT } else { Color::WHITE });
                f.stroke(&d, Stroke::default().with_color(Color::from_rgba(0.0, 0.0, 0.0, 0.5)).with_width(1.0));
            }
        }
        // A transition into this clip: a bow tie on the cut.
        if c.transition.is_some() && inner.x >= HEADER && inner.x <= w {
            let (x, y) = (inner.x, inner.y + inner.height / 2.0);
            let bow = Path::new(|b| {
                b.move_to(Point::new(x - 9.0, y - 7.0));
                b.line_to(Point::new(x + 9.0, y + 7.0));
                b.line_to(Point::new(x + 9.0, y - 7.0));
                b.line_to(Point::new(x - 9.0, y + 7.0));
                b.close();
            });
            f.fill(&Path::rounded_rectangle(Point::new(x - 13.0, y - 11.0), Size::new(26.0, 22.0), 6.0.into()), alpha(Color::BLACK, 0.65));
            f.fill(&bow, ACCENT);
        }
    }
}

fn header_flags(t: &Track) -> Vec<&'static str> {
    match t.kind.as_str() {
        "audio" => vec!["muted", "locked"],
        "text" => vec!["hidden", "locked"],
        _ => vec!["muted", "hidden", "locked"],
    }
}

fn trim_preview(c: &mut Clip, left: bool, t: f64) {
    let speed = if c.media_id.is_some() && c.speed > 0.0 { c.speed } else { 1.0 };
    if left {
        let t = t.min(c.end() - 0.05);
        c.in_ = (c.in_ + (t - c.start) * speed).max(0.0);
        c.start = t;
    } else {
        c.out = c.in_ + (t - c.start).max(0.05) * speed;
    }
}

fn label(content: String, position: Point, color: Color, size: f32) -> Text {
    Text { content, position, color, size: Pixels(size), ..Text::default() }
}

/// "00:01:05:12" -> "01:05" for the ruler.
fn trim_timecode(tc: &str) -> String {
    let parts: Vec<&str> = tc.split(':').collect();
    if parts.len() == 4 && parts[0] == "00" { format!("{}:{}", parts[1], parts[2]) } else { parts[..3].join(":") }
}

pub fn label_color(name: &str) -> Color {
    match name {
        "red" => Color::from_rgb8(0xe5, 0x48, 0x4d),
        "orange" => Color::from_rgb8(0xf0, 0x80, 0x3c),
        "yellow" => Color::from_rgb8(0xe8, 0xc3, 0x3a),
        "green" => Color::from_rgb8(0x3f, 0xbf, 0x7f),
        "teal" => Color::from_rgb8(0x22, 0xc3, 0xc9),
        "blue" => Color::from_rgb8(0x4f, 0x8c, 0xff),
        "purple" => Color::from_rgb8(0x8f, 0x6b, 0xff),
        _ => Color::from_rgb8(0xef, 0x6f, 0xb0),
    }
}

fn rect_of(a: Point, b: Point) -> Rectangle {
    Rectangle::new(Point::new(a.x.min(b.x), a.y.min(b.y)), Size::new((a.x - b.x).abs(), (a.y - b.y).abs()))
}

fn intersects(a: &Rectangle, b: &Rectangle) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

fn intersection(a: &Rectangle, b: &Rectangle) -> Option<Rectangle> {
    let x0 = a.x.max(b.x);
    let y0 = a.y.max(b.y);
    let x1 = (a.x + a.width).min(b.x + b.width);
    let y1 = (a.y + a.height).min(b.y + b.height);
    (x1 > x0 && y1 > y0).then(|| Rectangle::new(Point::new(x0, y0), Size::new(x1 - x0, y1 - y0)))
}

pub fn canvas<'a>(ed: &'a Editor) -> iced::Element<'a, Message> {
    iced::widget::canvas(Timeline { ed }).width(iced::Fill).height(iced::Fill).into()
}
