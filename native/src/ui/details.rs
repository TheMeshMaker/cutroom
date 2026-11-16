//! The details panel (right): every property of the selected clip, in tabs
//! (video, text, audio, speed, animation, color), or the project's settings
//! when nothing is selected.

use iced::widget::{button, canvas, column, container, pick_list, progress_bar, scrollable, slider, text, text_editor, toggler, Column};
use iced::{Element, Fill, Padding};
use serde_json::{json, Value};

use super::{btn, dir_row, format_duration, heading, labeled_slider, note};
use crate::color;
use crate::editor::{Editor, Panel};
use crate::i18n::{t, tr, Lang};
use crate::model::Clip;
use crate::theme::{self, Btn};
use crate::{App, AudioTool, Message};

const COLORS: [&str; 10] = ["#ffffff", "#000000", "#ffd400", "#ff7a1a", "#e5484d", "#ff4fa3", "#a855f7", "#3b82f6", "#1cd0db", "#39ff14"];

pub fn panel<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let panels = ed.panels();
    let label = |p: Panel| match p {
        Panel::Video => "Video",
        Panel::Text => "Text",
        Panel::Audio => "Audio",
        Panel::Speed => "Speed",
        Panel::Animation => "Animation",
        Panel::Color => "Color",
        Panel::Project => "Project",
    };
    let tabs = dir_row(lang, panels.iter().map(|&p| button(text(t(lang, label(p))).size(13)).padding([6, 10]).style(theme::btn(Btn::Tab(ed.panel == p))).on_press(Message::Panel(p)).into()).collect()).spacing(2).wrap().vertical_spacing(2);
    let body: Element<Message> = match ed.current().cloned() {
        None => project(app, ed),
        Some(c) => {
            let cj = ed.clip_json(&c.id);
            match ed.panel {
                Panel::Video => video(lang, ed, c, cj),
                Panel::Text => text_tab(app, ed, c, cj),
                Panel::Audio => audio(app, ed, c, cj),
                Panel::Speed => speed(app, ed, c),
                Panel::Animation => animation(app, ed, c, cj),
                Panel::Color => color(app, c, cj),
                Panel::Project => project(app, ed),
            }
        }
    };
    container(column![container(tabs).padding([6, 8]).width(Fill).style(theme::bar), scrollable(container(body).padding(Padding { top: 12.0, right: 18.0, bottom: 16.0, left: 14.0 })).height(Fill)])
        .width(370)
        .height(Fill)
        .style(theme::panel)
        .into()
}

// ---- small pieces

fn num(v: &Value, default: f64) -> f64 {
    v.as_f64().unwrap_or(default)
}

fn chips<'a>(lang: Lang, items: Vec<(String, bool, Message)>) -> Element<'a, Message> {
    dir_row(lang, items.into_iter().map(|(label, on, msg)| button(text(label).size(12)).padding([5, 10]).style(theme::btn(Btn::Tab(on))).on_press(msg).into()).collect()).spacing(4).wrap().vertical_spacing(4).into()
}

fn toggle<'a>(lang: Lang, label: &'a str, on: bool, msg: impl Fn(bool) -> Message + 'a) -> Element<'a, Message> {
    dir_row(lang, vec![text(label).size(12).color(theme::TEXT2).width(Fill).into(), toggler(on).on_toggle(msg).size(18).into()]).align_y(iced::Center).into()
}

fn swatches<'a>(lang: Lang, current: &str, msg: impl Fn(String) -> Message + 'a) -> Element<'a, Message> {
    let current = current.to_lowercase();
    dir_row(lang, COLORS.iter().map(|&c| button(text("")).width(24).height(24).style(theme::swatch(theme::hex(c), current.starts_with(c))).on_press(msg(c.to_string())).into()).collect()).spacing(6).into()
}

fn section<'a>(lang: Lang, title: &'a str, items: Vec<Element<'a, Message>>) -> Element<'a, Message> {
    let mut col = Column::new().spacing(10).push(heading(title, lang));
    for i in items {
        col = col.push(i);
    }
    container(col).padding(Padding { bottom: 8.0, ..Padding::ZERO }).into()
}

/// The clip's position/scale at the playhead, following its keyframes.
fn animated(cj: &Value, rel: f64, key: &str, base: f64) -> f64 {
    let Some(kfs) = cj["keyframes"].as_array().filter(|k| !k.is_empty()) else { return base };
    let at = |k: &Value| num(&k["t"], 0.0);
    let val = |k: &Value| num(&k[key], base);
    match (kfs.iter().rev().find(|k| at(k) <= rel), kfs.iter().find(|k| at(k) > rel)) {
        (Some(a), Some(b)) if a["ease"] != "hold" => {
            let mut u = ((rel - at(a)) / (at(b) - at(a)).max(1e-6)).clamp(0.0, 1.0);
            if a["ease"] == "smooth" {
                u = u * u * (3.0 - 2.0 * u);
            }
            val(a) + (val(b) - val(a)) * u
        }
        (Some(a), _) => val(a),
        (None, Some(b)) => val(b),
        (None, None) => base,
    }
}

// ---- video

