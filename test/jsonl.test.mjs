// JSONL robustness: a register edited by hand, by another tool, or cut short
// by a crash must never make lessons silently disappear.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const LIB = path.join(HERE, "..", "lib", "register.cjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-jsonl-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const envFor = (home) => ({ ...process.env, MURPHYS_HOME: home, HOME: home });
const cli = (home, args) => JSON.parse(execFileSync("node", [CLI, ...args], { env: envFor(home), encoding: "utf8" }));
function doctor(home) {
  const run = spawnSync("node", [CLI, "doctor"], { env: envFor(home), encoding: "utf8" });
  return { code: run.status, out: JSON.parse(run.stdout) };
}

const ROW_A = { id: "llg-jsonl-a", title: "Hand edited lesson", description: "Saved by an editor without a final newline.", status: "active" };

test("an append to a register missing its final newline keeps BOTH rows", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"), JSON.stringify(ROW_A)); // no trailing \n
  cli(home, ["add", "--title", "Appended after a hand edit", "--description", "Written by the CLI."]);
  const stats = cli(home, ["stats"]);
  assert.equal(stats.register.total, 2, "the hand-edited row and the new row must both survive");
  assert.equal(doctor(home).code, 0, "nothing unparseable was written");
});

test("other logs get the same guard: a usage log missing its final newline still counts both applies", async () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "usage.jsonl"), JSON.stringify({ id: "use-old", lessonIds: ["llg-x"], outcome: "worked" }));
  execFileSync("node", ["-e", `
    const core = require(${JSON.stringify(LIB)});
    core.callTool("lessons_apply", { lessonIds: ["llg-x"], task: "t", outcome: "failed" }).then(() => process.exit(0));
  `], { env: envFor(home), encoding: "utf8" });
  const stats = cli(home, ["stats"]);
  assert.equal(stats.outcomes.applies, 2);
});

test("a UTF-8 BOM never hides the first register row", () => {
  const home = freshHome();
  const rows = [ROW_A, { ...ROW_A, id: "llg-jsonl-b", title: "Second row" }];
  fs.writeFileSync(path.join(home, "lessons.jsonl"), "\uFEFF" + rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(cli(home, ["stats"]).register.total, 2);
  const result = cli(home, ["query", "hand edited lesson"]);
  assert.ok(result.lessons.some((l) => l.id === "llg-jsonl-a"), "the BOM-prefixed first row is queryable");
});

test("a UTF-8 BOM in projects.json and in a project's lessons file does not break sync", () => {
  const home = freshHome();
  const project = path.join(home, "proj");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, "projects.json"), "\uFEFF" + JSON.stringify({ projects: [{ slug: "bom", root: project }] }));
  fs.writeFileSync(path.join(project, "LESSONS-LEARNED.jsonl"), "\uFEFF" + JSON.stringify({ title: "BOM lesson", description: "First line of a BOM file." }) + "\n");
  const result = cli(home, ["sync"]);
  assert.equal(result.totalAppended, 1);
  assert.equal(result.projects[0].invalid, 0, "the BOM-prefixed first line is a valid lesson");
});

test("doctor counts unparseable register lines and fails", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"), [
    JSON.stringify(ROW_A),
    '{"id":"llg-torn","title":"torn wri',
    '"a bare JSON string is not a lesson"',
    "42",
  ].join("\n") + "\n");
  const { code, out } = doctor(home);
  assert.equal(code, 1, "unparseable lines are an integrity failure");
  assert.ok(out.issues.some((i) => /3 unparseable register line/.test(i)), `issues: ${JSON.stringify(out.issues)}`);
  assert.equal(out.register.unparseableLines, 3);
});

test("non-object JSON rows are never served as lessons", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"), ['"stray string row"', "42", "null", "[1,2]", JSON.stringify(ROW_A)].join("\n") + "\n");
  const result = cli(home, ["query"]);
  assert.deepEqual(result.lessons.map((l) => l.id), ["llg-jsonl-a"], "only the real object row is a lesson");
});
