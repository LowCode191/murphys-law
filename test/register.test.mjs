import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// Point the core at a throwaway home BEFORE requiring it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "murphys-test-"));
process.env.MURPHYS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const core = require("../lib/register.cjs");

before(() => {
  const lessons = [
    { title: "Always trash, never rm", description: "Deleting archived dirs with rm -rf lost data. Use trash or rename-archive so recovery exists.", tags: ["fs", "safety"], date: "2026-01-05" },
    { title: "Check git history, not just the working tree", description: "A secret redacted from a file still lives at every commit that contained it. git log -S at the history layer, then rotate the credential.", tags: ["secrets"], date: "2026-01-06" },
    { title: "Cleanup fixtures must include survivors", description: "A cleanup script validated only against the records being removed deleted keeper records in production. Fixtures must include the kept cohort.", tags: ["testing"], date: "2026-01-07" },
  ];
  core.appendLessons(core.lessonEntries({ lessons }), { author: "test", source: "seed" });
});

test("appendLessons stamps explicit ids and active status", async () => {
  const rows = core.readRegister();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.match(row.id, /^llg-/);
    assert.equal(row.status, "active");
  }
});

test("query ranks the on-topic lesson first and logs telemetry", async () => {
  const result = await core.callTool("lessons_query", { query: "secret redacted git history rotate" }, { caller: "test", surface: "test" });
  assert.ok(result.count >= 1);
  assert.match(result.lessons[0].title, /git history/);
  const log = fs.readFileSync(core.QUERIES_JSONL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = log[log.length - 1];
  assert.equal(last.caller, "test");
  assert.equal(last.results[0].rank, 1);
});

test("argument-less query is flagged as such, not counted as retrieval", async () => {
  await core.callTool("lessons_query", {}, { surface: "test" });
  const log = fs.readFileSync(core.QUERIES_JSONL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[log.length - 1].argumentless, true);
});

test("apply validates outcome enum", async () => {
  const ok = await core.callTool("lessons_apply", { lessonIds: ["llg-x"], task: "t", outcome: "worked", dryRun: true });
  assert.equal(ok.entry.outcome, "worked");
  await assert.rejects(() => core.callTool("lessons_apply", { lessonIds: ["llg-x"], task: "t", outcome: "great" }), /outcome must be one of/);
});

test("supersede retires by pointer, never deletes, and queries filter it", async () => {
  const rows = core.readRegister();
  const keeper = rows.find((r) => /survivors/.test(r.title));
  const victim = core.appendLessons(core.lessonEntries({ lessons: [{ title: "Cleanup fixtures must include survivors", description: "Older phrasing of the survivor-fixture rule.", date: "2026-01-01" }] }), { author: "test" })[0];
  const result = await core.callTool("lessons_supersede", { ids: [victim.id], supersededBy: keeper.id, reason: "duplicate" });
  assert.equal(result.retired, 1);
  const after = core.readRegister();
  assert.equal(after.length, rows.length + 1, "nothing deleted");
  const retired = after.find((r) => r.id === victim.id);
  assert.equal(retired.status, "superseded");
  assert.equal(retired.superseded_by, keeper.id);
  const query = await core.callTool("lessons_query", { query: "cleanup fixtures survivors kept cohort" });
  assert.ok(!query.lessons.some((l) => l.id === victim.id), "retired lesson must not be recallable");
});

test("supersede refuses unknown ids, self-supersession, and missing replacement", async () => {
  await assert.rejects(() => core.callTool("lessons_supersede", { ids: ["nope"], reason: "x" }), /supersededBy is required/);
  await assert.rejects(() => core.callTool("lessons_supersede", { ids: ["nope"], supersededBy: core.readRegister()[0].id, reason: "x", dryRun: true }), /not found in register/);
  const id = core.readRegister()[0].id;
  await assert.rejects(() => core.callTool("lessons_supersede", { ids: [id], supersededBy: id, reason: "x", dryRun: true }), /cannot supersede itself/);
});

test("long descriptions truncate explicitly, never silently", async () => {
  const long = core.appendLessons(core.lessonEntries({ lessons: [{ title: "Long lesson", description: "x".repeat(1000) + " THE ACTIONABLE RULE" }] }), { author: "test" })[0];
  const result = await core.callTool("lessons_query", { query: "long lesson" });
  const hit = result.lessons.find((l) => l.id === long.id);
  assert.equal(hit.truncated, true);
  assert.match(hit.description, /…\[truncated\]$/);
});
