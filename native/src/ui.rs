//! Every screen and panel: projects home, top bar, media library, player,
//! properties, timeline toolbar, context menu, export dialog and toasts.
//! Arabic mirrors the panel order and right-aligns text.

use iced::alignment::Horizontal;
use iced::widget::{button, center, column, container, image, mouse_area, opaque, pin, progress_bar, row, scrollable, slider, space, stack, text, text_input, Column, Row};
use iced::{ContentFit, Element, Fill, Font, Length};
use serde_json::json;

use crate::editor::{Editor, Panel};
use crate::i18n::{t, Lang};
use crate::model::timecode;
use crate::theme::{self, Btn};
use crate::{timeline, App, AudioTool, ExportMsg, Message, Screen};

mod assets;
mod details;

const ICONS: Font = Font::with_name("Segoe Fluent Icons");

fn icon<'a>(code: &'a str) -> iced::widget::Text<'a> {
    text(code).font(ICONS).size(15)
}

fn tool<'a>(code: &'a str, tip: &'a str, msg: Message) -> Element<'a, Message> {
    iced::widget::tooltip(button(center(icon(code))).width(32).height(30).padding(0).style(theme::btn(Btn::Ghost)).on_press(msg), container(text(tip).size(12)).padding([5, 9]).style(theme::menu), iced::widget::tooltip::Position::Bottom).into()
}

fn btn<'a>(code: &'a str, label: &'a str, kind: Btn, msg: Option<Message>) -> iced::widget::Button<'a, Message> {
    let content = if code.is_empty() { row![text(label).size(13)] } else { row![icon(code).size(14), text(label).size(13)].spacing(7).align_y(iced::Center) };
    let b = button(content).padding([7, 13]).style(theme::btn(kind));
    match msg {
        Some(m) => b.on_press(m),
        None => b,
    }
}

fn heading<'a>(label: &'a str, lang: Lang) -> Element<'a, Message> {
    // Aligned by the container: right-aligned Arabic text inside a Fill-width text widget is drawn off-screen.
    container(text(label.to_uppercase()).size(11).color(theme::MUTED)).width(Fill).align_x(if lang.rtl() { Horizontal::Right } else { Horizontal::Left }).into()
}

/// Children in reading order: reversed for Arabic.
fn dir_row<'a>(lang: Lang, mut items: Vec<Element<'a, Message>>) -> Row<'a, Message> {
    if lang.rtl() {
        items.reverse();
    }
    Row::with_children(items)
}

/// A small grey explanation; Arabic lines right-align by themselves.
fn note<'a>(s: &'a str) -> Element<'a, Message> {
    text(s).size(11).color(theme::MUTED).width(Fill).into()
}

fn tool_opt<'a>(code: &'a str, tip: &'a str, msg: Option<Message>) -> Element<'a, Message> {
    iced::widget::tooltip(button(center(icon(code))).width(32).height(30).padding(0).style(theme::btn(Btn::Ghost)).on_press_maybe(msg), container(text(tip).size(12)).padding([5, 9]).style(theme::menu), iced::widget::tooltip::Position::Bottom).into()
}

/// The canvas size for an aspect ratio, keeping the current short side.
pub fn ratio_size(cv: &crate::model::Canvas, w: f64, h: f64) -> (u32, u32) {
    let short = cv.width.min(cv.height).max(2) as f64;
    let even = |v: f64| ((v / 2.0).round() * 2.0) as u32;
    if w >= h { (even(short * w / h), short as u32) } else { (short as u32, even(short * h / w)) }
}

const RATIOS: [(&str, f64, f64); 6] = [("16:9", 16.0, 9.0), ("9:16", 9.0, 16.0), ("1:1", 1.0, 1.0), ("4:3", 4.0, 3.0), ("3:4", 3.0, 4.0), ("21:9", 21.0, 9.0)];

