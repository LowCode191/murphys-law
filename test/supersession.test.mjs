// Supersession repairs: chains can be re-pointed, id-less legacy rows can be
// retired by the ids the reader hands out, and the replacement check reads
// the register the same way every reader does (first occurrence wins).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-sup-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const envFor = (home) => ({ ...process.env, MURPHYS_HOME: home, HOME: home });
const cli = (home, args) => JSON.parse(execFileSync("node", [CLI, ...args], { env: envFor(home), encoding: "utf8" }));
const rowsOf = (home) => fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const seed = (home, rows) => fs.writeFileSync(path.join(home, "lessons.jsonl"), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");

test("an A→B→C chain can be re-pointed (A→C), keeping history, and doctor passes", () => {
  const home = freshHome();
  seed(home, [
    { id: "A", title: "v1", description: "first", status: "active" },
    { id: "B", title: "v2", description: "second", status: "active" },
    { id: "C", title: "v3", description: "third", status: "active" },
  ]);
  cli(home, ["supersede", "--ids", "A", "--superseded-by", "B", "--reason", "v2 better"]);
  cli(home, ["supersede", "--ids", "B", "--superseded-by", "C", "--reason", "v3 better"]);
  const before = spawnSync("node", [CLI, "doctor"], { env: envFor(home), encoding: "utf8" });
  assert.equal(before.status, 1, "sanity: the chain is a doctor issue");
  const result = cli(home, ["supersede", "--ids", "A", "--superseded-by", "C", "--reason", "re-point at the live replacement"]);
  assert.deepEqual(result.repointed.map((r) => r.id), ["A"]);
  const a = rowsOf(home).find((r) => r.id === "A");
  assert.equal(a.superseded_by, "C");
  assert.equal(a.status, "superseded");
  assert.equal(a.supersession_history.length, 1);
  assert.equal(a.supersession_history[0].superseded_by, "B", "the previous pointer is kept, never overwritten silently");
  const doctor = spawnSync("node", [CLI, "doctor"], { env: envFor(home), encoding: "utf8" });
  assert.equal(doctor.status, 0, doctor.stdout);
});

test("re-pointing still refuses a retired target (cycles stay unrepresentable)", () => {
  const home = freshHome();
  seed(home, [
    { id: "A", title: "v1", description: "first", status: "active" },
    { id: "B", title: "v2", description: "second", status: "active" },
  ]);
  cli(home, ["supersede", "--ids", "A", "--superseded-by", "B", "--reason", "v2 better"]);
  const run = spawnSync("node", [CLI, "supersede", "--ids", "B", "--superseded-by", "A", "--reason", "cycle"], { env: envFor(home), encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must be an ACTIVE lesson/);
});

test("id-less legacy rows: dedupe --apply retires them and stamps the ids it used", () => {
  const home = freshHome();
  seed(home, [
    { title: "Legacy dup", description: "Imported without ids", status: "active" },
    { title: "Legacy dup", description: "Imported without ids", status: "active" },
  ]);
  const plan = cli(home, ["dedupe"]);
  assert.equal(plan.wouldRetire.length, 1);
  const result = cli(home, ["dedupe", "--apply"]);
  assert.equal(result.retired, 1);
  const rows = rowsOf(home);
  assert.ok(rows.every((r) => typeof r.id === "string" && r.id.startsWith("ll-")), "both touched rows now carry their ids on disk");
  assert.deepEqual(rows.map((r) => r.id), [plan.wouldRetire[0].retire, plan.wouldRetire[0].keeper].sort((x, y) => rows.findIndex((r) => r.id === x) - rows.findIndex((r) => r.id === y)));
  const retired = rows.find((r) => r.id === plan.wouldRetire[0].retire);
  assert.equal(retired.status, "superseded");
  assert.equal(retired.superseded_by, plan.wouldRetire[0].keeper);
});

test("id-less legacy rows can be retired by the id lessons_query returned", () => {
  const home = freshHome();
  seed(home, [{ title: "Legacy lesson", description: "No id on disk", status: "active" }]);
  const id = cli(home, ["query", "legacy lesson"]).lessons[0].id;
  const result = cli(home, ["deprecate", "--ids", id, "--reason", "retire by the returned id"]);
  assert.equal(result.retired, 1);
  assert.equal(rowsOf(home)[0].id, id, "the synthesized id is stamped into the row");
  assert.equal(rowsOf(home)[0].status, "deprecated");
});

test("the replacement check reads first-wins, like every reader", () => {
  const home = freshHome();
  seed(home, [
    { id: "R", title: "Replacement", description: "retired copy first", status: "superseded", superseded_by: "Z" },
    { id: "R", title: "Replacement", description: "active copy second", status: "active" },
    { id: "Z", title: "Z", description: "z", status: "active" },
    { id: "X", title: "X", description: "x", status: "active" },
  ]);
  const run = spawnSync("node", [CLI, "supersede", "--ids", "X", "--superseded-by", "R", "--reason", "r"], { env: envFor(home), encoding: "utf8" });
  assert.notEqual(run.status, 0, "readers see R as retired (first copy wins), so it cannot be a replacement");
  assert.match(run.stderr, /must be an ACTIVE lesson/);
});
