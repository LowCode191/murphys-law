#!/usr/bin/env node
// murphys-law — lessons register core + MCP stdio server.
//
// A lessons register is an append-only JSONL file of operational lessons
// ("what burned us and what to do instead"), plus four small tools:
//
//   lessons_query      search the register (lexical scorer, telemetry-logged)
//   lessons_apply      declare that lessons influenced a task (+ outcome)
//   lessons_candidate  submit a new lesson for curation
//   lessons_supersede  retire lessons by judgment (curator-only; never deletes)
//
// Run `node lib/register.cjs` to serve these over MCP stdio, or use the
// exported functions directly (the CLI in bin/muphys.mjs does).
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
// Paths — everything lives under MURPHYS_HOME (default ~/.murphys), individually
// overridable for embedding into an existing data layout.
// ---------------------------------------------------------------------------
const MURPHYS_HOME = path.resolve(process.env.MURPHYS_HOME || path.join(os.homedir(), ".murphys"));
const p = (envName, fallback) => path.resolve(process.env[envName] || path.join(MURPHYS_HOME, fallback));
const REGISTER_JSONL = p("MURPHYS_REGISTER", "lessons.jsonl");
const USAGE_JSONL = p("MURPHYS_USAGE_LOG", "usage.jsonl");
const CANDIDATES_JSONL = p("MURPHYS_CANDIDATES", "candidates.jsonl");
const QUERIES_JSONL = p("MURPHYS_QUERY_LOG", "queries.jsonl");
const PROJECTS_JSON = p("MURPHYS_PROJECTS", "projects.json");

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

function atomicReplace(filePath, content) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
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

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
const EMBEDDINGS_URL = process.env.MURPHYS_EMBEDDINGS_URL || "";
const EMBEDDINGS_MODEL = process.env.MURPHYS_EMBEDDINGS_MODEL || "";
const EMBEDDINGS_API_KEY = process.env.MURPHYS_EMBEDDINGS_API_KEY || "";
const EMBEDDINGS_TIMEOUT_MS = Math.max(500, Number(process.env.MURPHYS_EMBEDDINGS_TIMEOUT_MS || 4000) || 4000);
const EMBEDDINGS_CACHE_JSONL = path.join(MURPHYS_HOME, "embeddings-cache.jsonl");
const EMBEDDINGS_MIN_COSINE = 0.3;   // below this, similarity contributes nothing
const EMBEDDINGS_WEIGHT = 20;        // max points cosine can add, comparable to lexical

function embeddingsEnabled() {
  return Boolean(EMBEDDINGS_URL && EMBEDDINGS_MODEL);
}

let embeddingsCache = null;
function loadEmbeddingsCache() {
  if (embeddingsCache) return embeddingsCache;
  embeddingsCache = new Map();
  try {
    for (const row of readJsonlRecords(EMBEDDINGS_CACHE_JSONL)) {
      if (typeof row.k === "string" && Array.isArray(row.v)) embeddingsCache.set(row.k, row.v);
    }
  } catch { /* no cache yet */ }
  return embeddingsCache;
}

