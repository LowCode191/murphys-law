#!/usr/bin/env node
// murphys — CLI for the lessons register.
//
//   murphys add --title "..." --description "..." [--tags a,b] [--evidence x]
//              [--project slug] [--author name] [--date YYYY-MM-DD]
//   murphys query "<text>" [--tags a,b] [--limit N]
//   murphys supersede --ids id1,id2 --superseded-by idX --reason "..."
//   murphys deprecate --ids id1,id2 --reason "..."
//   murphys dedupe [--apply]        byte-identical duplicates -> superseded; near-matches reported for review
//   murphys sync [--dry-run]        pull project LESSONS-LEARNED.jsonl files in
//   murphys doctor                  integrity + liveness checks
//   murphys stats [--by-lesson]     register/funnel counts + outcome rollup
//   murphys mcp                     run the stdio MCP server (npx-mountable)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "register.cjs"));

const [, , command, ...rest] = process.argv;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message) {
  console.error(`murphys: ${message}`);
  process.exit(2);
}

const args = parseArgs(rest);

function outcomeRollup() {
  // Per-lesson effectiveness from the apply log: the funnel's last hop,
  // finally read instead of only written.
  const perLesson = new Map();
  const totals = { applies: 0, worked: 0, partial: 0, failed: 0, unknown: 0, unspecified: 0 };
  for (const row of core.readJsonlRecords(core.USAGE_JSONL)) {
    if (!Array.isArray(row.lessonIds)) continue;
    const outcome = typeof row.outcome === "string" && ["worked", "partial", "failed", "unknown"].includes(row.outcome) ? row.outcome : "unspecified";
    totals.applies += 1;
    totals[outcome] += 1;
    // Read-side dedupe mirrors the write-side one: legacy or hand-written
    // usage rows with repeated ids still count once per event.
    for (const id of new Set(row.lessonIds)) {
      if (typeof id !== "string") continue;
      if (!perLesson.has(id)) perLesson.set(id, { id, applies: 0, worked: 0, partial: 0, failed: 0, unknown: 0, unspecified: 0 });
      const bucket = perLesson.get(id);
      bucket.applies += 1;
      bucket[outcome] += 1;
    }
  }
  return { totals, perLesson };
}