/// Interface size: Auto (fits the screen) or a fixed size.
fn size_menu<'a>(app: &App) -> Element<'a, Message> {
    let auto = crate::i18n::fill(t(app.lang, "Auto ({0})"), &[format!("{:.0}%", app.ui_auto * 100.0)]);
    let mut options = vec![auto.clone()];
    options.extend([70, 80, 90, 100, 110, 125, 150].map(|p| format!("{p}%")));
    let current = app.ui_manual.map_or(auto, |s| format!("{:.0}%", s * 100.0));
    row![
        icon("\u{E8A3}").size(14).color(theme::TEXT2),
        iced::widget::pick_list(options, Some(current), |o: String| Message::UiScale(o.strip_suffix('%').and_then(|p| p.parse::<f32>().ok()).map(|p| p / 100.0)))
            .text_size(13)
            .padding([5, 10])
            .style(theme::pick)
            .menu_style(theme::pick_menu),
    ]
    .spacing(8)
    .align_y(iced::Center)
    .into()
}

/// The language menu (top right): every language by its own name.
fn language_menu<'a>(lang: Lang) -> Element<'a, Message> {
    row![
        icon("\u{F2B7}").size(14).color(theme::TEXT2),
        iced::widget::pick_list(Lang::all(), Some(lang), Message::SetLang).text_size(13).padding([5, 10]).style(theme::pick).menu_style(theme::pick_menu),
    ]
    .spacing(8)
    .align_y(iced::Center)
    .into()
}

fn format_duration(t: f64) -> String {
    let s = t.round() as i64;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

pub fn view(app: &App) -> Element<'_, Message> {
    let screen = match &app.screen {
        Screen::Home => home(app),
        Screen::Editor(ed) => editor(app, ed),
    };
    let mut layers = vec![container(screen).width(Fill).height(Fill).style(theme::app).into()];
    if let Some(toast) = &app.toast {
        let mut line = row![
            icon(if toast.error { "\u{E783}" } else { "\u{E73E}" }).color(if toast.error { theme::DANGER } else { theme::ACCENT }),
            text(&toast.text).size(13),
        ]
        .spacing(10)
        .align_y(iced::Center);
        if toast.undo {
            line = line.push(btn("", t(app.lang, "Undo"), Btn::Tab(true), Some(Message::ToastUndo)));
        }
        line = line.push(button(icon("\u{E711}").size(11)).padding(6).style(theme::btn(Btn::Ghost)).on_press(Message::ToastClose));
        layers.push(container(container(line).padding([8, 12]).style(theme::toast)).width(Fill).height(Fill).align_x(iced::Center).align_y(iced::Bottom).padding(26).into());
    }
    stack(layers).into()
}

// ---- projects home

