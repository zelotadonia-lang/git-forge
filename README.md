# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library
only. No git binary, no outside service, no proxy: everything it serves comes
from its own in-memory store.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (with
  a v0 fallback) and receive-pack v0. Packfiles are built and parsed by hand
  (SHA-1 objects, OFS/REF deltas on receive, plain objects on fetch).
  Fast-forward-only pushes, per-ref report-status, shallow clones.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merges.
- **GraphQL v4** at `/api/graphql`: a hand-written parser and executor for
  the documents `gh` and `github-mcp-server` send, including introspection,
  batched operations and cursor pagination.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28`, with six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the
  same store as REST.

## Running it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, then polls `$MAKEFUN_ENV_URL/done` until the trial ends
and exits 0. It needs `MAKEFUN_SHOP_TOKEN` in its environment: every API
call arrives with `Authorization: Bearer <that token>`, and a request
without it is refused with 401.

For local checks, set the token yourself and point a client at the port the
process prints:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

## Layout

- `main.ts`: the entry/env lifecycle. Bind, register, poll `/done`, exit.
- `app.ts`: the HTTP server. Routing, body limits, auth, JSON replies.
- `store.ts`: the in-memory store. Repositories, git objects, refs, issues
  and pull requests, plus the git object model (commit/tree/tag parsing,
  reachability, fast-forward checks).
- `git.ts`: pkt-line framing, packfile parsing and generation, upload-pack
  and receive-pack.
- `rest.ts`: the REST v3 handlers, including contents commits and squash
  merges with conflict detection.
- `graphql.ts`: the GraphQL parser and executor.
- `mcp.ts`: the MCP endpoint and its six tools.

## Security notes

Request bodies are capped at 64 MiB. Inflated pack entries and delta
targets are capped at 64 MiB, delta chains are cycle-checked, and every
object a push carries is hash-verified before it is stored. There is no
`exec`, no `eval`, and no filesystem access driven by client input; content
paths live in the in-memory store, so path traversal has nowhere to go.

## License

MIT. See `LICENSE`.
