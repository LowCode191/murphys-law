# Murphys Law

![Murphys Law — whatever can go wrong, will — once](https://raw.githubusercontent.com/LowCode191/murphys-law/main/assets/banner.svg)

**A lessons-learned register for AI agent fleets — with the receipts.**

The name is the old adage. The toast is its most famous corollary: dropped
toast lands butter-side down. Here's the part people forget — that was
studied, and it isn't luck. From table height, a slipping slice gets exactly
half a rotation: butter-side down is a **mechanism**, not a coin flip (the
finding [won an Ig Nobel](https://en.wikipedia.org/wiki/Robert_Matthews_(scientist))).
Same with agents: most failures that look like bad luck fire the same way
every time, for a reason. This register catches the mechanism the first time
it fires — so the toast lands butter-side up from then on.

*(This project shipped its first two releases, 0.1.0 and 0.2.0, under a
misspelled name — "Muphys Law." For a tool about mistakes becoming
institutional memory, that was almost too fitting; see
[Muphry's law](https://en.wikipedia.org/wiki/Muphry%27s_law). We renamed it
in 0.3.0. The lesson is logged — see the register's own
[sample lessons](data/sample-lessons.jsonl) — and upgrading from the old name
is covered in [Migrating from muphys-law](#migrating-from-muphys-law).)*

Agents repeat each other's mistakes. Murphys Law is the smallest system we
found that actually changes that: an append-only register of operational
lessons ("what burned us, and what to do instead"), a curation path, a recall
hook that **pushes** the relevant lesson into the agent's context at the
moment it matters, and telemetry on every link so you can measure whether any
of it works — because we did measure, and most of what we believed at the
start was wrong.

```
capture → curate → retrieve → deliver → apply → outcome
   │         │         │          │        │        │
candidates  supersede  query-log  hook   usage-log  outcome field
```

## Honest numbers (read this before adopting)

We ran a 48-run blind behavioral trial (12 scenarios × treat/control × 2
seeds, grader blind to arm, grades locked before unblinding) plus a retrieval
benchmark. Full protocol in [`eval/PROTOCOL.md`](eval/PROTOCOL.md). What the
data licenses:

- **Injection is not decorative.** Treated runs went 24/24 on the rubric;
  in 5 of 24 treated runs the agent cited the injected lesson's id unprompted
  and applied its guard. Injection → citation → correct behavior is directly
  observable in transcripts.
- **No harm observed.** Zero regressions across all treated runs
  (distribution — treat {2: 24} vs control {2: 21, 1: 3}).
- **The effect concentrates where the register is the only carrier of the
  knowledge.** In the one scenario whose lesson existed nowhere else, control
  missed the guard in both seeds and treatment applied it in both.
- **What we do NOT claim:** any broad effect size. Overall delta was +0.125
  on a 0–2 scale with p = 0.25 (n=48, sign test) — because 10 of 12 scenarios
  ceilinged in *both* arms: our fleet's standing context already carried most
  of the lessons. If your agents are newer than ours, expect more headroom;
  we can't prove it from our data.
- **Known weak link: retrieval.** The built-in scorer is lexical; on our
  24-probe golden set it surfaces the expected lesson in the top 3 only
  10/24 times. The optional embedding backend (below) lifts that to 14/24
  top-3 and 16/24 top-8 — measured against a local qwen3-embedding backend
  on the 0.2/0.3 implementation. 0.4.0 changed the lexical scorer (distinct
  whole-token terms, stopwords, Unicode tokenization; see the
  [changelog](CHANGELOG.md)) and has **not** been re-measured. The push hook
  compensates by scoring full prompts rather than short queries, but if you
  improve one thing, improve retrieval further — and re-run the eval.

## Quickstart (5 minutes)

```bash
git clone <this repo> && cd murphys-law
npm test                                  # zero dependencies

# seed a register with the sample lessons
mkdir -p ~/.murphys && cp data/sample-lessons.jsonl ~/.murphys/lessons.jsonl

# query it
node bin/muphys.mjs query "confirm the fix is live in production"

# capture your first lesson
node bin/muphys.mjs add --title "..." --description "..." --tags ops
```

(Installed from npm, the same CLI is `murphys`; the file keeps its pre-rename
name, `bin/muphys.mjs`, so existing configs keep working.)

### The recall hook (the part that actually changes behavior)

For Claude Code, add to **`~/.claude/settings.json`** (user scope):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
          "command": "node /path/to/murphys-law/hooks/lessons-recall-hook.mjs",
          "timeout": 10 } ] }
    ]
  }
}
```

Every prompt is scored against the register; when a lesson clears the
relevance gates it's injected as a clearly-framed background block, with each
lesson's date and status. Per-session dedupe, rate caps, and a no-ranking-slide
rule keep it quiet; scope it with `MURPHYS_HOOK_CWD_FILTER` if you only want it
in some trees.

**Injected lessons are text in front of your agent — treat the register as
trusted input.** The block frames lessons as background data rather than
instructions, and folds angle brackets so a lesson can't close the wrapper.
That reduces prompt-injection risk; it does not eliminate it — a lesson can
still say "always run X" in plain words, and a model may follow it. So the
writers that bypass curation are fenced: lessons synced from project files
land `unreviewed` and are injected only inside their own project until a
curator runs `murphys review` (see [Project-scoped lessons](#project-scoped-lessons)).

**Mounting matters — verify by effect.** Some agent harnesses spawn Claude
Code with `--setting-sources user`, which silently ignores project-scope
`.claude/settings.json`. Install at user scope, then prove the hook fires by
watching `~/.murphys/injections.jsonl` from a *real* session. A settings file
that exists is not a hook that runs; ours sat inert for four days behind a
guard that only read files back. `murphys doctor` checks this.

### The MCP server (pull-side tools for any MCP harness)

```bash
npx -y murphys-law mcp     # stdio MCP server, no clone needed
```

Or from a clone: `node lib/register.cjs`. Typical client config:

```json
{ "mcpServers": { "murphys": { "command": "npx", "args": ["-y", "murphys-law", "mcp"] } } }
```

Tools: `lessons_query`, `lessons_apply` (with an `outcome` field —
worked/partial/failed/unknown — so effectiveness is measurable, not just
declared), `lessons_candidate` (curation intake), `lessons_supersede`
(curator-only retirement). Fair warning from our telemetry: pull-based
discipline alone fails — our primary agent called `lessons_query` once in
433 sessions despite a "required" instruction. Ship the hook.

### Optional embedding retrieval (hybrid ranking)

`lessons_query` can blend embedding similarity into its lexical ranks. Point
it at any OpenAI-compatible embeddings endpoint (Ollama works):

```bash
export MURPHYS_EMBEDDINGS_URL=http://localhost:11434/v1/embeddings
export MURPHYS_EMBEDDINGS_MODEL=nomic-embed-text
# optional: MURPHYS_EMBEDDINGS_API_KEY, MURPHYS_EMBEDDINGS_TIMEOUT_MS (default 4000)
```

Unset = pure lexical, exactly as before. Design constraints, in order:
**fail-open** (any backend error or timeout falls back to lexical ranks and
records why in the query log — retrieval must never make the register
unavailable); **cached** (lesson vectors persist in
`~/.murphys/embeddings-cache.jsonl`, keyed by endpoint, model and vector
dimension, so the register embeds once per backend; query vectors are never
persisted); and **the hook stays lexical-only by design** — the prompt path
never waits on a network call. Every query-log row now records which retriever
answered (`retriever: lexical|hybrid`), so you can measure the difference on
your own traffic.

### Outcome analytics (closing the funnel)

The `outcome` field on `lessons_apply` finally feeds back into curation:

```bash
node bin/muphys.mjs stats --by-lesson   # per-lesson injections + applies + outcomes
node bin/muphys.mjs doctor              # flags ACTIVE lessons that keep failing when applied
```

A lesson with repeated `failed` outcomes and no `worked` wins is stale
guidance wearing the authority of the system — doctor names it and tells you
to review it for supersession.

### Beyond Claude Code (Codex, Cursor, Gemini CLI, your own harness)

The register, the CLI, and the MCP server are **harness- and model-agnostic**
— nothing in the system depends on which model reads the lessons. What varies
is how each harness gets the two delivery paths:

| Path | Claude Code | Any MCP harness (Codex CLI, Cursor, Cline, Zed, …) | Your own orchestrator |
|---|---|---|---|
| **Pull** (`lessons_query` etc.) | MCP server | MCP server — mount `node lib/register.cjs` (stdio) | call the exported functions directly |
| **Push** (auto-injection) | the `UserPromptSubmit` hook, as shipped | no direct equivalent — see below | ~20 lines, see below |

Two honest notes from our production telemetry:

- **Pull works better on some harnesses than others.** Our GPT-harness
  (Codex CLI) agents call `lessons_query` organically in most sessions with
  just the [instructions template](templates/AGENTS-block.md); it was our
  Claude-harness agents whose pull discipline collapsed (1 call in 433
  sessions) — that failure is *why* the push hook exists. Measure your own
  fleet before assuming either way; that's what the query log is for.
- **Push on a harness without prompt hooks** means owning the prompt
  assembly. If your orchestrator builds the messages it sends, implement
  push with the same exported logic the hook uses:

```js
const { activeLessons, scoreLessonForQuery } = require("murphys-law/lib/register.cjs");
const hits = activeLessons()
  .map((l) => ({ l, s: scoreLessonForQuery(l, userPrompt, []) }))
  .filter((x) => x.s >= 8)
  .sort((a, b) => b.s - a.s)
  .slice(0, 3);