fn home(app: &App) -> Element<'_, Message> {
    let lang = app.lang;
    let top = dir_row(
        lang,
        vec![
            row![container(text("▶").size(12).color(theme::ACCENT_INK)).padding([2, 6]).style(|_: &iced::Theme| container::Style { background: Some(theme::ACCENT.into()), border: iced::Border { radius: 6.0.into(), ..Default::default() }, ..Default::default() }), text("Cutroom").size(18)].spacing(10).align_y(iced::Center).into(),
            space::horizontal().into(),
            row![iced::widget::tooltip(size_menu(app), container(text(t(lang, "Interface size")).size(12)).padding([5, 9]).style(theme::menu), iced::widget::tooltip::Position::Bottom), language_menu(lang)].spacing(16).align_y(iced::Center).into(),
        ],
    )
    .align_y(iced::Center);
    let tile = |code: &'static str, label: &'static str, kind: Btn, msg: Message| -> Element<'_, Message> {
        button(column![icon(code).size(22), space::vertical(), text(t(lang, label)).size(15)].width(Fill).align_x(if lang.rtl() { Horizontal::Right } else { Horizontal::Left })).width(200).height(104).padding(18).style(theme::btn(kind)).on_press(msg).into()
    };
    let actions = dir_row(lang, vec![tile("\u{E710}", "New project", Btn::Primary, Message::NewProject), tile("\u{E8E5}", "Open project…", Btn::Normal, Message::OpenDialog), tile("\u{E8B5}", "Import CapCut draft…", Btn::Normal, Message::ImportCapcut)]).spacing(14);
    let cards: Vec<Element<Message>> = app
        .cards
        .iter()
        .map(|c| {
            let thumb: Element<Message> = match app.thumbs.get(&c.path) {
                Some(h) => image(h.clone()).width(Fill).height(Fill).content_fit(ContentFit::Cover).into(),
                None => center(icon("\u{E714}").size(26).color(theme::MUTED)).into(),
            };
            let stage = container(stack![
                thumb,
                container(container(text(if c.missing { t(lang, "Missing file").to_string() } else { format_duration(c.duration) }).size(11)).padding([2, 6]).style(theme::pill)).width(Fill).height(Fill).align_x(iced::Right).align_y(iced::Bottom).padding(7),
            ])
            .width(Fill)
            .height(140)
            .style(theme::stage);
            let meta = row![
                column![text(&c.name).size(14), text(if c.missing { String::new() } else { format!("{} × {}", c.size.0, c.size.1) }).size(11).color(theme::MUTED)].spacing(2).width(Fill),
                iced::widget::tooltip(button(icon("\u{E711}").size(11)).padding(6).style(theme::btn(Btn::Ghost)).on_press(Message::Forget(c.path.clone())), container(text(t(lang, "Remove from list")).size(12)).padding([5, 9]).style(theme::menu), iced::widget::tooltip::Position::Top),
            ]
            .align_y(iced::Center)
            .padding([10, 12]);
            let card = button(column![stage, meta]).width(250).padding(0).style(theme::btn(Btn::Normal));
            if c.missing { card.into() } else { card.on_press(Message::Open(c.path.clone())).into() }
        })
        .collect();
    let list: Element<Message> = if cards.is_empty() {
        text(t(lang, "No projects yet. Create one to start editing.")).color(theme::MUTED).size(14).into()
    } else {
        // Rows of fixed columns (not a wrapping row) so Arabic fills each row right to left.
        let per_row = ((app.window.width - 56.0 + 18.0) / (250.0 + 18.0)).floor().max(1.0) as usize;
        let mut rows: Vec<Element<Message>> = Vec::new();
        let mut cards = cards.into_iter().peekable();
        while cards.peek().is_some() {
            rows.push(dir_row(lang, cards.by_ref().take(per_row).collect()).spacing(18).into());
        }
        Column::with_children(rows).spacing(18).width(Fill).align_x(if lang.rtl() { Horizontal::Right } else { Horizontal::Left }).into()
    };
    container(scrollable(column![top, actions, heading(t(lang, "Recent projects"), lang), list].spacing(26).padding([22, 28]).align_x(if lang.rtl() { Horizontal::Right } else { Horizontal::Left }))).width(Fill).height(Fill).into()
}

// ---- editor

fn editor<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let body = dir_row(lang, vec![assets::panel(app, ed), player(app, ed), details::panel(app, ed)]).spacing(6).height(Length::FillPortion(56));
    let tl = container(column![timeline_bar(ed), timeline::canvas(ed)]).width(Fill).height(Length::FillPortion(44)).style(theme::panel);
    let main = column![top_bar(app, ed), container(column![body, tl].spacing(6)).padding([4, 6]).height(Fill)];
    let mut layers: Vec<Element<Message>> = vec![main.into()];
    if let Some(menu) = &ed.menu {
        layers.push(mouse_area(container(space()).width(Fill).height(Fill)).on_press(Message::CloseMenu).on_right_press(Message::CloseMenu).into());
        let x = menu.x.min(app.window.width - 250.0).max(4.0);
        let y = menu.y.min(app.window.height - 330.0).max(4.0);
        layers.push(pin(context_menu(ed, menu.clip.as_deref(), menu.t)).x(x).y(y).into());
    }
    if ed.export.is_some() {
        layers.push(opaque(container(center(export_dialog(app, ed))).width(Fill).height(Fill).style(theme::overlay)));
    }
    // A job that rewrites the project (reverse, freeze, captions…) blocks editing so no change is lost.
    if let Some((job, what)) = ed.busy.as_ref().filter(|(job, _)| job == "flow") {
        let p = app.jobs.progress(job).unwrap_or(0.0) as f32;
        let card = container(column![text(what).size(15), progress_bar(0.0..=1.0, p).girth(6).length(320), row![text(format!("{:.0}%", p * 100.0)).size(12).color(theme::MUTED), space::horizontal(), btn("", t(app.lang, "Cancel"), Btn::Normal, Some(Message::CancelFlow))].align_y(iced::Center)].spacing(14).width(360))
            .padding(22)
            .style(theme::dialog);
        layers.push(opaque(container(center(card)).width(Fill).height(Fill).style(theme::overlay)));
    }
    stack(layers).into()
}

