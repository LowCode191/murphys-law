# Contributing

Thanks for helping. The project is small on purpose; contributions that keep
it that way are the easiest to merge.

- **Zero dependencies, Node ≥ 22.** `npm test` runs the whole suite with
  the built-in test runner; there is nothing to install.
- **Every behavioural fix comes with a regression test** that fails before
  the fix and passes after it. Tests create their own temp homes (set
  `MURPHYS_HOME`, never touch `~/.murphys`) and remove them when done.
- **Respect the design rules in the README.** Especially: explicit ids at
  write time, nothing is ever deleted, lossy matching never gates
  destruction, failure modes of fail-open paths are silence plus an external
  check, and truncation is always explicit.
- **Retrieval changes need numbers.** If you change the scorer or the
  hook's gates, say how you measured the effect (see `eval/PROTOCOL.md`), or
  say plainly that you didn't.
- **Never commit live register data** — real lessons, logs, or
  `projects.json` files from your own deployment.
- Small pull requests with one logical change each, and an entry under the
  unreleased section of `CHANGELOG.md` for anything user-visible.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening
an issue.
