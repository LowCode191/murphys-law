#!/usr/bin/env node
// murphys-law — lessons register core + MCP stdio server.
//
// A lessons register is an append-only JSONL file of operational lessons
// ("what burned us and what to do instead"), plus four small tools:
//
//   lessons_query      search the register (lexical scorer, telemetry-logged)
//   lessons_apply      declare that lessons influenced a task (+ outcome)
//   lessons_candidate  submit a new lesson for curation
//   lessons_supersede  retire or re-point lessons by judgment (curator-only;
//                      never deletes)
//
// Run `node lib/register.cjs` to serve these over MCP stdio, or use the
// exported functions directly (the CLI in bin/muphys.mjs — installed as
// `murphys` — does).
//
// Design invariants, learned the hard way (see eval/PROTOCOL.md):
//   - Every record carries an explicit `id` at write time. Synthesized,
//     position-dependent ids break every downstream reference the first time
//     someone deduplicates the file.
//   - Records are never deleted. Retirement is a status (`superseded` /
//     `deprecated`) with a pointer to the replacement; queries filter it.
//   - Every query is logged server-side (query, returned ids, ranks, scores,
//     caller). Retrieval you can't observe is retrieval you can't improve.
//   - Failure mode of telemetry is silence, so telemetry writes never throw.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Configuration. Releases up to 0.2 shipped as "muphys-law" with MUPHYS_*
// variables and a ~/.muphys home. Current names win; the legacy ones are
// read as fallbacks, so an upgrade never silently starts from an empty
// register (the hook is fail-open, so an empty register looks healthy).
// Nothing is ever moved or deleted.
// ---------------------------------------------------------------------------
const legacyEnvUsed = new Set();
function envValue(name) {
  const current = process.env[`MURPHYS_${name}`];
  if (current !== undefined && current !== "") return current;
  const legacy = process.env[`MUPHYS_${name}`];
  if (legacy !== undefined && legacy !== "") {
    legacyEnvUsed.add(name);
    return legacy;
  }
  return undefined;
}

function resolveHome() {
  const explicit = envValue("HOME");
  if (explicit) return { home: path.resolve(explicit), legacy: legacyEnvUsed.has("HOME") ? "env" : null };
  const current = path.join(os.homedir(), ".murphys");
  const legacyDir = path.join(os.homedir(), ".muphys");
  // The current home wins once it holds a register. A 0.3 install could
  // create an empty ~/.murphys just by logging a query, so "directory
  // exists" is not the test — "has lessons" is.
  try {
    if (!fs.existsSync(path.join(current, "lessons.jsonl")) && fs.existsSync(path.join(legacyDir, "lessons.jsonl"))) {
      return { home: legacyDir, legacy: "dir" };
    }
  } catch { /* unreadable: fall through to the default */ }
  return { home: current, legacy: null };
}

// Paths — everything lives under MURPHYS_HOME (default ~/.murphys), individually
// overridable for embedding into an existing data layout.
const HOME_RESOLUTION = resolveHome();
const MURPHYS_HOME = HOME_RESOLUTION.home;
const LEGACY_HOME = Boolean(HOME_RESOLUTION.legacy);
const p = (name, fallback) => path.resolve(envValue(name) || path.join(MURPHYS_HOME, fallback));
const REGISTER_JSONL = p("REGISTER", "lessons.jsonl");
const USAGE_JSONL = p("USAGE_LOG", "usage.jsonl");
const CANDIDATES_JSONL = p("CANDIDATES", "candidates.jsonl");
const QUERIES_JSONL = p("QUERY_LOG", "queries.jsonl");
const PROJECTS_JSON = p("PROJECTS", "projects.json");
const INJECTIONS_JSONL = p("INJECTION_LOG", "injections.jsonl");

// One-time (per data home) stderr notice for upgraders, printed by the CLI
// and the MCP server — never by the hook, whose output channel is the
// prompt. A marker file in the home records that it was shown.
function migrationNotice() {
  const parts = [];
  if (HOME_RESOLUTION.legacy === "dir") {
    parts.push(`using the pre-0.3 data home ${MURPHYS_HOME} because ~/.murphys holds no register. Nothing was moved; rename the directory to ~/.murphys (or set MURPHYS_HOME) when convenient.`);
  }
  if (legacyEnvUsed.size) {
    parts.push(`legacy environment variable(s) ${[...legacyEnvUsed].sort().map((name) => `MUPHYS_${name}`).join(", ")} in use; rename them to MURPHYS_*.`);
  }
  return parts.length ? parts.join(" ") : null;
}

function printMigrationNoticeOnce() {
  const notice = migrationNotice();
  if (!notice) return;
  const marker = path.join(MURPHYS_HOME, ".murphys-migration-notice");
  try {
    if (fs.existsSync(marker)) return;
    process.stderr.write(`murphys: ${notice}\n`);
    fs.writeFileSync(marker, `${new Date().toISOString()} ${notice}\n`, { flag: "wx", mode: 0o600 });
  } catch { /* a notice must never break a command */ }
}

const APPLY_OUTCOMES = new Set(["worked", "partial", "failed", "unknown"]);
const MAX_TEXT_CHARS = 240000;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function ensureSafeText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > MAX_TEXT_CHARS) throw new Error(`${field} exceeds ${MAX_TEXT_CHARS} characters`);
  return value.replace(/\r\n/g, "\n");
}

function safeSlug(value, fallback = "x") {
  const slug = String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return slug || fallback;
}

function assertDate(value, field = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  return value;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// JSONL I/O. Every file this package appends to is JSONL, and every one of
// them may also be touched by an editor, another tool, or a crash mid-write.
// ---------------------------------------------------------------------------
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Readers strip a leading UTF-8 BOM (Windows editors add one): JSON.parse
// rejects it, which used to make the first row of a file silently vanish.
function readText(filePath) {
  return stripBom(fs.readFileSync(filePath, "utf8"));
}

function endsWithNewline(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

// A file whose last byte is not "\n" (an editor that strips the final
// newline, a crash mid-append) would fuse its last row and ours into one
// unparseable line, and both would silently disappear from every reader.
// Prefixing "\n" is always safe: readers skip blank lines.
function appendLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  const body = line.endsWith("\n") ? line : line + "\n";
  fs.appendFileSync(filePath, (endsWithNewline(filePath) ? "" : "\n") + body, { mode: 0o600 });
}

// One entry per physical line, blank lines included (rewrites preserve the
// file's layout and legacy synthesized ids depend on line positions). Only
// JSON objects are records; anything else is `invalid`, kept on disk, skipped
// by readers, and counted by `murphys doctor`.
function parseJsonlLines(text) {
  return text.split("\n").map((line, index) => {
    const content = stripBom(line).trim();
    if (!content) return { index, line, blank: true, invalid: false, record: null };
    let record;
    try {
      record = JSON.parse(content);
    } catch {
      return { index, line, blank: false, invalid: true, record: null };
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return { index, line, blank: false, invalid: true, record: null };
    }
    return { index, line, blank: false, invalid: false, record };
  });
}

function readJsonlRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseJsonlLines(readText(filePath)).filter((entry) => entry.record).map((entry) => entry.record);
}

