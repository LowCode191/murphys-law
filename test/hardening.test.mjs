// Regressions for the pre-release practitioner review findings.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Every temp home this file creates is removed after the last test — a
// suite that leaks one directory per test per run fills shared temp dirs.
const TEMP_DIRS = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const HOME = tempDir("murphys-hardening-");
process.env.MURPHYS_HOME = HOME;

const require = createRequire(import.meta.url);
const core = require("../lib/register.cjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");

function cli(cliArgs, env = {}) {
  return execFileSync("node", [CLI, ...cliArgs], { env: { ...process.env, MURPHYS_HOME: HOME, ...env }, encoding: "utf8" });
}

// Round 7 split the dedupe surfaces: wouldRetire (destructive, byte-identical
// only) and reviewCandidates (report-only fold near-matches). Distinctness
// tests must assert absence from BOTH.
function dedupePlan() {
  const plan = JSON.parse(cli(["dedupe"]));
  return {
    plan,
    retire: JSON.stringify(plan.wouldRetire || []),
    review: JSON.stringify(plan.reviewCandidates || []),
  };
}

before(() => {
  core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Alpha rule", description: "First version of the alpha guidance for the fleet." },
    { title: "Alpha rule v2", description: "Second, better version of the alpha guidance for the fleet." },
    { title: "日本語のみの教訓", description: "説明も完全に非ラテン文字です。" },
    { title: "완전히 한국어로 된 교훈", description: "설명도 한국어로만 되어 있습니다." },
  ] }), { author: "test" });
});

test("supersede refuses a retired replacement (cycles unrepresentable)", async () => {
  const [a, b] = core.readRegister();
  await core.callTool("lessons_supersede", { ids: [a.id], supersededBy: b.id, reason: "v2 wins" });
  // b now active, a retired. Retiring b toward a must fail: a is retired.
  await assert.rejects(
    () => core.callTool("lessons_supersede", { ids: [b.id], supersededBy: a.id, reason: "cycle attempt" }),
    /must be an ACTIVE lesson/,
  );
});

test("dedupe never groups non-Latin lessons on empty fold keys", async () => {
  const { retire, review } = dedupePlan();
  for (const surface of [retire, review]) assert.ok(!/日本語|한국어/.test(surface), "distinct non-Latin lessons must not surface in either dedupe tier");
  const rows = core.readRegister();
  const nonLatin = rows.filter((r) => /日本語|한국어/.test(r.title));
  assert.equal(nonLatin.length, 2);
  for (const row of nonLatin) assert.notEqual(row.status, "superseded");
});

test("sync respects a held lock and appends nothing", async () => {
  fs.writeFileSync(path.join(HOME, "projects.json"), JSON.stringify({ projects: [{ slug: "demo", root: HOME }] }));
  fs.writeFileSync(path.join(HOME, "LESSONS-LEARNED.jsonl"), JSON.stringify({ title: "Sync lesson", description: "A lesson captured at the project." }) + "\n");
  fs.writeFileSync(core.REGISTER_LOCK, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  try {
    const before_ = core.readRegister().length;
    const result = JSON.parse(cli(["sync"]));
    assert.equal(result.skipped, true);
    assert.equal(core.readRegister().length, before_, "no append under a held lock");
  } finally {
    fs.rmSync(core.REGISTER_LOCK, { force: true });
  }
  const applied = JSON.parse(cli(["sync"]));
  assert.equal(applied.totalAppended, 1, "sync proceeds once the lock is free");
});

test("invalid cwd-filter regex exits 0, stays silent, never blocks the prompt", async () => {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "rex", cwd: "/tmp", prompt: "update the alpha guidance rule for the fleet so the second better version applies everywhere" }),
    env: { ...process.env, MURPHYS_HOME: HOME, MURPHYS_HOOK_CWD_FILTER: "([unclosed" },
    encoding: "utf8",
  });
  assert.equal(out, "");
});

test("malformed hook state degrades to sane defaults, not a reset cap or crash", async () => {
  const stateDir = path.join(HOME, "hook-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "clamp.json"), '{"injectedIds": "not-an-array", "injectionEvents": "NaN-ish"}');
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "clamp", cwd: "/tmp", prompt: "update the alpha guidance rule for the fleet so the second better version applies everywhere" }),
    env: { ...process.env, MURPHYS_HOME: HOME },
    encoding: "utf8",
  });
  assert.match(out, /<lessons-recall>/, "clamped state must still allow recall");
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "clamp.json"), "utf8"));
  assert.ok(Array.isArray(state.injectedIds) && state.injectedIds.length > 0);
  assert.equal(state.injectionEvents, 1);
});