fn video<'a>(lang: Lang, ed: &'a Editor, c: Clip, cj: &'a Value) -> Element<'a, Message> {
    let id = c.id.clone();
    let rel = (ed.playhead - c.start).clamp(0.0, c.len());
    let keyed = !c.keyframes.is_empty();
    let tr_ = c.transform.clone();
    let (scale, x, y) = (animated(cj, rel, "scale", tr_.scale), animated(cj, rel, "x", tr_.x), animated(cj, rel, "y", tr_.y));
    // With keyframes, moving a slider sets a keyframe at the playhead (like any editor's diamond).
    let set = |field: &'static str| {
        let id = id.clone();
        move |v: f64| if keyed { Message::Op("setKeyframe", vec![json!(id), json!(rel), json!({ field: v })], Some(field)) } else { Message::SetClip(id.clone(), json!({ "transform": { field: v } }), field) }
    };
    let here = c.keyframes.iter().find(|k| (k.t - rel).abs() < 0.02).map(|k| k.t);
    let key_btn = match here {
        Some(at) => btn("", t(lang, "◆  Remove keyframe"), Btn::Tab(true), Some(Message::Op("removeKeyframe", vec![json!(id), json!(at)], None))),
        None => btn("", t(lang, "◇  Add keyframe"), Btn::Normal, Some(Message::Op("setKeyframe", vec![json!(id), json!(rel), json!({ "scale": scale, "x": x, "y": y })], None))),
    };
    let mut keys = vec![key_btn.into()];
    if keyed {
        keys.push(btn("", t(lang, "Clear keyframes"), Btn::Ghost, Some(Message::Op("clearKeyframes", vec![json!(id)], None))).into());
    }
    let (i2, i3, i4, i5) = (id.clone(), id.clone(), id.clone(), id.clone());
    let crop = |side: &'static str, label: &'static str| {
        let id = id.clone();
        let v = num(&cj["crop"][side], 0.0);
        labeled_slider(lang, t(lang, label), v, 0.0..=0.45, 0.005, format!("{:.0}%", v * 100.0), move |v| Message::SetClip(id.clone(), json!({ "crop": { side: v } }), "crop"))
    };
    let chroma = &cj["chroma"];
    let chroma_on = chroma["enabled"] == true;
    let mut chroma_items = vec![toggle(lang, t(lang, "Remove a color (green screen)"), chroma_on, {
        let id = id.clone();
        move |on| Message::SetClip(id.clone(), json!({ "chroma": { "enabled": on } }), "chroma")
    })];
    if chroma_on {
        let (a, b, d) = (id.clone(), id.clone(), id.clone());
        chroma_items.push(dir_row(lang, ["#00ff00", "#0000ff", "#ffffff", "#000000"].iter().map(|&col| button(text("")).width(24).height(24).style(theme::swatch(theme::hex(col), chroma["color"] == col)).on_press(Message::SetClip(a.clone(), json!({ "chroma": { "color": col } }), "chroma")).into()).collect()).spacing(6).into());
        let sim = num(&chroma["similarity"], 0.18);
        chroma_items.push(labeled_slider(lang, t(lang, "Strength"), sim, 0.01..=1.0, 0.01, format!("{:.0}", sim * 100.0), move |v| Message::SetClip(b.clone(), json!({ "chroma": { "similarity": v } }), "chroma-sim")));
        let blend = num(&chroma["blend"], 0.1);
        chroma_items.push(labeled_slider(lang, t(lang, "Edge softness"), blend, 0.0..=1.0, 0.01, format!("{:.0}", blend * 100.0), move |v| Message::SetClip(d.clone(), json!({ "chroma": { "blend": v } }), "chroma-blend")));
    }
    let stab_on = cj["stabilize"]["enabled"] == true;
    let mut stab = vec![toggle(lang, t(lang, "Stabilize shaky footage"), stab_on, {
        let id = id.clone();
        move |on| Message::SetClip(id.clone(), json!({ "stabilize": { "enabled": on } }), "stab")
    })];
    if stab_on {
        let s = num(&cj["stabilize"]["strength"], 50.0);
        let id = id.clone();
        stab.push(labeled_slider(lang, t(lang, "Strength"), s, 0.0..=100.0, 1.0, format!("{s:.0}"), move |v| Message::SetClip(id.clone(), json!({ "stabilize": { "strength": v } }), "stab-s")));
    }
    let denoise = num(&cj["videoDenoise"], 0.0);
    let labels = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
    let label_row = dir_row(
        lang,
        labels
            .iter()
            .map(|&l| button(text("")).width(22).height(22).style(theme::swatch(crate::timeline::label_color(l), c.label.as_deref() == Some(l))).on_press(Message::SetClip(id.clone(), json!({ "label": if c.label.as_deref() == Some(l) { Value::Null } else { json!(l) } }), "label")).into())
            .collect(),
    )
    .spacing(6);
    column![
        section(lang, t(lang, "Position & size"), vec![
            labeled_slider(lang, t(lang, "Scale"), scale, 0.1..=4.0, 0.01, format!("{:.0}%", scale * 100.0), set("scale")),
            labeled_slider(lang, t(lang, "Position X"), x, -1.0..=1.0, 0.005, format!("{:.0}%", x * 100.0), set("x")),
            labeled_slider(lang, t(lang, "Position Y"), y, -1.0..=1.0, 0.005, format!("{:.0}%", y * 100.0), set("y")),
            labeled_slider(lang, t(lang, "Rotation"), tr_.rotation, -180.0..=180.0, 1.0, format!("{:.0}°", tr_.rotation), move |v| Message::SetClip(i2.clone(), json!({ "transform": { "rotation": v } }), "rotation")),
            labeled_slider(lang, t(lang, "Opacity"), c.opacity, 0.0..=1.0, 0.01, format!("{:.0}%", c.opacity * 100.0), move |v| Message::SetClip(i3.clone(), json!({ "opacity": v }), "opacity")),
            dir_row(lang, keys).spacing(6).into(),
            dir_row(lang, vec![
                btn("\u{E8AB}", t(lang, "Mirror"), Btn::Tab(cj["flipH"] == true), Some(Message::SetClip(i4.clone(), json!({ "flipH": cj["flipH"] != true }), "flip"))).into(),
                btn("\u{E8AB}", t(lang, "Flip"), Btn::Tab(cj["flipV"] == true), Some(Message::SetClip(i4.clone(), json!({ "flipV": cj["flipV"] != true }), "flip"))).into(),
                btn("\u{E7AD}", t(lang, "Rotate"), Btn::Normal, Some(Message::SetClip(i5.clone(), json!({ "transform": { "rotation": ((tr_.rotation + 90.0 + 180.0).rem_euclid(360.0)) - 180.0 } }), "rotate90"))).into(),
                btn("", t(lang, "Reset"), Btn::Ghost, Some(Message::SetClip(i5.clone(), json!({ "transform": { "scale": 1, "x": 0, "y": 0, "rotation": 0 }, "opacity": 1, "flipH": false, "flipV": false }), "reset"))).into(),
            ]).spacing(4).into(),
        ]),
        section(lang, t(lang, "Crop"), vec![crop("l", "Left"), crop("t", "Top"), crop("r", "Right"), crop("b", "Bottom")]),
        section(lang, t(lang, "Mask"), mask_items(lang, &id, &cj["mask"])),
        section(lang, t(lang, "Remove background"), chroma_items),
        section(lang, t(lang, "Stabilize"), stab),
        section(lang, t(lang, "Clean up"), vec![labeled_slider(lang, t(lang, "Video denoise"), denoise, 0.0..=100.0, 1.0, format!("{denoise:.0}"), {
            let id = id.clone();
            move |v| Message::SetClip(id.clone(), json!({ "videoDenoise": v }), "vdenoise")
        })]),
        section(lang, t(lang, "Color label"), vec![label_row.into()]),
    ]
    .spacing(8)
    .into()
}