fn top_bar<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let saving = if ed.dirty { t(lang, "Saving…") } else { t(lang, "Saved") };
    let left = row![
        tool("\u{E80F}", t(lang, "Projects"), Message::Home),
        button(icon("\u{E7A7}")).padding([6, 9]).style(theme::btn(Btn::Ghost)).on_press_maybe(ed.can_undo().then_some(Message::Undo)),
        button(icon("\u{E7A6}")).padding([6, 9]).style(theme::btn(Btn::Ghost)).on_press_maybe(ed.can_redo().then_some(Message::Redo)),
    ]
    .spacing(2)
    .align_y(iced::Center);
    let title = row![
        text_input(t(lang, "Untitled"), &ed.p.name).on_input(Message::Rename).width(300).size(14).padding([5, 9]).style(theme::input).align_x(iced::Center),
        text(format!("● {saving}")).size(11).color(if ed.dirty { theme::AMBER } else { theme::MUTED }),
    ]
    .spacing(10)
    .align_y(iced::Center);
    // A background edit (captions, reverse, stems…) shows its progress up here wherever you are.
    let title: Element<Message> = match &ed.busy {
        Some((job, what)) => {
            let p = app.jobs.progress(job).unwrap_or(0.0) as f32;
            row![title, container(row![text(what).size(11), progress_bar(0.0..=1.0, p).girth(4).length(90)].spacing(8).align_y(iced::Center)).padding([4, 10]).style(theme::pill)].spacing(12).align_y(iced::Center).into()
        }
        None => title.into(),
    };
    let right = row![language_menu(lang), btn("\u{EDE1}", t(lang, "Export"), Btn::Primary, Some(Message::Export(ExportMsg::Open)))].spacing(8).align_y(iced::Center);
    container(dir_row(lang, vec![left.into(), space::horizontal().into(), title, space::horizontal().into(), right.into()]).align_y(iced::Center).padding([0, 10]))
        .height(48)
        .width(Fill)
        .align_y(iced::Center)
        .style(theme::bar)
        .into()
}

