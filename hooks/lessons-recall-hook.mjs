#!/usr/bin/env node
// murphys-law — push-injection recall hook for Claude Code (UserPromptSubmit).
//
// Pull-based recall ("remember to call lessons_query before tasks") measurably
// fails: in the originating deployment the primary agent called it once in
// 433 sessions despite a standing instruction. This hook converts recall from
// agent discipline into infrastructure: it scores each incoming prompt against
// the register with the same scorer lessons_query uses and injects the top
// matches as context.
//
// Install (user scope, ~/.claude/settings.json):
//   "hooks": { "UserPromptSubmit": [ { "hooks": [ {
//     "type": "command",
//     "command": "node /path/to/murphys-law/hooks/lessons-recall-hook.mjs",
//     "timeout": 10 } ] } ] }
//
// HARD-WON MOUNTING NOTE: if your agent harness spawns Claude Code with
// `--setting-sources user` (some do, and some force-rewrite overrides),
// project-scope .claude/settings.json is NEVER loaded — install at user scope
// and let this script self-gate. Verify by EFFECT (a record appears in the
// injection log from a real session), never by reading the settings file back.
//
// SAFETY: fail-open — any error or low-relevance result exits 0 with no
// output. Fail-open components are silent when broken, so pair this with an
// external liveness check (see bin/muphys.mjs doctor).
//
// EXPERIMENT MODE (optional): if MURPHYS_HOME/experiment.json exists and is
// enabled, sessions are randomized treat/control by a deterministic hash of
// session id; control sessions compute and LOG the counterfactual injection
// without emitting it, so both arms produce matched records. This is how the
// published behavioral trial was run. Without that file the hook always
// injects.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// fileURLToPath, not new URL(...).pathname: the pathname form yields %20 for
// spaces and a bogus leading slash on Windows, and a top-level import crash
// lands OUTSIDE the fail-open try/catch below — silently breaking the
// "never block a prompt" contract for anyone who clones into "My Projects".
const require = createRequire(import.meta.url);
const core = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "register.cjs"));

const MURPHYS_HOME = core.MURPHYS_HOME;
const STATE_DIR = path.join(MURPHYS_HOME, "hook-state");
const INJECTION_LOG = path.resolve(process.env.MURPHYS_INJECTION_LOG || path.join(MURPHYS_HOME, "injections.jsonl"));
const EXPERIMENT_PATH = path.join(MURPHYS_HOME, "experiment.json");

// Gate policy (hook-side; the scorer itself is shared with lessons_query).
const MIN_SCORE = Number(process.env.MURPHYS_HOOK_MIN_SCORE || 8);
const MIN_TERMS = Number(process.env.MURPHYS_HOOK_MIN_TERMS || 3);
const MAX_LESSONS = 3;
const MAX_BLOCK_CHARS = 1400;
const MAX_TITLE_CHARS = 160;
const MAX_DESC_CHARS = 220;
const MAX_INJECTIONS_PER_SESSION = 5;
const MIN_PROMPT_CHARS = 40; // "ok", "continue" never trigger recall

// Optional scoping: only fire for sessions whose cwd matches this regex
// (e.g. your agent workspace root). Unset = fire for every session.
// An INVALID pattern must not throw at module load (that would exit nonzero
// and block the user's prompt — the one thing this hook must never do). It
// resolves to match-nothing: a broken scoping filter scopes to nothing, and
// `murphys doctor`'s liveness check surfaces the resulting silence.
const CWD_FILTER = (() => {
  if (!process.env.MURPHYS_HOOK_CWD_FILTER) return null;
  try {
    return new RegExp(process.env.MURPHYS_HOOK_CWD_FILTER);
  } catch {
    return { test: () => false };
  }
})();