test("literal JSON null state (valid JSON!) still recalls — never silently disables", async () => {
  const stateDir = path.join(HOME, "hook-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "nullstate.json"), "null");
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "nullstate", cwd: "/tmp", prompt: "update the alpha guidance rule for the fleet so the second better version applies everywhere" }),
    env: { ...process.env, MURPHYS_HOME: HOME },
    encoding: "utf8",
  });
  assert.match(out, /<lessons-recall>/);
});

test("dedupe: mixed-language lessons sharing ASCII tokens are NOT conflated", async () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "API 本番環境では必ずバックアップを取る production", description: "本番環境の API を変更する前にバックアップ。production の教訓。" },
    { title: "API レート制限は指数バックオフで処理する production", description: "API のレート制限エラーは指数バックオフ。production の別の教訓。" },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "distinct mixed-language lessons must never auto-retire");
    assert.ok(!review.includes(record.id), "distinct mixed-language lessons must not even be review candidates");
  }
});

test("dedupe: exact non-Latin duplicates ARE grouped (byte-identical tier)", async () => {
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "重複した教訓のタイトル", description: "全く同じ説明文です。" },
    { title: "重複した教訓のタイトル", description: "全く同じ説明文です。" },
  ] }), { author: "test" });
  const plan = JSON.parse(cli(["dedupe"]));
  const planned = JSON.stringify(plan.wouldRetire || []);
  assert.ok(dupes.some((record) => planned.includes(record.id)), "exact non-Latin duplicates must be dedupe candidates");
});

test("sync: concurrent runs against a STALE lock never write duplicate ids", async () => {
  const raceHome = tempDir("murphys-race-");
  fs.writeFileSync(path.join(raceHome, "projects.json"), JSON.stringify({ projects: [{ slug: "race", root: raceHome }] }));
  fs.writeFileSync(path.join(raceHome, "LESSONS-LEARNED.jsonl"),
    JSON.stringify({ title: "Race lesson one", description: "First lesson for the race test." }) + "\n" +
    JSON.stringify({ title: "Race lesson two", description: "Second lesson for the race test." }) + "\n");
  const staleLock = path.join(raceHome, ".lessons.jsonl.lock");
  fs.writeFileSync(staleLock, JSON.stringify({ pid: 999999999, ts: "2026-01-01T00:00:00Z" }));
  const { execFile } = await import("node:child_process");
  const run = () => new Promise((resolve) => execFile("node", [CLI, "sync"], { env: { ...process.env, MURPHYS_HOME: raceHome } }, () => resolve()));
  await Promise.all([run(), run(), run(), run(), run()]);
  // settle: one more sync with no lock contention picks up any stragglers
  await run();
  // The contract (see the sync lock comment): the lock makes double-appends
  // rare, not impossible — POSIX has no path compare-and-swap. What IS
  // guaranteed: any duplicated id is a byte-identical line (content-derived
  // ids), and the READER collapses it, so every read site sees each lesson
  // exactly once.
  const register = path.join(raceHome, "lessons.jsonl");
  const rawLines = fs.readFileSync(register, "utf8").split("\n").filter(Boolean);
  const firstById = new Map();
  for (const line of rawLines) {
    const rowId = JSON.parse(line).id;
    if (firstById.has(rowId)) assert.equal(firstById.get(rowId), line, "a duplicated id must only ever be the same byte-identical row");
    else firstById.set(rowId, line);
  }
  assert.equal(firstById.size, 2, "both lessons land, each under exactly one id");
  const stats = JSON.parse(execFileSync("node", [CLI, "stats"], { env: { ...process.env, MURPHYS_HOME: raceHome }, encoding: "utf8" }));
  assert.equal(stats.register.total, 2, "the reader collapses any raced duplicate line to exactly one lesson");
});

test("dedupe fold preserves combining marks: Devanagari क and कि never collide", async () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "क के बारे में सबक", description: "पहला सबक क अक्षर के बारे में है।" },
    { title: "कि के बारे में सबक", description: "पहला सबक कि अक्षर के बारे में है।" },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "mark-distinguished Devanagari lessons must never auto-retire");
    assert.ok(!review.includes(record.id), "mark-distinguished Devanagari lessons must not even be review candidates");
  }
});