fn player<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let picture: Element<Message> = match ed.frame.as_ref().or(ed.still.as_ref()) {
        Some(h) => image(h.clone()).width(Fill).height(Fill).content_fit(ContentFit::Contain).into(),
        None if ed.p.clips.is_empty() => center(text(t(lang, "Import media, then drag it here or press + on a media card")).color(theme::MUTED).size(13)).into(),
        None => center(text(t(lang, "Preparing preview…")).color(theme::MUTED).size(13)).into(),
    };
    let fps = ed.p.canvas.fps;
    let playing = ed.playback.is_some();
    let transport = row![
        container(row![text(timecode(ed.playhead, fps)).size(12).color(theme::ACCENT).font(Font::MONOSPACE), text(format!(" / {}", timecode(ed.p.duration(), fps))).size(12).color(theme::MUTED).font(Font::MONOSPACE)]).padding([4, 9]).style(theme::pill),
        space::horizontal(),
        tool("\u{E892}", t(lang, "Previous frame"), Message::Step(-1.0 / fps.max(1.0))),
        button(center(icon(if playing { "\u{E769}" } else { "\u{E768}" }).size(16).color(theme::ACCENT_INK))).width(38).height(38).padding(0).style(theme::btn(Btn::Primary)).on_press(Message::Play),
        tool("\u{E893}", t(lang, "Next frame"), Message::Step(1.0 / fps.max(1.0))),
        space::horizontal(),
        text(format!("{}×{} · {} fps", ed.p.canvas.width, ed.p.canvas.height, fps)).size(11).color(theme::MUTED),
        iced::widget::pick_list(
            RATIOS.map(|r| r.0).to_vec(),
            RATIOS.iter().find(|r| ratio_size(&ed.p.canvas, r.1, r.2) == (ed.p.canvas.width, ed.p.canvas.height)).map(|r| r.0),
            |label| {
                let r = RATIOS.iter().find(|r| r.0 == label).copied().unwrap_or(RATIOS[0]);
                Message::RatioPick(r.1, r.2)
            },
        )
        .placeholder(t(lang, "Ratio"))
        .text_size(12)
        .padding([4, 8])
        .style(theme::pick)
        .menu_style(theme::pick_menu),
    ]
    .spacing(6)
    .align_y(iced::Center);
    container(column![container(picture).width(Fill).height(Fill).padding(10).style(theme::stage), transport].spacing(8).padding(10)).width(Fill).height(Fill).style(theme::panel).into()
}

fn labeled_slider<'a>(lang: Lang, label: &'a str, value: f64, range: std::ops::RangeInclusive<f64>, step: f64, shown: String, on: impl Fn(f64) -> Message + 'a) -> Element<'a, Message> {
    dir_row(
        lang,
        vec![
            text(label).size(12).color(theme::TEXT2).width(92).into(),
            slider(range, value, on).step(step).style(theme::slider_style).into(),
            container(text(shown).size(11).font(Font::MONOSPACE)).width(58).padding([3, 6]).style(theme::pill).align_x(iced::Right).into(),
        ],
    )
    .spacing(10)
    .align_y(iced::Center)
    .into()
}

fn timeline_bar(ed: &Editor) -> Element<'_, Message> {
    let lang = ed.lang;
    let target = ed.targets().first().cloned();
    let free = ed.busy.is_none();
    let tools = row![
        tool("\u{E7A7}", t(lang, "Undo"), Message::Undo),
        tool("\u{E7A6}", t(lang, "Redo"), Message::Redo),
        space().width(8),
        tool("\u{E8C6}", t(lang, "Split"), Message::Split),
        tool("\u{E72B}", t(lang, "Delete left"), Message::DeleteSide(true)),
        tool("\u{E72A}", t(lang, "Delete right"), Message::DeleteSide(false)),
        tool("\u{E74D}", t(lang, "Delete"), Message::Delete(false)),
        tool("\u{E8C8}", t(lang, "Duplicate"), Message::Duplicate),
        space().width(8),
        tool_opt("\u{E722}", t(lang, "Freeze frame"), target.clone().filter(|_| free).map(|id| Message::Flow("freeze", vec![json!(id), json!(ed.playhead), json!({ "duration": 3 })], "Making a freeze frame…"))),
        tool_opt("\u{E72C}", t(lang, "Reverse"), target.clone().filter(|_| free).map(|id| Message::Flow("reverse", vec![json!(id), json!({})], "Reversing the clip…"))),
        tool_opt("\u{E8AB}", t(lang, "Mirror"), target.clone().map(|id| Message::SetClip(id.clone(), json!({ "flipH": ed.clip_json(&id)["flipH"] != true }), "flip"))),
        tool_opt("\u{E7AD}", t(lang, "Rotate"), target.clone().map(|id| {
            let r = ed.clip_json(&id)["transform"]["rotation"].as_f64().unwrap_or(0.0);
            Message::SetClip(id, json!({ "transform": { "rotation": (r + 270.0).rem_euclid(360.0) - 180.0 } }), "rotate90")
        })),
        tool_opt("\u{E7A8}", t(lang, "Crop"), target.clone().map(|id| Message::Reveal(id, Panel::Video))),
        tool("\u{E7C1}", t(lang, "Add marker"), Message::Marker(ed.playhead)),
        space::horizontal(),
        iced::widget::tooltip(
            button(center(icon("\u{E71B}"))).width(32).height(30).padding(0).style(theme::btn(Btn::Tab(ed.p.settings.magnet))).on_press(Message::Magnet(!ed.p.settings.magnet)),
            container(text(t(lang, "Main track magnet")).size(12)).padding([5, 9]).style(theme::menu),
            iced::widget::tooltip::Position::Bottom,
        ),
        space().width(8),
        tool("\u{E71F}", t(lang, "Zoom out"), Message::Zoom(1.0 / 1.4)),
        tool("\u{E8A3}", t(lang, "Zoom in"), Message::Zoom(1.4)),
        tool("\u{E9A6}", t(lang, "Fit timeline"), Message::Fit),
    ]
    .spacing(2)
    .align_y(iced::Center);
    container(tools).padding([5, 8]).width(Fill).into()
}