/// Mask shape chips, then position/size/feather/invert for the chosen shape.
fn mask_items<'a>(lang: Lang, id: &str, mask: &Value) -> Vec<Element<'a, Message>> {
    let kind = mask["type"].as_str();
    let with = |patch: Value| {
        let mut m = if mask.is_object() { mask.clone() } else { json!({ "x": 0, "y": 0, "w": 0.6, "h": 0.6, "feather": 0.1, "invert": false }) };
        for (k, v) in patch.as_object().into_iter().flatten() {
            m[k] = v.clone();
        }
        m
    };
    let shapes = [(None, "None"), (Some("circle"), "Circle"), (Some("rectangle"), "Rectangle"), (Some("linear"), "Linear"), (Some("mirror"), "Band")];
    let mut items = vec![chips(lang, shapes.iter().map(|&(v, l)| (t(lang, l).to_string(), kind == v, Message::SetClip(id.to_string(), json!({ "mask": v.map(|v| with(json!({ "type": v }))) }), "mask"))).collect())];
    let Some(kind) = kind else { return items };
    let field = |key: &'static str, label: &'static str, range: std::ops::RangeInclusive<f64>, default: f64| {
        let v = num(&mask[key], default);
        let (id, base) = (id.to_string(), mask.clone());
        labeled_slider(lang, t(lang, label), v, range, 0.01, format!("{:.0}", v * 100.0), move |v| {
            let mut m = base.clone();
            m[key] = json!(v);
            Message::SetClip(id.clone(), json!({ "mask": m }), "mask-edit")
        })
    };
    if kind != "linear" && kind != "mirror" {
        items.push(field("x", "Position X", -1.0..=1.0, 0.0));
    }
    items.push(field("y", "Position Y", -1.0..=1.0, 0.0));
    if kind == "circle" || kind == "rectangle" {
        items.push(field("w", "Width", 0.02..=2.0, 0.6));
    }
    if kind != "linear" {
        items.push(field("h", "Height", 0.02..=2.0, 0.6));
    }
    items.push(field("feather", "Feather", 0.0..=1.0, 0.1));
    let (id2, base) = (id.to_string(), mask.clone());
    items.push(toggle(lang, t(lang, "Invert"), mask["invert"] == true, move |on| {
        let mut m = base.clone();
        m["invert"] = json!(on);
        Message::SetClip(id2.clone(), json!({ "mask": m }), "mask")
    }));
    items
}

// ---- text

