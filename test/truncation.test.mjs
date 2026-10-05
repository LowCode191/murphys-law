// Truncation is explicit everywhere text is cut: a silently cut description
// can lose exactly the actionable rule.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-trunc-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const PROMPT = "Rotate the staging database credentials and restart the replica pool after the failover drill";
const words = "rotate staging database credentials restart replica pool failover drill";

function hookWith(lessons) {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"), lessons.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ session_id: "trunc", cwd: "/tmp", prompt: PROMPT }), env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" });
  return { home, out };
}

test("hook fields cut with an explicit marker", () => {
  const { out } = hookWith([{
    id: "llg-long-fields",
    title: `${words} ${"t".repeat(300)}`,
    description: `${words} ${"d".repeat(600)} THE ACTIONABLE RULE AT THE END`,
    status: "active",
  }]);
  const line = out.split("\n").find((l) => l.includes("llg-long-fields"));
  assert.ok(line, out);
  assert.equal((line.match(/…\[truncated\]/g) || []).length, 2, "both the title and the description say they were cut");
});

test("the block cap drops whole lessons, says so, and never cuts mid-line", () => {
  const lessons = [1, 2, 3].map((n) => ({
    id: `llg-cap-${n}`,
    title: `${words} ${String(n).repeat(200)}`,
    description: `${words} ${"x".repeat(400)}`,
    status: "active",
  }));
  const { home, out } = hookWith(lessons);
  assert.ok(out.length <= 1400, `block is ${out.length} chars`);
  const lines = out.split("\n");
  assert.equal(lines[0], "<lessons-recall>");
  assert.equal(lines.at(-1), "</lessons-recall>");
  assert.match(lines.at(-2), /ignore this block entirely\.$/, "the closing guidance line is intact");
  for (const line of lines.filter((l) => l.startsWith("- [llg-cap-"))) assert.match(line, /\(score \d+\)$/, "every lesson line is complete");
  assert.match(out, /more matching lessons? omitted: block size cap/);
  const shown = lines.filter((l) => l.startsWith("- [llg-cap-")).length;
  const logged = JSON.parse(fs.readFileSync(path.join(home, "injections.jsonl"), "utf8").trim()).lessons.length;
  assert.equal(logged, shown, "telemetry records what was delivered, not what was cut");
});

test("sync marks cut titles and descriptions, and keeps the ids earlier releases derived", () => {
  const home = freshHome();
  const project = path.join(home, "proj");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: [{ slug: "long", root: project }] }));
  const title = "T".repeat(320);
  const description = "D".repeat(8100);
  fs.writeFileSync(path.join(project, "LESSONS-LEARNED.jsonl"), JSON.stringify({ title, description }) + "\n");
  execFileSync("node", [CLI, "sync"], { env: { ...process.env, MURPHYS_HOME: home }, encoding: "utf8" });
  const row = JSON.parse(fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim());
  assert.ok(row.title.endsWith("…[truncated]"));
  assert.ok(row.description.endsWith("…[truncated]"));
  assert.equal(row.truncated, true);
  const legacyId = "llp-" + crypto.createHash("sha1").update(JSON.stringify(["long", title.slice(0, 300), description.slice(0, 8000)])).digest("hex").slice(0, 12);
  assert.equal(row.id, legacyId, "a re-sync after upgrading must not re-import long rows under new ids");
});