// Numeric settings fail SAFE: an unparseable value falls back to the
// default with a one-line warning. (Number("abc") is NaN, and every
// `score < NaN` comparison is false — a typo used to disable the hook's
// relevance gates entirely.)
const warnedEnv = new Set();
function numberEnv(name, fallback, { min = 0, integer = false } = {}) {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min && (!integer || Number.isInteger(value))) return value;
  if (!warnedEnv.has(name)) {
    warnedEnv.add(name);
    try { process.stderr.write(`murphys: ignoring MURPHYS_${name}=${JSON.stringify(raw)} (expected ${integer ? "an integer" : "a number"} >= ${min}); using ${fallback}\n`); } catch { /* never fatal */ }
  }
  return fallback;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Register write lock. EVERY register writer (add, sync, supersede, dedupe
// --apply, review) takes it; readers never do. A rewrite that ran unlocked
// used to rename a stale snapshot over appends that landed after its read —
// acknowledged lessons silently vanished.
//
// Protocol: O_EXCL create is the front door; a lock naming a LIVE holder is
// never touched. A dead lock is reaped by RENAME-CLAIM: rename it to a
// private tombstone (one winner per inode — a losing reaper gets ENOENT and
// can no longer delete anything it didn't judge), re-judge the CLAIMED
// content, and if it turns out live (we yanked a fresh lock inside the
// read-judge gap) restore it with a no-clobber link. Release removes the
// lock only when it provably carries this acquisition's token. POSIX offers
// no compare-and-swap on paths, so a residual window remains; the reader's
// duplicate-id collapse and the post-rename reap in rewriteRegister keep a
// lost race from losing data.
// ---------------------------------------------------------------------------
const REGISTER_LOCK = path.join(path.dirname(REGISTER_JSONL), `.${path.basename(REGISTER_JSONL)}.lock`);
const LOCK_WAIT_MS = numberEnv("LOCK_WAIT_MS", 15000, { integer: true });
// Every critical section is milliseconds long, so a lock older than this is
// stale even if its pid is alive — after a crash the pid can be reused by
// an unrelated long-lived process, which used to block sync forever.
const LOCK_STALE_MS = numberEnv("LOCK_STALE_MS", 10 * 60 * 1000, { integer: true });
const LOCK_UNWRITTEN_GRACE_MS = 2000; // an empty lock this young is a creator mid-write

let heldLockToken = null;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists, owned by another user: alive
  }
}

function judgeLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "live"; // unreadable for other reasons: never touch it
  }
  let holder = null;
  try { holder = JSON.parse(raw); } catch { /* empty or torn */ }
  if (!holder || typeof holder !== "object") {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_UNWRITTEN_GRACE_MS ? "live" : "dead";
    } catch {
      return "missing";
    }
  }
  const age = Date.now() - Date.parse(holder.ts);
  if (!Number.isFinite(age) || age > LOCK_STALE_MS) return "dead";
  const pid = Number(holder.pid);
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? "live" : "dead";
}