fn text_tab<'a>(app: &'a App, ed: &'a Editor, c: Clip, cj: &'a Value) -> Element<'a, Message> {
    let lang = app.lang;
    let id = c.id.clone();
    let st = &cj["style"];
    let set = |key: &'static str| {
        let id = id.clone();
        move |v: Value| Message::SetClip(id.clone(), json!({ "style": { key: v } }), key)
    };
    let box_: Element<Message> = match &ed.text_box {
        Some((tid, content)) if *tid == c.id => text_editor(content).on_action(Message::TextEdit).height(96).padding(10).size(15).style(theme::editor).into(),
        _ => text("").into(),
    };
    let presets = chips(lang, app.catalog.styles.iter().map(|s| (tr(lang, s["name"].as_str().unwrap_or("")).to_string(), false, Message::SetClip(id.clone(), json!({ "style": s["style"] }), "preset"))).collect());
    let font = st["font"].as_str().unwrap_or("Segoe UI").to_string();
    let size = num(&st["size"], 72.0);
    let stroke = num(&st["strokeWidth"], 0.0);
    let (f1, f2, f3, f4, f5, f6) = (set("font"), set("size"), set("color"), set("bold"), set("strokeWidth"), set("strokeColor"));
    let (f7, f8, f9) = (set("bg"), set("shadow"), set("align"));
    let bg = st["bg"].as_str();
    let fonts = pick_list(app.catalog.font_names.as_slice(), Some(font), move |f: String| f1(json!(f))).text_size(13).padding([6, 10]).width(Fill).style(theme::pick).menu_style(theme::pick_menu);
    let aligns = chips(lang, [("left", "Left"), ("center", "Center"), ("right", "Right")].into_iter().map(|(v, l)| (t(lang, l).to_string(), st["align"] == v, f9(json!(v)))).collect());
    let mut bg_items = vec![toggle(lang, t(lang, "Background"), bg.is_some(), {
        let f7 = set("bg");
        move |on| f7(if on { json!("#000000a6") } else { Value::Null })
    })];
    if let Some(bg) = bg {
        bg_items.push(swatches(lang, bg, move |c| f7(json!(format!("{c}{}", bg.get(7..9).unwrap_or("ff"))))));
    }
    column![
        section(lang, t(lang, "Text"), vec![box_]),
        section(lang, t(lang, "Styles"), vec![presets]),
        section(lang, t(lang, "Font"), vec![
            fonts.into(),
            labeled_slider(lang, t(lang, "Size"), size, 12.0..=300.0, 1.0, format!("{size:.0}"), move |v| f2(json!(v.round()))),
            swatches(lang, st["color"].as_str().unwrap_or("#ffffff"), move |c| f3(json!(c))),
            toggle(lang, t(lang, "Bold"), st["bold"] == true, move |on| f4(json!(on))),
            aligns,
        ]),
        section(lang, t(lang, "Outline"), vec![
            labeled_slider(lang, t(lang, "Width"), stroke, 0.0..=20.0, 1.0, format!("{stroke:.0}"), move |v| f5(json!(v.round()))),
            swatches(lang, st["strokeColor"].as_str().unwrap_or("#000000"), move |c| f6(json!(c))),
        ]),
        section(lang, t(lang, "Background"), bg_items),
        section(lang, t(lang, "Shadow"), vec![toggle(lang, t(lang, "Drop shadow"), st["shadow"] == true, move |on| f8(json!(on)))]),
        section(lang, t(lang, "Read aloud"), read_aloud(app, ed, &c)),
        video_basics(lang, ed, &c, cj),
    ]
    .spacing(8)
    .into()
}

/// Text to speech with the Windows voices on this PC.
fn read_aloud<'a>(app: &'a App, ed: &Editor, c: &Clip) -> Vec<Element<'a, Message>> {
    let lang = app.lang;
    if app.voices.is_empty() {
        return vec![note(t(lang, "No Windows voices found. Add some in Windows Settings › Time & language › Speech."))];
    }
    let voice = app.voice.clone().unwrap_or_else(|| app.voices[0].clone());
    let say = Message::Flow("speak", vec![json!({ "text": c.text, "voice": voice, "start": c.start })], "Making the voice…");
    vec![
        pick_list(app.voices.as_slice(), Some(voice), Message::Voice).text_size(13).padding([6, 10]).width(Fill).style(theme::pick).menu_style(theme::pick_menu).into(),
        btn("\u{E767}", t(lang, "Read the text aloud"), Btn::Normal, ed.busy.is_none().then_some(say)).width(Fill).into(),
        note(t(lang, "Uses the voices installed in Windows; add more (like Arabic) in Settings › Time & language › Speech.")),
    ]
}

