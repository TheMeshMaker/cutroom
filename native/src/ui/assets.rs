//! The asset panel (top left): media, audio, text, effects, transitions,
//! captions, filters and adjustment layers. Picking an item adds it at the
//! playhead or applies it to the current clip.

use iced::alignment::Horizontal;
use iced::widget::{button, column, container, hover, image, mouse_area, progress_bar, scrollable, space, stack, text, Column};
use iced::{ContentFit, Element, Fill, Font};
use serde_json::{json, Value};

use super::{btn, dir_row, format_duration, heading, icon, note};
use crate::editor::{Asset, Editor};
use crate::i18n::{t, tr, Lang};
use crate::theme::{self, Btn};
use crate::{App, Message};

const TABS: [(Asset, &str, &str); 9] = [
    (Asset::Media, "\u{E91B}", "Media"),
    (Asset::Audio, "\u{E8D6}", "Audio"),
    (Asset::Text, "\u{E8D2}", "Text"),
    (Asset::Stickers, "\u{E76E}", "Stickers"),
    (Asset::Effects, "\u{E945}", "Effects"),
    (Asset::Transitions, "\u{E8AB}", "Transitions"),
    (Asset::Captions, "\u{E7F0}", "Captions"),
    (Asset::Filters, "\u{E790}", "Filters"),
    (Asset::Adjustment, "\u{E706}", "Adjustment"),
];

pub fn panel<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let tabs = dir_row(
        lang,
        TABS.iter()
            .map(|&(a, code, label)| {
                // Long names (other languages) are clipped to the tab instead of running into the next one.
                button(column![icon(code).size(17), container(text(t(lang, label)).size(10).wrapping(text::Wrapping::None)).center_x(Fill).clip(true)].spacing(4).align_x(iced::Center).width(Fill))
                    .width(Fill)
                    .padding([7, 0])
                    .style(theme::btn(Btn::Tab(ed.asset == a)))
                    .on_press(Message::Asset(a))
                    .into()
            })
            .collect(),
    )
    .spacing(2);
    let body: Element<Message> = match ed.asset {
        Asset::Media => media(app, ed, false),
        Asset::Audio => media(app, ed, true),
        Asset::Text => texts(app, ed),
        Asset::Effects => effects(app, ed),
        Asset::Transitions => transitions(app, ed),
        Asset::Captions => captions(app, ed),
        Asset::Filters => filters(app, ed),
        Asset::Adjustment => adjustment(app, ed),
        Asset::Stickers => stickers(app, ed),
    };
    container(column![container(tabs).padding([6, 6]).style(theme::bar), container(scrollable(container(body).padding([12, 14])).height(Fill)).height(Fill)])
        .width((app.window.width * 0.27).clamp(300.0, 450.0))
        .height(Fill)
        .style(theme::panel)
        .into()
}

/// Items in rows of `per_row`, right to left in Arabic.
fn grid<'a>(lang: Lang, items: Vec<Element<'a, Message>>, per_row: usize) -> Element<'a, Message> {
    let mut rows: Vec<Element<Message>> = Vec::new();
    let mut items = items.into_iter().peekable();
    while items.peek().is_some() {
        let mut row: Vec<Element<Message>> = items.by_ref().take(per_row).collect();
        while row.len() < per_row {
            row.push(space().width(Fill).into());
        }
        rows.push(dir_row(lang, row).spacing(8).into());
    }
    Column::with_children(rows).spacing(8).into()
}

/// A library tile: a picture area (icon or custom) and a name; lit when in use.
fn tile<'a>(art: Element<'a, Message>, label: String, on: bool, msg: Option<Message>) -> Element<'a, Message> {
    button(column![container(art).width(Fill).height(64).center_x(Fill).center_y(64).clip(true).style(theme::stage), container(text(label).size(11)).center_x(Fill)].spacing(6))
        .width(Fill)
        .padding(5)
        .style(theme::tile(on))
        .on_press_maybe(msg)
        .into()
}

