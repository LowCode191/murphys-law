# Changelog

## 0.4.0 — unreleased

### Behaviour changes (read before upgrading)

- **Lexical scorer.** Queries and prompts now match on *distinct, whole-token*
  terms. A small English stopword list never scores, light plural folding
  keeps `skills` ≈ `skill`, and tokenization is Unicode-aware: NFKC, every
  script's letters, numbers and marks, and character bigrams for CJK, Thai,
  Lao, Khmer and Myanmar. The 0.3 scorer counted every occurrence of every
  3+ letter substring hit, so a prompt that said "the" six times cleared the
  hook's gate. `lessons_query` rankings differ from 0.3. **The README's
  retrieval numbers were measured on the 0.2/0.3 scorer and have not been
  re-measured.**
- **Argumentless queries.** Only an empty query with no tags lists recent
  lessons. A non-empty query that yields no usable terms now matches
  nothing. Before, it returned the newest 8 lessons at score 1, logged as a
  real retrieval. The query log records `terms` (distinct terms used).
- **Hook gate.** The `MURPHYS_HOOK_MIN_SCORE` default dropped from 12 to 8.
  Scores no longer include substring and repetition inflation, so 8 (four
  distinct matching terms) keeps the old gate's intent.
- **Synced project lessons land `unreviewed`.** Whoever can write to a
  project's `LESSONS-LEARNED.jsonl` wrote them, with no curator in between.
  `lessons_query` returns them with their status, and the hook injects them
  only into sessions whose cwd is inside that project's registered root. A
  curator promotes them with the new `murphys review` command.
- **Legacy names are honoured again** (see "Migrating from muphys-law" in
  the README):
  - `MUPHYS_*` variables are read as fallbacks.
  - A pre-0.3 `~/.muphys` register is used when `~/.murphys` has none.
  - Experiments in a legacy home keep their arm salt.
  - `MUPHYS_HOME` stays exported.
- **Node ≥ 22.** Node 20 is end-of-life, and `npm test` now uses the test
  runner's default discovery instead of a quoted glob.

### Fixed

- **Lost appends.** `supersede`, `dedupe --apply` and `lessons_supersede`
  rewrote the register without a lock, so appends that landed between the
  read and the rename vanished. In a reproduction, 32 of 40 concurrent `add`
  rows survived. Now:
  - Every writer takes a shared register lock.
  - Rewrites re-append anything a lock-ignoring writer added to the old file.
  - `dedupe --apply` plans and applies in one locked rewrite.
- **Stale locks.** A crashed writer's lock whose pid was reused blocked
  `sync` forever (`skipped`, exit 0). Locks now expire by age as well as pid
  liveness. EPERM from `kill(pid, 0)` counts as alive.
- **JSONL safety.**
  - Appends add a missing trailing newline first, so a hand-edited register
    no longer fuses two rows into one unparseable line.
  - A UTF-8 BOM is stripped on every read.
  - Non-object rows are never lessons.
  - `doctor` counts unparseable lines and fails on them.
- **Supersession.**
  - An already-retired lesson can be re-pointed at a new active
    replacement; the previous pointer is kept in `supersession_history`.
  - `supersede` accepts the synthesized `ll-…` ids of rows without an
    explicit id, and stamps them into the row.
  - The replacement check reads first-wins, like every reader.
- **Explicit truncation.** Hook titles and descriptions, the hook's
  1400-character block cap (whole lessons are dropped, with a marker), and
  synced titles and descriptions all say when they were cut.
- **MCP conformance.**
  - `ping` returns `{}`.
  - Batches and non-object messages get -32600.
  - A missing method is -32600; unknown tools and bad arguments are -32602.
  - `protocolVersion` is negotiated, and `serverInfo.version` comes from
    `package.json`.
- **Embedding cache.**
  - Keyed by endpoint, model and vector dimension; a dimension change used
    to fail every query open until the cache was deleted.
  - Query vectors are no longer persisted, which grew the cache by one row
    per distinct query.
  - `data[].index` is honoured.
- **CLI.**
  - `--flag=value` works.
  - A value that starts with `--` is still a value.
  - Unknown flags are usage errors.
  - Errors print one line unless `DEBUG=1`.
  - Usage lists every command.
  - Non-numeric numeric settings fall back to defaults with a warning; a NaN
    used to disable the hook's score gate.
- **Tests** remove every temp directory they create.

### Added

- `murphys review --ids … | --project slug [--by name] [--dry-run]`.
- `doctor` and `stats` report the unreviewed count; `doctor` reports
  `unparseableLines` and `notes`.
- `MURPHYS_LOCK_WAIT_MS` and `MURPHYS_LOCK_STALE_MS`.
- `SECURITY.md`, `CONTRIBUTING.md`, and a CI workflow (Node 22 and 24).

### Known issue

- The MCP stdio server exits as soon as its request queue settles after
  stdin closes. A client that closes stdin before reading a large response
  can receive it cut off at the OS pipe buffer. MCP clients that keep stdin
  open are unaffected.

## 0.3.0 — 2026-08-19

- Renamed from **muphys-law** to **murphys-law**:
  - npm package, bin names (`murphys`, `murphys-law`), `MURPHYS_*`
    variables, the `~/.murphys` home and the MCP `serverInfo` name.
  - The CLI file keeps its old path, `bin/muphys.mjs`.
  - No fallbacks were provided for the old names; 0.4.0 adds them.
- README intro and banner rewritten; the rename itself is logged as sample
  lesson `llg-sample-0007`.
- Published to npm as `murphys-law@0.3.0`, built from commit `113d5a9`. No
  git tag was created for this release.

## 0.2.0 — 2026-08-17 (published as `muphys-law`)

- Optional embedding retrieval for `lessons_query`: hybrid ranking against
  any OpenAI-compatible endpoint. It is fail-open, cached, and records its
  retriever in the query log.
- `mcp` subcommand: `npx -y muphys-law mcp` mounts the stdio server.
- Outcome analytics: `stats --by-lesson` and doctor's failing-lesson flag.
- Two review rounds hardened the new boundaries:
  - Repeated apply ids are deduped.
  - Vector shape and finiteness are validated, including after
    quantization.
  - Persisted errors are constructed categories, never exception text.
  - The suite grew from 48 to 57 tests.
- npm `muphys-law@0.2.0` was built from `6d7bcdd`, the commit tagged `v0.2.0`.

## 0.1.0 — 2026-08-17 (published as `muphys-law`)

- First release:
  - The lessons register.
  - The MCP stdio server: `lessons_query`, `lessons_apply`,
    `lessons_candidate` and `lessons_supersede`.
  - The CLI: `add`, `query`, `supersede`, `deprecate`, `dedupe`, `sync`,
    `doctor` and `stats`.
  - The UserPromptSubmit recall hook, with experiment mode.
  - The evaluation protocol and the instruction templates.
- **Tag note:** the `v0.1.0` git tag points at `6c9e353`, but npm
  `muphys-law@0.1.0` was built from `666056c`, one commit later. That commit
  changed only npm packaging metadata (repository fields, the `files`
  whitelist, an absolute banner URL for the npm README); there were no code
  changes.