/// Position, size and rotation only (for text).
fn video_basics<'a>(lang: Lang, ed: &Editor, c: &Clip, cj: &Value) -> Element<'a, Message> {
    let rel = (ed.playhead - c.start).clamp(0.0, c.len());
    let tr_ = &c.transform;
    let (scale, x, y) = (animated(cj, rel, "scale", tr_.scale), animated(cj, rel, "x", tr_.x), animated(cj, rel, "y", tr_.y));
    let set = |field: &'static str| {
        let id = c.id.clone();
        move |v: f64| Message::SetClip(id.clone(), json!({ "transform": { field: v } }), field)
    };
    section(lang, t(lang, "Position & size"), vec![
        labeled_slider(lang, t(lang, "Scale"), scale, 0.1..=4.0, 0.01, format!("{:.0}%", scale * 100.0), set("scale")),
        labeled_slider(lang, t(lang, "Position X"), x, -1.0..=1.0, 0.005, format!("{:.0}%", x * 100.0), set("x")),
        labeled_slider(lang, t(lang, "Position Y"), y, -1.0..=1.0, 0.005, format!("{:.0}%", y * 100.0), set("y")),
        labeled_slider(lang, t(lang, "Rotation"), tr_.rotation, -180.0..=180.0, 1.0, format!("{:.0}°", tr_.rotation), set("rotation")),
    ])
}

// ---- audio

fn audio<'a>(app: &'a App, ed: &'a Editor, c: Clip, cj: &'a Value) -> Element<'a, Message> {
    let lang = app.lang;
    let id = c.id.clone();
    let a = &cj["audio"];
    let set = |key: &'static str| {
        let id = id.clone();
        move |v: Value| Message::SetClip(id.clone(), json!({ "audio": { key: v } }), key)
    };
    let (s1, s2, s3, s4, s5) = (set("denoise"), set("enhance"), set("normalize"), set("pitch"), set("voice"));
    let (v1, v2, v3) = (id.clone(), id.clone(), id.clone());
    let denoise = num(&a["denoise"], 0.0);
    let pitch = num(&a["pitch"], 0.0);
    let voice = a["voice"].as_str();
    let mut voices = vec![(t(lang, "None").to_string(), voice.is_none(), s5(Value::Null))];
    voices.extend(app.catalog.voices.iter().map(|v| (tr(lang, v["name"].as_str().unwrap_or("")).to_string(), voice == v["id"].as_str(), s5(v["id"].clone()))));
    let tools: Element<Message> = match &ed.busy {
        Some((job, what)) => {
            let p = app.jobs.progress(job).unwrap_or(0.0) as f32;
            column![text(what).size(12), progress_bar(0.0..=1.0, p).girth(6), text(format!("{:.0}%", p * 100.0)).size(11).color(theme::MUTED)].spacing(6).into()
        }
        None => column![
            btn("\u{E8D6}", t(lang, "Separate voice, game & music"), Btn::Normal, Some(Message::Audio(AudioTool::Stems))).width(Fill),
            btn("\u{E74F}", t(lang, "Remove music"), Btn::Normal, Some(Message::Audio(AudioTool::NoMusic))).width(Fill),
            btn("\u{E9D5}", t(lang, "Split recorded tracks (OBS)"), Btn::Normal, Some(Message::Audio(AudioTool::Tracks))).width(Fill),
            btn("\u{E8D6}", t(lang, "Extract audio to its own track"), Btn::Normal, Some(Message::Op("extractAudio", vec![json!(id)], None))).width(Fill),
            btn("\u{E7C1}", t(lang, "Mark the beats"), Btn::Normal, Some(Message::Flow("beats", vec![json!(id), json!({})], "Finding the beats…"))).width(Fill),
        ]
        .spacing(6)
        .into(),
    };
    column![
        section(lang, t(lang, "Sound"), vec![
            labeled_slider(lang, t(lang, "Volume"), c.volume, 0.0..=4.0, 0.01, format!("{:.0}%", c.volume * 100.0), move |v| Message::SetClip(v1.clone(), json!({ "volume": v }), "volume")),
            labeled_slider(lang, t(lang, "Fade in"), c.fade_in, 0.0..=5.0, 0.05, format!("{:.2}s", c.fade_in), move |v| Message::SetClip(v2.clone(), json!({ "fadeIn": v }), "fadeIn")),
            labeled_slider(lang, t(lang, "Fade out"), c.fade_out, 0.0..=5.0, 0.05, format!("{:.2}s", c.fade_out), move |v| Message::SetClip(v3.clone(), json!({ "fadeOut": v }), "fadeOut")),
            btn(if c.muted { "\u{E767}" } else { "\u{E74F}" }, t(lang, if c.muted { "Unmute clip" } else { "Mute clip" }), Btn::Normal, Some(Message::SetClip(id.clone(), json!({ "muted": !c.muted }), "mute"))).into(),
        ]),
        section(lang, t(lang, "Enhance"), vec![
            toggle(lang, t(lang, "Enhance voice"), a["enhance"] == true, move |on| s2(json!(on))),
            toggle(lang, t(lang, "Normalize loudness"), a["normalize"] == true, move |on| s3(json!(on))),
            labeled_slider(lang, t(lang, "Reduce noise"), denoise, 0.0..=100.0, 1.0, format!("{denoise:.0}"), move |v| s1(json!(v))),
            labeled_slider(lang, t(lang, "Pitch"), pitch, -12.0..=12.0, 1.0, format!("{pitch:+.0}"), move |v| s4(json!(v))),
        ]),
        section(lang, t(lang, "Voice effects"), vec![chips(lang, voices)]),
        section(lang, t(lang, "Audio tools"), vec![note(t(lang, "Runs on your PC with AI models; nothing is uploaded.")), tools]),
    ]
    .spacing(8)
    .into()
}

