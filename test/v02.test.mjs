// v0.2 features: npx-mountable MCP subcommand, outcome analytics, and the
// optional embedding retriever (hybrid ranking, fail-open, cached).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");

// Every temp home this file creates is removed after the last test.
const TEMP_DIRS = [];
function freshHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

// Async CLI runner. execFileSync blocks this process's event loop — and the
// fake embeddings endpoint lives in THIS process, so a sync child would
// deadlock: its fetch waits on a server that can't respond until the child
// exits. (Found the hard way; the abort-after-exactly-timeout signature is
// the tell.)
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    execFile("node", [CLI, ...args], { env, encoding: "utf8" }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });
}

function seedRegister(home, lessons) {
  fs.writeFileSync(path.join(home, "lessons.jsonl"), lessons.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("mcp subcommand hosts the stdio server (initialize + tools/list)", async () => {
  const home = freshHome("murphys-v02mcp-");
  const proc = spawn("node", [CLI, "mcp"], { env: { ...process.env, MURPHYS_HOME: home } });
  const out = [];
  proc.stdout.on("data", (d) => out.push(d));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  proc.stdin.end();
  await new Promise((resolve) => proc.on("exit", resolve));
  const lines = Buffer.concat(out).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const init = lines.find((l) => l.id === 1);
  const list = lines.find((l) => l.id === 2);
  assert.equal(init.result.serverInfo.name, "murphys-law");
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["lessons_apply", "lessons_candidate", "lessons_query", "lessons_supersede"]);
});

test("stats rolls up apply outcomes; --by-lesson joins injections per lesson", () => {
  const home = freshHome("murphys-v02stats-");
  seedRegister(home, [
    { id: "llg-goodlesson1", title: "Good lesson", description: "Works when applied.", status: "active" },
    { id: "llg-otherlesson", title: "Other lesson", description: "Rarely used.", status: "active" },
  ]);
  const usage = [
    { id: "use-1", lessonIds: ["llg-goodlesson1"], outcome: "worked" },
    { id: "use-2", lessonIds: ["llg-goodlesson1"], outcome: "worked" },
    { id: "use-3", lessonIds: ["llg-goodlesson1", "llg-otherlesson"], outcome: "failed" },
    { id: "use-4", lessonIds: ["llg-otherlesson"] },
  ];
  fs.writeFileSync(path.join(home, "usage.jsonl"), usage.map((u) => JSON.stringify(u)).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "injections.jsonl"),
    JSON.stringify({ id: "inj-1", lessons: [{ id: "llg-goodlesson1", rank: 1 }] }) + "\n" +
    JSON.stringify({ id: "inj-2", lessons: [{ id: "llg-goodlesson1", rank: 1 }, { id: "llg-otherlesson", rank: 2 }] }) + "\n");
  const env = { ...process.env, MURPHYS_HOME: home };
  const stats = JSON.parse(execFileSync("node", [CLI, "stats", "--by-lesson"], { env, encoding: "utf8" }));
  assert.deepEqual(stats.outcomes, { applies: 4, worked: 2, partial: 0, failed: 1, unknown: 0, unspecified: 1 });
  const good = stats.byLesson.find((l) => l.id === "llg-goodlesson1");
  assert.equal(good.title, "Good lesson");
  assert.equal(good.applies, 3);
  assert.equal(good.worked, 2);
  assert.equal(good.failed, 1);
  assert.equal(good.injections, 2);
  const other = stats.byLesson.find((l) => l.id === "llg-otherlesson");
  assert.equal(other.applies, 2);
  assert.equal(other.unspecified, 1);
  assert.equal(other.injections, 1);
});