test("round 7: NFC canonical forms are review candidates, never auto-retired", async () => {
  // Canonically equivalent ≠ byte-identical: a lesson quoting the literal
  // decomposed e+combining-acute sequence is a different instruction than
  // one quoting precomposed é. The fold (which NFC-normalizes) surfaces the
  // pair for a curator; the destructive gate refuses it.
  const precomposed = "caf\u00e9 lesson";
  const decomposed = "cafe\u0301 lesson";
  assert.notEqual(precomposed, decomposed, "sanity: different code points");
  assert.equal(precomposed.normalize("NFC"), decomposed.normalize("NFC"), "sanity: canonically equivalent");
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: precomposed, description: `${precomposed} description body.` },
    { title: decomposed, description: `${decomposed} description body.` },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of dupes) assert.ok(!retire.includes(record.id), "canonical-form variants are not byte-identical — they must never auto-retire");
  assert.ok(dupes.every((record) => review.includes(record.id)), "canonical-form variants must surface together for curator review");
});

test("dedupe never merges emoji-distinguished lessons (✅ vs ❌ are opposites)", async () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "deploy check ✅ before restart", description: "Run the deploy check ✅ before any restart of the service." },
    { title: "deploy check ❌ before restart", description: "Run the deploy check ❌ before any restart of the service." },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "emoji-distinguished lessons must never auto-retire");
    assert.ok(!review.includes(record.id), "emoji-distinguished lessons must not even be review candidates");
  }
});

test("dedupe treats case variants as DISTINCT (locale-safe by design: IŞIK ≠ ışık)", async () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "IŞIK KONTROL YAP KURALI", description: "BÜYÜK HARFLİ DERS METNİ BURADA." },
    { title: "ışık kontrol yap kuralı", description: "büyük harfli ders metni burada.".toLowerCase() },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "case variants must never auto-retire (Turkish casing is unfixable by folding)");
    assert.ok(!review.includes(record.id), "case variants are deliberately not even review candidates");
  }
});

test("round 7: typographic quote/dash variants are review candidates, never auto-retired", async () => {
  // The original backfill class this command was built for — but a lesson can
  // be ABOUT an exact character („ vs "), so the typographic map is lossy and
  // lossy never gates destruction. The curator sees the pair and decides.
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Don't pipe ‘sensitive’ output — mask it", description: "The rule… applies to “every” pipeline — always." },
    { title: "Don't pipe 'sensitive' output - mask it", description: "The rule... applies to \"every\" pipeline - always." },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of dupes) assert.ok(!retire.includes(record.id), "typographic variants are not NFC-exact — they must never auto-retire");
  assert.ok(dupes.every((record) => review.includes(record.id)), "typographic-variant copies must surface together for curator review");
});

test("dedupe: a dash glued to the last token is content, not separator noise (A- ≠ A)", async () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "service tier is A-", description: "The service tier grade here is A- for this quarter." },
    { title: "service tier is A", description: "The service tier grade here is A for this quarter." },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "grade A- and grade A must never auto-retire");
    assert.ok(!review.includes(record.id), "grade A- and grade A must not even be review candidates");
  }
});

test("round 7: separator-dash variants are review candidates, never auto-retired", async () => {
  // A trailing "—" is usually decoration — but "Required delimiter is —" is a
  // lesson ABOUT a terminal dash, and no trim can tell those apart. Report,
  // never retire.
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Always verify the backup restore path —", description: "Backups without a tested restore path are decorative —" },
    { title: "Always verify the backup restore path", description: "Backups without a tested restore path are decorative" },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of dupes) assert.ok(!retire.includes(record.id), "separator-dash variants are not NFC-exact — they must never auto-retire");
  assert.ok(dupes.every((record) => review.includes(record.id)), "separator-dash variants must surface together for curator review");
});

// ---------------------------------------------------------------------------
// Round 7: the four confirmed fold collisions must be unrepresentable in the
// destructive path — proven under a real --apply, not a dry run.
// ---------------------------------------------------------------------------

