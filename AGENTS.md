# Agent workflow

Use CodeGraphContext as the only repository code graph. Before broad file reads for
non-trivial work, query the `codegraphcontext` MCP server for the relevant symbols,
callers, callees, imports, and likely impact. Read the returned source locations and
their direct dependencies rather than scanning the whole repository.

Keep the graph current:

1. Run `npm run graph:index` after cloning or when the repository is not indexed.
2. Run `npm run graph:index` after meaningful source changes before final review.
3. Use `npm run graph:reindex` only when the incremental index appears stale or
   structurally incorrect.

Treat graph results as navigation evidence, not proof of runtime behavior. Confirm
dynamic browser selectors, Kakao accessibility labels, string-based dispatch, and
other runtime relationships with targeted source reads and tests. Never index `.gjc/`,
`.omc/`, `.oh-my-chat/`, `.oh-my-dm/`, `.env*`, browser profiles, cookies, sessions,
or real conversation data; `.cgcignore` is the authoritative exclusion list.

Use the project-local Jev harness for non-trivial implementation work:

1. Run `node --import tsx tools/jev-harness.ts preflight "<task>"` before editing.
2. Run `node --import tsx tools/jev-harness.ts triage "<task>"` when ownership, risk, or manual validation is not obvious.
3. Run `node --import tsx tools/jev-harness.ts verify "<task>"` after editing. This runs tests, typecheck, and build before asking Jev for an advisory completion judgment.

Jev is advisory. Deterministic checks, repository rules, user intent, and approval requirements remain authoritative. Never use a Jev answer alone to authorize deletion, release, external messaging, credential access, or other irreversible actions.

Never send real conversations, cookies, sessions, browser profiles, API keys, KakaoTalk accessibility dumps, `.env*`, `.gjc/`, `.omc/`, `.oh-my-chat/`, or `.oh-my-dm/` content to Jev. Keep any fixtures synthetic and sanitized.