test("doctor flags an active lesson that keeps failing; healthy lessons stay quiet", () => {
  const home = freshHome("murphys-v02doc-");
  seedRegister(home, [
    { id: "llg-failing0001", title: "Stale guidance", description: "Keeps failing when applied.", status: "active" },
    { id: "llg-healthy0001", title: "Healthy lesson", description: "Mostly works.", status: "active" },
  ]);
  const usage = [
    { id: "u1", lessonIds: ["llg-failing0001"], outcome: "failed" },
    { id: "u2", lessonIds: ["llg-failing0001"], outcome: "failed" },
    { id: "u3", lessonIds: ["llg-failing0001"], outcome: "worked" },
    { id: "u4", lessonIds: ["llg-healthy0001"], outcome: "failed" },
    { id: "u5", lessonIds: ["llg-healthy0001"], outcome: "worked" },
    { id: "u6", lessonIds: ["llg-healthy0001"], outcome: "worked" },
  ];
  fs.writeFileSync(path.join(home, "usage.jsonl"), usage.map((u) => JSON.stringify(u)).join("\n") + "\n");
  const env = { ...process.env, MURPHYS_HOME: home, HOME: home };
  let code = 0;
  let raw = "";
  try {
    raw = execFileSync("node", [CLI, "doctor"], { env, encoding: "utf8" });
  } catch (err) {
    code = err.status;
    raw = err.stdout;
  }
  assert.equal(code, 1, "a persistently failing lesson is a doctor issue");
  const doctor = JSON.parse(raw);
  assert.ok(doctor.issues.some((i) => i.includes("llg-failing0001") && i.includes("supersession")));
  assert.ok(!doctor.issues.some((i) => i.includes("llg-healthy0001")), "healthy lessons must not be flagged");
});

// ---------------------------------------------------------------------------
// Embedding retriever — against a local fake OpenAI-compatible endpoint.
// ---------------------------------------------------------------------------

function startFakeEmbeddings(vectorForOverride) {
  // Paraphrase pair maps to near-identical vectors; everything else is far.
  const vectorFor = vectorForOverride || ((text) => {
    const t = String(text).toLowerCase();
    if (t.includes("live in production") || t.includes("actually shipped")) return [0.99, 0.05, 0.0];
    if (t.includes("unrelated")) return [0.0, 0.05, 0.99];
    return [0.1, 0.95, 0.1];
  });
  const state = { requests: 0, embedded: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      state.requests += 1;
      const parsed = JSON.parse(body);
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      state.embedded += inputs.length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

const PARAPHRASE_HOME = freshHome("murphys-v02emb-");
seedRegister(PARAPHRASE_HOME, [
  { id: "llg-target00001", title: "Confirm the fix is live in production", description: "A change is not done until it is verified live in production, not just merged.", status: "active", tags: ["ops"] },
  { id: "llg-decoy000001", title: "Deployment checklist hygiene", description: "Keep the deployment verify checklist versioned and reviewed.", status: "active", tags: ["ops"] },
  { id: "llg-noise000001", title: "Unrelated database tuning", description: "Completely unrelated indexing guidance.", status: "active", tags: ["db"] },
]);
// Paraphrase with near-zero useful lexical overlap with the target
// ("verify"/"deployment" appear in the DECOY, steering lexical the wrong way).
const PARAPHRASE = "verify the deployment actually shipped";

test("hybrid retrieval re-ranks a paraphrase the lexical scorer gets wrong", async () => {
  const { server, port } = await startFakeEmbeddings();
  try {
    const env = { ...process.env, MURPHYS_HOME: PARAPHRASE_HOME };
    const lexical = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(lexical.retriever, "lexical");
    assert.notEqual(lexical.lessons[0]?.id, "llg-target00001", "sanity: lexical alone must NOT already rank the paraphrase target first");
    const hybridEnv = { ...env, MURPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`, MURPHYS_EMBEDDINGS_MODEL: "fake-model" };
    const hybrid = JSON.parse(await runCli(["query", PARAPHRASE], hybridEnv));
    assert.equal(hybrid.retriever, "hybrid");
    assert.equal(hybrid.lessons[0].id, "llg-target00001", "embedding similarity must lift the true paraphrase to rank 1");
  } finally {
    server.close();
  }
});

test("lesson vectors are cached: a repeat query re-embeds only the query text", async () => {
  const { server, state, port } = await startFakeEmbeddings();
  try {
    const env = {
      ...process.env,
      MURPHYS_HOME: PARAPHRASE_HOME,
      MURPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`,
      MURPHYS_EMBEDDINGS_MODEL: "fake-cache-model",
    };
    JSON.parse(await runCli(["query", PARAPHRASE], env));
    const afterFirst = state.embedded;
    assert.ok(afterFirst >= 4, "first run embeds the query and the register");
    const second = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(second.retriever, "hybrid");
    assert.equal(state.embedded, afterFirst + 1, "second run embeds the query only; every lesson vector comes from the cache");
  } finally {
    server.close();
  }
});

test("embedding backend failure is fail-open: lexical results, no error", () => {
  const env = {
    ...process.env,
    MURPHYS_HOME: PARAPHRASE_HOME,
    MURPHYS_EMBEDDINGS_URL: "http://127.0.0.1:1/v1/embeddings", // nothing listens here
    MURPHYS_EMBEDDINGS_MODEL: "fake-model",
    MURPHYS_EMBEDDINGS_TIMEOUT_MS: "600",
  };
  const result = JSON.parse(execFileSync("node", [CLI, "query", "deployment verify checklist"], { env, encoding: "utf8" }));
  assert.equal(result.retriever, "lexical", "a dead backend must degrade to lexical, never to an error");
  assert.ok(result.count >= 1, "lexical results still flow");
});

// ---------------------------------------------------------------------------
// v0.2 review round: trust-the-input fixes at the new boundaries.
// ---------------------------------------------------------------------------

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    execFile("node", ["-e", script], { env, encoding: "utf8" }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });
}

