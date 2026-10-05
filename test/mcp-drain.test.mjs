// MCP stdio server: output is never cut off at stdin EOF, and responses are
// size-capped with explicit markers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-mcp-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function bigRegister() {
  const home = freshHome();
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push(JSON.stringify({
      id: `llg-big-${i}`,
      title: `Deploy lesson ${i} ${"t".repeat(1000)}`,
      description: `deploy ${"d".repeat(3000)}`,
      evidence: Array.from({ length: 20 }, (_, k) => `evidence ${k} ${"e".repeat(5000)}`),
      status: "active",
    }));
  }
  fs.writeFileSync(path.join(home, "lessons.jsonl"), rows.join("\n") + "\n");
  return home;
}

// Sends requests, closes stdin, and only starts reading after a delay — a
// slow client. Resolves with the parsed response lines.
function exchange(home, requests, { readDelayMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [CLI, "mcp"], { env: { ...process.env, MURPHYS_HOME: home } });
    proc.stdout.pause();
    for (const request of requests) proc.stdin.write(typeof request === "string" ? request + "\n" : JSON.stringify(request) + "\n");
    proc.stdin.end();
    const chunks = [];
    setTimeout(() => {
      proc.stdout.on("data", (d) => chunks.push(d));
      proc.stdout.resume();
    }, readDelayMs);
    proc.on("error", reject);
    proc.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      } catch (error) {
        reject(new Error(`unparseable output (${text.length} bytes): ${error.message}`));
      }
    });
  });
}

test("stdin EOF never truncates output: every queued response arrives whole", async () => {
  const home = bigRegister();
  const requests = Array.from({ length: 6 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "lessons_query", arguments: { query: "deploy", limit: 20 } } }));
  const lines = await exchange(home, requests);
  assert.deepEqual(lines.map((l) => l.id), [1, 2, 3, 4, 5, 6], "all six responses, in order, each parseable");
});

test("query responses are capped with explicit markers", async () => {
  const home = bigRegister();
  const [response] = await exchange(home, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lessons_query", arguments: { query: "deploy", limit: 20 } } }], { readDelayMs: 0 });
  const text = response.result.content[0].text;
  assert.ok(text.length <= 60000, `response text is ${text.length} chars`);
  const body = JSON.parse(text);
  assert.equal(body.truncated, true);
  assert.ok(body.omitted > 0 && body.count + body.omitted === 20, "omitted lessons are counted, not silently dropped");
  assert.match(body.note, /omitted/);
  const lesson = body.lessons[0];
  assert.ok(lesson.title.endsWith("…[truncated]") && lesson.title.length < 400);
  assert.ok(lesson.description.endsWith("…[truncated]"));
  assert.equal(lesson.evidence.length, 9, "8 entries plus an explicit omission marker");
  assert.match(lesson.evidence.at(-1), /12 more evidence entries omitted/);
  for (const entry of lesson.evidence.slice(0, 8)) assert.ok(entry.length <= 320 && entry.endsWith("…[truncated]"));
});

test("other tools' responses are capped too (candidate echo)", async () => {
  const home = freshHome();
  const [response] = await exchange(home, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lessons_candidate", arguments: { dryRun: true, lessons: [{ title: "x".repeat(10000), description: "y".repeat(10000) }] } } }], { readDelayMs: 0 });
  const body = JSON.parse(response.result.content[0].text);
  assert.ok(body.candidates[0].title.length < 2100 && body.candidates[0].title.endsWith("…[truncated]"));
});