switch (command) {
  case "add": {
    if (!args.title || !args.description) fail("--title and --description are required");
    const entries = core.lessonEntries({
      lessons: [{
        title: String(args.title),
        description: String(args.description),
        date: args.date ? String(args.date) : undefined,
        tags: args.tags ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
        evidence: args.evidence ? [String(args.evidence)] : [],
        project: args.project ? String(args.project) : undefined,
      }],
    });
    const records = core.appendLessons(entries, { author: args.author ? String(args.author) : null, source: "cli" });
    out({ appended: records.map((r) => ({ id: r.id, title: r.title })) });
    break;
  }

  case "query": {
    const result = await core.callTool("lessons_query", {
      query: args._.join(" "),
      tags: args.tags ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
      limit: args.limit ? Number(args.limit) : undefined,
    }, { surface: "cli" });
    out(result);
    break;
  }

  case "supersede":
  case "deprecate": {
    if (!args.ids || !args.reason) fail("--ids and --reason are required");
    const result = await core.callTool("lessons_supersede", {
      ids: String(args.ids).split(",").map((s) => s.trim()).filter(Boolean),
      supersededBy: args["superseded-by"] ? String(args["superseded-by"]) : undefined,
      status: command === "deprecate" ? "deprecated" : "superseded",
      reason: String(args.reason),
      dryRun: args["dry-run"] === true,
    });
    out(result);
    break;
  }

  case "dedupe": {
    // Two tiers, because dedupe is DESTRUCTIVE under --apply and six review
    // rounds proved a theorem about lossy transforms on a destructive path:
    // enumeration of their failure modes never terminates. Every stripped
    // character class created a false-merge (ASCII folding ate non-Latin
    // text; \p{L}\p{N} ate combining marks, क vs कि; \p{M} still ate symbols,
    // ✅ vs ❌; toLowerCase corrupts Turkish both ways) — and after retreating
    // to "strip nothing semantic", the surviving fold FEATURES still merged
    // real lessons: the trailing-dash trim ate a lesson about a terminal
    // dash, whitespace collapse merged a two-line payload with its one-line
    // variant, the typographic map merged lessons about exact characters
    // („ vs "), and the "|" composite key was delimiter-injectable from
    // round 1 (title "a|b" + desc "c" ≡ title "a" + desc "b|c").
    //
    // So the split:
    //   AUTO-RETIRE (--apply) — BYTE-IDENTICAL tuple equality ONLY, keyed
    //     structurally (JSON array — no delimiter to inject). Not even NFC:
    //     a lesson quoting the literal decomposed e+combining-acute sequence
    //     is a different instruction than one quoting precomposed é, the
    //     same way „ differs from ". Byte identity is the only equivalence
    //     with zero destructive collisions — and the only gate with nothing
    //     left to adversarially probe.
    //   REVIEW CANDIDATES (always report-only) — the folded near-match
    //     (typographic variants, whitespace runs, separator dashes, and
    //     NFC canonical forms: the original backfill classes) is surfaced
    //     for a curator to judge and supersede manually. Missed-or-deferred
    //     merge is the cheap error; a false auto-retire is the expensive
    //     one.
    // Only string-typed, non-empty content is ever judged — in EITHER tier.
    // readRegister admits any parsed JSON row (the file is append-only and
    // tolerates legacy/manual appends), and String() coercion is itself a
    // lossy transform: {a:1} and {b:2} both become "[object Object]", and 42
    // collides with "42". Rows that fail the guard are skipped, never coerced.
    const judgeable = (lesson) =>
      typeof lesson.title === "string" && lesson.title.length > 0 &&
      typeof lesson.description === "string" && lesson.description.length > 0;
    const exactKey = (lesson) => JSON.stringify([lesson.title, lesson.description]);
    const TYPOGRAPHIC = new Map(Object.entries({
      "‘": "'", "’": "'", "‚": "'", "‛": "'",
      "“": '"', "”": '"', "„": '"', "‟": '"',
      "–": "-", "—": "-", "‒": "-", "―": "-",
      "…": "...",
      " ": " ",
    }));
    const fold = (t) => String(t || "")
      .normalize("NFC")
      .replace(/[‘’‚‛“”„‟–—‒―… ]/g, (ch) => TYPOGRAPHIC.get(ch) ?? ch)
      .replace(/\s+/g, " ")
      // Whitespace-gated separator trim: "title —" is decoration, but a dash
      // GLUED to the last token is content ("service tier is A-" ≠ "... A").
      .replace(/\s[-\s]+$/, "")
      .trim();
    const planDedupe = () => {
    const active = core.readRegister().filter((lesson) => lesson.status !== "superseded" && lesson.status !== "deprecated");

    const exactGroups = new Map();
    for (const lesson of active) {
      if (!judgeable(lesson)) continue;
      const key = exactKey(lesson);
      if (!exactGroups.has(key)) exactGroups.set(key, []);
      exactGroups.get(key).push(lesson);
    }
    const plans = [];
    for (const members of exactGroups.values()) {
      if (members.length < 2) continue;
      const keeper = [...members].sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""))).pop();
      for (const member of members) {
        if (member.id !== keeper.id) plans.push({ retire: member.id, keeper: keeper.id, title: member.title });
      }
    }

    const foldGroups = new Map();
    for (const lesson of active) {
      if (!judgeable(lesson)) continue;
      const foldedTitle = fold(lesson.title);
      const foldedDescription = fold(lesson.description);
      if (!foldedTitle || !foldedDescription) continue; // emoji-only etc: never judge on empty keys
      const key = JSON.stringify([foldedTitle, foldedDescription]);
      if (!foldGroups.has(key)) foldGroups.set(key, []);
      foldGroups.get(key).push(lesson);
    }
    // Candidates reflect the POST-plan register: a member the retire plan is
    // about to remove must not be re-listed for curator review. Same explicit
    // truncation marker as lessons_query — a candidate row is curator UI, and
    // description-only variants are indistinguishable without descriptions.
    const retiring = new Set(plans.map((plan) => plan.retire));
    const preview = (d) => (d.length > 240 ? d.slice(0, 240) + " …[truncated]" : d);
    const candidates = [];
    for (const grouped of foldGroups.values()) {
      const members = grouped.filter((m) => !retiring.has(m.id));
      if (members.length < 2) continue;
      // Groups that are entirely byte-identical already live in the
      // auto-retire plan; a candidate group must contain at least two
      // DISTINCT contents.
      if (new Set(members.map(exactKey)).size < 2) continue;
      candidates.push({ ids: members.map((m) => m.id), members: members.map((m) => ({ id: m.id, title: m.title, description: preview(m.description) })) });
    }
    return { plans, candidates };
    };

    if (args.apply !== true) {
      const { plans, candidates } = planDedupe();
      out({ dryRun: true, wouldRetire: plans, reviewCandidates: candidates });
      break;
    }
    // Plan and apply under ONE lock hold, in ONE rewrite: a plan computed
    // outside the lock could be stale by the time it is applied, and
    // per-plan rewrites multiplied the window concurrent writers raced.
    const applied = core.withRegisterLock(() => {
      const fresh = planDedupe();
      if (fresh.plans.length) {
        core.supersedeMany(fresh.plans.map((plan) => ({ ids: [plan.retire], supersededBy: plan.keeper, reason: "exact-duplicate-content (murphys dedupe)" })));
      }
      return fresh;
    });
    out({ retired: applied.plans.length, reviewCandidates: applied.candidates });
    break;
  }

  case "sync": {
    // Deterministic feed-up of per-project LESSONS-LEARNED.jsonl files.
    // Content-derived ids (llp-<sha1 of the [slug,title,description] JSON tuple>) make re-runs
    // idempotent with no checkpoint state; the register is append-only here.
    let registry;
    if (!fs.existsSync(core.PROJECTS_JSON)) fail(`no project registry at ${core.PROJECTS_JSON} — see data/projects.example.json`);
    try {
      registry = JSON.parse(core.readText(core.PROJECTS_JSON));
    } catch (error) {
      fail(`project registry at ${core.PROJECTS_JSON} is not valid JSON: ${error.message}`);
    }
    const projects = (registry.projects || []).filter((project) => project && project.slug && project.root);
    const existing = new Set(core.readRegister().map((l) => l.id));
    const now = new Date().toISOString();
    const summary = [];
    const toAppend = [];
    for (const project of projects) {
      const slug = String(project.slug).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const root = path.resolve(project.root);
      const file = path.resolve(root, project.file || "LESSONS-LEARNED.jsonl");
      const row = { project: slug, file, scanned: 0, appended: 0, duplicates: 0, invalid: 0 };
      summary.push(row);
      if (!file.startsWith(root + path.sep) && file !== root) { row.error = "lessons file escapes project root"; continue; }
      if (!fs.existsSync(file)) continue;
      let realFile;
      try {
        realFile = fs.realpathSync(file);
        const realRoot = fs.realpathSync(root);
        if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) { row.error = "symlink escape refused"; continue; }
      } catch { continue; }
      for (const { index, blank, record: entry } of core.parseJsonlLines(core.readText(realFile))) {
        if (blank) continue;
        row.scanned += 1;
        if (!entry) { row.invalid += 1; continue; }
        const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 300) : "";
        const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 8000) : "";
        if (!title || !description) { row.invalid += 1; continue; }
        // Structural JSON-tuple hash basis: with a bare "|" join, title "a|b" +
        // desc "c" collides with title "a" + desc "b|c" — the second lesson
        // inherits the first's id and silently never syncs.
        const id = "llp-" + crypto.createHash("sha1").update(JSON.stringify([slug, title, description])).digest("hex").slice(0, 12);
        if (existing.has(id)) { row.duplicates += 1; continue; }
        existing.add(id);
        // The durable row is a PURE FUNCTION of source content (slug + line
        // content + line position): no wall clock rides in it, so a raced
        // double-append is byte-identical and the reader's first-wins
        // collapse is a true no-op, never a mask. Sync-time telemetry lives
        // in the run summary only. Undated source rows stay undated (every
        // reader tolerates a missing timestamp) — a today() fallback would
        // reintroduce a midnight divergence window. Known residue: `source`
        // carries the line number, so an edit that MOVES a lesson mid-race
        // can still produce divergent provenance rows — genuinely different
        // source states, surfaced by doctor for a curator, never merged
        // silently.
        const date = typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : null;
        toAppend.push(JSON.stringify({
          id,
          author: typeof entry.author === "string" && entry.author.trim() ? entry.author.trim().slice(0, 64) : slug,
          ...(date ? { timestamp: `${date}T12:00:00` } : {}),
          title,
          description,
          evidence: Array.isArray(entry.evidence) ? entry.evidence.filter(Boolean).map(String).slice(0, 20) : [],
          tags: [...new Set([...(Array.isArray(entry.tags) ? entry.tags.filter(Boolean).map(String) : []), slug])].slice(0, 20),
          scope: `project:${slug}`,
          project: slug,
          status: "active",
          source: `project-sync:${slug}#L${index + 1}`,
        }));
        row.appended += 1;
      }
    }
    if (args["dry-run"] !== true && toAppend.length) {
      // The register lock (shared with every other writer — see
      // withRegisterLock in lib/register.cjs) is best-effort serialization,
      // NOT the correctness gate for sync: POSIX offers no compare-and-swap
      // on paths. Correctness rests on two structural facts: sync rows are
      // pure functions of source content (a raced double-append writes
      // byte-identical rows — no wall clock rides in a durable row) and
      // readRegister collapses duplicate ids at read time (first wins), so a
      // lost race is a no-op at every read site. Sync never waits: a held
      // lock means another writer is active, and the next run picks up
      // whatever this one skipped.
      let stillNew;
      try {
        stillNew = core.withRegisterLock(() => {
          // Re-check ids under the lock — a racing sync may have won.
          const current = new Set(core.readRegister().map((l) => l.id));
          const fresh = toAppend.filter((line) => !current.has(JSON.parse(line).id));
          if (fresh.length) core.appendLine(core.REGISTER_JSONL, fresh.join("\n"));
          return fresh;
        }, { wait: false });
      } catch (error) {
        if (error.code !== "EREGISTERLOCKED") throw error;
        out({ skipped: true, reason: "another writer holds the register lock", lock: core.REGISTER_LOCK });
        break;
      }
      out({ dryRun: false, totalAppended: stillNew.length, syncedAt: now, projects: summary });
      break;
    }
    out({ dryRun: args["dry-run"] === true, totalAppended: 0, syncedAt: now, projects: summary });
    break;
  }

  case "mcp": {
    // Host the stdio MCP server through the CLI so `npx -y murphys-law mcp`
    // is a complete mount command — no clone, no path to the lib file.
    core.startMcpServer();
    // The server owns the process from here; it exits on stdin EOF.
    await new Promise(() => {});
    break;
  }

  case "doctor": {
    // Integrity + liveness. Fail-open components (the hook) are silent when
    // broken — this is the external assertion that catches that.
    const issues = [];
    const rows = core.readRegister();
    const lines = fs.existsSync(core.REGISTER_JSONL) ? core.parseJsonlLines(core.readText(core.REGISTER_JSONL)) : [];
    // Unparseable lines (torn writes, hand edits, non-object JSON) are
    // skipped by every reader — whatever they held is invisible to queries
    // and the hook, so they fail the check rather than hide.
    const unparseable = lines.filter((entry) => entry.invalid);
    if (unparseable.length) {
      issues.push(`${unparseable.length} unparseable register line(s) (first at line ${unparseable[0].index + 1}) — readers skip them, so whatever they held is invisible; repair the register file`);
    }
    const withoutExplicitId = lines.filter((entry) => entry.record && (typeof entry.record.id !== "string" || !entry.record.id.trim())).length;
    if (withoutExplicitId > 0) issues.push(`${withoutExplicitId} register rows lack an explicit id — run writers from this package only`);
    // Duplicate-id LINES: benign when byte-identical (concurrent-sync
    // artifact; the reader collapses them, first wins) — reported as a
    // count. DIVERGENT same-id lines mean the reader is masking real data
    // and a curator must repair the file: that is an issue.
    let duplicateIdLines = 0;
    const firstLineById = new Map();
    for (const entry of lines) {
      const rowId = entry.record?.id;
      if (typeof rowId !== "string" || !rowId) continue;
      if (!firstLineById.has(rowId)) { firstLineById.set(rowId, entry.line.trim()); continue; }
      duplicateIdLines += 1;
      if (firstLineById.get(rowId) !== entry.line.trim()) {
        issues.push(`divergent duplicate-id lines for ${rowId} — the reader keeps the FIRST and is masking the rest; repair the register file`);
      }
    }
    for (const lesson of rows) {
      if (lesson.status !== "superseded" || !lesson.superseded_by) continue;
      const replacement = rows.find((other) => other.id === lesson.superseded_by);
      if (!replacement) {
        issues.push(`dangling superseded_by pointer: ${lesson.id} -> ${lesson.superseded_by}`);
      } else if (replacement.status === "superseded" || replacement.status === "deprecated") {
        issues.push(`superseded_by points at a retired lesson: ${lesson.id} -> ${lesson.superseded_by} (chains/cycles; re-point at the active replacement)`);
      }
    }
    // Outcome telemetry finally feeds curation: an ACTIVE lesson that keeps
    // failing when applied is stale guidance wearing the authority of the
    // system — exactly what supersession exists for.
    const { perLesson } = outcomeRollup();
    for (const lesson of rows) {
      if (lesson.status === "superseded" || lesson.status === "deprecated") continue;
      const bucket = perLesson.get(lesson.id);
      if (!bucket) continue;
      if (bucket.failed >= 2 && bucket.failed > bucket.worked) {
        issues.push(`lesson ${lesson.id} keeps failing when applied (${bucket.failed} failed vs ${bucket.worked} worked across ${bucket.applies} applies) — review for supersession`);
      }
    }
    for (const name of ["readRegister", "scoreLessonForQuery", "normalizeSearchText", "callTool"]) {
      if (typeof core[name] !== "function") issues.push(`runtime missing export ${name} — wrong or stale checkout?`);
    }
    const injLog = path.resolve(process.env.MURPHYS_INJECTION_LOG || path.join(core.MURPHYS_HOME, "injections.jsonl"));
    if (!fs.existsSync(injLog)) {
      // Only alarm if the hook appears MOUNTED somewhere — a fresh install
      // with no hook yet is healthy, not broken.
      // Match THIS install's absolute hook path, not the basename: another
      // checkout's mounted hook logs to ITS home, and alarming here for it
      // is a false positive. A symlinked mount won't string-match and fails
      // toward silence — accepted: this alarm only ever fires when it can
      // name a hook that provably should be writing THIS install's log.
      const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "lessons-recall-hook.mjs");
      let mounted = false;
      for (const settingsPath of [
        path.join(os.homedir(), ".claude", "settings.json"),
        path.join(process.cwd(), ".claude", "settings.json"),
      ]) {
        try {
          if (fs.readFileSync(settingsPath, "utf8").includes(hookPath)) mounted = true;
        } catch { /* absent */ }
      }
      if (mounted) {
        issues.push(`hook is mounted but no injection log exists at ${injLog} — it has never fired. Verify by EFFECT: send a real prompt and watch this file. Reading settings back proves nothing (some harnesses never load the scope you installed into).`);
      }
    }
    out({ register: { total: rows.length, active: core.activeLessons().length, duplicateIdLines, unparseableLines: unparseable.length }, issues, ok: issues.length === 0 });
    process.exit(issues.length ? 1 : 0);
    break;
  }

  case "stats": {
    const count = (file) => core.readJsonlRecords(file).length;
    const injectionLog = path.resolve(process.env.MURPHYS_INJECTION_LOG || path.join(core.MURPHYS_HOME, "injections.jsonl"));
    const { totals, perLesson } = outcomeRollup();
    const result = {
      home: core.MURPHYS_HOME,
      register: { total: core.readRegister().length, active: core.activeLessons().length },
      queries: count(core.QUERIES_JSONL),
      applications: count(core.USAGE_JSONL),
      candidates: count(core.CANDIDATES_JSONL),
      injections: count(injectionLog),
      outcomes: totals,
    };
    if (args["by-lesson"] === true) {
      // Injection counts per lesson, joined with apply outcomes: the funnel
      // (deliver -> apply -> outcome) as one table per lesson.
      const injectedByLesson = new Map();
      for (const row of core.readJsonlRecords(injectionLog)) {
        for (const hit of Array.isArray(row.lessons) ? row.lessons : []) {
          if (hit && typeof hit.id === "string") injectedByLesson.set(hit.id, (injectedByLesson.get(hit.id) || 0) + 1);
        }
      }
      const titles = new Map(core.readRegister().map((l) => [l.id, { title: l.title || null, status: l.status || "active" }]));
      const ids = new Set([...perLesson.keys(), ...injectedByLesson.keys()]);
      result.byLesson = [...ids].map((id) => ({
        id,
        title: titles.get(id)?.title ?? null,
        status: titles.get(id)?.status ?? "unknown-id",
        injections: injectedByLesson.get(id) || 0,
        ...(perLesson.get(id) || { applies: 0, worked: 0, partial: 0, failed: 0, unknown: 0, unspecified: 0 }),
      })).sort((a, b) => (b.applies - a.applies) || (b.injections - a.injections) || String(a.id).localeCompare(String(b.id)));
    }
    out(result);
    break;
  }

  default:
    console.error(`murphys — lessons register CLI

  add | query | supersede | deprecate | dedupe | sync | doctor | stats

Data home: ${core.MURPHYS_HOME}  (override with MURPHYS_HOME)
MCP server: node lib/register.cjs   (stdio)
Recall hook: hooks/lessons-recall-hook.mjs  (Claude Code UserPromptSubmit)`);
    process.exit(command ? 2 : 0);
}
