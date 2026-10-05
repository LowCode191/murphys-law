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
