// Concurrent writers: every register writer takes the register lock, and a
// rewrite (supersede / dedupe --apply / review) re-appends anything a
// lock-ignoring writer added to the old file after the rewrite's read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const LIB = path.join(HERE, "..", "lib", "register.cjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-conc-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const envFor = (home, extra = {}) => ({ ...process.env, MURPHYS_HOME: home, HOME: home, ...extra });
const lockPathFor = (home) => path.join(home, ".lessons.jsonl.lock");

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

async function inBatches(count, width, task) {
  for (let start = 0; start < count; start += width) {
    const batch = [];
    for (let i = start; i < Math.min(count, start + width); i += 1) batch.push(task(i));
    await Promise.all(batch);
  }
}

test("stress: 40 concurrent adds racing dedupe --apply all survive, across repeated rounds", async () => {
  for (let round = 0; round < 3; round += 1) {
    const home = freshHome("murphys-stress-");
    const rows = [];
    for (let i = 0; i < 150; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        rows.push(JSON.stringify({ id: `llg-seed-${i}-${j}`, title: `Dup ${i}`, description: `Body ${i}`, status: "active", timestamp: `2026-01-01T00:00:0${j}` }));
      }
    }
    fs.writeFileSync(path.join(home, "lessons.jsonl"), rows.join("\n") + "\n");
    const env = envFor(home);
    const dedupe = runCli(["dedupe", "--apply"], env);
    await inBatches(40, 8, (k) => runCli(["add", "--title", `Concurrent add ${round}-${k}`, "--description", `Added during dedupe ${k}`], env));
    const dedupeResult = await dedupe;
    assert.ok(!dedupeResult.error, `dedupe failed: ${dedupeResult.stderr}`);
    const text = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8");
    const added = text.split("\n").filter((line) => line.includes(`Concurrent add ${round}-`)).length;
    assert.equal(added, 40, `round ${round}: every acknowledged add must survive the concurrent rewrites (got ${added}/40)`);
    const superseded = text.split("\n").filter((line) => line.includes('"status":"superseded"')).length;
    assert.equal(superseded, 150, `round ${round}: every byte-identical duplicate is still retired`);
  }
});

test("a rewrite re-appends rows a lock-ignoring writer added after the rewrite's read", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"),
    JSON.stringify({ id: "llg-keep", title: "Keeper", description: "Stays active.", status: "active" }) + "\n" +
    JSON.stringify({ id: "llg-old", title: "Old", description: "Gets retired.", status: "active" }) + "\n");
  const out = execFileSync("node", ["-e", `
    const fs = require("fs");
    const core = require(${JSON.stringify(LIB)});
    core.withRegisterLock(() => core._rewriteRegister((text) => {
      // Simulates a writer that ignores the lock (an older release, a script
      // doing >>): it appends to the CURRENT file between our read and rename.
      fs.appendFileSync(core.REGISTER_JSONL, JSON.stringify({ id: "llg-rogue", title: "Rogue append", description: "Written mid-rewrite.", status: "active" }) + "\\n");
      return text.replace('"id":"llg-old","title":"Old","description":"Gets retired.","status":"active"', '"id":"llg-old","title":"Old","description":"Gets retired.","status":"deprecated"');
    }));
    console.log(JSON.stringify(core.readRegister().map((l) => [l.id, l.status])));
  `], { env: envFor(home), encoding: "utf8" });
  const rows = new Map(JSON.parse(out.trim()));
  assert.equal(rows.get("llg-old"), "deprecated", "the rewrite itself landed");
  assert.equal(rows.get("llg-rogue"), "active", "the mid-rewrite append was reaped from the old inode and re-appended");
  assert.equal(rows.get("llg-keep"), "active");
});

test("add waits for a held register lock and fails cleanly when it never frees", () => {
  const home = freshHome();
  fs.writeFileSync(lockPathFor(home), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "held-by-test" }));
  const run = spawnSync("node", [CLI, "add", "--title", "Blocked add", "--description", "Must not land while the lock is held."],
    { env: envFor(home, { MURPHYS_LOCK_WAIT_MS: "300" }), encoding: "utf8" });
  assert.notEqual(run.status, 0, "a writer that cannot get the lock must fail, not write unserialized");
  assert.match(run.stderr, /register is locked/);
  assert.ok(!fs.existsSync(path.join(home, "lessons.jsonl")) || !fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").includes("Blocked add"));
  assert.equal(JSON.parse(fs.readFileSync(lockPathFor(home), "utf8")).token, "held-by-test", "a live holder's lock is never touched");
  fs.rmSync(lockPathFor(home));
  const ok = spawnSync("node", [CLI, "add", "--title", "Unblocked add", "--description", "Lands once the lock is free."], { env: envFor(home), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!fs.existsSync(lockPathFor(home)), "the writer releases its own lock");
});

test("supersede respects a held register lock", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"),
    JSON.stringify({ id: "llg-a", title: "A", description: "a", status: "active" }) + "\n" +
    JSON.stringify({ id: "llg-b", title: "B", description: "b", status: "active" }) + "\n");
  fs.writeFileSync(lockPathFor(home), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "held-by-test" }));
  const run = spawnSync("node", [CLI, "supersede", "--ids", "llg-a", "--superseded-by", "llg-b", "--reason", "r"],
    { env: envFor(home, { MURPHYS_LOCK_WAIT_MS: "300" }), encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.ok(fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").includes('"id":"llg-a","title":"A","description":"a","status":"active"'), "no rewrite under someone else's lock");
});