// ---- speed

fn speed<'a>(app: &'a App, ed: &'a Editor, c: Clip) -> Element<'a, Message> {
    let lang = app.lang;
    let id = c.id.clone();
    let s = if c.speed > 0.0 { c.speed } else { 1.0 };
    let i1 = id.clone();
    // Log scale: 0.1× … 10× with 1× in the middle.
    let slider = labeled_slider(lang, t(lang, "Speed"), s.log10(), -1.0..=1.0, 0.01, format!("{s:.2}×"), move |v| Message::SetClip(i1.clone(), json!({ "speed": (10f64.powf(v) * 100.0).round() / 100.0 }), "speed"));
    let presets = chips(lang, [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0].into_iter().map(|v| (format!("{v}×"), (s - v).abs() < 1e-3, Message::SetClip(id.clone(), json!({ "speed": v }), "speed"))).collect());
    let ramps: Vec<Element<Message>> = app.catalog.ramps.iter().map(|(key, label)| btn("\u{E9D9}", tr(lang, label), Btn::Normal, Some(Message::Op("speedRamp", vec![json!(id), json!(key)], None))).width(Fill).into()).collect();
    let busy = ed.busy.is_some();
    column![
        section(lang, t(lang, "Normal speed"), vec![slider, presets, text(format!("{} {}", t(lang, "Length"), format_duration(c.len()))).size(11).color(theme::MUTED).into()]),
        section(lang, t(lang, "Speed curves"), ramps),
        section(lang, t(lang, "Time"), vec![
            btn("\u{E72C}", t(lang, "Reverse (play backwards)"), Btn::Normal, (!busy).then(|| Message::Flow("reverse", vec![json!(id), json!({})], "Reversing the clip…"))).width(Fill).into(),
            btn("\u{E722}", t(lang, "Freeze frame at the playhead"), Btn::Normal, (!busy).then(|| Message::Flow("freeze", vec![json!(id), json!(ed.playhead), json!({ "duration": 3 })], "Making a freeze frame…"))).width(Fill).into(),
        ]),
    ]
    .spacing(8)
    .into()
}

// ---- animation

fn animation<'a>(app: &'a App, ed: &'a Editor, c: Clip, cj: &'a Value) -> Element<'a, Message> {
    let lang = app.lang;
    let id = c.id.clone();
    let key = if ed.anim_out { "animOut" } else { "animIn" };
    let current = &cj[key];
    let kind = current["type"].as_str();
    let duration = num(&current["duration"], 0.5);
    let side = chips(lang, vec![(t(lang, "In").to_string(), !ed.anim_out, Message::AnimSide(false)), (t(lang, "Out").to_string(), ed.anim_out, Message::AnimSide(true))]);
    let mut items = vec![(t(lang, "None").to_string(), kind.is_none(), Message::SetClip(id.clone(), json!({ key: null }), "anim"))];
    items.extend(app.catalog.animations.iter().map(|a| (tr(lang, a["name"].as_str().unwrap_or("")).to_string(), kind == a["id"].as_str(), Message::SetClip(id.clone(), json!({ key: { "type": a["id"], "duration": duration } }), "anim"))));
    let mut anim = vec![side, chips(lang, items)];
    if let Some(k) = kind {
        let (id2, k) = (id.clone(), k.to_string());
        anim.push(labeled_slider(lang, t(lang, "Duration"), duration, 0.1..=c.len().clamp(0.2, 5.0), 0.05, format!("{duration:.2}s"), move |v| Message::SetClip(id2.clone(), json!({ key: { "type": k, "duration": v } }), "anim-d")));
    }
    let mut trans = vec![];
    match &c.transition {
        Some(tr_) => {
            let name = app.catalog.transitions.iter().find(|x| x["id"] == tr_.kind.as_str()).and_then(|x| x["name"].as_str()).unwrap_or(&tr_.kind);
            let (i2, kind2) = (id.clone(), tr_.kind.clone());
            trans.push(text(tr(lang, name).to_string()).size(13).into());
            trans.push(labeled_slider(lang, t(lang, "Duration"), tr_.duration, 0.1..=3.0, 0.05, format!("{:.2}s", tr_.duration), move |v| Message::Op("setTransition", vec![json!(i2), json!({ "type": kind2, "duration": v })], Some("transition"))));
            trans.push(btn("\u{E711}", t(lang, "Remove transition"), Btn::Ghost, Some(Message::Op("setTransition", vec![json!(id), Value::Null], None))).into());
        }
        None => trans.push(note(t(lang, "Add one from Transitions in the left panel."))),
    }
    column![section(lang, t(lang, "Animation"), anim), section(lang, t(lang, "Transition into this clip"), trans)].spacing(8).into()
}

// ---- color