fn hint<'a>(lang: Lang, ed: &Editor) -> Option<Element<'a, Message>> {
    ed.targets().is_empty().then(|| note(t(lang, "Select a clip on the timeline first.")))
}

// ---- media / audio

fn media<'a>(app: &'a App, ed: &'a Editor, audio: bool) -> Element<'a, Message> {
    let lang = app.lang;
    let items: Vec<Element<Message>> = ed
        .p
        .media
        .iter()
        .filter(|m| !audio || !m.has_video)
        .map(|m| {
            let thumb: Element<Message> = match ed.strips.get(&m.id).and_then(|s| s.tiles.get(s.tiles.len() / 3)) {
                Some(tile) => image(tile.clone()).width(Fill).height(Fill).content_fit(ContentFit::Cover).into(),
                None => container(icon(if m.has_video { "\u{E714}" } else { "\u{E8D6}" }).size(20).color(theme::MUTED)).center(Fill).into(),
            };
            let length = if m.kind == "image" { t(lang, "Image").to_string() } else { format_duration(m.duration) };
            let base = container(stack![thumb, container(container(text(length).size(10)).padding([1, 5]).style(theme::pill)).width(Fill).height(Fill).align_x(iced::Right).align_y(iced::Bottom).padding(4)])
                .width(Fill)
                .height(78)
                .clip(true)
                .style(theme::stage);
            let add = container(iced::widget::tooltip(
                button(icon("\u{E710}").size(12).color(theme::ACCENT_INK)).padding(6).style(theme::btn(Btn::Primary)).on_press(Message::AddMedia(m.id.clone())),
                container(text(t(lang, "Add to timeline")).size(12)).padding([5, 9]).style(theme::menu),
                iced::widget::tooltip::Position::Top,
            ))
            .width(Fill)
            .height(Fill)
            .align_x(iced::Right)
            .padding(4);
            let mut card = column![
                mouse_area(hover(base, add)).on_press(Message::DragMedia(Some(m.id.clone()))).interaction(iced::mouse::Interaction::Grab),
                container(text(crate::i18n::message(lang, &m.name)).size(11).wrapping(text::Wrapping::None)).width(Fill).clip(true),
            ]
            .spacing(4);
            if let Some(tracks) = &m.audio_tracks {
                card = card.push(text(format!("{} {}", tracks.len(), t(lang, "audio tracks"))).size(10).color(theme::ACCENT));
            }
            if let Some(p) = app.jobs.progress(&format!("prep:{}", m.id)) {
                card = card.push(progress_bar(0.0..=1.0, p as f32).girth(3));
            }
            card.into()
        })
        .collect();
    let mut body = column![dir_row(lang, vec![heading(t(lang, if audio { "Audio" } else { "Media" }), lang), btn("\u{E710}", t(lang, "Import"), Btn::Primary, Some(Message::Import)).into()]).align_y(iced::Center)].spacing(12);
    if items.is_empty() {
        body = body.push(
            button(column![icon("\u{E8B5}").size(26), text(t(lang, "Import")).size(14), text(t(lang, "Video, audio and images")).size(11).color(theme::MUTED)].spacing(8).align_x(iced::Center))
                .width(Fill)
                .padding(28)
                .style(theme::tile(false))
                .on_press(Message::Import),
        );
    } else {
        body = body.push(grid(lang, items, 3));
    }
    if audio {
        let target = ed.targets().first().cloned();
        body = body.push(heading(t(lang, "From the timeline"), lang));
        body = body.push(btn("\u{E8D6}", t(lang, "Extract audio from the clip"), Btn::Normal, target.clone().map(|id| Message::Op("extractAudio", vec![json!(id)], None))).width(Fill));
        body = body.push(btn("\u{E7BA}", t(lang, "Bleep (censor) at the playhead"), Btn::Normal, Some(Message::Op("addBleep", vec![json!(ed.playhead), json!(ed.playhead + 0.6)], None))).width(Fill));
        body = body.push(note(t(lang, "Voice, game and music separation is in the Audio tab on the right when a clip is selected.")));
    }
    body.into()
}