test("apply dedupes repeated lesson ids: one event counts once, doctor stays quiet", async () => {
  const home = freshHome("murphys-r1apply-");
  seedRegister(home, [{ id: "llg-dupapply001", title: "Dup apply lesson", description: "Applied once with a stuttered id.", status: "active" }]);
  const env = { ...process.env, MURPHYS_HOME: home, HOME: home };
  await runNode(`
    const core = require(${JSON.stringify(path.join(HERE, "..", "lib", "register.cjs"))});
    core.callTool("lessons_apply", { lessonIds: ["llg-dupapply001", "llg-dupapply001"], task: "t", outcome: "failed" }).then(() => process.exit(0));
  `, env);
  const stats = JSON.parse(execFileSync("node", [CLI, "stats", "--by-lesson"], { env, encoding: "utf8" }));
  const row = stats.byLesson.find((l) => l.id === "llg-dupapply001");
  assert.equal(row.applies, 1, "a stuttered id in one apply event counts once");
  assert.equal(row.failed, 1);
  const doctorOut = JSON.parse(execFileSync("node", [CLI, "doctor"], { env, encoding: "utf8" }));
  assert.equal(doctorOut.ok, true, "a single real failed event must not trip the supersession flag");
});

test("garbage vectors fail the hybrid pass open and are never cached", async () => {
  // Reviewer's probe: a wrong-length vector mixed in with real ones. The old
  // Math.min truncation scored it cosine 1.0; batch dimension-consistency
  // now fails the whole pass open. (A backend returning uniformly
  // degenerate-but-consistent vectors is indistinguishable in shape from a
  // bad model — correctness guards shape, model quality is the operator's
  // choice.)
  const { server, port } = await startFakeEmbeddings((text) => (String(text).includes("shipped") ? [999] : [0.1, 0.95, 0.1]));
  try {
    const home = freshHome("murphys-r1vec-");
    seedRegister(home, [
      { id: "llg-veclesson01", title: "Confirm the fix is live in production", description: "verified live in production", status: "active" },
      { id: "llg-veclesson02", title: "Deployment checklist hygiene", description: "deployment verify checklist", status: "active" },
    ]);
    const env = { ...process.env, MURPHYS_HOME: home, MURPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`, MURPHYS_EMBEDDINGS_MODEL: "bad-model" };
    const result = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(result.retriever, "lexical", "a 1-dim garbage vector must not score as similarity 1.0 — the pass fails open");
    assert.ok(!fs.existsSync(path.join(home, "embeddings-cache.jsonl")), "invalid vectors must never enter the cache");
  } finally {
    server.close();
  }
});

test("NaN and empty vectors also fail open", async () => {
  for (const bad of [[NaN, 0, 0], []]) {
    const { server, port } = await startFakeEmbeddings(() => bad);
    try {
      const home = freshHome("murphys-r1nan-");
      seedRegister(home, [{ id: "llg-nanlesson01", title: "Confirm the fix is live in production", description: "verified live in production", status: "active" }]);
      const env = { ...process.env, MURPHYS_HOME: home, MURPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`, MURPHYS_EMBEDDINGS_MODEL: "bad-model" };
      const result = JSON.parse(await runCli(["query", PARAPHRASE], env));
      assert.equal(result.retriever, "lexical");
    } finally {
      server.close();
    }
  }
});