function embeddingCacheKey(text) {
  return crypto.createHash("sha256").update(JSON.stringify([EMBEDDINGS_MODEL, text])).digest("hex");
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
    const vectors = body.data.map((d) => {
      if (!validVector(d.embedding)) throw new Error("embeddings response vector invalid (empty or non-finite)");
      return d.embedding;
    });
    const dims = vectors[0].length;
    if (!vectors.every((v) => v.length === dims)) throw new Error("embeddings response vectors have inconsistent dimensions");
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

async function embedMany(texts) {
  const cache = loadEmbeddingsCache();
  const vectors = new Array(texts.length);
  const missing = [];
  texts.forEach((text, i) => {
    const cached = cache.get(embeddingCacheKey(text));
    // A poisoned cache row (crash mid-append, historical bad write) is
    // treated as missing and re-fetched — the cache heals instead of
    // serving garbage forever.
    if (validVector(cached)) vectors[i] = cached;
    else missing.push(i);
  });
  for (let start = 0; start < missing.length; start += 128) {
    const slice = missing.slice(start, start + 128);
    const fetched = await fetchEmbeddings(slice.map((i) => texts[i]));
    slice.forEach((i, j) => {
      const vec = fetched[j].map((x) => Math.round(x * 1e5) / 1e5);
      // Validate the TRANSFORMED vector — the one that is actually ranked
      // and cached. Fetch-time validation alone verifies a premise the
      // quantization step can then break (1e308 rounds to Infinity).
      if (!validVector(vec)) throw new Error("embeddings vector invalid after quantization");
      vectors[i] = vec;
      const key = embeddingCacheKey(texts[i]);
      cache.set(key, vec);
      try { appendLine(EMBEDDINGS_CACHE_JSONL, JSON.stringify({ k: key, v: vec })); } catch { /* cache only */ }
    });
  }
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
function scoreLessonForQuery(lesson, query, tags) {
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = normalizedQuery ? normalizedQuery.split(/\s+/).filter((t) => t.length > 2) : [];
  const haystack = normalizeSearchText([
    lesson.title,
    lesson.description,
    lesson.author,
    Array.isArray(lesson.tags) ? lesson.tags.join(" ") : "",
  ].join(" "));
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 2;
  }
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 6;
  const lessonTags = new Set(Array.isArray(lesson.tags) ? lesson.tags.map((t) => normalizeSearchText(t)) : []);
  for (const tag of tags) {
    if (lessonTags.has(normalizeSearchText(tag))) score += 4;
  }
  if (!queryTerms.length && !tags.length) score = 1;
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
      const vectors = await embedMany([query, ...items.map((item) => lessonEmbeddingText(item.lesson))]);
      const queryVector = vectors[0];
      if (!vectors.every((v) => v.length === queryVector.length)) throw new Error("embedding dimension mismatch across cache/backend");
      items.forEach((item, i) => {
        const cos = cosineSimilarity(queryVector, vectors[i + 1]);
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
function handleSupersede(args) {
  const supersededBy = typeof args.supersededBy === "string" && args.supersededBy.trim() ? args.supersededBy.trim() : null;
  const reason = ensureSafeText(args.reason, "reason").trim().slice(0, 500);
  const status = args.status === "deprecated" ? "deprecated" : "superseded";
  const ids = Array.isArray(args.ids) ? args.ids.filter(Boolean).map(String).slice(0, 50) : [];
  if (!ids.length) throw new Error("ids array is required");
  if (status === "superseded" && !supersededBy) {
    throw new Error("supersededBy is required when status is 'superseded' (use status 'deprecated' to retire with no replacement)");
  }
  const targets = new Set(ids);
  const found = new Set();
  let replacementExists = !supersededBy;
  const parsed = parseJsonlLines(readText(REGISTER_JSONL));
  // The replacement must be ACTIVE: pointing retired lessons at other retired
  // lessons builds chains and cycles the query filter can't reason about
  // (A→B then B→A would otherwise both "succeed"). Requiring an active
  // replacement makes cycles unrepresentable.
  let replacementActive = false;
  for (const entry of parsed) {
    if (entry.record && entry.record.id === supersededBy) {
      replacementExists = true;
      replacementActive = entry.record.status !== "superseded" && entry.record.status !== "deprecated";
    }
  }
  if (!replacementExists) throw new Error(`supersededBy id not found in register: ${supersededBy}`);
  if (supersededBy && !replacementActive) throw new Error(`supersededBy must be an ACTIVE lesson: ${supersededBy} is retired`);
  if (supersededBy && targets.has(supersededBy)) throw new Error("a lesson cannot supersede itself");
  const now = new Date().toISOString();
  const changed = [];
  const output = parsed.map((entry) => {
    const record = entry.record;
    if (!record || !targets.has(record.id)) return entry.line;
    found.add(record.id);
    if (record.status === "superseded" || record.status === "deprecated") return entry.line;
    const updated = { ...record, status, superseded_at: now, superseded_reason: reason };
    if (supersededBy) updated.superseded_by = supersededBy;
    changed.push({ id: record.id, title: record.title, status });
    return JSON.stringify(updated);
  });
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`ids not found in register: ${missing.join(", ")}`);
  if (args.dryRun === true) return { dryRun: true, status, supersededBy, reason, changed };
  if (changed.length) atomicReplace(REGISTER_JSONL, output.join("\n"));
  return { path: REGISTER_JSONL, status, supersededBy, reason, retired: changed.length, changed };
}

// Direct append for curators / the project-sync pipeline. Explicit id + status
// stamped at write time, always.
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
  appendLine(REGISTER_JSONL, records.map((r) => JSON.stringify(r)).join("\n"));
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
    description: "Curator only: retire lessons by judgment. Marks status superseded (with supersededBy pointer) or deprecated. Never deletes; retired lessons stop appearing in lessons_query.",
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

async function processRequest(request) {
  try {
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murphys-law", version: "0.1.0" } } });
    } else if (request.method === "notifications/initialized") {
      // no-op
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    } else if (request.method === "tools/call") {
      const result = await callTool(request.params?.name, request.params?.arguments || {}, { surface: "mcp" });
      send({ jsonrpc: "2.0", id: request.id, result: okText(result) });
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported method: " + request.method } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, result: errorText(error, request.params?.name || null) });
  }
}

// The stdio server loop, exported so the CLI can host it (`murphys mcp`).
// Requests are processed strictly in arrival order — the promise chain is the
// serialization guarantee now that handlers can await.
function startMcpServer() {
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
      if (!request || typeof request !== "object" || request.id === undefined) continue;
      queue = queue.then(() => processRequest(request)).catch(() => { /* per-request errors already sent */ });
    }
  });
  // A stdio server whose client is gone must not linger as an orphan.
  process.stdin.on("end", () => { queue.finally(() => process.exit(0)); });
}

module.exports = {
  MURPHYS_HOME,
  REGISTER_JSONL,
  USAGE_JSONL,
  CANDIDATES_JSONL,
  QUERIES_JSONL,
  PROJECTS_JSON,
  readText,
  appendLine,
  parseJsonlLines,
  readJsonlRecords,
  readRegister,
  activeLessons,
  normalizeSearchText,
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