// ---- text

fn texts<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let at = ed.playhead;
    let add = button(dir_row(lang, vec![icon("\u{E710}").size(16).into(), text(t(lang, "Add text")).size(14).into()]).spacing(10).align_y(iced::Center))
        .width(Fill)
        .padding([12, 14])
        .style(theme::btn(Btn::Primary))
        .on_press(Message::Op("addText", vec![json!({ "text": t(lang, "Text"), "start": at })], None));
    let styles: Vec<Element<Message>> = app
        .catalog
        .styles
        .iter()
        .map(|s| {
            let st = &s["style"];
            let font = app.catalog.font(st["font"].as_str().unwrap_or("Segoe UI"));
            let mut sample = container(text("Aa").size(22).font(font).color(theme::hex(st["color"].as_str().unwrap_or("#ffffff")))).padding([2, 8]);
            if let Some(bg) = st["bg"].as_str() {
                let bg = theme::hex(bg);
                sample = sample.style(move |_: &iced::Theme| container::Style { background: Some(bg.into()), border: iced::Border { radius: 4.0.into(), ..Default::default() }, ..Default::default() });
            }
            tile(sample.into(), tr(lang, s["name"].as_str().unwrap_or("")).to_string(), false, Some(Message::Op("addText", vec![json!({ "text": t(lang, "Text"), "style": st, "start": at })], None)))
        })
        .collect();
    let titles: Vec<Element<Message>> = app
        .catalog
        .titles
        .iter()
        .map(|s| {
            let art = text(s["text"].as_str().unwrap_or("").lines().next().unwrap_or("")).size(13).font(app.catalog.font(s["style"]["font"].as_str().unwrap_or("Segoe UI"))).color(theme::hex(s["style"]["color"].as_str().unwrap_or("#ffffff")));
            tile(art.into(), tr(lang, s["name"].as_str().unwrap_or("")).to_string(), false, Some(Message::Op("addTitle", vec![s["id"].clone(), json!({ "start": at })], None)))
        })
        .collect();
    column![add, heading(t(lang, "Text styles"), lang), grid(lang, styles, 3), heading(t(lang, "Title templates"), lang), grid(lang, titles, 2)].spacing(14).into()
}

// ---- effects, transitions, filters

fn effects<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let target = ed.targets().first().cloned();
    let applied: Vec<Value> = target.as_deref().map(|id| ed.clip_json(id)["effects"].as_array().cloned().unwrap_or_default()).unwrap_or_default();
    let items = app
        .catalog
        .effects
        .iter()
        .map(|e| {
            let id = e["id"].as_str().unwrap_or("").to_string();
            let on = applied.iter().any(|a| a["id"] == id.as_str());
            let msg = target.clone().map(|clip| {
                let mut next = applied.clone();
                if on {
                    next.retain(|a| a["id"] != id.as_str());
                } else {
                    next.push(json!({ "id": id, "intensity": 60 }));
                }
                Message::SetClip(clip, json!({ "effects": next }), "effects")
            });
            tile(look(ed, "effect", &id).unwrap_or_else(|| icon("\u{E945}").size(22).into()), tr(lang, e["name"].as_str().unwrap_or("")).to_string(), on, msg)
        })
        .collect();
    let mut body = column![heading(t(lang, "Video effects"), lang)].spacing(12);
    if let Some(h) = hint(lang, ed) {
        body = body.push(h);
    }
    body.push(grid(lang, items, 3)).push(note(t(lang, "Click again to remove. Strength is in the Color tab on the right."))).into()
}