test("a poisoned cache row is treated as missing and re-fetched, not served", async () => {
  const { server, state, port } = await startFakeEmbeddings();
  try {
    const home = freshHome("murphys-r1heal-");
    seedRegister(home, [{ id: "llg-heallesson1", title: "Confirm the fix is live in production", description: "verified live in production", status: "active", tags: ["ops"] }]);
    // Poison the cached vector for the LESSON under this endpoint, model and
    // dimension before any run (query vectors are never persisted).
    const crypto = await import("node:crypto");
    const url = `http://127.0.0.1:${port}/v1/embeddings`;
    const lessonText = "Confirm the fix is live in production\nverified live in production\nops";
    const key = crypto.createHash("sha256").update(JSON.stringify([url, "heal-model", 3, lessonText])).digest("hex");
    fs.writeFileSync(path.join(home, "embeddings-cache.jsonl"), JSON.stringify({ k: key, v: [null, "x", 1] }) + "\n");
    const env = { ...process.env, MURPHYS_HOME: home, MURPHYS_EMBEDDINGS_URL: url, MURPHYS_EMBEDDINGS_MODEL: "heal-model" };
    const result = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(result.retriever, "hybrid", "the poisoned row heals via re-fetch instead of failing the pass");
    assert.ok(state.embedded >= 2, "query and lesson were re-embedded despite the cache file existing");
  } finally {
    server.close();
  }
});

test("credentials in the endpoint URL never reach the query log", async () => {
  const home = freshHome("murphys-r1cred-");
  seedRegister(home, [{ id: "llg-credlesson1", title: "Confirm the fix is live in production", description: "verified live in production", status: "active" }]);
  const env = {
    ...process.env,
    MURPHYS_HOME: home,
    MURPHYS_EMBEDDINGS_URL: "http://markeruser:markerpass2026@127.0.0.1:1/v1/embeddings",
    MURPHYS_EMBEDDINGS_MODEL: "cred-model",
    MURPHYS_EMBEDDINGS_TIMEOUT_MS: "600",
  };
  const result = JSON.parse(await runCli(["query", PARAPHRASE], env));
  assert.equal(result.retriever, "lexical");
  const log = fs.readFileSync(path.join(home, "queries.jsonl"), "utf8");
  assert.ok(!log.includes("markerpass2026"), "URL userinfo must be stripped from persisted error text");
  const row = JSON.parse(log.trim().split("\n").pop());
  assert.ok(row.embeddingsError, "the failure itself is still recorded (sanitized)");
});

