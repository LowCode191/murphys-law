# Lessons-lookup instruction block (template)

Paste into each agent's standing instructions (AGENTS.md / system prompt).
Name the *exact callable tool names your harness exposes* — instruction blocks
that hedge the name ("use the lessons tool if available") measurably don't get
followed. And know that this pull-based discipline alone is weak; the recall
hook (push) is the reliable delivery path. Ship both.

---

### Lessons Learned Lookup (required)

- Before starting any non-trivial task, query the lessons register
  (`lessons_query`) with the task goal, domain, and likely failure modes.
- If retrieved lessons influenced the work, declare it with `lessons_apply`,
  including the lesson ids — and set `outcome`
  (worked | partial | failed | unknown) once the result is observable.
- If the task produced a reusable lesson, submit it via `lessons_candidate`
  for curator review; set `project: <slug>` when it is project-specific.
  Never append to the register directly.
- When working inside a registered project, you may also capture
  project-scoped lessons by appending to `<project-root>/LESSONS-LEARNED.jsonl`
  (one JSON object per line: `{title, description, [date], [tags],
  [evidence]}`); `murphys sync` feeds them into the register deterministically, as
  `unreviewed` rows that are injected only inside that project until a curator
  runs `murphys review`.
- If the lessons tools are missing or denied, say so explicitly in your final
  response so the tool-surface gap is visible.
