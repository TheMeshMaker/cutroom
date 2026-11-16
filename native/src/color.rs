//! Color tools for the details panel: a color wheel (drag the puck to push
//! shadows/midtones/highlights toward a color) and a tone curve editor.

use iced::mouse::{self, Button, Cursor};
use iced::widget::canvas::{self, Event, Frame, Geometry, Path, Program, Stroke};
use iced::{Color, Point, Rectangle, Renderer, Size, Theme};
use serde_json::json;

use crate::theme::{alpha, ACCENT, LINE2, MUTED};
use crate::Message;

/// The color a puck direction pushes toward (same math as wheelRgb in core/render.js:
/// x pushes blue, y pushes red).
fn wheel_color(x: f32, y: f32) -> Color {
    let (r, g, b) = (1.402 * y, -0.344 * x - 0.714 * y, 1.772 * x);
    let k = 0.42;
    Color::from_rgb((0.5 + k * r).clamp(0.0, 1.0), (0.5 + k * g).clamp(0.0, 1.0), (0.5 + k * b).clamp(0.0, 1.0))
}

pub struct Wheel {
    pub clip: String,
    pub key: &'static str,
    pub x: f32,
    pub y: f32,
    pub l: f64,
}

impl Wheel {
    fn geometry(bounds: Rectangle) -> (Point, f32) {
        (Point::new(bounds.width / 2.0, bounds.height / 2.0), bounds.width.min(bounds.height) / 2.0 - 6.0)
    }

    fn set(&self, x: f32, y: f32) -> Message {
        Message::SetClip(self.clip.clone(), json!({ "color": { self.key: { "x": x, "y": y, "l": self.l } } }), "wheel")
    }
}

impl Program<Message> for Wheel {
    type State = bool; // dragging the puck

    fn update(&self, dragging: &mut bool, event: &Event, bounds: Rectangle, cursor: Cursor) -> Option<canvas::Action<Message>> {
        let (c, r) = Self::geometry(bounds);
        let puck = |p: Point| {
            let (dx, dy) = ((p.x - bounds.x - c.x) / r, -(p.y - bounds.y - c.y) / r);
            let len = (dx * dx + dy * dy).sqrt().max(1.0);
            ((dx / len * 100.0).round() / 100.0, (dy / len * 100.0).round() / 100.0)
        };
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(Button::Left)) if cursor.is_over(bounds) => {
                *dragging = true;
                let (x, y) = puck(cursor.position()?);
                Some(canvas::Action::publish(self.set(x, y)).and_capture())
            }
            // Right click puts the puck back in the middle.
            Event::Mouse(mouse::Event::ButtonPressed(Button::Right)) if cursor.is_over(bounds) => Some(canvas::Action::publish(self.set(0.0, 0.0)).and_capture()),
            Event::Mouse(mouse::Event::CursorMoved { position }) if *dragging => {
                let (x, y) = puck(*position);
                Some(canvas::Action::publish(self.set(x, y)).and_capture())
            }
            Event::Mouse(mouse::Event::ButtonReleased(Button::Left)) if *dragging => {
                *dragging = false;
                Some(canvas::Action::capture())
            }
            _ => None,
        }
    }

    fn draw(&self, _: &bool, renderer: &Renderer, _: &Theme, bounds: Rectangle, _: Cursor) -> Vec<Geometry> {
        let mut f = Frame::new(renderer, bounds.size());
        let (c, r) = Self::geometry(bounds);
        // Hue wedges, then a soft grey middle so it reads as "less color" toward the center.
        let n = 48;
        for i in 0..n {
            let (a0, a1) = (i as f32 / n as f32 * std::f32::consts::TAU, (i + 1) as f32 / n as f32 * std::f32::consts::TAU + 0.01);
            let mid = (a0 + a1) / 2.0;
            let wedge = Path::new(|b| {
                b.move_to(c);
                b.line_to(Point::new(c.x + r * a0.cos(), c.y - r * a0.sin()));
                b.line_to(Point::new(c.x + r * a1.cos(), c.y - r * a1.sin()));
                b.close();
            });
            f.fill(&wedge, wheel_color(mid.cos(), mid.sin()));
        }
        for (k, a) in [(0.75, 0.25), (0.5, 0.45), (0.25, 0.7)] {
            f.fill(&Path::circle(c, r * k), Color::from_rgba(0.42, 0.43, 0.46, a));
        }
        f.stroke(&Path::circle(c, r), Stroke::default().with_color(LINE2).with_width(1.5));
        f.stroke(&Path::line(Point::new(c.x - r, c.y), Point::new(c.x + r, c.y)), Stroke::default().with_color(alpha(Color::BLACK, 0.25)).with_width(1.0));
        f.stroke(&Path::line(Point::new(c.x, c.y - r), Point::new(c.x, c.y + r)), Stroke::default().with_color(alpha(Color::BLACK, 0.25)).with_width(1.0));
        let p = Point::new(c.x + self.x * r, c.y - self.y * r);
        f.fill(&Path::circle(p, 7.0), alpha(Color::BLACK, 0.35));
        f.stroke(&Path::circle(p, 6.0), Stroke::default().with_color(Color::WHITE).with_width(2.5));
        vec![f.into_geometry()]
    }

    fn mouse_interaction(&self, dragging: &bool, bounds: Rectangle, cursor: Cursor) -> mouse::Interaction {
        if *dragging || cursor.is_over(bounds) { mouse::Interaction::Crosshair } else { mouse::Interaction::default() }
    }
}

