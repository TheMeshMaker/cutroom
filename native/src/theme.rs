//! Cutroom's look: layered dark surfaces, one teal accent, soft borders.

use iced::widget::{button, container, pick_list, slider, text_editor, text_input};
use iced::{Background, Border, Color, Shadow, Theme, Vector};

pub const BG: Color = Color::from_rgb(0.039, 0.043, 0.055);
pub const BG2: Color = Color::from_rgb(0.055, 0.063, 0.078);
pub const PANEL: Color = Color::from_rgb(0.078, 0.086, 0.106);
pub const PANEL2: Color = Color::from_rgb(0.102, 0.114, 0.137);
pub const PANEL3: Color = Color::from_rgb(0.133, 0.149, 0.176);
pub const LINE: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.07);
pub const LINE2: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.11);
pub const TEXT: Color = Color::from_rgb(0.925, 0.925, 0.945);
pub const TEXT2: Color = Color::from_rgb(0.765, 0.776, 0.808);
pub const MUTED: Color = Color::from_rgb(0.522, 0.541, 0.580);
pub const ACCENT: Color = Color::from_rgb(0.110, 0.804, 0.859);
pub const ACCENT_INK: Color = Color::from_rgb(0.008, 0.102, 0.114);
pub const DANGER: Color = Color::from_rgb(0.898, 0.282, 0.302);
pub const AMBER: Color = Color::from_rgb(0.949, 0.702, 0.239);
pub const VIDEO: Color = Color::from_rgb(0.141, 0.349, 0.416);
pub const AUDIO: Color = Color::from_rgb(0.114, 0.424, 0.322);
pub const AUDIO_WAVE: Color = Color::from_rgb(0.698, 1.0, 0.871);
pub const TEXTCLIP: Color = Color::from_rgb(0.616, 0.365, 0.141);
pub const IMAGECLIP: Color = Color::from_rgb(0.310, 0.231, 0.471);

pub fn alpha(c: Color, a: f32) -> Color {
    Color { a, ..c }
}

fn border(color: Color, radius: f32) -> Border {
    Border { color, width: 1.0, radius: radius.into() }
}

pub fn theme() -> Theme {
    Theme::custom(
        "Cutroom",
        iced::theme::Palette { background: BG, text: TEXT, primary: ACCENT, success: Color::from_rgb(0.243, 0.812, 0.557), warning: AMBER, danger: DANGER },
    )
}

pub fn app(_: &Theme) -> container::Style {
    container::Style { background: Some(BG.into()), text_color: Some(TEXT), ..Default::default() }
}

pub fn panel(_: &Theme) -> container::Style {
    container::Style { background: Some(PANEL.into()), border: border(LINE, 10.0), text_color: Some(TEXT), ..Default::default() }
}

pub fn card(_: &Theme) -> container::Style {
    container::Style { background: Some(PANEL2.into()), border: border(LINE, 9.0), ..Default::default() }
}

pub fn stage(_: &Theme) -> container::Style {
    container::Style { background: Some(Color::from_rgb(0.035, 0.039, 0.047).into()), ..Default::default() }
}

pub fn bar(_: &Theme) -> container::Style {
    container::Style { background: Some(BG2.into()), border: Border { color: LINE, width: 0.0, radius: 0.0.into() }, ..Default::default() }
}

pub fn pill(_: &Theme) -> container::Style {
    container::Style { background: Some(Color::from_rgb(0.047, 0.051, 0.067).into()), border: border(LINE, 7.0), text_color: Some(TEXT), ..Default::default() }
}

pub fn overlay(_: &Theme) -> container::Style {
    container::Style { background: Some(Color::from_rgba(0.02, 0.024, 0.031, 0.62).into()), ..Default::default() }
}