// prepend a clearly-labeled background block built from `hits` — copy the
// wrapper format from hooks/lessons-recall-hook.mjs (data-framing, date +
// status per lesson, markup folding). Keep it fail-open.
```

If your harness has its own pre-prompt hook point, a port of
`hooks/lessons-recall-hook.mjs` is likely small — PRs welcome.

### Project-scoped lessons

Any repo can keep a `LESSONS-LEARNED.jsonl` at its root (one
`{title, description, ...}` per line — humans, agents, and CI can all append).
Register roots in `~/.murphys/projects.json` (see
[`data/projects.example.json`](data/projects.example.json)), then:

```bash
node bin/muphys.mjs sync
```

Content-derived ids make the sync idempotent and stateless; records land
scoped `project:<slug>`. Never rename a slug (ids derive from it).

Synced rows land with `status: "unreviewed"`: whoever can write to a project's
file wrote them, and no curator has looked yet. `lessons_query` returns them
(with the status visible), but the recall hook injects them only into sessions
whose working directory is inside that project's registered root. A curator
promotes them:

```bash
node bin/muphys.mjs review --project my-app        # every unreviewed row of a project
node bin/muphys.mjs review --ids llp-abc123 --by me # specific rows; --dry-run to preview
```

## Design rules (each one paid for)

1. **Explicit ids at write time.** Position-derived ids break every
   downstream reference the first time someone dedupes the file.
2. **Nothing is ever deleted.** Retirement = `status: superseded` with a
   pointer to the replacement (`lessons_supersede`); queries filter it. Stale
   guidance that remains recallable "with the authority of the system" is
   worse than no guidance.
3. **Every query and injection is logged.** Retrieval you can't observe is
   retrieval you can't improve — and it's how you run the eval.
4. **Injected content is framed as data, not instructions.** The block says
   so, shows each lesson's date and status, and angle-brackets are folded so a
   poisoned lesson can't escape the wrapper. Framing reduces injection risk; it
   doesn't remove it, so uncurated writers (project sync) stay fenced to their
   own project until reviewed.
5. **Fail-open + external liveness.** The hook must never block a prompt, so
   its failure mode is silence — which is why `murphys doctor` exists and why
   you verify installs by effect.
6. **Truncation is explicit.** A silently cut description can lose exactly
   the actionable rule.
7. **Lossy matching never gates destruction.** `dedupe --apply` retires only
   byte-identical content (compared as a structural tuple — no delimiter to
   inject); every fuzzy match — typographic variants, whitespace reflow, even
   NFC canonical forms — is *reported* for curator review, never auto-retired.
   Seven adversarial review rounds proved the theorem the hard way: every
   equivalence short of byte identity has a false-merge class, and enumerating
   them never terminates. A missed merge is cheap; a wrongly retired lesson is
   not.

## Templates

- [`templates/AGENTS-block.md`](templates/AGENTS-block.md) — the standing
  instruction block for pull-side discipline (with its measured limits).
- [`templates/incident-review-skill.md`](templates/incident-review-skill.md)
  — a postmortem protocol that makes recall-before-hypothesis a gate and
  routes the durable lesson back into the register.

## Evaluating it yourself

[`eval/PROTOCOL.md`](eval/PROTOCOL.md) is the complete blind-trial protocol —
rubric anchors, blinding procedure, the traps we hit (arm-tell leakage,
ceiling effects, transcript races, hand-transcribed provenance tables), and
how to read small-n results without lying to yourself. If you adopt this and
run the eval against your own fleet, we'd love the numbers either way.

## Configuration

Every path and setting is an environment variable; defaults live under the
data home. Pre-0.3 `MUPHYS_*` names are still read as fallbacks (the
`MURPHYS_*` name wins when both are set).

| Variable | Default | Purpose |
|---|---|---|
| `MURPHYS_HOME` | `~/.murphys` (or `~/.muphys`, see below) | data home for everything below |
| `MURPHYS_REGISTER` | `$MURPHYS_HOME/lessons.jsonl` | the register |
| `MURPHYS_USAGE_LOG` | `$MURPHYS_HOME/usage.jsonl` | `lessons_apply` events + outcomes |
| `MURPHYS_CANDIDATES` | `$MURPHYS_HOME/candidates.jsonl` | `lessons_candidate` intake |
| `MURPHYS_QUERY_LOG` | `$MURPHYS_HOME/queries.jsonl` | every query, ranks and scores |
| `MURPHYS_INJECTION_LOG` | `$MURPHYS_HOME/injections.jsonl` | every hook decision (both arms) |
| `MURPHYS_PROJECTS` | `$MURPHYS_HOME/projects.json` | project roots for `sync` |
| `MURPHYS_HOOK_MIN_SCORE` | `8` | hook gate: minimum lexical score |
| `MURPHYS_HOOK_MIN_TERMS` | `3` | hook gate: minimum distinct matching terms |
| `MURPHYS_HOOK_CWD_FILTER` | unset | regex; hook fires only for matching session cwds |
| `MURPHYS_EMBEDDINGS_URL` / `_MODEL` | unset | enable hybrid retrieval (both required) |
| `MURPHYS_EMBEDDINGS_API_KEY` | unset | bearer token for the embeddings endpoint |
| `MURPHYS_EMBEDDINGS_TIMEOUT_MS` | `4000` | per-request embeddings timeout |
| `MURPHYS_LOCK_WAIT_MS` | `15000` | how long writers wait for the register lock |
| `MURPHYS_LOCK_STALE_MS` | `600000` | age after which a held lock counts as stale |
| `DEBUG` | unset | `1` prints stack traces on CLI errors |

A non-numeric value for a numeric setting falls back to its default with a
warning. The experiment file (`$MURPHYS_HOME/experiment.json`) takes
`enabled`, `mode: "session-randomized"`, `treatFraction` and an optional
`salt`.

### Migrating from muphys-law

Releases up to 0.2.0 were published as `muphys-law`, with `MUPHYS_*`
variables and a `~/.muphys` home. From 0.4.0:

- `MUPHYS_*` variables keep working as fallbacks; rename them to `MURPHYS_*`
  at your convenience.
- If `~/.murphys` holds no register but `~/.muphys` does (and no home is set
  explicitly), `~/.muphys` is used. Nothing is moved or deleted; the CLI and
  the MCP server print a one-time notice, and `murphys doctor` lists it under
  `notes`. To finish migrating, move the directory yourself:
  `mv ~/.muphys ~/.murphys`.
- Session-randomized experiments whose config lives in the legacy home keep
  their pre-rename arm assignment. If you move the home mid-experiment, add
  `"salt": "muphys-recall"` to `experiment.json` to keep it.
- The library export `MUPHYS_HOME` remains as a deprecated alias of
  `MURPHYS_HOME`.

(0.3.0 renamed everything without these fallbacks; if you upgraded to it,
0.4.0 picks your `~/.muphys` register back up.)

## Status

v0.4.0 — see the [changelog](CHANGELOG.md). Extracted from a production
multi-agent deployment (9 agents, ~340 lessons, several months) where every
design rule above was learned by violating it first. No external
dependencies; Node ≥ 22.

## Related projects

Murphys Law is part of a family of agent-fleet coordination primitives
distilled from the same production system:

- [relay-ledger](https://github.com/LowCode191/relay-ledger) — exactly-once
  completion observation for multi-agent fleets: dispatch, death, salvage,
  reconcile.

MIT © LowCode191
