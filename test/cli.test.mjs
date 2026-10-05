// CLI ergonomics: real flag parsing, clean errors, honest usage text, and
// gate settings that fail safe.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-cli-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function envFor(home, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MU(R)?PHYS_/.test(key) && key !== "DEBUG"));
  return { ...env, MURPHYS_HOME: home, HOME: home, ...extra };
}
const run = (home, args, extra) => spawnSync("node", [CLI, ...args], { env: envFor(home, extra), encoding: "utf8" });
const rows = (home) => fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a value that starts with -- is still a value", () => {
  const home = freshHome();
  const result = run(home, ["add", "--title", "--force-with-lease beats --force", "--description", "Use the lease variant."]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rows(home)[0].title, "--force-with-lease beats --force");
});

test("--flag=value works and never swallows the next positional", () => {
  const home = freshHome();
  for (let i = 0; i < 3; i += 1) run(home, ["add", "--title", `Deploy lesson ${i}`, "--description", "Deploy guidance."]);
  const result = JSON.parse(run(home, ["query", "--limit=2", "deploy"]).stdout);
  assert.equal(result.query, "deploy");
  assert.equal(result.lessons.length, 2);
});

test("--evidence can repeat", () => {
  const home = freshHome();
  run(home, ["add", "--title", "Evidence lesson", "--description", "Has two refs.", "--evidence", "ref-a", "--evidence=ref-b"]);
  assert.deepEqual(rows(home)[0].evidence, ["ref-a", "ref-b"]);
});

test("unknown options and missing values are usage errors (exit 2, one line)", () => {
  const home = freshHome();
  const unknown = run(home, ["query", "--limt", "2", "deploy"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option --limt/);
  const missing = run(home, ["add", "--title"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--title needs a value/);
});

test("command errors print one clean line; DEBUG adds the stack", () => {
  const home = freshHome();
  const plain = run(home, ["deprecate", "--ids", "llg-x", "--reason", "r"]);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /^murphys: the register is empty/);
  assert.ok(!/\n\s+at /.test(plain.stderr), `no stack trace without DEBUG: ${plain.stderr}`);
  const debug = run(home, ["deprecate", "--ids", "llg-x", "--reason", "r"], { DEBUG: "1" });
  assert.match(debug.stderr, /\n\s+at /);
});

test("usage lists every command, including mcp and review", () => {
  const usage = spawnSync("node", [CLI, "--help"], { env: envFor(freshHome()), encoding: "utf8" });
  assert.equal(usage.status, 0);
  for (const command of ["add", "query", "supersede", "deprecate", "dedupe", "sync", "review", "doctor", "stats", "mcp"]) {
    assert.match(usage.stderr, new RegExp(`\\b${command}\\b`), `usage mentions ${command}`);
  }
  assert.equal(spawnSync("node", [CLI, "nonsense"], { env: envFor(freshHome()), encoding: "utf8" }).status, 2);
});

test("a non-numeric gate setting falls back to the default with a warning", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"), JSON.stringify({ id: "llg-gate", title: "Alpha beta gamma", description: "Delta epsilon zeta.", status: "active" }) + "\n");
  // Three shared terms score 6: below the default gate (8), so silent.
  const prompt = "alpha beta gamma are three words for the weather report tomorrow morning";
  const result = spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "gate", cwd: "/tmp", prompt }), env: envFor(home, { MURPHYS_HOOK_MIN_SCORE: "abc" }), encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "", "NaN must not disable the score gate");
  assert.match(result.stderr, /MURPHYS_HOOK_MIN_SCORE/);
});
