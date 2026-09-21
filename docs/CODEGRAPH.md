# Code graph

This repository uses [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext)
as its only code graph. It indexes TypeScript, TSX, JavaScript, and Swift into a local
graph that Codex can query through MCP.

## Install

Install the pinned tool in an isolated Python environment:

```sh
uv tool install --python 3.12 codegraphcontext==0.5.1
```

Verify the installation and build the initial index:

```sh
npm run graph:doctor
npm run graph:index
npm run graph:list
```

The graph database and CodeGraphContext configuration live under
`~/.codegraphcontext/`; they are not committed. The repository exclusions live in
`.cgcignore` and must continue to cover local sessions, credentials, browser state,
and real conversation data.

## Codex integration

The project-scoped `.codex/config.toml` starts `cgc mcp start` for trusted local
checkouts. Restart Codex after installing the tool or changing the MCP configuration,
then use `/mcp` to confirm that `codegraphcontext` is connected.

For non-trivial exploration or review:

1. Query the graph for the relevant symbol or concept.
2. Inspect callers, callees, imports, and inheritance relationships.
3. Read only the returned source locations and their immediate dependencies.
4. Make the change and update the incremental index with `npm run graph:index`.
5. Query the affected relationships again before running deterministic verification.

Use `npm run graph:reindex` only when the incremental graph is stale or incorrect.
Static relationships do not capture every DOM selector, accessibility label,
string-based dispatch, or other runtime behavior, so focused tests remain required.

## Direct CLI use

```sh
cgc analyze callers <symbol>
cgc analyze calls <symbol>
cgc analyze tree <class>
cgc analyze dead-code
cgc watch .
```

`cgc watch .` is optional and long-running. Stop it when the working session ends.