fn color<'a>(app: &'a App, c: Clip, cj: &'a Value) -> Element<'a, Message> {
    let lang = app.lang;
    let id = c.id.clone();
    let mut look = vec![];
    match cj["filter"]["id"].as_str() {
        Some(fid) => {
            let name = app.catalog.filters.iter().find(|f| f["id"] == fid).and_then(|f| f["name"].as_str()).unwrap_or(fid);
            let v = num(&cj["filter"]["intensity"], 100.0);
            let (i1, fid2) = (id.clone(), fid.to_string());
            look.push(dir_row(lang, vec![text(tr(lang, name)).size(13).width(Fill).into(), btn("\u{E711}", t(lang, "Remove"), Btn::Ghost, Some(Message::SetClip(id.clone(), json!({ "filter": null }), "filter"))).into()]).align_y(iced::Center).into());
            look.push(labeled_slider(lang, t(lang, "Strength"), v, 0.0..=100.0, 1.0, format!("{v:.0}"), move |v| Message::SetClip(i1.clone(), json!({ "filter": { "id": fid2, "intensity": v } }), "filter-i")));
        }
        None => look.push(note(t(lang, "Pick a filter in the left panel."))),
    }
    let lut = cj["lut"].as_str();
    look.push(match lut {
        Some(path) => dir_row(lang, vec![text(format!("LUT: {}", path.rsplit(['\\', '/']).next().unwrap_or(path))).size(12).width(Fill).into(), btn("\u{E711}", t(lang, "Remove"), Btn::Ghost, Some(Message::SetClip(id.clone(), json!({ "lut": null }), "lut"))).into()]).align_y(iced::Center).into(),
        None => btn("\u{E8B5}", t(lang, "Load a LUT (.cube)"), Btn::Normal, Some(Message::Pick("lut"))).width(Fill).into(),
    });
    let adjust: Vec<Element<Message>> = app
        .catalog
        .adjust
        .iter()
        .map(|(key, lo, hi)| {
            let v = num(&cj["adjust"][key.as_str()], 0.0);
            let (id, key2) = (id.clone(), key.clone());
            labeled_slider(lang, t(lang, crate::Catalog::adjust_label(key)), v, *lo..=*hi, 1.0, format!("{v:.0}"), move |v| Message::SetClip(id.clone(), json!({ "adjust": { key2.clone(): v } }), "adjust"))
        })
        .collect();
    let mut adjust_items = adjust;
    let zero: serde_json::Map<String, Value> = app.catalog.adjust.iter().map(|(k, _, _)| (k.clone(), json!(0))).collect();
    adjust_items.push(btn("", t(lang, "Reset"), Btn::Ghost, Some(Message::SetClip(id.clone(), json!({ "adjust": zero }), "adjust-reset"))).into());
    let applied = cj["effects"].as_array().cloned().unwrap_or_default();
    let mut fx: Vec<Element<Message>> = vec![];
    for (i, e) in applied.iter().enumerate() {
        let name = app.catalog.effects.iter().find(|x| x["id"] == e["id"]).and_then(|x| x["name"].as_str()).unwrap_or("");
        let v = num(&e["intensity"], 60.0);
        let (list, id2) = (applied.clone(), id.clone());
        let mut without = applied.clone();
        without.remove(i);
        fx.push(dir_row(lang, vec![text(tr(lang, name)).size(13).width(Fill).into(), btn("\u{E711}", t(lang, "Remove"), Btn::Ghost, Some(Message::SetClip(id.clone(), json!({ "effects": without }), "effects"))).into()]).align_y(iced::Center).into());
        fx.push(labeled_slider(lang, t(lang, "Strength"), v, 0.0..=100.0, 1.0, format!("{v:.0}"), move |v| {
            let mut next = list.clone();
            next[i]["intensity"] = json!(v);
            Message::SetClip(id2.clone(), json!({ "effects": next }), "effects-i")
        }));
    }
    if fx.is_empty() {
        fx.push(note(t(lang, "Add effects from Effects in the left panel.")));
    }
    let col = &cj["color"];
    let wheel = |key: &'static str, label: &'static str| -> Element<'a, Message> {
        let w = &col[key];
        let (x, y, l) = (num(&w["x"], 0.0) as f32, num(&w["y"], 0.0) as f32, num(&w["l"], 0.0));
        let id2 = id.clone();
        column![
            text(t(lang, label)).size(11).color(theme::TEXT2),
            canvas(color::Wheel { clip: id.clone(), key, x, y, l }).width(136).height(136),
            slider(-1.0..=1.0, l, move |v| Message::SetClip(id2.clone(), json!({ "color": { key: { "x": x, "y": y, "l": v } } }), "wheel-l")).step(0.01).width(136).style(theme::slider_style),
        ]
        .spacing(6)
        .align_x(iced::Center)
        .into()
    };
    let points: Vec<[f32; 2]> = col["curve"].as_array().map(|a| a.iter().map(|p| [num(&p[0], 0.0) as f32, num(&p[1], 0.0) as f32]).collect()).filter(|p: &Vec<[f32; 2]>| p.len() >= 2).unwrap_or_else(|| vec![[0.0, 0.0], [1.0, 1.0]]);
    let wheels = vec![
        dir_row(lang, vec![wheel("lift", "Shadows"), wheel("gamma", "Midtones")]).spacing(16).into(),
        dir_row(lang, vec![wheel("gain", "Highlights"), wheel("offset", "Offset")]).spacing(16).into(),
        dir_row(lang, vec![note(t(lang, "Drag a puck to tint; right-click to reset.")), btn("", t(lang, "Reset"), Btn::Ghost, Some(Message::SetClip(id.clone(), json!({ "color": { "lift": {}, "gamma": {}, "gain": {}, "offset": {} } }), "wheels-reset"))).into()]).align_y(iced::Center).into(),
    ];
    let curve = vec![
        canvas(color::Curve { clip: id.clone(), points }).width(Fill).height(200).into(),
        dir_row(lang, vec![note(t(lang, "Click to add a point, drag to move, right-click to remove.")), btn("", t(lang, "Reset"), Btn::Ghost, Some(Message::SetClip(id.clone(), json!({ "color": { "curve": [[0, 0], [1, 1]] } }), "curve-reset"))).into()]).align_y(iced::Center).into(),
    ];
    column![
        section(lang, t(lang, "Filter"), look),
        section(lang, t(lang, "Adjust"), adjust_items),
        section(lang, t(lang, "Color wheels"), wheels),
        section(lang, t(lang, "Curve"), curve),
        section(lang, t(lang, "Effects"), fx),
    ]
    .spacing(8)
    .into()
}