/// Tone curve: drag points, click to add one, right-click to remove one.
pub struct Curve {
    pub clip: String,
    pub points: Vec<[f32; 2]>,
}

impl Curve {
    fn publish(&self, points: Vec<[f32; 2]>) -> Option<canvas::Action<Message>> {
        let pts: Vec<_> = points.iter().map(|p| json!([(p[0] * 1000.0).round() / 1000.0, (p[1] * 1000.0).round() / 1000.0])).collect();
        Some(canvas::Action::publish(Message::SetClip(self.clip.clone(), json!({ "color": { "curve": pts } }), "curve")).and_capture())
    }
}

impl Program<Message> for Curve {
    type State = Option<usize>; // the point being dragged

    fn update(&self, drag: &mut Option<usize>, event: &Event, bounds: Rectangle, cursor: Cursor) -> Option<canvas::Action<Message>> {
        let to_unit = |p: Point| [((p.x - bounds.x) / bounds.width).clamp(0.0, 1.0), (1.0 - (p.y - bounds.y) / bounds.height).clamp(0.0, 1.0)];
        let near = |p: Point| self.points.iter().position(|q| (q[0] * bounds.width - (p.x - bounds.x)).abs() < 9.0 && ((1.0 - q[1]) * bounds.height - (p.y - bounds.y)).abs() < 9.0);
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(Button::Left)) if cursor.is_over(bounds) => {
                let p = cursor.position()?;
                if let Some(i) = near(p) {
                    *drag = Some(i);
                    return Some(canvas::Action::capture());
                }
                let u = to_unit(p);
                let mut points = self.points.clone();
                let i = points.iter().position(|q| q[0] > u[0]).unwrap_or(points.len());
                points.insert(i, u);
                *drag = Some(i);
                self.publish(points)
            }
            Event::Mouse(mouse::Event::ButtonPressed(Button::Right)) if cursor.is_over(bounds) => {
                let i = near(cursor.position()?)?;
                if i == 0 || i + 1 == self.points.len() {
                    return None;
                }
                let mut points = self.points.clone();
                points.remove(i);
                self.publish(points)
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) => {
                let i = (*drag)?;
                let mut points = self.points.clone();
                let mut u = to_unit(*position);
                // Ends stay at the edges; inner points stay between their neighbors.
                let last = points.len() - 1;
                u[0] = match i {
                    0 => 0.0,
                    _ if i == last => 1.0,
                    _ => u[0].clamp(points[i - 1][0] + 0.01, points[i + 1][0] - 0.01),
                };
                *points.get_mut(i)? = u;
                self.publish(points)
            }
            Event::Mouse(mouse::Event::ButtonReleased(Button::Left)) if drag.is_some() => {
                *drag = None;
                Some(canvas::Action::capture())
            }
            _ => None,
        }
    }

    fn draw(&self, _: &Option<usize>, renderer: &Renderer, _: &Theme, bounds: Rectangle, _: Cursor) -> Vec<Geometry> {
        let mut f = Frame::new(renderer, bounds.size());
        let (w, h) = (bounds.width, bounds.height);
        f.fill_rectangle(Point::ORIGIN, Size::new(w, h), Color::from_rgb(0.047, 0.051, 0.067));
        for i in 1..4 {
            let k = i as f32 / 4.0;
            f.stroke(&Path::line(Point::new(k * w, 0.0), Point::new(k * w, h)), Stroke::default().with_color(alpha(Color::WHITE, 0.06)).with_width(1.0));
            f.stroke(&Path::line(Point::new(0.0, k * h), Point::new(w, k * h)), Stroke::default().with_color(alpha(Color::WHITE, 0.06)).with_width(1.0));
        }
        f.stroke(&Path::line(Point::new(0.0, h), Point::new(w, 0.0)), Stroke::default().with_color(alpha(MUTED, 0.4)).with_width(1.0));
        let at = |p: &[f32; 2]| Point::new(p[0] * w, (1.0 - p[1]) * h);
        // Smooth curve through the points (Catmull-Rom), close to FFmpeg's curves filter.
        let pts = &self.points;
        let curve = Path::new(|b| {
            b.move_to(at(&pts[0]));
            for i in 0..pts.len().saturating_sub(1) {
                let (p0, p1, p2, p3) = (pts[i.saturating_sub(1)], pts[i], pts[i + 1], pts[(i + 2).min(pts.len() - 1)]);
                for s in 1..=12 {
                    let t = s as f32 / 12.0;
                    let cr = |a: f32, b: f32, c: f32, d: f32| 0.5 * (2.0 * b + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t * t + (-a + 3.0 * b - 3.0 * c + d) * t * t * t);
                    b.line_to(at(&[cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]).clamp(0.0, 1.0)]));
                }
            }
        });
        f.stroke(&curve, Stroke::default().with_color(Color::WHITE).with_width(2.0));
        for p in pts {
            f.fill(&Path::circle(at(p), 5.0), ACCENT);
            f.stroke(&Path::circle(at(p), 5.0), Stroke::default().with_color(Color::WHITE).with_width(1.5));
        }
        f.stroke(&Path::rectangle(Point::ORIGIN, Size::new(w, h)), Stroke::default().with_color(LINE2).with_width(1.0));
        vec![f.into_geometry()]
    }

    fn mouse_interaction(&self, drag: &Option<usize>, bounds: Rectangle, cursor: Cursor) -> mouse::Interaction {
        if drag.is_some() { mouse::Interaction::Grabbing } else if cursor.is_over(bounds) { mouse::Interaction::Crosshair } else { mouse::Interaction::default() }
    }
}