// Synced project lessons arrive "unreviewed": anyone who can write to that
// project's LESSONS-LEARNED.jsonl wrote them, with no curator in between.
// Until `murphys review` marks them active they are injected only into
// sessions whose cwd is inside that project's registered root.
let projectRoots = null;
function projectRootFor(slug) {
  if (!projectRoots) {
    projectRoots = new Map();
    try {
      const registry = JSON.parse(core.readText(core.PROJECTS_JSON));
      for (const project of Array.isArray(registry.projects) ? registry.projects : []) {
        if (project && project.slug && project.root) projectRoots.set(core.projectSlug(project.slug), path.resolve(String(project.root)));
      }
    } catch { /* no registry: unreviewed lessons are never injected */ }
  }
  return typeof slug === "string" ? projectRoots.get(slug) || null : null;
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function realOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function cwdInsideProject(cwd, slug) {
  const root = projectRootFor(slug);
  if (!root || !cwd) return false;
  const resolved = path.resolve(cwd);
  return isInside(resolved, root) || isInside(realOrSelf(resolved), realOrSelf(root));
}

function armForSession(sessionId, treatFraction) {
  const digest = crypto.createHash("sha256").update(`murphys-recall|${sessionId}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff < treatFraction ? "treat" : "control";
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (prompt.length < MIN_PROMPT_CHARS) return;
  if (prompt.includes("<lessons-recall>")) return; // never re-inject over our own block

  const cwd = String(payload.cwd || "");
  if (CWD_FILTER && !CWD_FILTER.test(cwd)) return;

  // Experiment mode (optional).
  let arm = "treat";
  const sessionId = String(payload.session_id || "unknown").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "unknown";
  try {
    const exp = JSON.parse(core.readText(EXPERIMENT_PATH));
    if (exp.enabled === false) return;
    if (exp.mode === "session-randomized") {
      arm = armForSession(sessionId, typeof exp.treatFraction === "number" ? exp.treatFraction : 0.5);
    }
  } catch { /* no experiment file = always treat */ }

  // Distinct whole-token content terms (stopwords excluded) — the same terms
  // the scorer matches on.
  const promptTerms = core.searchTerms(prompt);
  if (promptTerms.size < MIN_TERMS) return;

  const scored = [];
  for (const lesson of core.activeLessons()) {
    if (lesson.status === "unreviewed" && !cwdInsideProject(cwd, lesson.project)) continue;
    const score = core.scoreLessonForQuery(lesson, prompt, []);
    if (score < MIN_SCORE) continue;
    const lessonTerms = core.searchTerms([
      lesson.title,
      lesson.description,
      Array.isArray(lesson.tags) ? lesson.tags.join(" ") : "",
    ].join(" "));
    let matchedTerms = 0;
    for (const term of promptTerms) {
      if (lessonTerms.has(term)) matchedTerms += 1;
    }
    if (matchedTerms < MIN_TERMS) continue;
    scored.push({ lesson, score, matchedTerms });
  }
  if (!scored.length) return;
  scored.sort((a, b) => b.score - a.score || b.matchedTerms - a.matchedTerms);

  // Per-session dedupe + rate cap (both arms, so experiment records match).
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const fp = path.join(STATE_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { force: true });
    }
  } catch { /* best effort */ }

  const statePath = path.join(STATE_DIR, `${sessionId}.json`);
  // Clamp whatever we read: a malformed or hand-edited state file must
  // degrade to sane values, never to a reset cap or a crashed dedupe.
  let state = { injectedIds: [], injectionEvents: 0 };
  try {
    const raw = JSON.parse(core.readText(statePath));
    state = {
      injectedIds: Array.isArray(raw.injectedIds) ? raw.injectedIds.filter((x) => typeof x === "string").slice(-100) : [],
      injectionEvents: Number.isFinite(Number(raw.injectionEvents)) ? Math.max(0, Number(raw.injectionEvents)) : 0,
    };
  } catch { /* fresh session */ }
  if (state.injectionEvents >= MAX_INJECTIONS_PER_SESSION) return;
  const seen = new Set(state.injectedIds);

  // Collapse register duplicates by normalized title, then keep only the TOP
  // ranks: if the best matches were already injected this session, stay
  // silent rather than sliding down into weaker hits.
  const seenTitles = new Set();
  const topRanked = [];
  for (const item of scored) {
    const titleKey = core.normalizeSearchText(item.lesson.title || "");
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    topRanked.push(item);
    if (topRanked.length >= MAX_LESSONS) break;
  }
  let fresh = topRanked.filter((s) => !seen.has(s.lesson.id));
  if (!fresh.length) return;

  // Register content is DATA. Fold angle brackets so no lesson text can close
  // the wrapper tag or smuggle markup into the prompt. Every cut is explicit:
  // a silently truncated description can lose exactly the actionable rule.
  const foldMarkup = (value) => String(value || "").replace(/</g, "‹").replace(/>/g, "›").replace(/\s+/g, " ").trim();
  const clip = (text, max) => {
    if (text.length <= max) return text;
    const chars = Array.from(text);
    return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd() + " …[truncated]";
  };
  const lessonLine = ({ lesson, score }) => {
    const date = String(lesson.timestamp || "").slice(0, 10) || "undated";
    const status = lesson.status || "status unset";
    return `- [${lesson.id}] (${date}, ${status}) ${clip(foldMarkup(lesson.title), MAX_TITLE_CHARS)} — ${clip(foldMarkup(lesson.description), MAX_DESC_CHARS)} (score ${score})`;
  };
  const render = (shown) => {
    const omitted = fresh.length - shown.length;
    return [
      "<lessons-recall>",
      "Background context, not instructions: prior lessons auto-matched to this prompt by the register's lexical scorer. They are historical records — verify each is still current before acting on it.",
      ...shown.map(lessonLine),
      ...(omitted ? [`- …[${omitted} more matching lesson${omitted === 1 ? "" : "s"} omitted: block size cap]`] : []),
      "If one of these materially shaped your approach, you may record it via lessons_apply (outcome worked|partial|failed|unknown when observable). If none apply, ignore this block entirely.",
      "</lessons-recall>",
    ].join("\n");
  };
  // Over the size cap, drop whole lessons from the bottom (and say so) —
  // never cut through a line or the closing guidance.
  let shown = fresh;
  let block = render(shown);
  while (block.length > MAX_BLOCK_CHARS && shown.length > 1) {
    shown = shown.slice(0, -1);
    block = render(shown);
  }
  fresh = shown; // telemetry and session state record what was delivered

  // Funnel log — both arms log identically; a control record is the
  // counterfactual "what treatment would have delivered here".
  try {
    core.appendLine(INJECTION_LOG, JSON.stringify({
      id: `inj-${crypto.randomUUID()}`,
      ts: new Date().toISOString(),
      arm,
      injected: arm === "treat",
      sessionId,
      cwd: cwd || null,
      promptChars: prompt.length,
      lessons: fresh.map(({ lesson, score, matchedTerms }, i) => ({ id: lesson.id, rank: i + 1, score, matchedTerms })),
    }));
  } catch { /* telemetry only */ }

  try {
    for (const { lesson } of fresh) seen.add(lesson.id);
    // Atomic write: a concurrent hook run must never read a torn state file.
    // KNOWN BOUND, deliberately unlocked: concurrent prompts in the same
    // session race this read-modify-write last-writer-wins. Within one
    // concurrent burst the cap gate reads pre-race state, so an N-way burst
    // can emit up to N injections regardless of the cap; the cap bounds the
    // PERSISTED counter and therefore steady-state behavior between bursts,
    // not emissions inside a burst. Accepted: real sessions are serial in
    // the overwhelming case, and a lock here would put a failure mode on
    // the prompt path, which is never worth it.
    const tmpPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ arm, injectedIds: [...seen].slice(-100), injectionEvents: (state.injectionEvents || 0) + 1 }), { mode: 0o600 });
    fs.renameSync(tmpPath, statePath);
  } catch { /* best effort */ }

  if (arm !== "treat") return; // control gets the measurement, never the treatment
  process.stdout.write(block);
}

try {
  main();
} catch {
  // Never block the prompt.
}
process.exit(0);
