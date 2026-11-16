//! Interface languages. Strings are written in English in the code and are the
//! keys; every other language is a JSON file in native/i18n/ (built into the
//! app) mapping English to its translation. Messages that carry values use
//! {0}, {1}… ("{0} beats marked"), which also translates engine errors.

use std::collections::HashMap;
use std::sync::OnceLock;

pub struct Language {
    pub code: &'static str,
    /// The language's own name, as shown in the language menu.
    pub name: &'static str,
    pub rtl: bool,
    json: &'static str,
}

pub const LANGUAGES: [Language; 9] = [
    Language { code: "en", name: "English", rtl: false, json: "{}" },
    Language { code: "ar", name: "العربية", rtl: true, json: include_str!("../i18n/ar.json") },
    Language { code: "es", name: "Español", rtl: false, json: include_str!("../i18n/es.json") },
    Language { code: "fr", name: "Français", rtl: false, json: include_str!("../i18n/fr.json") },
    Language { code: "de", name: "Deutsch", rtl: false, json: include_str!("../i18n/de.json") },
    Language { code: "tr", name: "Türkçe", rtl: false, json: include_str!("../i18n/tr.json") },
    Language { code: "id", name: "Bahasa Indonesia", rtl: false, json: include_str!("../i18n/id.json") },
    Language { code: "ur", name: "اردو", rtl: true, json: include_str!("../i18n/ur.json") },
    Language { code: "pt", name: "Português", rtl: false, json: include_str!("../i18n/pt.json") },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Lang(usize);

impl Lang {
    pub fn rtl(self) -> bool {
        LANGUAGES[self.0].rtl
    }
    pub fn code(self) -> &'static str {
        LANGUAGES[self.0].code
    }
    /// "ar", "ar-SA", "ar_SA.UTF-8"… -> Arabic; unknown -> English.
    pub fn from_code(code: &str) -> Lang {
        let base = code.split(['-', '_', '.']).next().unwrap_or("").to_lowercase();
        Lang(LANGUAGES.iter().position(|l| l.code == base).unwrap_or(0))
    }
    /// The Windows display language, for the first start.
    pub fn system() -> Lang {
        sys_locale::get_locale().map(|l| Lang::from_code(&l)).unwrap_or_default()
    }
    pub fn all() -> Vec<Lang> {
        (0..LANGUAGES.len()).map(Lang).collect()
    }
}

impl std::fmt::Display for Lang {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(LANGUAGES[self.0].name)
    }
}

fn table(lang: Lang) -> &'static HashMap<String, String> {
    static TABLES: OnceLock<Vec<HashMap<String, String>>> = OnceLock::new();
    &TABLES.get_or_init(|| LANGUAGES.iter().map(|l| serde_json::from_str(l.json).unwrap_or_else(|e| panic!("i18n/{}.json: {e}", l.code))).collect())[lang.0]
}

/// A fixed interface string.
pub fn t(lang: Lang, en: &'static str) -> &'static str {
    table(lang).get(en).map_or(en, String::as_str)
}

/// A name that comes from data (catalog items); unknown names stay as they are.
pub fn tr(lang: Lang, en: &str) -> &str {
    table(lang).get(en).map_or(en, String::as_str)
}

/// Any message, including ones with values ("12 beats marked", engine errors,
/// "Audio 2"): an exact match, else the first {0}-template that fits. Values
/// are translated too, so "Save failed: No clip x" reads fully translated.
pub fn message(lang: Lang, text: &str) -> String {
    if lang.0 == 0 || text.is_empty() {
        return text.to_string();
    }
    let table = table(lang);
    if let Some(s) = table.get(text) {
        return s.clone();
    }
    for (template, translated) in table.iter().filter(|(k, _)| k.contains("{0}")) {
        if let Some(values) = fit(template, text) {
            return fill(translated, &values.iter().map(|v| message(lang, v)).collect::<Vec<_>>());
        }
    }
    text.to_string()
}

/// "Deleted 1 clip" / "Deleted {0} clips", translated.
pub fn plural(lang: Lang, n: usize, one: &'static str, many: &'static str) -> String {
    if n == 1 { t(lang, one).to_string() } else { fill(t(lang, many), &[n.to_string()]) }
}

/// Put values into {0}, {1}…
pub fn fill(template: &str, values: &[String]) -> String {
    values.iter().enumerate().fold(template.to_string(), |s, (i, v)| s.replace(&format!("{{{i}}}"), v))
}

/// The values of `text` if it has the shape of `template` ("{0} beats marked").
fn fit(template: &str, text: &str) -> Option<Vec<String>> {
    // The template as literal pieces, each followed by a placeholder number.
    let mut pieces: Vec<(&str, usize)> = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}')? + open;
        pieces.push((&rest[..open], rest[open + 1..close].parse().ok()?));
        rest = &rest[close + 1..];
    }
    if pieces.is_empty() {
        return None;
    }
    let tail = rest;
    let mut values = vec![String::new(); pieces.iter().map(|p| p.1).max()? + 1];
    let mut at = text.strip_prefix(pieces[0].0).map(|_| pieces[0].0.len())?;
    for (i, &(_, index)) in pieces.iter().enumerate() {
        // A value runs up to the next literal piece, or to the tail at the very end.
        let end = match pieces.get(i + 1) {
            Some(&(next, _)) if !next.is_empty() => at + text.get(at..)?.find(next)?,
            Some(_) => return None, // two placeholders in a row can't be told apart
            None if tail.is_empty() => text.len(),
            None => text.len().checked_sub(tail.len()).filter(|e| *e > at && text.get(*e..) == Some(tail))?,
        };
        let value = text.get(at..end).filter(|v| !v.is_empty())?;
        values[index] = value.to_string();
        at = end + pieces.get(i + 1).map_or(tail.len(), |p| p.0.len());
    }
    (at == text.len()).then_some(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_fit_and_fill() {
        assert_eq!(fit("{0} beats marked", "12 beats marked"), Some(vec!["12".into()]));
        assert_eq!(fit("{0} captions, language {1}", "8 captions, language ar"), Some(vec!["8".into(), "ar".into()]));
        assert_eq!(fit("No clip {0}", "No clip c_1"), Some(vec!["c_1".into()]));
        assert_eq!(fit("Audio {0}", "Audio 2"), Some(vec!["2".into()]));
        assert_eq!(fit("Voice ({0})", "Voice (game.mkv)"), Some(vec!["game.mkv".into()]));
        assert_eq!(fit("{0} beats marked", "beats marked"), None);
        assert_eq!(fit("No clip {0}", "Clip x"), None);
        assert_eq!(fit("Plain", "Plain"), None);
        assert_eq!(fill("صوت {0}", &["2".into()]), "صوت 2");
    }

    #[test]
    fn every_language_file_parses_and_keeps_placeholders() {
        for (i, l) in LANGUAGES.iter().enumerate() {
            for (en, tr) in table(Lang(i)) {
                for n in 0..4 {
                    let p = format!("{{{n}}}");
                    assert_eq!(en.contains(&p), tr.contains(&p), "{}: {en:?} -> {tr:?}", l.code);
                }
            }
        }
    }

    #[test]
    fn arabic_messages() {
        let ar = Lang::from_code("ar-SA");
        assert!(ar.rtl());
        assert_eq!(t(ar, "Export"), "تصدير");
        assert_eq!(message(ar, "Audio 2"), "صوت 2");
        assert_ne!(message(ar, "Save failed: No clip c_9"), "Save failed: No clip c_9");
        assert_eq!(Lang::from_code("xx"), Lang::default());
    }
}
