// Embedding cache: keyed by endpoint + model + dimension, lesson vectors only
// (query vectors are never persisted), backend result order honored by index.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-emb-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

// The fake endpoint lives in this process, so the CLI must run async.
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    execFile("node", [CLI, ...args], { env, encoding: "utf8" }, (error, stdout) => (error && !stdout ? reject(error) : resolve(JSON.parse(stdout))));
  });
}

function vectorFor(text, dims) {
  const t = String(text).toLowerCase();
  const base = t.includes("live in production") || t.includes("actually shipped") ? [0.99, 0.05, 0.0]
    : t.includes("unrelated") ? [0.0, 0.05, 0.99]
      : [0.1, 0.95, 0.1];
  return Array.from({ length: dims }, (_, i) => base[i % 3] + (i >= 3 ? 0.01 : 0));
}

function fakeEndpoint({ dims = 3, reverse = false } = {}) {
  const state = { requests: 0, embedded: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      state.requests += 1;
      const inputs = [].concat(JSON.parse(body).input);
      state.embedded += inputs.length;
      let data = inputs.map((text, index) => ({ index, embedding: vectorFor(text, dims) }));
      if (reverse) data = data.reverse(); // allowed by the API: order is given by `index`
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/v1/embeddings` })));
}

function seededHome() {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "lessons.jsonl"), [
    { id: "llg-target00001", title: "Confirm the fix is live in production", description: "A change is not done until it is verified live in production.", status: "active" },
    { id: "llg-decoy000001", title: "Deployment checklist hygiene", description: "Keep the deployment verify checklist versioned and reviewed.", status: "active" },
    { id: "llg-noise000001", title: "Unrelated database tuning", description: "Completely unrelated indexing guidance.", status: "active" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return home;
}

const cacheRows = (home) => fs.readFileSync(path.join(home, "embeddings-cache.jsonl"), "utf8").split("\n").filter(Boolean).length;
const envFor = (home, url, model = "fake-model") => ({ ...process.env, MURPHYS_HOME: home, MURPHYS_EMBEDDINGS_URL: url, MURPHYS_EMBEDDINGS_MODEL: model });

test("distinct queries never grow the cache: only lesson vectors persist", async () => {
  const { server, url } = await fakeEndpoint();
  try {
    const home = seededHome();
    for (const q of ["verify the deployment actually shipped", "deployment checklist", "database indexing", "live in production"]) {
      assert.equal((await runCli(["query", q], envFor(home, url))).retriever, "hybrid");
    }
    assert.equal(cacheRows(home), 3, "three lessons, three cached vectors — queries are not persisted");
  } finally {
    server.close();
  }
});

test("a backend whose dimension changes re-embeds instead of failing open forever", async () => {
  const home = seededHome();
  const first = await fakeEndpoint({ dims: 3 });
  try {
    assert.equal((await runCli(["query", "verify the deployment actually shipped"], envFor(home, first.url))).retriever, "hybrid");
  } finally {
    first.server.close();
  }
  const second = await fakeEndpoint({ dims: 4 });
  try {
    // Same endpoint URL shape, same model name, new vector size.
    const env = envFor(home, first.url.replace(/:\d+\//, `:${new URL(second.url).port}/`));
    const result = await runCli(["query", "confirm the release actually shipped"], env);
    assert.equal(result.retriever, "hybrid", "the stale 3-dim lesson vectors are not served to a 4-dim query");
    assert.equal(result.lessons[0].id, "llg-target00001");
  } finally {
    second.server.close();
  }
});

test("switching endpoints does not reuse another endpoint's vectors", async () => {
  const home = seededHome();
  const a = await fakeEndpoint();
  try {
    await runCli(["query", "deployment checklist"], envFor(home, a.url));
  } finally {
    a.server.close();
  }
  const b = await fakeEndpoint();
  try {
    await runCli(["query", "deployment checklist"], envFor(home, b.url));
    assert.equal(b.state.embedded, 4, "query + all three lessons re-embedded against the new endpoint");
  } finally {
    b.server.close();
  }
});

test("data[].index decides which vector belongs to which input", async () => {
  const { server, url } = await fakeEndpoint({ reverse: true });
  try {
    const home = seededHome();
    const result = await runCli(["query", "verify the deployment actually shipped"], envFor(home, url));
    assert.equal(result.retriever, "hybrid");
    assert.equal(result.lessons[0].id, "llg-target00001", "vectors are matched to inputs by index, not by position");
  } finally {
    server.close();
  }
});