function tryCreateLock(token) {
  ensureDir(path.dirname(REGISTER_LOCK));
  try {
    fs.writeFileSync(REGISTER_LOCK, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

function reapDeadLock() {
  const tomb = `${REGISTER_LOCK}.reap.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(REGISTER_LOCK, tomb); // claim: exactly one reaper wins this inode
  } catch {
    return false; // another reaper claimed it first; contend fresh
  }
  if (judgeLock(tomb) === "live") {
    // We yanked a FRESH lock created inside our read-judge gap. Restore it
    // without clobbering any newer lock.
    try { fs.linkSync(tomb, REGISTER_LOCK); } catch { /* a newer lock exists */ }
  }
  try { fs.rmSync(tomb, { force: true }); } catch { /* best effort */ }
  return true;
}

function acquireRegisterLock(waitMs) {
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  let pause = 2;
  for (;;) {
    if (tryCreateLock(token)) return token;
    const state = judgeLock(REGISTER_LOCK);
    if (state === "missing") continue;
    if (state === "dead" && reapDeadLock()) continue;
    if (Date.now() >= deadline) return null;
    sleepSync(pause);
    pause = Math.min(pause * 2, 50);
  }
}

function releaseRegisterLock(token) {
  try {
    if (JSON.parse(fs.readFileSync(REGISTER_LOCK, "utf8")).token === token) fs.rmSync(REGISTER_LOCK, { force: true });
  } catch { /* not provably ours — leave it; a dead lock is reaped by the next writer */ }
}

// Runs `fn` (synchronous) holding the register lock. Re-entrant within one
// call stack. `wait: false` fails fast instead of waiting (sync uses it: a
// skipped sync is simply picked up by the next run).
function withRegisterLock(fn, { wait = true } = {}) {
  if (heldLockToken) return fn();
  const token = acquireRegisterLock(wait ? LOCK_WAIT_MS : 0);
  if (!token) {
    const error = new Error(`the register is locked by another writer (${REGISTER_LOCK}); retry shortly`);
    error.code = "EREGISTERLOCKED";
    throw error;
  }
  heldLockToken = token;
  try {
    return fn();
  } finally {
    heldLockToken = null;
    releaseRegisterLock(token);
  }
}

function readFdFrom(fd, offset) {
  const size = fs.fstatSync(fd).size;
  if (size <= offset) return Buffer.alloc(0);
  const buffer = Buffer.alloc(size - offset);
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

// After the rename our fd still points at the OLD inode. Anything a writer
// that ignores the lock (an older release, a script doing `>>`) appended to
// it after our read would be orphaned with that inode, so re-append it to
// the new file. Complete lines only, giving a writer caught mid-line a
// moment to finish. A writer still holding the old file open after this
// window can still lose its row — every writer in this package locks.
function reapOrphanedAppends(fd, consumed) {
  let idleRounds = 0;
  for (let round = 0; round < 40 && idleRounds < 2; round += 1) {
    const tail = readFdFrom(fd, consumed);
    if (!tail.length) {
      idleRounds += 1;
      sleepSync(1);
      continue;
    }
    idleRounds = 0;
    let end = tail.lastIndexOf(0x0a) + 1;
    if (end === 0) {
      if (round < 30) { sleepSync(2); continue; }
      end = tail.length;
    }
    appendLine(REGISTER_JSONL, tail.subarray(0, end).toString("utf8"));
    consumed += end;
  }
}

// Read-modify-write of the register; the caller must hold the register
// lock. `transform(text)` returns the new full text, or null for no change.
function rewriteRegister(transform) {
  if (!heldLockToken) throw new Error("rewriteRegister requires the register lock (use withRegisterLock)");
  let fd;
  try {
    fd = fs.openSync(REGISTER_JSONL, "r");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("the register is empty (no lessons file yet)");
    throw error;
  }
  try {
    const head = readFdFrom(fd, 0);
    const next = transform(stripBom(head.toString("utf8")));
    if (next === null || next === undefined) return false;
    // Rename onto the real path, so a symlinked register keeps its link.
    const target = fs.realpathSync(REGISTER_JSONL);
    let mode = 0o600;
    try { mode = fs.fstatSync(fd).mode & 0o777; } catch { /* keep default */ }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, next, { mode });
    fs.renameSync(tmp, target);
    reapOrphanedAppends(fd, head.length);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Register read + scoring (the scorer used in the published behavioral trial)
// ---------------------------------------------------------------------------
// Legacy rows without an id get a stable synthesized one — but every WRITER
// in this package stamps explicit ids, so this is read-side compatibility
// only. The "|" join is NOT delimiter-injectable between rows: the per-file
// line `index` is unique per row, so two rows can never share a basis.
function synthesizedId(record, index) {
  const basis = [record.author || "", record.timestamp || "", record.title || "", record.description || "", index].join("|");
  return `ll-${crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12)}`;
}

function readRegister() {
  if (!fs.existsSync(REGISTER_JSONL)) return [];
  const lessons = [];
  const seenIds = new Set();
  for (const entry of parseJsonlLines(readText(REGISTER_JSONL))) {
    // Blank and unparseable lines are skipped here and preserved on disk;
    // `murphys doctor` counts the unparseable ones and fails on them.
    if (!entry.record) continue;
    const parsed = entry.record;
    if (typeof parsed.id !== "string" || !parsed.id.trim()) parsed.id = synthesizedId(parsed, entry.index);
    // Duplicate-id lines collapse at READ time; first occurrence wins.
    // Concurrent syncs racing a stale lock can double-append a row
    // (POSIX gives no compare-and-swap on paths, so perfect file-lock
    // exclusion is not winnable — see the sync lock comment). Sync rows
    // are pure functions of source content — no wall clock in a durable
    // row — so the raced duplicate is byte-identical and this collapse
    // is a true no-op: correctness lives here, not in the lock.
    // Synthesized legacy ids embed the line index and cannot collide;
    // divergent same-id lines (true corruption) are surfaced by
    // `murphys doctor`.
    if (seenIds.has(parsed.id)) continue;
    seenIds.add(parsed.id);
    lessons.push(parsed);
  }
  return lessons;
}

function activeLessons() {
  return readRegister().filter((l) => l.status !== "superseded" && l.status !== "deprecated");
}

// Unicode-aware: NFKC folds canonical/compatibility variants (precomposed
// vs combining é, full-width letters), letters/numbers/marks of every script
// are kept, everything else separates words. The 0.3 normalizer kept only
// [a-z0-9], so non-Latin text normalized to nothing.
function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Optional embedding retrieval (v0.2). OFF unless BOTH env vars are set:
//   MURPHYS_EMBEDDINGS_URL    e.g. http://localhost:11434/v1/embeddings (Ollama)
//                            or https://api.openai.com/v1/embeddings
//   MURPHYS_EMBEDDINGS_MODEL  e.g. nomic-embed-text / text-embedding-3-small
//   MURPHYS_EMBEDDINGS_API_KEY   optional bearer token
//   MURPHYS_EMBEDDINGS_TIMEOUT_MS   default 4000
// Design constraints, in order: (1) zero dependencies — plain fetch to any
// OpenAI-compatible endpoint; (2) FAIL-OPEN — any error or timeout falls back
// to lexical ranks and records why in the query log, because retrieval must
// never make the register unavailable; (3) ranking is non-destructive, so a
// lossy similarity signal is allowed HERE — the byte-exact discipline guards
// deletion paths, not ranking. The hook stays lexical-only by design: the
// prompt path must never wait on a network call.
// Vectors cache to MURPHYS_HOME/embeddings-cache.jsonl keyed by a structural
// hash of [model, text] (no delimiter to inject), so the register is embedded
// once per model, not once per query.
const EMBEDDINGS_URL = envValue("EMBEDDINGS_URL") || "";
const EMBEDDINGS_MODEL = envValue("EMBEDDINGS_MODEL") || "";
const EMBEDDINGS_API_KEY = envValue("EMBEDDINGS_API_KEY") || "";
const EMBEDDINGS_TIMEOUT_MS = Math.max(500, numberEnv("EMBEDDINGS_TIMEOUT_MS", 4000));
const EMBEDDINGS_CACHE_JSONL = path.join(MURPHYS_HOME, "embeddings-cache.jsonl");
const EMBEDDINGS_MIN_COSINE = 0.3;   // below this, similarity contributes nothing
const EMBEDDINGS_WEIGHT = 20;        // max points cosine can add, comparable to lexical

function embeddingsEnabled() {
  return Boolean(EMBEDDINGS_URL && EMBEDDINGS_MODEL);
}

// Only LESSON vectors persist. Query vectors are fetched per query (and kept
// in a small in-process memo for a long-running MCP server): persisting
// them grew the cache file by one row per distinct query, forever.
let embeddingsCache = null;
let embeddingsCacheRows = 0;
function loadEmbeddingsCache() {
  if (embeddingsCache) return embeddingsCache;
  embeddingsCache = new Map();
  try {
    for (const row of readJsonlRecords(EMBEDDINGS_CACHE_JSONL)) {
      embeddingsCacheRows += 1;
      if (typeof row.k === "string" && validVector(row.v)) embeddingsCache.set(row.k, row.v);
    }
  } catch { /* no cache yet */ }
  return embeddingsCache;
}

// Keyed by endpoint + model + vector dimension + text: the same model name
// behind another endpoint, or a backend whose dimension changed, misses the
// cache and re-embeds instead of mixing vector spaces (a dimension change
// used to make every later query fail open to lexical until the cache file
// was deleted by hand).
function embeddingCacheKey(text, dims) {
  return crypto.createHash("sha256").update(JSON.stringify([EMBEDDINGS_URL, EMBEDDINGS_MODEL, dims, text])).digest("hex");
}

const queryVectorMemo = new Map();
const QUERY_MEMO_LIMIT = 64;

async function embedQuery(text) {
  const memoKey = JSON.stringify([EMBEDDINGS_URL, EMBEDDINGS_MODEL, text]);
  if (queryVectorMemo.has(memoKey)) return queryVectorMemo.get(memoKey);
  const [vector] = await fetchEmbeddings([text]);
  const quantized = quantize(vector);
  queryVectorMemo.set(memoKey, quantized);
  if (queryVectorMemo.size > QUERY_MEMO_LIMIT) queryVectorMemo.delete(queryVectorMemo.keys().next().value);
  return quantized;
}

function quantize(vector) {
  const quantized = vector.map((x) => Math.round(x * 1e5) / 1e5);
  // Validate the TRANSFORMED vector — the one that is actually ranked and
  // cached. Fetch-time validation alone verifies a premise the quantization
  // step can then break (1e308 rounds to Infinity).
  if (!validVector(quantized)) throw new Error("embeddings vector invalid after quantization");
  return quantized;
}

// Rewrite the cache with only live rows once dead ones (edited or retired
// lessons, other endpoints/models) dominate. Best effort: a concurrent
// appender can lose a row, which is simply re-embedded next time.
function compactEmbeddingsCache(liveKeys) {
  const cache = loadEmbeddingsCache();
  if (embeddingsCacheRows <= 2 * liveKeys.size + 64) return;
  try {
    const rows = [...liveKeys].filter((key) => cache.has(key)).map((key) => JSON.stringify({ k: key, v: cache.get(key) }));
    const tmp = `${EMBEDDINGS_CACHE_JSONL}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, rows.length ? rows.join("\n") + "\n" : "", { mode: 0o600 });
    fs.renameSync(tmp, EMBEDDINGS_CACHE_JSONL);
    embeddingsCacheRows = rows.length;
  } catch { /* cache only */ }
}