fn context_menu<'a>(ed: &'a Editor, clip: Option<&'a str>, at: f64) -> Element<'a, Message> {
    let lang = ed.lang;
    let item = |code: &'a str, label: &'a str, msg: Message, danger: bool| -> Element<'a, Message> {
        button(row![icon(code).size(13).color(if danger { theme::DANGER } else { theme::MUTED }), text(label).size(13)].spacing(10).align_y(iced::Center)).width(Fill).padding([7, 10]).style(theme::btn(if danger { Btn::Danger } else { Btn::Item })).on_press(msg).into()
    };
    let mut items: Vec<Element<Message>> = Vec::new();
    match clip.and_then(|id| ed.p.clip(id)) {
        Some(c) => {
            items.push(item("\u{E8C6}", t(lang, "Split here"), Message::Split, false));
            items.push(item("\u{E8C8}", t(lang, "Duplicate"), Message::Duplicate, false));
            items.push(item("\u{E8C8}", t(lang, "Copy"), Message::Copy, false));
            if c.media_id.is_some() || c.adjustment {
                items.push(item("\u{E790}", t(lang, "Copy attributes"), Message::CopyLook, false));
                if ed.look_clipboard.is_some() {
                    items.push(item("\u{E790}", t(lang, "Paste attributes"), Message::PasteLook, false));
                }
            }
            if c.media_id.is_some() {
                items.push(item(if c.muted { "\u{E767}" } else { "\u{E74F}" }, t(lang, if c.muted { "Unmute clip" } else { "Mute clip" }), Message::SetClip(c.id.clone(), json!({ "muted": !c.muted }), "mute"), false));
                items.push(item("\u{E8D6}", t(lang, "Separate voice, game & music"), Message::Audio(AudioTool::Stems), false));
                items.push(item("\u{E74F}", t(lang, "Remove music"), Message::Audio(AudioTool::NoMusic), false));
                items.push(item("\u{E9D5}", t(lang, "Split recorded tracks (OBS)"), Message::Audio(AudioTool::Tracks), false));
            }
            items.push(item("\u{E74D}", t(lang, "Delete"), Message::Delete(false), true));
            items.push(item("\u{E74D}", t(lang, "Ripple delete"), Message::Delete(true), true));
        }
        None => {
            items.push(item("\u{E77F}", t(lang, "Paste here"), Message::Paste(Some(at)), false));
            items.push(item("\u{E8B3}", t(lang, "Select all"), Message::SelectAll, false));
            items.push(item("\u{E7C1}", t(lang, "Add marker here"), Message::Marker(at), false));
        }
    }
    container(Column::with_children(items).spacing(1)).width(240).padding(5).style(theme::menu).into()
}