test("malformed JSON lines get a spec-compliant -32700, valid requests still answered", async () => {
  const home = freshHome("murphys-r1parse-");
  const proc = spawn("node", [CLI, "mcp"], { env: { ...process.env, MURPHYS_HOME: home } });
  const out = [];
  proc.stdout.on("data", (d) => out.push(d));
  proc.stdin.write("this is not json\n");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n");
  proc.stdin.end();
  await new Promise((resolve) => proc.on("exit", resolve));
  const lines = Buffer.concat(out).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const parseError = lines.find((l) => l.error && l.error.code === -32700);
  assert.ok(parseError, "malformed input answers with -32700");
  assert.equal(parseError.id, null);
  assert.ok(lines.find((l) => l.id === 7 && l.result), "valid requests after garbage still answered");
});

// ---------------------------------------------------------------------------
// Round 2: validate what you transformed; persist what you constructed.
// ---------------------------------------------------------------------------

test("round 2: a vector that overflows during cache quantization fails open and is never cached", async () => {
  // 1e308 is finite at fetch-time validation; quantization (x*1e5) overflows
  // it to Infinity — the transformed vector must be re-validated.
  const { server, port } = await startFakeEmbeddings(() => [1e308, 0.5, 0.5]);
  try {
    const home = freshHome("murphys-r2quant-");
    seedRegister(home, [{ id: "llg-quantlesson", title: "Confirm the fix is live in production", description: "verified live in production", status: "active" }]);
    const env = { ...process.env, MURPHYS_HOME: home, MURPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`, MURPHYS_EMBEDDINGS_MODEL: "quant-model" };
    const result = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(result.retriever, "lexical", "post-quantization Infinity must fail the pass open");
    assert.ok(!fs.existsSync(path.join(home, "embeddings-cache.jsonl")), "the overflowed vector must never be cached");
  } finally {
    server.close();
  }
});

test("round 2: persisted embeddings errors are constructed categories, never exception text", async () => {
  const cases = [
    { url: "mailto:secretmarkerA@example.com", markers: ["secretmarkerA"] },
    { url: "http://127.0.0.1:1/v1/e?key=marker%2DsecretB", markers: ["marker%2DsecretB", "secretB"] },
  ];
  const categories = new Set(["timeout", "bad-response", "invalid-vector", "dimension-mismatch", "backend-error", "connect-failure"]);
  for (const c of cases) {
    const home = freshHome("murphys-r2cat-");
    seedRegister(home, [{ id: "llg-catlesson01", title: "Confirm the fix is live in production", description: "verified live in production", status: "active" }]);
    const env = { ...process.env, MURPHYS_HOME: home, MURPHYS_EMBEDDINGS_URL: c.url, MURPHYS_EMBEDDINGS_MODEL: "cat-model", MURPHYS_EMBEDDINGS_TIMEOUT_MS: "600" };
    const result = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(result.retriever, "lexical");
    const log = fs.readFileSync(path.join(home, "queries.jsonl"), "utf8");
    for (const marker of c.markers) assert.ok(!log.includes(marker), `marker ${marker} must never persist`);
    const row = JSON.parse(log.trim().split("\n").pop());
    assert.ok(categories.has(row.embeddingsError) || String(row.embeddingsError).startsWith("embeddings endpoint HTTP "), `persisted value must be a constructed category, got: ${row.embeddingsError}`);
  }
});

test("round 2: non-string lesson ids are dropped at the apply boundary, never coerced", async () => {
  const home = freshHome("murphys-r2coerce-");
  const env = { ...process.env, MURPHYS_HOME: home };
  const out = await runNode(`
    const core = require(${JSON.stringify(path.join(HERE, "..", "lib", "register.cjs"))});
    core.callTool("lessons_apply", { lessonIds: [1, "llg-realid0001", null, "llg-realid0001"], task: "t", dryRun: true }).then((r) => { console.log(JSON.stringify(r.entry.lessonIds)); process.exit(0); });
  `, env);
  assert.deepEqual(JSON.parse(out.trim()), ["llg-realid0001"], "numeric 1 dropped (not stringified), null dropped, dup deduped");
});
