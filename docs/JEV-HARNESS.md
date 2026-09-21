# Jev work harness

The project harness helps a work agent such as Codex combine deterministic tooling with TypeSafe Jev. Jev does not perform the work. It only returns narrow, structured judgments about ownership, risk, and evidence quality.

```bash
node --import tsx tools/jev-harness.ts preflight "Handle Instagram selector failures safely"
node --import tsx tools/jev-harness.ts triage "Handle Instagram selector failures safely"
node --import tsx tools/jev-harness.ts verify "Handle Instagram selector failures safely"
```

- `preflight` prints the branch, filtered Git status, and tracked file inventory without network access.
- `triage` asks Jev about ownership, risk, scope clarity, privacy boundaries, and manual validation.
- `verify` runs tests, typecheck, and build, then sends only a sanitized tracked diff and check statuses to Jev.

`verify` exits with status 1 when a deterministic check fails. Jev remains advisory and cannot by itself block work or authorize deletion, release, external messaging, or other irreversible actions. Untracked file contents are never transmitted.

The user environment must have an authenticated `jev` CLI. Manage questions and policy in [`.harness/questions.json`](../.harness/questions.json) and [`.harness/config.json`](../.harness/config.json).
