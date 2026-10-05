# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for anything that
could be exploited.

Include what you can: affected version, a reproduction (a minimal register,
prompt, or MCP message), and the impact you expect. You will get an
acknowledgement in the advisory thread, and fixes are released with a
changelog entry crediting the reporter unless you prefer otherwise.

## Supported versions

Only the latest release of `murphys-law` receives fixes. `muphys-law` (the
pre-0.3 package name) is deprecated; upgrade to `murphys-law`.

## Scope notes

- **Register content is injected into agent context.** The recall hook frames
  lessons as background data and folds angle brackets, which reduces but does
  not eliminate prompt-injection risk. Treat write access to the register —
  and to any project `LESSONS-LEARNED.jsonl` you sync — as write access to
  your agents' prompts. Synced project lessons land `unreviewed` and are only
  injected inside their own project until a curator runs `murphys review`.
- **Optional embeddings send text off-machine.** When
  `MURPHYS_EMBEDDINGS_URL` points at a remote service, query text and lesson
  text are sent to it. Use a local endpoint if that matters to you.
- Reports about either of these behaving differently than documented are in
  scope.
