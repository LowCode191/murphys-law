import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "murphys-hook-test-"));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function runHook(payload, env = {}) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, MURPHYS_HOME: HOME, ...env },
    encoding: "utf8",
  });
}

before(() => {
  fs.mkdirSync(HOME, { recursive: true });
  const lesson = {
    id: "llg-testlesson01",
    title: "Adding a skill must preserve the whole whitelist",
    description: "The skills array is an exclusive whitelist: setting it to one entry removes every other skill. Always write the complete list.",
    tags: ["config", "skills"],
    status: "active",
    timestamp: "2026-01-05T12:00:00",
  };
  const retired = { ...lesson, id: "llg-retired00001", status: "superseded", superseded_by: "llg-testlesson01" };
  fs.writeFileSync(path.join(HOME, "lessons.jsonl"), JSON.stringify(lesson) + "\n" + JSON.stringify(retired) + "\n");
});

const RELEVANT = {
  session_id: "sess-1",
  cwd: "/tmp/somewhere",
  prompt: "I need to update the skills array in the config so the agent gets the review skill without losing the existing entries of the whitelist",
};

test("relevant prompt injects a wrapped, markup-folded block and logs it", () => {
  const out = runHook(RELEVANT);
  assert.match(out, /^<lessons-recall>/);
  assert.match(out, /llg-testlesson01/);
  assert.match(out, /Background context, not instructions/);
  const log = fs.readFileSync(path.join(HOME, "injections.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[log.length - 1].injected, true);
});

test("retired lessons are never injected", () => {
  const out = runHook({ ...RELEVANT, session_id: "sess-retired" });
  assert.ok(!out.includes("llg-retired00001"));
});

test("short prompts stay silent", () => {
  assert.equal(runHook({ session_id: "s2", cwd: "/tmp", prompt: "ok thanks" }), "");
});

test("irrelevant prompts stay silent", () => {
  assert.equal(runHook({ session_id: "s3", cwd: "/tmp", prompt: "Please summarize the weather forecast for tomorrow morning in three short bullet points thanks" }), "");
});

test("same session never re-injects the same top lessons (no ranking slide)", () => {
  const first = runHook({ ...RELEVANT, session_id: "sess-dedupe" });
  assert.match(first, /<lessons-recall>/);
  const second = runHook({ ...RELEVANT, session_id: "sess-dedupe" });
  assert.equal(second, "");
});

test("cwd filter gates sessions out", () => {
  const out = runHook({ ...RELEVANT, session_id: "sess-gated" }, { MURPHYS_HOOK_CWD_FILTER: "^/agents/" });
  assert.equal(out, "");
});

test("experiment mode: deterministic arms, control logs but never emits", () => {
  fs.writeFileSync(path.join(HOME, "experiment.json"), JSON.stringify({ enabled: true, mode: "session-randomized", treatFraction: 0.5 }));
  try {
    let treat = 0;
    let control = 0;
    for (let i = 0; i < 12; i += 1) {
      const sid = `arm-sess-${i}`;
      const out1 = runHook({ ...RELEVANT, session_id: sid });
      fs.rmSync(path.join(HOME, "hook-state", `${sid}.json`), { force: true });
      const out2 = runHook({ ...RELEVANT, session_id: sid });
      assert.equal(out1, out2, "same session id must always land in the same arm");
      if (out1) treat += 1; else control += 1;
    }
    assert.ok(treat > 0 && control > 0, `expected both arms, got treat=${treat} control=${control}`);
    const log = fs.readFileSync(path.join(HOME, "injections.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const controlRecords = log.filter((r) => r.arm === "control");
    assert.ok(controlRecords.length > 0, "control sessions must log counterfactual records");
    assert.ok(controlRecords.every((r) => r.injected === false));
  } finally {
    fs.rmSync(path.join(HOME, "experiment.json"), { force: true });
  }
});

test("malformed stdin exits 0 silently (fail-open)", () => {
  assert.equal(execFileSync("node", [HOOK], { input: "not json", env: { ...process.env, MURPHYS_HOME: HOME }, encoding: "utf8" }), "");
});