test("round 7: --apply retires only byte-identical duplicates; every semantic near-match survives", async () => {
  const home = tempDir("murphys-r7-");
  const seed = [
    // (1) composite-key delimiter injection
    { title: "a|b", description: "c" },
    { title: "a", description: "b|c" },
    // (2) a lesson ABOUT a terminal dash vs its dash-less sibling
    { title: "Delimiter rule", description: "Required delimiter is —" },
    { title: "Delimiter rule", description: "Required delimiter is" },
    // (3) whitespace is semantic in payloads
    { title: "Printf payload", description: "line one\npayload line two" },
    { title: "Printf payload", description: "line one payload line two" },
    // (4) lessons about exact characters
    { title: "Charset rule", description: "Reject character „" },
    { title: "Charset rule", description: 'Reject character "' },
    // (5) canonically equivalent but not byte-identical (NFC vs NFD é)
    { title: "Caf\u00e9 rule", description: "The caf\u00e9 rule body." },
    { title: "Cafe\u0301 rule", description: "The cafe\u0301 rule body." },
    // (6) a true byte-identical duplicate — the one pair that must still die
    { title: "True duplicate", description: "Identical description body." },
    { title: "True duplicate", description: "Identical description body." },
  ];
  for (const lesson of seed) {
    execFileSync("node", [CLI, "add", "--title", lesson.title, "--description", lesson.description],
      { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" });
  }
  const result = JSON.parse(execFileSync("node", [CLI, "dedupe", "--apply"],
    { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" }));

  assert.equal(result.retired, 1, "exactly the byte-identical pair auto-retires — nothing else");
  const rows = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const superseded = rows.filter((r) => r.status === "superseded");
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].title, "True duplicate");
  const active = rows.filter((r) => r.status === "active");
  assert.equal(active.length, 11, "all ten semantic near-matches plus the kept duplicate stay active");

  const review = JSON.stringify(result.reviewCandidates || []);
  const byContent = (title, desc) => rows.find((r) => r.title === title && r.description === desc);
  // fold-equal near-matches surface for the curator...
  for (const [title, desc] of [
    ["Delimiter rule", "Required delimiter is —"], ["Delimiter rule", "Required delimiter is"],
    ["Printf payload", "line one\npayload line two"], ["Printf payload", "line one payload line two"],
    ["Charset rule", "Reject character „"], ["Charset rule", 'Reject character "'],
    ["Caf\u00e9 rule", "The caf\u00e9 rule body."], ["Cafe\u0301 rule", "The cafe\u0301 rule body."],
  ]) {
    assert.ok(review.includes(byContent(title, desc).id), `review candidates must include ${title} / ${desc}`);
  }
  // ...the structurally-distinct pipe pair appears NOWHERE...
  for (const [title, desc] of [["a|b", "c"], ["a", "b|c"]]) {
    const id = byContent(title, desc).id;
    assert.ok(!review.includes(id), "pipe-injection pair must not be review candidates — the structural key keeps them distinct");
  }
  // ...and the retired pair is not double-reported as a candidate.
  assert.ok(!review.includes("True duplicate"), "NFC-exact groups belong to the retire plan, not the review list");
});

test("round 7: sync content ids are delimiter-proof (a|b + c ≠ a + b|c)", async () => {
  const home = tempDir("murphys-r7sync-");
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: [{ slug: "inj", root: home }] }));
  fs.writeFileSync(path.join(home, "LESSONS-LEARNED.jsonl"),
    JSON.stringify({ title: "a|b", description: "c" }) + "\n" +
    JSON.stringify({ title: "a", description: "b|c" }) + "\n");
  execFileSync("node", [CLI, "sync"], { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" });
  const rows = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, "both pipe-shifted lessons land — neither is swallowed as the other's duplicate");
  assert.notEqual(rows[0].id, rows[1].id, "structural tuple hash gives distinct ids");
});

test("round 7.2: non-string content is never judged — coercion is a lossy transform", async () => {
  const home = tempDir("murphys-r72-");
  // Out-of-contract rows appended directly to the file, as a legacy migration
  // or manual edit could: no writer in this package produces these.
  const rows = [
    { id: "llg-objtitle0001", title: { a: 1 }, description: "same body", status: "active" },
    { id: "llg-objtitle0002", title: { b: 2 }, description: "same body", status: "active" },
    { id: "llg-numtitle0001", title: 42, description: "answer body", status: "active" },
    { id: "llg-strtitle0001", title: "42", description: "answer body", status: "active" },
  ];
  fs.writeFileSync(path.join(home, "lessons.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const result = JSON.parse(execFileSync("node", [CLI, "dedupe", "--apply"],
    { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" }));
  assert.equal(result.retired, 0, "coerced collisions ({a:1}/{b:2} -> [object Object], 42 -> \"42\") must never retire");
  const surfaces = JSON.stringify(result);
  for (const r of rows) assert.ok(!surfaces.includes(r.id), `out-of-contract row ${r.id} must appear in neither tier`);
  const after = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(after.every((r) => r.status === "active"), "no row was retired");
});

test("round 7.2: candidates reflect the post-plan register and carry usable member objects", async () => {
  const home = tempDir("murphys-r72c-");
  const env = { ...process.env, MURPHYS_HOME: home };
  // A and A2 are byte-identical (one will retire); B is fold-equal only.
  execFileSync("node", [CLI, "add", "--title", "Restart rule —", "--description", "Drain before restart.", "--date", "2026-01-01"], { env, encoding: "utf8" });
  execFileSync("node", [CLI, "add", "--title", "Restart rule —", "--description", "Drain before restart.", "--date", "2026-02-01"], { env, encoding: "utf8" });
  execFileSync("node", [CLI, "add", "--title", "Restart rule", "--description", "Drain before restart.", "--date", "2026-03-01"], { env, encoding: "utf8" });
  const result = JSON.parse(execFileSync("node", [CLI, "dedupe", "--apply"], { env, encoding: "utf8" }));
  assert.equal(result.retired, 1, "the byte-identical pair retires exactly one row");
  const after = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const retired = after.find((r) => r.status === "superseded");
  assert.equal(result.reviewCandidates.length, 1, "keeper + fold-equal sibling remain a review group");
  const group = result.reviewCandidates[0];
  assert.ok(!group.ids.includes(retired.id), "a just-retired row must not be re-listed for curator review");
  assert.equal(group.members.length, 2);
  for (const member of group.members) {
    assert.equal(typeof member.id, "string");
    assert.equal(typeof member.title, "string");
    assert.equal(typeof member.description, "string", "description-only variants are indistinguishable without descriptions");
  }
});

test("round 7.3: reader collapses duplicate-id lines (first wins) and dedupe never self-retires them", async () => {
  const home = tempDir("murphys-r73-");
  const rowX = JSON.stringify({ id: "llp-dupline00001", title: "Synced lesson", description: "Body of the synced lesson.", status: "active" });
  const rowY = JSON.stringify({ id: "llg-distinct0001", title: "Other lesson", description: "A different body entirely.", status: "active" });
  fs.writeFileSync(path.join(home, "lessons.jsonl"), rowX + "\n" + rowX + "\n" + rowY + "\n");
  const env = { ...process.env, MURPHYS_HOME: home, HOME: home };
  const stats = JSON.parse(execFileSync("node", [CLI, "stats"], { env, encoding: "utf8" }));
  assert.equal(stats.register.total, 2, "the duplicated line is one lesson to every reader");
  const result = JSON.parse(execFileSync("node", [CLI, "dedupe", "--apply"], { env, encoding: "utf8" }));
  assert.equal(result.retired, 0, "a collapsed duplicate line must never become a self-retirement");
  const doctor = JSON.parse(execFileSync("node", [CLI, "doctor"], { env, encoding: "utf8" }));
  assert.equal(doctor.register.duplicateIdLines, 1, "doctor counts the extra line");
  assert.equal(doctor.ok, true, "byte-identical duplicate lines are a benign, reported artifact");
});

test("round 7.3: divergent same-id lines are a doctor issue — the reader is masking data", async () => {
  const home = tempDir("murphys-r73d-");
  const first = JSON.stringify({ id: "llg-divergent001", title: "First version", description: "The first body.", status: "active" });
  const second = JSON.stringify({ id: "llg-divergent001", title: "Second version", description: "A conflicting body.", status: "active" });
  fs.writeFileSync(path.join(home, "lessons.jsonl"), first + "\n" + second + "\n");
  const env = { ...process.env, MURPHYS_HOME: home, HOME: home };
  const stats = JSON.parse(execFileSync("node", [CLI, "stats"], { env, encoding: "utf8" }));
  assert.equal(stats.register.total, 1, "first occurrence wins");
  let doctorOut = "";
  let doctorCode = 0;
  try {
    doctorOut = execFileSync("node", [CLI, "doctor"], { env, encoding: "utf8" });
  } catch (err) {
    doctorCode = err.status;
    doctorOut = err.stdout;
  }
  assert.equal(doctorCode, 1, "divergent duplicate ids must fail doctor");
  const doctor = JSON.parse(doctorOut);
  assert.ok(doctor.issues.some((i) => i.includes("llg-divergent001")), "the divergent id is named");
});

test("round 7.4: sync rows are pure functions of source content — two syncs, byte-identical registers", async () => {
  const source = tempDir("murphys-r74src-");
  fs.writeFileSync(path.join(source, "LESSONS-LEARNED.jsonl"),
    JSON.stringify({ title: "Dated lesson", description: "Has a source date.", date: "2026-03-04" }) + "\n" +
    JSON.stringify({ title: "Undated lesson", description: "No date in the source row." }) + "\n");
  const registers = [];
  for (const label of ["a", "b"]) {
    const home = tempDir(`murphys-r74${label}-`);
    fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: [{ slug: "det", root: source }] }));
    execFileSync("node", [CLI, "sync"], { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" });
    registers.push(fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8"));
  }
  assert.equal(registers[0], registers[1], "same source must produce byte-identical durable rows regardless of when sync runs");
  const rows = registers[0].trim().split("\n").map((l) => JSON.parse(l));
  const dated = rows.find((r) => r.title === "Dated lesson");
  const undated = rows.find((r) => r.title === "Undated lesson");
  assert.equal(dated.timestamp, "2026-03-04T12:00:00");
  assert.ok(!("timestamp" in undated), "an undated source row stays undated — no wall-clock fallback");
  assert.ok(!("synced_at" in dated) && !("synced_at" in undated), "no wall clock rides in a durable row");
});

test("round 7.4: a live foreign lock is respected AND survives the run — no blind unlock", async () => {
  const home = tempDir("murphys-r74lock-");
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: [{ slug: "lk", root: home }] }));
  fs.writeFileSync(path.join(home, "LESSONS-LEARNED.jsonl"),
    JSON.stringify({ title: "Lock test lesson", description: "Body for the lock test." }) + "\n");
  const lockPath = path.join(home, ".lessons.jsonl.lock");
  // This test process's pid IS alive — the sync child must treat the lock as
  // held, skip, and leave the file untouched.
  const foreign = JSON.stringify({ pid: process.pid, ts: new Date().toISOString() });
  fs.writeFileSync(lockPath, foreign);
  const outRaw = execFileSync("node", [CLI, "sync"], { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" });
  assert.equal(JSON.parse(outRaw).skipped, true, "a live holder is never displaced");
  assert.equal(fs.readFileSync(lockPath, "utf8"), foreign, "the foreign lock survives byte-for-byte — release only ever removes a lock naming the releaser's own pid");
});

test("round 7.4: doctor's liveness alarm is scoped to THIS install's hook path", async () => {
  const hookPath = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");
  // Foreign checkout mounted (same basename, different path): no alarm.
  const homeForeign = tempDir("murphys-r74docf-");
  fs.mkdirSync(path.join(homeForeign, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeForeign, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /some/other/checkout/hooks/lessons-recall-hook.mjs" }] }] } }));
  const okOut = JSON.parse(execFileSync("node", [CLI, "doctor"],
    { env: { ...process.env, MURPHYS_HOME: homeForeign, HOME: homeForeign }, encoding: "utf8" }));
  assert.equal(okOut.ok, true, "another install's hook logs to ITS home — alarming here is a false positive");
  // THIS install mounted, no injection log: alarm.
  const homeMine = tempDir("murphys-r74docm-");
  fs.mkdirSync(path.join(homeMine, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeMine, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${hookPath}` }] }] } }));
  let code = 0;
  let raw = "";
  try {
    raw = execFileSync("node", [CLI, "doctor"], { env: { ...process.env, MURPHYS_HOME: homeMine, HOME: homeMine }, encoding: "utf8" });
  } catch (err) {
    code = err.status;
    raw = err.stdout;
  }
  assert.equal(code, 1, "this install mounted with no injection log must alarm");
  assert.ok(JSON.parse(raw).issues.some((i) => i.includes("never fired")));
});