// ---- project (nothing selected)

fn project<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let cv = &ed.p.canvas;
    let short = cv.width.min(cv.height).max(2);
    let even = |v: f64| ((v / 2.0).round() * 2.0) as u32;
    let ratio = |w: f64, h: f64| super::ratio_size(cv, w, h);
    let ratios = chips(
        lang,
        [("16:9", 16.0, 9.0), ("9:16", 9.0, 16.0), ("1:1", 1.0, 1.0), ("4:3", 4.0, 3.0), ("3:4", 3.0, 4.0), ("21:9", 21.0, 9.0)]
            .into_iter()
            .map(|(l, w, h)| {
                let (cw, ch) = ratio(w, h);
                (l.to_string(), cw == cv.width && ch == cv.height, Message::Op("setCanvas", vec![json!({ "width": cw, "height": ch })], None))
            })
            .collect(),
    );
    let scale_to = |s: u32| {
        let k = s as f64 / short as f64;
        (even(cv.width as f64 * k), even(cv.height as f64 * k))
    };
    let sizes = chips(
        lang,
        [(720u32, "720p"), (1080, "1080p"), (1440, "1440p"), (2160, "4K")]
            .into_iter()
            .map(|(s, l)| {
                let (w, h) = scale_to(s);
                (l.to_string(), short == s, Message::Op("setCanvas", vec![json!({ "width": w, "height": h })], None))
            })
            .collect(),
    );
    let fps = chips(lang, [24.0, 25.0, 30.0, 50.0, 60.0].into_iter().map(|f| (format!("{f}"), (cv.fps - f).abs() < 0.01, Message::Op("setCanvas", vec![json!({ "fps": f })], None))).collect());
    let loud = ed.p.settings.loudness;
    let loudness = chips(
        lang,
        [(None, "Off"), (Some(-14.0), "YouTube −14"), (Some(-16.0), "−16"), (Some(-23.0), "TV −23")]
            .into_iter()
            .map(|(v, l)| (t(lang, l).to_string(), loud == v, Message::Op("setSettings", vec![json!({ "loudness": v })], None)))
            .collect(),
    );
    let fact = |k: &'static str, v: String| -> Element<'a, Message> { container(column![text(t(lang, k)).size(10).color(theme::MUTED), text(v).size(13)].spacing(2)).padding([8, 10]).width(Fill).style(theme::card).into() };
    column![
        section(lang, t(lang, "Project"), vec![
            dir_row(lang, vec![fact("Canvas", format!("{}×{}", cv.width, cv.height)), fact("Frame rate", format!("{} fps", cv.fps))]).spacing(8).into(),
            dir_row(lang, vec![fact("Duration", format_duration(ed.p.duration())), fact("Clips", ed.p.clips.len().to_string())]).spacing(8).into(),
            note(t(lang, "Select a clip to edit it.")),
        ]),
        section(lang, t(lang, "Aspect ratio"), vec![ratios]),
        section(lang, t(lang, "Canvas background"), vec![
            chips(lang, [(None, "Black"), (Some("blur"), "Blur"), (Some("#ffffff"), "White"), (Some("#1cd0db"), "Teal"), (Some("#ffd400"), "Yellow")].into_iter().map(|(v, l)| (t(lang, l).to_string(), ed.p.settings.background.as_deref() == v, Message::Op("setSettings", vec![json!({ "background": v })], None))).collect()),
            note(t(lang, "Fills the frame around footage that doesn't cover it, like a vertical video on a wide canvas.")),
        ]),
        section(lang, t(lang, "Resolution"), vec![sizes]),
        section(lang, t(lang, "Frame rate"), vec![fps]),
        section(lang, t(lang, "Loudness on export"), vec![loudness]),
        section(lang, t(lang, "Timeline"), vec![
            toggle(lang, t(lang, "Main track magnet"), ed.p.settings.magnet, Message::Magnet),
            btn("\u{E9A6}", t(lang, "Close all gaps"), Btn::Normal, Some(Message::Op("closeGaps", vec![], None))).width(Fill).into(),
        ]),
    ]
    .spacing(8)
    .into()
}