async function fetchEmbeddings(texts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDINGS_TIMEOUT_MS);
  try {
    const headers = { "content-type": "application/json" };
    if (EMBEDDINGS_API_KEY) headers.authorization = `Bearer ${EMBEDDINGS_API_KEY}`;
    const res = await fetch(EMBEDDINGS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: EMBEDDINGS_MODEL, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`embeddings endpoint HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("embeddings response shape mismatch");
    // The API identifies each vector by `index`; order in the array is not
    // a contract. Honor it when present (all-or-nothing), else array order.
    let ordered = body.data;
    if (body.data.some((d) => d && d.index !== undefined)) {
      ordered = new Array(texts.length);
      for (const d of body.data) {
        if (!d || !Number.isInteger(d.index) || d.index < 0 || d.index >= texts.length || ordered[d.index]) {
          throw new Error("embeddings response index invalid or duplicated");
        }
        ordered[d.index] = d;
      }
    }
    const vectors = ordered.map((d) => {
      if (!d || !validVector(d.embedding)) throw new Error("embeddings response vector invalid (empty or non-finite)");
      return d.embedding;
    });
    const dims = vectors[0].length;
    if (!vectors.every((v) => v.length === dims)) throw new Error("embeddings response vectors have inconsistent dimensions");
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

// Lesson vectors for the dimension the backend currently produces (taken
// from the freshly fetched query vector).
async function embedLessons(texts, dims) {
  const cache = loadEmbeddingsCache();
  const vectors = new Array(texts.length);
  const keys = texts.map((text) => embeddingCacheKey(text, dims));
  const missing = [];
  keys.forEach((key, i) => {
    const cached = cache.get(key);
    // A poisoned cache row (crash mid-append, historical bad write) is
    // treated as missing and re-fetched — the cache heals instead of
    // serving garbage forever.
    if (validVector(cached) && cached.length === dims) vectors[i] = cached;
    else missing.push(i);
  });
  for (let start = 0; start < missing.length; start += 128) {
    const slice = missing.slice(start, start + 128);
    const fetched = await fetchEmbeddings(slice.map((i) => texts[i]));
    slice.forEach((i, j) => {
      const vec = quantize(fetched[j]);
      vectors[i] = vec;
      if (vec.length !== dims) return; // the pass fails on the dimension check; never cache it
      cache.set(keys[i], vec);
      embeddingsCacheRows += 1;
      try { appendLine(EMBEDDINGS_CACHE_JSONL, JSON.stringify({ k: keys[i], v: vec })); } catch { /* cache only */ }
    });
  }
  compactEmbeddingsCache(new Set(keys));
  return vectors;
}

// Trust nothing from the backend: a wrong-length, NaN, Infinity, or empty
// vector must fail the WHOLE hybrid pass (fail-open to lexical) rather than
// silently truncate into a fake similarity — and must never enter the cache.
function validVector(v) {
  return Array.isArray(v) && v.length > 0 && v.every(Number.isFinite);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// Telemetry persists only what WE constructed. Sanitizing arbitrary
// exception text is an unwinnable enumeration (scheme://, mailto:,
// URL-encoded secrets, tomorrow's variant) — design rule 7 applied to
// telemetry: never gate secrets on lossy matching.
function classifyEmbeddingsError(error) {
  const msg = String(error?.message || "");
  if (error?.name === "AbortError" || msg.includes("aborted")) return "timeout";
  if (msg.startsWith("embeddings endpoint HTTP ")) return msg.slice(0, 40);
  if (msg.startsWith("embeddings response")) return "bad-response";
  if (msg.startsWith("embeddings vector invalid")) return "invalid-vector";
  if (msg.startsWith("embedding dimension mismatch")) return "dimension-mismatch";
  return "backend-error";
}

function lessonEmbeddingText(lesson) {
  return [
    String(lesson.title || ""),
    String(lesson.description || "").slice(0, 2000),
    Array.isArray(lesson.tags) ? lesson.tags.join(" ") : "",
  ].join("\n");
}

// Lexical token-overlap scorer — the retriever measured in the A1 retrieval
// benchmark (its paraphrase recall is the documented weak link; the A2
// behavioral trial injected scenario-mapped lessons directly, so A2 tested
// delivery, not this scorer's selection). If you swap in BM25/embeddings,
// keep the interface and re-run both eval tracks.
//
// Since 0.4.0 a query matches on DISTINCT, WHOLE-TOKEN content terms:
// repeated words count once, "cat" no longer matches inside "concatenate",
// and a small English stopword list never scores. The 0.3 scorer counted
// every occurrence of every 3+ letter substring hit, so a prompt that said
// "the" six times cleared the hook's gate on any lesson containing "the".
// (The published retrieval numbers were measured on the 0.3 scorer.)
const STOPWORDS = new Set((
  "a about above after again against all also am an and any are as at be because been before being below between " +
  "both but by can could did do does doing down during each few for from further had has have having he her here " +
  "hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off " +
  "on once only or other our ours ourselves out over own please same she should so some such than thank thanks that " +
  "the their theirs them themselves then there these they this those through to too under until up us very was we " +
  "were what when where which while who whom why will with would you your yours yourself yourselves"
).split(" "));

// Scripts written without spaces between words (or, for Hangul, with
// particles glued to words) are indexed as overlapping character bigrams,
// the usual approach for CJK search; everything else is whole words.
const BIGRAM_SCRIPTS = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}";
const BIGRAM_RUN = new RegExp(`[${BIGRAM_SCRIPTS}][${BIGRAM_SCRIPTS}\\p{M}]*`, "gu");
const BIGRAM_CHAR = new RegExp(`[${BIGRAM_SCRIPTS}]`, "u");

function tokenize(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const tokens = [];
  for (const word of normalized.split(" ")) {
    if (!BIGRAM_CHAR.test(word)) {
      tokens.push(word);
      continue;
    }
    let last = 0;
    for (const match of word.matchAll(BIGRAM_RUN)) {
      if (match.index > last) tokens.push(word.slice(last, match.index));
      const chars = Array.from(match[0]);
      if (chars.length === 1) tokens.push(chars[0]);
      for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1]);
      last = match.index + match[0].length;
    }
    if (last < word.length) tokens.push(word.slice(last));
  }
  return tokens;
}

// Light plural folding, so whole-token matching keeps "skills" ≈ "skill".
function foldTerm(token) {
  if (token.length >= 4 && /^[a-z]+$/.test(token)) {
    if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
    if (token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  }
  return token;
}

// The distinct content terms of a text: what queries, prompts and lessons
// are matched on.
function searchTerms(value) {
  const terms = new Set();
  for (const token of tokenize(value)) {
    if (STOPWORDS.has(token)) continue;
    if (token.length < 2 && !BIGRAM_CHAR.test(token)) continue; // a lone CJK character is a word
    terms.add(foldTerm(token));
  }
  return terms;
}

let lastParsedQuery = null;
function parseQuery(query) {
  const raw = typeof query === "string" ? query : String(query || "");
  if (lastParsedQuery && lastParsedQuery.raw === raw) return lastParsedQuery; // the hook scores one prompt against every lesson
  lastParsedQuery = { raw, terms: searchTerms(raw), phrase: tokenize(raw).join(" ") };
  return lastParsedQuery;
}

const lessonIndexes = new WeakMap();
function lessonIndex(lesson) {
  let index = lessonIndexes.get(lesson);
  if (!index) {
    const text = [lesson.title, lesson.description, lesson.author, Array.isArray(lesson.tags) ? lesson.tags.join(" ") : ""].join(" ");
    index = { terms: searchTerms(text), phrase: ` ${tokenize(text).join(" ")} ` };
    lessonIndexes.set(lesson, index);
  }
  return index;
}

function scoreLessonForQuery(lesson, query, tags) {
  const q = parseQuery(query);
  const haystack = lessonIndex(lesson);
  let score = 0;
  for (const term of q.terms) {
    if (haystack.terms.has(term)) score += 2;
  }
  if (q.phrase && haystack.phrase.includes(` ${q.phrase} `)) score += 6;
  const lessonTags = new Set(Array.isArray(lesson.tags) ? lesson.tags.map((t) => normalizeSearchText(t)) : []);
  for (const tag of tags) {
    if (lessonTags.has(normalizeSearchText(tag))) score += 4;
  }
  // Only a truly argumentless call (no query text, no tags) lists recent
  // lessons. A query whose text yields no usable terms (all stopwords,
  // punctuation) matches nothing — it used to fall into this branch and
  // return the newest lessons at score 1, logged as a real retrieval.
  if (!q.raw.trim() && !tags.length) score = 1;
  return score;
}

function compactLesson(lesson, score = 0) {
  const fullDescription = String(lesson.description || "");
  const truncated = fullDescription.length > 900;
  return {
    id: lesson.id,
    title: lesson.title || "Untitled lesson",
    // Truncation is explicit: silent mid-sentence cuts were observed removing
    // the actionable rule from results.
    description: truncated ? fullDescription.slice(0, 900) + " …[truncated]" : fullDescription,
    truncated,
    author: lesson.author || null,
    timestamp: lesson.timestamp || null,
    status: lesson.status || "active",
    project: lesson.project || null,
    evidence: Array.isArray(lesson.evidence) ? lesson.evidence.slice(0, 8) : [],
    tags: Array.isArray(lesson.tags) ? lesson.tags.slice(0, 12) : [],
    score,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleQuery(args, meta = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const tags = Array.isArray(args.tags) ? args.tags.filter(Boolean).map(String).slice(0, 12) : [];
  const limit = Math.max(1, Math.min(Number(args.limit || 8) || 8, 20));
  const all = activeLessons();
  const items = all.map((lesson) => ({ lesson, score: scoreLessonForQuery(lesson, query, tags) }));
  let retriever = "lexical";
  let embeddingsError = null;
  if (embeddingsEnabled() && query) {
    try {
      const queryVector = await embedQuery(query);
      const vectors = await embedLessons(items.map((item) => lessonEmbeddingText(item.lesson)), queryVector.length);
      if (!vectors.every((v) => v.length === queryVector.length)) throw new Error("embedding dimension mismatch across cache/backend");
      items.forEach((item, i) => {
        const cos = cosineSimilarity(queryVector, vectors[i]);
        if (cos >= EMBEDDINGS_MIN_COSINE) item.score += Math.round(cos * EMBEDDINGS_WEIGHT);
      });
      retriever = "hybrid";
    } catch (error) {
      embeddingsError = classifyEmbeddingsError(error); // constructed category only — raw exception text never persists
    }
  }
  const scored = items
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.lesson.timestamp || "").localeCompare(String(a.lesson.timestamp || ""));
    })
    .slice(0, limit)
    .map((item) => compactLesson(item.lesson, item.score));
  try {
    appendLine(QUERIES_JSONL, JSON.stringify({
      id: `q-${crypto.randomUUID()}`,
      ts: new Date().toISOString(),
      caller: meta.caller || null,
      surface: meta.surface || null,
      query: query.slice(0, 500),
      argumentless: !query && !tags.length,
      terms: searchTerms(query).size,
      tags,
      limit,
      registerSize: all.length,
      retriever,
      embeddingsError,
      count: scored.length,
      results: scored.map((l, i) => ({ id: l.id, rank: i + 1, score: l.score })),
    }));
  } catch { /* telemetry only */ }
  return { query, tags, retriever, count: scored.length, source: REGISTER_JSONL, lessons: scored };
}

function handleApply(args, meta = {}) {
  // Dedupe at the boundary: one apply event names a lesson once, however
  // many times the caller repeated the id — double-counting here inflated
  // outcome analytics and could trip doctor's failing-lesson flag off a
  // single real event.
  const lessonIds = [...new Set(Array.isArray(args.lessonIds) ? args.lessonIds.filter((x) => typeof x === "string" && x) : [])].slice(0, 30);
  if (!lessonIds.length) throw new Error("lessonIds array is required");
  const task = ensureSafeText(args.task || "unspecified task", "task").trim().slice(0, 500);
  let outcome = null;
  if (args.outcome !== undefined && args.outcome !== null && args.outcome !== "") {
    outcome = String(args.outcome).trim().toLowerCase();
    if (!APPLY_OUTCOMES.has(outcome)) throw new Error(`outcome must be one of: ${[...APPLY_OUTCOMES].join(", ")}`);
  }
  const entry = {
    id: `use-${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    caller: meta.caller || (typeof args.agent === "string" ? args.agent.slice(0, 64) : null),
    task,
    lessonIds,
    rationale: typeof args.rationale === "string" ? args.rationale.trim().slice(0, 1000) : "",
    outcome,
    outcomeNote: typeof args.outcomeNote === "string" ? args.outcomeNote.trim().slice(0, 500) : null,
  };
  if (args.dryRun === true) return { dryRun: true, path: USAGE_JSONL, entry };
  appendLine(USAGE_JSONL, JSON.stringify(entry));
  return { path: USAGE_JSONL, entry };
}

function lessonEntries(args) {
  const lessons = Array.isArray(args.lessons) ? args.lessons : (args.lesson ? [args.lesson] : []);
  if (!lessons.length) throw new Error("lessons array is required");
  return lessons.map((lesson, index) => ({
    title: ensureSafeText(lesson.title, `lessons[${index}].title`).trim(),
    description: ensureSafeText(lesson.description, `lessons[${index}].description`).trim(),
    date: lesson.date ? assertDate(lesson.date, `lessons[${index}].date`) : new Date().toISOString().slice(0, 10),
    evidence: Array.isArray(lesson.evidence) ? lesson.evidence.filter(Boolean).map(String).slice(0, 20) : [],
    tags: Array.isArray(lesson.tags) ? lesson.tags.filter(Boolean).map((t) => safeSlug(t, "tag")).slice(0, 20) : [],
    project: typeof lesson.project === "string" && lesson.project.trim() ? safeSlug(lesson.project).slice(0, 64).toLowerCase() : null,
  }));
}

function handleCandidate(args, meta = {}) {
  const entries = lessonEntries(args);
  const now = new Date().toISOString();
  const records = entries.map((lesson) => ({
    id: `cand-${crypto.randomUUID()}`,
    ts: now,
    status: "pending-review",
    author: meta.caller || (typeof args.agent === "string" ? args.agent.slice(0, 64) : null),
    ...lesson,
    task: typeof args.task === "string" ? args.task.trim().slice(0, 500) : "",
  }));
  if (args.dryRun === true) return { dryRun: true, path: CANDIDATES_JSONL, candidates: records };
  appendLine(CANDIDATES_JSONL, records.map((r) => JSON.stringify(r)).join("\n"));
  return { path: CANDIDATES_JSONL, appended: records.length, candidates: records };
}

// Curator write-back: retire by judgment. Rows are marked, never deleted.
function supersedeOp(args) {
  const supersededBy = typeof args.supersededBy === "string" && args.supersededBy.trim() ? args.supersededBy.trim() : null;
  const reason = ensureSafeText(args.reason, "reason").trim().slice(0, 500);
  const status = args.status === "deprecated" ? "deprecated" : "superseded";
  const ids = Array.isArray(args.ids) ? args.ids.filter(Boolean).map(String).slice(0, 50) : [];
  if (!ids.length) throw new Error("ids array is required");
  if (status === "superseded" && !supersededBy) {
    throw new Error("supersededBy is required when status is 'superseded' (use status 'deprecated' to retire with no replacement)");
  }
  return { ids, supersededBy, status, reason };
}

const isRetired = (record) => record.status === "superseded" || record.status === "deprecated";

// The id every reader sees for a parsed line: the explicit id, or the
// synthesized legacy id readRegister derives from the line position.
function effectiveId(entry) {
  const id = entry.record.id;
  return typeof id === "string" && id.trim() ? id : synthesizedId(entry.record, entry.index);
}

// Writes `record` back into its line, stamping a synthesized id into rows
// that lack one: once a retirement or a pointer refers to that id, it must
// survive later edits that shift line positions.
function writeEntry(entry, record) {
  const stamped = typeof record.id === "string" && record.id.trim() ? record : { id: effectiveId(entry), ...record };
  entry.record = stamped;
  entry.line = JSON.stringify(stamped);
}

// Applies one op to parsed register lines in place (later ops in a batch
// see earlier ones). Throws on any validation failure, before anything is
// written.
function applySupersedeOp(entries, op, now) {
  const { ids, supersededBy, status, reason } = op;
  const targets = new Set(ids);
  const found = new Set();
  // The replacement must be ACTIVE: pointing retired lessons at other retired
  // lessons builds chains and cycles the query filter can't reason about
  // (A→B then B→A would otherwise both "succeed"). Requiring an active
  // replacement makes cycles unrepresentable. Judged on the FIRST line with
  // that id — the copy every reader serves.
  if (supersededBy) {
    const replacement = entries.find((entry) => entry.record && effectiveId(entry) === supersededBy);
    if (!replacement) throw new Error(`supersededBy id not found in register: ${supersededBy}`);
    if (isRetired(replacement.record)) throw new Error(`supersededBy must be an ACTIVE lesson: ${supersededBy} is retired`);
    if (targets.has(supersededBy)) throw new Error("a lesson cannot supersede itself");
    if (typeof replacement.record.id !== "string" || !replacement.record.id.trim()) writeEntry(replacement, replacement.record);
  }
  const changed = [];
  const repointed = [];
  for (const entry of entries) {
    if (!entry.record) continue;
    const id = effectiveId(entry);
    if (!targets.has(id)) continue;
    found.add(id);
    const record = entry.record;
    if (!isRetired(record)) {
      const updated = { ...record, status, superseded_at: now, superseded_reason: reason };
      if (supersededBy) updated.superseded_by = supersededBy;
      writeEntry(entry, updated);
      changed.push({ id, title: record.title, status });
    } else if (supersededBy && record.superseded_by !== supersededBy) {
      // Re-point an already-retired row at a new ACTIVE replacement (repairs
      // A→B→C chains). The previous pointer moves into history, never lost.
      const history = Array.isArray(record.supersession_history) ? record.supersession_history : [];
      const updated = {
        ...record,
        status,
        superseded_by: supersededBy,
        superseded_at: now,
        superseded_reason: reason,
        supersession_history: [...history, {
          status: record.status,
          superseded_by: record.superseded_by ?? null,
          superseded_at: record.superseded_at ?? null,
          superseded_reason: record.superseded_reason ?? null,
        }],
      };
      writeEntry(entry, updated);
      repointed.push({ id, title: record.title, from: record.superseded_by ?? null, to: supersededBy });
    }
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`ids not found in register: ${missing.join(", ")}`);
  return { changed, repointed };
}

// Applies a batch of supersede ops in ONE locked rewrite (dedupe --apply
// uses this; lessons_supersede is a batch of one).
function supersedeMany(argsList, { dryRun = false } = {}) {
  const ops = argsList.map(supersedeOp);
  const now = new Date().toISOString();
  const plan = (text) => {
    const entries = parseJsonlLines(text);
    const before = entries.map((entry) => entry.line);
    const results = ops.map((op) => applySupersedeOp(entries, op, now));
    const dirty = entries.some((entry, i) => entry.line !== before[i]);
    return { entries, results, dirty };
  };
  if (dryRun) {
    if (!fs.existsSync(REGISTER_JSONL)) throw new Error("the register is empty (no lessons file yet)");
    return { ops, results: plan(readText(REGISTER_JSONL)).results };
  }
  return withRegisterLock(() => {
    let outcome;
    rewriteRegister((text) => {
      outcome = plan(text);
      return outcome.dirty ? outcome.entries.map((entry) => entry.line).join("\n") : null;
    });
    return { ops, results: outcome.results };
  });
}

function handleSupersede(args) {
  const { ops: [op], results: [{ changed, repointed }] } = supersedeMany([args], { dryRun: args.dryRun === true });
  const { status, supersededBy, reason } = op;
  if (args.dryRun === true) return { dryRun: true, status, supersededBy, reason, changed, repointed };
  return { path: REGISTER_JSONL, status, supersededBy, reason, retired: changed.length, changed, repointed };
}

// Slug normalization shared by sync (ids derive from it) and the hook's
// project-root lookup.
function projectSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

// Curator sign-off for synced project lessons: "unreviewed" -> "active".
// Synced rows are written by whoever can write to a project's
// LESSONS-LEARNED.jsonl; until reviewed, the hook injects them only inside
// that project's own root.
function markReviewed({ ids = [], project = null, reviewer = null, dryRun = false } = {}) {
  const wanted = new Set(ids);
  const slug = project ? projectSlug(project) : null;
  if (!wanted.size && !slug) throw new Error("ids or project is required");
  const now = new Date().toISOString();
  const plan = (text) => {
    const entries = parseJsonlLines(text);
    const reviewed = [];
    const skipped = [];
    const found = new Set();
    for (const entry of entries) {
      if (!entry.record) continue;
      const id = effectiveId(entry);
      const byId = wanted.has(id);
      if (!byId && !(slug && entry.record.project === slug)) continue;
      if (byId) found.add(id);
      if (entry.record.status !== "unreviewed") {
        if (byId) skipped.push({ id, status: entry.record.status || "active" });
        continue;
      }
      const updated = { ...entry.record, status: "active", reviewed_at: now };
      if (reviewer) updated.reviewed_by = String(reviewer).slice(0, 64);
      writeEntry(entry, updated);
      reviewed.push({ id, title: entry.record.title });
    }
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length) throw new Error(`ids not found in register: ${missing.join(", ")}`);
    return { entries, reviewed, skipped };
  };
  if (dryRun) {
    if (!fs.existsSync(REGISTER_JSONL)) throw new Error("the register is empty (no lessons file yet)");
    const { reviewed, skipped } = plan(readText(REGISTER_JSONL));
    return { dryRun: true, reviewed, skipped };
  }
  return withRegisterLock(() => {
    let outcome;
    rewriteRegister((text) => {
      outcome = plan(text);
      return outcome.reviewed.length ? outcome.entries.map((entry) => entry.line).join("\n") : null;
    });
    return { path: REGISTER_JSONL, reviewed: outcome.reviewed, skipped: outcome.skipped };
  });
}

