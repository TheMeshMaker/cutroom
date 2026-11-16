// Every string the app can show is translated in every language file
// (native/i18n/*.json), and no translation drops a {0} value.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { englishStrings, read, root } from "./i18n-keys.js";

test("every language file has every string", () => {
  const keys = englishStrings();
  assert.ok(keys.length > 300, `found ${keys.length} strings`);
  const langs = readdirSync(join(root, "native/i18n")).filter((f) => f.endsWith(".json"));
  assert.ok(langs.length >= 8, "Arabic and the other languages");
  const problems = [];
  for (const f of langs) {
    const table = JSON.parse(read(join("native/i18n", f)));
    const missing = keys.filter((k) => !(k in table) || !table[k].trim());
    if (missing.length) problems.push(`${f}: ${missing.length} missing, e.g. ${missing.slice(0, 5).map((m) => JSON.stringify(m)).join(", ")}`);
    for (const [en, tr] of Object.entries(table)) {
      for (const p of en.match(/\{\d\}/g) ?? []) if (!tr.includes(p)) problems.push(`${f}: ${JSON.stringify(en)} lost ${p}`);
    }
  }
  assert.deepEqual(problems, []);
});