pub fn dialog(_: &Theme) -> container::Style {
    container::Style {
        background: Some(PANEL.into()),
        border: border(LINE2, 14.0),
        shadow: Shadow { color: Color::from_rgba(0.0, 0.0, 0.0, 0.6), offset: Vector::new(0.0, 18.0), blur_radius: 48.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

pub fn menu(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color::from_rgb(0.106, 0.114, 0.137).into()),
        border: border(LINE2, 10.0),
        shadow: Shadow { color: Color::from_rgba(0.0, 0.0, 0.0, 0.55), offset: Vector::new(0.0, 10.0), blur_radius: 30.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

pub fn toast(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color::from_rgb(0.118, 0.129, 0.157).into()),
        border: border(LINE2, 12.0),
        shadow: Shadow { color: Color::from_rgba(0.0, 0.0, 0.0, 0.5), offset: Vector::new(0.0, 8.0), blur_radius: 24.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// Button looks: Primary (accent), Normal (raised), Ghost (flat), Tab (active
/// state), Danger (red text), Item (menu row).
#[derive(Clone, Copy, PartialEq)]
pub enum Btn {
    Primary,
    Normal,
    Ghost,
    Tab(bool),
    Danger,
    Item,
}

pub fn btn(kind: Btn) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let disabled = matches!(status, button::Status::Disabled);
        let (bg, fg, line) = match kind {
            Btn::Primary => (if hover { Color::from_rgb(0.25, 0.86, 0.91) } else { ACCENT }, ACCENT_INK, Color::TRANSPARENT),
            Btn::Normal => (if hover { alpha(Color::WHITE, 0.09) } else { alpha(Color::WHITE, 0.05) }, TEXT, if hover { LINE2 } else { LINE }),
            Btn::Ghost => (if hover { alpha(Color::WHITE, 0.08) } else { Color::TRANSPARENT }, TEXT2, Color::TRANSPARENT),
            Btn::Tab(true) => (alpha(ACCENT, 0.14), ACCENT, Color::TRANSPARENT),
            Btn::Tab(false) => (if hover { alpha(Color::WHITE, 0.06) } else { Color::TRANSPARENT }, if hover { TEXT } else { MUTED }, Color::TRANSPARENT),
            Btn::Danger => (if hover { alpha(DANGER, 0.16) } else { Color::TRANSPARENT }, Color::from_rgb(1.0, 0.54, 0.55), Color::TRANSPARENT),
            Btn::Item => (if hover { alpha(ACCENT, 0.16) } else { Color::TRANSPARENT }, TEXT, Color::TRANSPARENT),
        };
        button::Style {
            background: Some(Background::Color(if disabled { alpha(bg, bg.a * 0.4) } else { bg })),
            text_color: if disabled { alpha(fg, 0.35) } else { fg },
            border: border(line, 7.0),
            shadow: if kind == Btn::Primary { Shadow { color: alpha(ACCENT, 0.35), offset: Vector::new(0.0, 4.0), blur_radius: 14.0 } } else { Shadow::default() },
            snap: true,
        }
    }
}

pub fn slider_style(_: &Theme, status: slider::Status) -> slider::Style {
    let active = matches!(status, slider::Status::Hovered | slider::Status::Dragged);
    slider::Style {
        rail: slider::Rail { backgrounds: (ACCENT.into(), alpha(Color::WHITE, 0.12).into()), width: 4.0, border: Border { radius: 2.0.into(), ..Default::default() } },
        handle: slider::Handle {
            shape: slider::HandleShape::Circle { radius: if active { 8.0 } else { 7.0 } },
            background: Color::WHITE.into(),
            border_width: if active { 4.0 } else { 1.0 },
            border_color: if active { alpha(ACCENT, 0.35) } else { Color::from_rgba(0.0, 0.0, 0.0, 0.35) },
        },
    }
}

pub fn input(_: &Theme, status: text_input::Status) -> text_input::Style {
    let focused = matches!(status, text_input::Status::Focused { .. });
    text_input::Style {
        background: Color::from_rgb(0.047, 0.051, 0.067).into(),
        border: border(if focused { alpha(ACCENT, 0.6) } else { LINE2 }, 7.0),
        icon: MUTED,
        placeholder: Color::from_rgb(0.353, 0.373, 0.412),
        value: TEXT,
        selection: alpha(ACCENT, 0.35),
    }
}

/// Library tiles: a raised card that lights up when it's the one in use.
pub fn tile(on: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(Background::Color(if on { alpha(ACCENT, 0.12) } else if hover { alpha(Color::WHITE, 0.07) } else { alpha(Color::WHITE, 0.035) })),
            text_color: if on { ACCENT } else if hover { TEXT } else { TEXT2 },
            border: border(if on { ACCENT } else if hover { LINE2 } else { LINE }, 8.0),
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

/// A color swatch; the chosen one gets a white ring.
pub fn swatch(color: Color, on: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(Background::Color(color)),
            text_color: TEXT,
            border: Border { color: if on { Color::WHITE } else if hover { alpha(Color::WHITE, 0.5) } else { LINE2 }, width: if on { 2.0 } else { 1.0 }, radius: 6.0.into() },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

pub fn pick(_: &Theme, status: pick_list::Status) -> pick_list::Style {
    let open = matches!(status, pick_list::Status::Hovered | pick_list::Status::Opened { .. });
    pick_list::Style { text_color: TEXT, placeholder_color: MUTED, handle_color: MUTED, background: Color::from_rgb(0.047, 0.051, 0.067).into(), border: border(if open { alpha(ACCENT, 0.6) } else { LINE2 }, 7.0) }
}

pub fn pick_menu(_: &Theme) -> iced::overlay::menu::Style {
    iced::overlay::menu::Style { background: PANEL2.into(), border: border(LINE2, 8.0), text_color: TEXT, selected_text_color: ACCENT_INK, selected_background: ACCENT.into(), shadow: Shadow { color: Color::from_rgba(0.0, 0.0, 0.0, 0.5), offset: Vector::new(0.0, 8.0), blur_radius: 24.0 } }
}

pub fn editor(_: &Theme, status: text_editor::Status) -> text_editor::Style {
    let focused = matches!(status, text_editor::Status::Focused { .. });
    text_editor::Style { background: Color::from_rgb(0.047, 0.051, 0.067).into(), border: border(if focused { alpha(ACCENT, 0.6) } else { LINE2 }, 7.0), placeholder: MUTED, value: TEXT, selection: alpha(ACCENT, 0.35) }
}

/// "#rrggbb" or "#rrggbbaa" to a color (white if it doesn't parse).
pub fn hex(s: &str) -> Color {
    let h = s.trim_start_matches('#');
    let byte = |i: usize| h.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok());
    match (byte(0), byte(2), byte(4)) {
        (Some(r), Some(g), Some(b)) => Color::from_rgba8(r, g, b, byte(6).map_or(1.0, |a| a as f32 / 255.0)),
        _ => Color::WHITE,
    }
}
