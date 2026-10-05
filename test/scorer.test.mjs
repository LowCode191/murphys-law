// Relevance gate: distinct whole-token terms, no stopwords. Irrelevant prompts
// that merely repeat "the", "and", "for" used to clear the hook's gates.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");
const SAMPLES = path.join(HERE, "..", "data", "sample-lessons.jsonl");
const require = createRequire(import.meta.url);

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-scorer-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const SAMPLE_HOME = freshHome();
fs.copyFileSync(SAMPLES, path.join(SAMPLE_HOME, "lessons.jsonl"));
process.env.MURPHYS_HOME = SAMPLE_HOME;
const core = require("../lib/register.cjs");

let sessionCounter = 0;
function hook(prompt, env = {}) {
  sessionCounter += 1;
  return execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: `scorer-${sessionCounter}`, cwd: "/tmp", prompt }),
    env: { ...process.env, MURPHYS_HOME: SAMPLE_HOME, ...env },
    encoding: "utf8",
  });
}

test("stopword-only and stopword-heavy irrelevant prompts never inject (sample register)", () => {
  for (const prompt of [
    "the the the the the the the the the the the the the the the the",
    "Please write a haiku about the ocean and the moon for the kids at the school picnic on the weekend",
    "Write a birthday poem for my cat: the cat, the nap, the sun, the window, the bowl, and the yarn.",
  ]) {
    assert.equal(hook(prompt), "", `must stay silent for: ${prompt}`);
  }
});

test("a genuinely relevant prompt still injects (sample register)", () => {
  const out = hook("We committed the fix but need to verify the deploy is actually served in production: restart the running process and smoke the live endpoint");
  assert.match(out, /llg-sample-0001/);
});

test("repeating a query word does not inflate the score", () => {
  const lesson = { title: "Deploy verification", description: "Verify every deploy at the served layer.", tags: [] };
  const once = core.scoreLessonForQuery(lesson, "deploy", []);
  const fiveTimes = core.scoreLessonForQuery(lesson, "deploy deploy deploy deploy deploy", []);
  assert.ok(fiveTimes <= once, `five repeats (${fiveTimes}) must not outscore one mention (${once})`);
  assert.ok(fiveTimes < 8, "repetition alone can never clear the hook's default gate");
});

test("terms match whole tokens, not substrings", () => {
  const lesson = { title: "Concatenate logs before rotation", description: "Merge the shards first.", tags: [] };
  assert.equal(core.scoreLessonForQuery(lesson, "cat rot", []), 0, "'cat' is not 'concatenate'; 'rot' is not 'rotation'");
  assert.ok(core.scoreLessonForQuery(lesson, "concatenate rotation", []) >= 4);
});

test("stopwords are not search terms; plural forms still match", () => {
  assert.deepEqual([...core.searchTerms("the and for of with")], []);
  const lesson = { title: "Adding a skill must preserve the whole whitelist", description: "Always write the complete list.", tags: [] };
  assert.ok(core.scoreLessonForQuery(lesson, "skills whitelists", []) >= 4, "skills/skill and whitelists/whitelist are the same term");
});

// ---------------------------------------------------------------------------
// Unicode tokenization + honest argumentless handling. Non-Latin text used to
// normalize to nothing, and a non-empty query with no usable terms fell into
// the argumentless branch: the newest 8 lessons at score 1, logged as a real
// retrieval.
// ---------------------------------------------------------------------------

function unicodeHome() {
  const home = freshHome("murphys-unicode-");
  const rows = [
    { id: "llg-ja", title: "本番環境では必ずバックアップを取る", description: "本番の変更前にバックアップ。", status: "active", timestamp: "2026-01-01T12:00:00" },
    { id: "llg-ko", title: "배포 전에 백업을 확인하라", description: "백업이 없으면 배포하지 않는다.", status: "active", timestamp: "2026-01-02T12:00:00" },
    { id: "llg-ru", title: "Проверяйте развертывание в продакшене", description: "Развертывание не завершено, пока не проверено.", status: "active", timestamp: "2026-01-03T12:00:00" },
    { id: "llg-nfd", title: "Cafe\u0301 rule", description: "The cafe\u0301 rule body.", status: "active", timestamp: "2026-01-04T12:00:00" },
    { id: "llg-en", title: "Unrelated English lesson", description: "Rotate logs weekly.", status: "active", timestamp: "2026-09-01T12:00:00" },
  ];
  fs.writeFileSync(path.join(home, "lessons.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return home;
}

function queryIn(home, query) {
  const cli = path.join(HERE, "..", "bin", "muphys.mjs");
  const result = JSON.parse(execFileSync("node", [cli, "query", ...(query ? [query] : [])], { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" }));
  const log = fs.readFileSync(path.join(home, "queries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  return { result, log };
}

test("non-Latin queries match non-Latin lessons, and only them", () => {
  const home = unicodeHome();
  for (const [query, id] of [["本番環境 バックアップ", "llg-ja"], ["백업 확인", "llg-ko"], ["развертывание продакшене", "llg-ru"]]) {
    const { result } = queryIn(home, query);
    assert.equal(result.lessons[0]?.id, id, `${query} → ${id}`);
    assert.ok(result.lessons[0].score > 1, "a real match, not the argumentless fallback");
    assert.ok(!result.lessons.some((l) => l.id === "llg-en"), "unrelated lessons are not returned");
  }
});

test("canonically equivalent text matches (NFC query, NFD lesson)", () => {
  const { result } = queryIn(unicodeHome(), "caf\u00e9");
  assert.equal(result.lessons[0]?.id, "llg-nfd", "precomposed \u00e9 in the query matches e + combining acute in the lesson");
});

test("a non-empty query with no usable terms returns nothing and is not logged as argumentless", () => {
  const home = unicodeHome();
  const stopwords = queryIn(home, "the the the");
  assert.equal(stopwords.result.count, 0, "no arbitrary 'newest 8' fallback");
  assert.equal(stopwords.log.argumentless, false);
  assert.equal(stopwords.log.terms, 0);
  const shortTokens = queryIn(home, "CI DB");
  assert.equal(shortTokens.result.count, 0, "no lesson mentions CI or DB");
  const empty = queryIn(home, "");
  assert.equal(empty.log.argumentless, true);
  assert.equal(empty.result.count, 5, "a truly argumentless query still lists recent lessons");
});
