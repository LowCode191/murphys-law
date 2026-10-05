// Regression: the hook and CLI must work when the package lives at a path
// containing spaces ("My Projects", most Windows homes). The original code
// used new URL(import.meta.url).pathname, which yields %20 and crashes at
// top-level import — OUTSIDE the hook's fail-open try/catch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACED = fs.mkdtempSync(path.join(os.tmpdir(), "murphys space test-"));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "murphys-space-home-"));
after(() => {
  fs.rmSync(SPACED, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

before(() => {
  for (const dir of ["lib", "hooks", "bin"]) {
    fs.cpSync(path.join(REPO, dir), path.join(SPACED, dir), { recursive: true });
  }
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "lessons.jsonl"), JSON.stringify({
    id: "llg-space-test-1",
    title: "Adding a skill must preserve the whole whitelist",
    description: "The skills array is an exclusive whitelist: setting it to one entry removes every other skill. Always write the complete list.",
    tags: ["config", "skills"],
    status: "active",
    timestamp: "2026-01-05T12:00:00",
  }) + "\n");
});

test("hook loads and injects from a path containing spaces", () => {
  assert.match(SPACED, / /, "test dir must actually contain a space");
  const out = execFileSync("node", [path.join(SPACED, "hooks", "lessons-recall-hook.mjs")], {
    input: JSON.stringify({
      session_id: "space-sess",
      cwd: "/tmp",
      prompt: "I need to update the skills array in the config so the agent keeps the existing whitelist entries when adding the new skill",
    }),
    env: { ...process.env, MURPHYS_HOME: HOME },
    encoding: "utf8",
  });
  assert.match(out, /<lessons-recall>/);
  assert.match(out, /llg-space-test-1/);
});

test("CLI loads and queries from a path containing spaces", () => {
  const out = execFileSync("node", [path.join(SPACED, "bin", "muphys.mjs"), "query", "skills", "whitelist"], {
    env: { ...process.env, MURPHYS_HOME: HOME },
    encoding: "utf8",
  });
  const result = JSON.parse(out);
  assert.ok(result.count >= 1);
  assert.equal(result.lessons[0].id, "llg-space-test-1");
});