fn transitions<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let target = ed.targets().first().and_then(|id| ed.p.clip(id)).cloned();
    let current = target.as_ref().and_then(|c| c.transition.clone());
    let duration = current.as_ref().map_or(0.5, |c| c.duration);
    let mut items: Vec<Element<Message>> = vec![tile(icon("\u{E711}").size(20).into(), t(lang, "None").to_string(), target.is_some() && current.is_none(), target.as_ref().map(|c| Message::Op("setTransition", vec![json!(c.id), Value::Null], None)))];
    items.extend(app.catalog.transitions.iter().map(|tr_| {
        let id = tr_["id"].as_str().unwrap_or("");
        let on = current.as_ref().is_some_and(|c| c.kind == id);
        tile(icon("\u{E8AB}").size(20).into(), tr(lang, tr_["name"].as_str().unwrap_or("")).to_string(), on, target.as_ref().map(|c| Message::Op("setTransition", vec![json!(c.id), json!({ "type": id, "duration": duration })], None)))
    }));
    let mut body = column![heading(t(lang, "Transitions"), lang), note(t(lang, "Plays between the selected clip and the clip right before it."))].spacing(12);
    if let Some(h) = hint(lang, ed) {
        body = body.push(h);
    }
    body.push(grid(lang, items, 3)).into()
}

fn filters<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let target = ed.targets().first().cloned();
    let current = target.as_deref().and_then(|id| ed.clip_json(id)["filter"]["id"].as_str());
    let mut items: Vec<Element<Message>> = vec![tile(icon("\u{E711}").size(20).into(), t(lang, "None").to_string(), target.is_some() && current.is_none(), target.clone().map(|id| Message::SetClip(id, json!({ "filter": null }), "filter")))];
    items.extend(app.catalog.filters.iter().map(|f| {
        let id = f["id"].as_str().unwrap_or("");
        tile(look(ed, "filter", id).unwrap_or_else(|| filter_art(&f["adjust"])), tr(lang, f["name"].as_str().unwrap_or("")).to_string(), current == Some(id), target.clone().map(|clip| Message::SetClip(clip, json!({ "filter": { "id": id, "intensity": 100 } }), "filter")))
    }));
    let mut body = column![heading(t(lang, "Filters"), lang)].spacing(12);
    if let Some(h) = hint(lang, ed) {
        body = body.push(h);
    }
    body.push(grid(lang, items, 3)).push(note(t(lang, "Strength is in the Color tab on the right."))).into()
}

/// The rendered thumbnail of this filter/effect on the current clip, once ready.
fn look<'a>(ed: &Editor, kind: &str, id: &str) -> Option<Element<'a, Message>> {
    let (key, pictures) = ed.looks.as_ref()?;
    (ed.looks_key().as_ref() == Some(key)).then_some(())?;
    pictures.get(&format!("{kind}:{id}")).map(|h| image(h.clone()).width(Fill).height(Fill).content_fit(ContentFit::Cover).into())
}

/// A small swatch that hints at what a filter does (warmer, cooler, faded, black and white).
fn filter_art<'a>(adjust: &Value) -> Element<'a, Message> {
    let v = |k: &str| adjust[k].as_f64().unwrap_or(0.0) as f32 / 100.0;
    let (temp, sat, fade) = (v("temperature"), v("saturation"), v("fade"));
    let base = iced::Color::from_rgb(0.45 + 0.25 * temp, 0.5, 0.55 - 0.25 * temp);
    let grey = 0.5;
    let mix = |c: f32| c + (grey - c) * (-sat).max(0.0);
    let color = iced::Color::from_rgb(mix(base.r) + fade * 0.2, mix(base.g) + fade * 0.2, mix(base.b) + fade * 0.2);
    container(space()).width(44).height(44).style(move |_: &iced::Theme| container::Style { background: Some(color.into()), border: iced::Border { radius: 22.0.into(), color: theme::LINE2, width: 1.0 }, ..Default::default() }).into()
}

// ---- stickers