// Direct append for curators and the CLI `add` command. Explicit id + status
// stamped at write time, always. (Project sync does NOT use this: its rows
// are pure functions of source content with content-derived ids, while
// these rows carry a random id and a `synced_at` write timestamp.)
function appendLessons(entries, { author = null, source = null } = {}) {
  const now = new Date().toISOString();
  const records = entries.map((lesson) => ({
    id: `llg-${crypto.randomUUID()}`,
    author,
    title: lesson.title,
    description: lesson.description,
    evidence: lesson.evidence || [],
    tags: lesson.tags || [],
    project: lesson.project || null,
    scope: lesson.project ? `project:${lesson.project}` : "global",
    status: "active",
    source,
    timestamp: `${lesson.date || now.slice(0, 10)}T12:00:00`,
    synced_at: now,
  }));
  withRegisterLock(() => appendLine(REGISTER_JSONL, records.map((r) => JSON.stringify(r)).join("\n")));
  return records;
}

// ---------------------------------------------------------------------------
// MCP stdio server
// ---------------------------------------------------------------------------
const tools = [
  {
    name: "lessons_query",
    description: "Search the lessons register and return relevant lesson records with stable ids for attribution.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lessons_apply",
    description: "Record that specific lesson ids influenced a task. Telemetry only. Include outcome (worked|partial|failed|unknown) when observable so effectiveness is measurable, not just declared.",
    inputSchema: {
      type: "object",
      properties: {
        lessonIds: { type: "array", items: { type: "string" } },
        task: { type: "string" },
        rationale: { type: "string" },
        outcome: { type: "string", enum: ["worked", "partial", "failed", "unknown"] },
        outcomeNote: { type: "string" },
        agent: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["lessonIds", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "lessons_candidate",
    description: "Submit candidate lessons for curator review instead of writing to the register directly. Set project (slug) for project-scoped lessons.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        agent: { type: "string" },
        lessons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              date: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
              project: { type: "string" },
            },
            required: ["title", "description"],
            additionalProperties: false,
          },
        },
        dryRun: { type: "boolean" },
      },
      required: ["lessons"],
      additionalProperties: false,
    },
  },
  {
    name: "lessons_supersede",
    description: "Curator only: retire lessons by judgment. Marks status superseded (with supersededBy pointer) or deprecated. An already-retired lesson can be re-pointed at a new ACTIVE replacement (the previous pointer is kept in supersession_history). Never deletes; retired lessons stop appearing in lessons_query.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        supersededBy: { type: "string" },
        status: { type: "string", enum: ["superseded", "deprecated"] },
        reason: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
];