fn export_dialog<'a>(app: &'a App, ed: &'a Editor) -> Element<'a, Message> {
    let lang = app.lang;
    let Some(form) = &ed.export else { return space().into() };
    let chips = |options: Vec<(String, bool, Message)>| -> Element<'a, Message> {
        dir_row(lang, options.into_iter().map(|(label, on, msg)| button(text(label).size(12)).padding([6, 11]).style(theme::btn(Btn::Tab(on))).on_press_maybe(form.running.is_none().then_some(msg)).into()).collect()).spacing(4).wrap().into()
    };
    let canvas = &ed.p.canvas;
    let same = format!("{} ({}p)", t(lang, "Same as project"), canvas.width.min(canvas.height));
    let res = chips(
        [(0u32, same.clone()), (720, "720p".into()), (1080, "1080p".into()), (1440, "1440p".into()), (2160, "4K".into())]
            .into_iter()
            .map(|(v, l)| (l, form.resolution == v, Message::Export(ExportMsg::Resolution(v))))
            .collect(),
    );
    let fps = chips([(0u32, format!("{} ({})", t(lang, "Same as project"), canvas.fps)), (24, "24".into()), (30, "30".into()), (60, "60".into())].into_iter().map(|(v, l)| (l, form.fps == v, Message::Export(ExportMsg::Fps(v)))).collect());
    let quality = chips([("high", "High"), ("recommended", "Recommended"), ("compact", "Small file")].into_iter().map(|(v, l)| (t(lang, l).to_string(), form.quality == v, Message::Export(ExportMsg::Quality(v)))).collect());
    let codec = chips([("h264", "H.264 (MP4)"), ("hevc", "HEVC (MP4)"), ("av1", "AV1 (MP4)"), ("prores", "ProRes (MOV)")].into_iter().map(|(v, l)| (l.to_string(), form.codec == v, Message::Export(ExportMsg::Codec(v)))).collect());
    let field = |label: &'static str, w: Element<'a, Message>| column![heading(t(lang, label), lang), w].spacing(8);
    let mut body = column![
        row![text(t(lang, "Export video")).size(18), space::horizontal(), button(icon("\u{E711}").size(12)).padding(7).style(theme::btn(Btn::Ghost)).on_press_maybe(form.running.is_none().then_some(Message::Export(ExportMsg::Close)))].align_y(iced::Center),
        field("Resolution", res),
        field("Frame rate", fps),
        field("Quality", quality),
        field("Format", codec),
    ]
    .spacing(18);
    if form.running.is_some() {
        let p = app.jobs.progress("export").unwrap_or(0.0) as f32;
        body = body.push(column![row![text(t(lang, "Exporting…")).size(13), space::horizontal(), text(format!("{:.0}%", p * 100.0)).size(13).font(Font::MONOSPACE)], progress_bar(0.0..=1.0, p).girth(8)].spacing(8));
        body = body.push(row![space::horizontal(), btn("", t(lang, "Cancel"), Btn::Normal, Some(Message::Export(ExportMsg::Cancel)))]);
    } else {
        match &form.done {
            Some(Ok(path)) => {
                body = body.push(column![text(t(lang, "Export finished")).size(13).color(theme::ACCENT), text(path).size(11).color(theme::TEXT2)].spacing(4));
                body = body.push(row![space::horizontal(), btn("\u{E838}", t(lang, "Show in folder"), Btn::Normal, Some(Message::Export(ExportMsg::Reveal(path.clone())))), btn("", t(lang, "Close"), Btn::Primary, Some(Message::Export(ExportMsg::Close)))].spacing(8));
            }
            done => {
                if let Some(Err(e)) = done {
                    body = body.push(text(format!("{}: {e}", t(lang, "Export failed"))).size(12).color(theme::DANGER));
                }
                body = body.push(row![space::horizontal(), btn("", t(lang, "Cancel"), Btn::Normal, Some(Message::Export(ExportMsg::Close))), btn("\u{EDE1}", t(lang, "Export"), Btn::Primary, Some(Message::Export(ExportMsg::Start)))].spacing(8));
            }
        }
    }
    container(body).width(560).padding(22).style(theme::dialog).into()
}
