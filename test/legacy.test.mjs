// Upgrading from muphys-law (<= 0.2): legacy MUPHYS_* variables and a
// ~/.muphys home keep working as fallbacks; nothing is moved or deleted.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");
const LIB = path.join(HERE, "..", "lib", "register.cjs");
const SAMPLES = path.join(HERE, "..", "data", "sample-lessons.jsonl");

const TEMP_DIRS = [];
function freshDir(prefix = "murphys-legacy-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

// A child environment with no MURPHYS_* / MUPHYS_* inherited from the
// developer's shell, HOME pointing at a throwaway directory, and colour off:
// a terminal that exports FORCE_COLOR makes `console.log(true)` print ANSI
// escapes, which broke exact-output assertions.
function envWith(home, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MU(R)?PHYS_/.test(key) && key !== "FORCE_COLOR"));
  return { ...env, NO_COLOR: "1", HOME: home, ...extra };
}

function legacyHome() {
  const home = freshDir();
  fs.mkdirSync(path.join(home, ".muphys"));
  fs.copyFileSync(SAMPLES, path.join(home, ".muphys", "lessons.jsonl"));
  return home;
}

test("a pre-0.3 ~/.muphys register is used when ~/.murphys has none, with a one-time notice", () => {
  const home = legacyHome();
  const first = spawnSync("node", [CLI, "query", "verify the deploy is served in production"], { env: envWith(home), encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(JSON.parse(first.stdout).count > 0, "the legacy register is read");
  assert.match(first.stderr, /\.muphys/, "the user is told which home is in use");
  const second = spawnSync("node", [CLI, "query", "verify the deploy is served in production"], { env: envWith(home), encoding: "utf8" });
  assert.equal(second.stderr, "", "the notice is shown once");
  assert.ok(fs.existsSync(path.join(home, ".muphys", "lessons.jsonl")), "nothing is moved");
  assert.ok(!fs.existsSync(path.join(home, ".murphys", "lessons.jsonl")), "nothing is copied");
});

test("the current home wins once it holds a register", () => {
  const home = legacyHome();
  fs.mkdirSync(path.join(home, ".murphys"));
  fs.writeFileSync(path.join(home, ".murphys", "lessons.jsonl"), JSON.stringify({ id: "llg-current", title: "Current home lesson", description: "Lives in the new home.", status: "active" }) + "\n");
  const stats = JSON.parse(execFileSync("node", [CLI, "stats"], { env: envWith(home), encoding: "utf8" }));
  assert.equal(stats.home, path.join(home, ".murphys"));
  assert.equal(stats.register.total, 1);
});

test("MUPHYS_* variables are fallbacks; MURPHYS_* wins when both are set", () => {
  const home = freshDir();
  const legacyData = legacyHome();
  const viaLegacy = JSON.parse(execFileSync("node", [CLI, "stats"], { env: envWith(home, { MUPHYS_HOME: path.join(legacyData, ".muphys") }), encoding: "utf8" }));
  assert.equal(viaLegacy.register.total, 7);
  const current = freshDir();
  const both = JSON.parse(execFileSync("node", [CLI, "stats"], { env: envWith(home, { MUPHYS_HOME: path.join(legacyData, ".muphys"), MURPHYS_HOME: current }), encoding: "utf8" }));
  assert.equal(both.home, current);
  const enabled = execFileSync("node", ["-e", `console.log(String(require(${JSON.stringify(LIB)}).embeddingsEnabled()))`],
    { env: envWith(home, { MURPHYS_HOME: current, MUPHYS_EMBEDDINGS_URL: "http://127.0.0.1:1/v1/embeddings", MUPHYS_EMBEDDINGS_MODEL: "m" }), encoding: "utf8" });
  assert.equal(enabled.trim(), "true", "legacy embedding settings still enable hybrid retrieval");
});

test("library users keep the pre-0.3 MUPHYS_HOME export", () => {
  const out = execFileSync("node", ["-e", `const c = require(${JSON.stringify(LIB)}); console.log(String(c.MUPHYS_HOME === c.MURPHYS_HOME))`], { env: envWith(freshDir(), { MURPHYS_HOME: freshDir() }), encoding: "utf8" });
  assert.equal(out.trim(), "true");
});

test("experiments running in a legacy home keep their pre-0.3 arm assignment", () => {
  const home = legacyHome();
  fs.writeFileSync(path.join(home, ".muphys", "experiment.json"), JSON.stringify({ enabled: true, mode: "session-randomized", treatFraction: 0.5 }));
  const prompt = "We committed the fix but need to verify the deploy is actually served in production: restart the running process and smoke the live endpoint";
  const legacyArm = (sid) => (crypto.createHash("sha256").update(`muphys-recall|${sid}`).digest().readUInt32BE(0) / 0xffffffff < 0.5 ? "treat" : "control");
  let treated = 0;
  for (let i = 0; i < 10; i += 1) {
    const sid = `legacy-arm-${i}`;
    const out = execFileSync("node", [HOOK], { input: JSON.stringify({ session_id: sid, cwd: "/tmp", prompt }), env: envWith(home), encoding: "utf8" });
    assert.equal(out ? "treat" : "control", legacyArm(sid), `session ${sid} keeps the arm it had before the rename`);
    if (out) treated += 1;
  }
  assert.ok(treated > 0, "sanity: some sessions are treated");
});