const EMOJI: [&str; 42] = [
    "😂", "🤣", "😍", "😎", "🤯", "😱", "😭", "😡", "🥶", "🤔", "😴", "🤡", "👀", "👍", "👎", "👏", "🙏", "💪", "🔥", "💯", "✨",
    "⭐", "❤️", "💔", "💀", "👻", "🎉", "🎮", "🏆", "⚡", "💥", "💣", "🚀", "🎯", "🍿", "📍", "⏰", "❓", "❗", "✅", "❌", "➡️",
];
const SHAPES: [(&str, &str, &str, &str); 5] = [
    ("arrow", "➜", "Arrow", ""),
    ("circle", "◯", "Highlight circle", ""),
    ("bubble", "💬", "Speech bubble", "..."),
    ("burst", "💥", "Burst", "WOW!"),
    ("subscribe", "🔔", "Subscribe button", "SUBSCRIBE"),
];

fn stickers<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let (at, free) = (ed.playhead, ed.busy.is_none());
    let add = move |sticker: Value| free.then(|| Message::Flow("addSticker", vec![sticker], "Adding the sticker…"));
    let emoji: Vec<Element<Message>> = EMOJI
        .iter()
        .map(|&e| {
            button(container(text(e).size(28).font(Font::with_name("Segoe UI Emoji"))).center(Fill))
                .width(Fill)
                .height(56)
                .padding(0)
                .style(theme::tile(false))
                .on_press_maybe(add(json!({ "emoji": e, "start": at })))
                .into()
        })
        .collect();
    let shapes: Vec<Element<Message>> = SHAPES
        .iter()
        .map(|&(id, glyph, label, words)| tile(text(glyph).size(28).font(Font::with_name("Segoe UI Emoji")).into(), t(lang, label).to_string(), false, add(json!({ "shape": id, "text": words, "start": at }))))
        .collect();
    column![
        heading(t(lang, "Emoji"), lang),
        grid(lang, emoji, 6),
        heading(t(lang, "Shapes"), lang),
        grid(lang, shapes, 3),
        note(t(lang, "Stickers go on their own track above your video, at the playhead. Move and size them in the Video tab.")),
    ]
    .spacing(12)
    .into()
}

// ---- captions, adjustment

fn captions<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let langs = [("auto", "Detect"), ("ar", "Arabic"), ("en", "English")];
    let lang_chips = dir_row(lang, langs.iter().map(|&(code, label)| button(text(t(lang, label)).size(12)).padding([6, 12]).style(theme::btn(Btn::Tab(ed.caption_lang == code))).on_press(Message::CaptionLang(code)).into()).collect()).spacing(4);
    let busy = ed.busy.as_ref().map(|(job, what)| column![text(what).size(12), progress_bar(0.0..=1.0, app.jobs.progress(job).unwrap_or(0.0) as f32).girth(6)].spacing(6));
    let generate = btn("\u{E7F0}", t(lang, "Generate captions"), Btn::Primary, ed.busy.is_none().then(|| Message::Flow("captions", vec![json!({ "language": ed.caption_lang, "styleId": "subtitle" })], "Writing captions…"))).width(Fill);
    let mut body = column![heading(t(lang, "Auto captions"), lang), note(t(lang, "Turns the speech in your video into captions on your PC (nothing is uploaded).")), heading(t(lang, "Spoken language"), lang), lang_chips, generate].spacing(12);
    if let Some(b) = busy {
        body = body.push(b);
    }
    body.push(heading(t(lang, "Subtitle files"), lang))
        .push(btn("\u{E8B5}", t(lang, "Import subtitles (.srt)"), Btn::Normal, Some(Message::Pick("subtitles"))).width(Fill))
        .push(btn("\u{E74E}", t(lang, "Save captions as .srt"), Btn::Normal, Some(Message::Pick("save-srt"))).width(Fill))
        .into()
}

fn adjustment<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    column![
        heading(t(lang, "Adjustment layer"), lang),
        note(t(lang, "A layer that changes the look of everything under it: filters, color and effects for many clips at once.")),
        btn("\u{E710}", t(lang, "Add adjustment layer"), Btn::Primary, Some(Message::Op("addAdjustment", vec![json!({ "start": ed.playhead, "duration": 5 })], None))).width(Fill),
    ]
    .spacing(12)
    .align_x(if lang.rtl() { Horizontal::Right } else { Horizontal::Left })
    .into()
}