const handlers = {
  lessons_query: handleQuery,
  lessons_apply: handleApply,
  lessons_candidate: handleCandidate,
  lessons_supersede: handleSupersede,
};

// Async since v0.2 (lessons_query may await an embeddings backend). Await is
// harmless for the other, synchronous handlers.
async function callTool(name, args, meta) {
  if (!handlers[name]) throw new Error("Unknown tool: " + name);
  return await handlers[name](args || {}, meta || {});
}

function okText(value) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...value }, null, 2) }] };
}

function errorText(error, toolName) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { tool: toolName || null, message: error?.message || String(error) } }, null, 2) }],
  };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// Protocol versions this server implements, newest first. A client asking
// for one of them gets it echoed; anything else gets our newest, and the
// client decides whether to continue (MCP version negotiation).
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_VERSION = (() => {
  try {
    return JSON.parse(readText(path.join(__dirname, "..", "package.json"))).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function processRequest(request) {
  const id = request.id;
  try {
    if (typeof request.method !== "string" || !request.method) {
      rpcError(id, -32600, "Invalid Request: method must be a non-empty string");
    } else if (request.method === "initialize") {
      const requested = request.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      send({ jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "murphys-law", version: SERVER_VERSION } } });
    } else if (request.method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      // Protocol errors (unknown tool, malformed arguments) are JSON-RPC
      // errors; failures while running a tool stay in-band (isError).
      if (typeof name !== "string" || !handlers[name]) {
        rpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name : JSON.stringify(name)}`);
      } else if (!args || typeof args !== "object" || Array.isArray(args)) {
        rpcError(id, -32602, `Invalid params: arguments for ${name} must be an object`);
      } else {
        try {
          send({ jsonrpc: "2.0", id, result: okText(await callTool(name, args, { surface: "mcp" })) });
        } catch (error) {
          send({ jsonrpc: "2.0", id, result: errorText(error, name) });
        }
      }
    } else {
      rpcError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    rpcError(id, -32603, `Internal error: ${error?.message || String(error)}`);
  }
}

// The stdio server loop, exported so the CLI can host it (`murphys mcp`).
// Requests are processed strictly in arrival order — the promise chain is the
// serialization guarantee now that handlers can await.
function startMcpServer() {
  printMigrationNoticeOnce();
  let buffer = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      // Batches are not supported and must not be met with silence (the
      // client would wait forever): every non-object message is an Invalid
      // Request with id null.
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a single JSON-RPC request object (batches are not supported)" } });
        continue;
      }
      if (request.id === undefined) {
        // A notification (method, no id) gets no response. A message with
        // neither is not a valid request at all.
        if (typeof request.method !== "string") send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: missing method" } });
        continue;
      }
      queue = queue.then(() => processRequest(request)).catch(() => { /* per-request errors already sent */ });
    }
  });
  // A stdio server whose client is gone must not linger as an orphan.
  process.stdin.on("end", () => { queue.finally(() => process.exit(0)); });
}

module.exports = {
  MURPHYS_HOME,
  MUPHYS_HOME: MURPHYS_HOME, // deprecated pre-0.3 name, kept for library users
  LEGACY_HOME,
  envValue,
  numberEnv,
  printMigrationNoticeOnce,
  migrationNotice,
  INJECTIONS_JSONL,
  REGISTER_JSONL,
  USAGE_JSONL,
  CANDIDATES_JSONL,
  QUERIES_JSONL,
  PROJECTS_JSON,
  REGISTER_LOCK,
  withRegisterLock,
  _rewriteRegister: rewriteRegister,
  supersedeMany,
  projectSlug,
  markReviewed,
  readText,
  appendLine,
  parseJsonlLines,
  readJsonlRecords,
  readRegister,
  activeLessons,
  normalizeSearchText,
  searchTerms,
  scoreLessonForQuery,
  compactLesson,
  lessonEntries,
  appendLessons,
  callTool,
  tools,
  handlers,
  startMcpServer,
  embeddingsEnabled,
};

if (require.main === module) {
  startMcpServer();
}
