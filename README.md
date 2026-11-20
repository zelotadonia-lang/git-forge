# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zelotadonia-lang/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zelotadonia-lang/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process, standard library only. It serves git smart HTTP, REST v3, GraphQL v4, and MCP from the same in-memory store, with no git binary and no network at runtime. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the trial ends and exits 0. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry.

## What it serves

- Git smart HTTP at `/{owner}/{repo}.git`: upload-pack protocol v2 (v0 fallback) and receive-pack v0. Clone, fetch, push, shallow clone, annotated tags.
- REST v3 under `/api/v3`: repositories, branches, commits, contents, labels, issues, comments, pull requests, and squash merges.
- GraphQL v4 at `/api/graphql`: viewer, repository, issues, pull requests, mutations, node lookup, and introspection.
- MCP at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28, with six tools for repos, issues, and pull requests.

## Layout

- `main.ts` entry lifecycle (bind, register, wait for done).
- `app.ts` HTTP routing.
- `store.ts` in-memory git objects, refs, and REST resources.
- `git.ts` pkt-line codec, packfiles, upload-pack, and receive-pack.
- `rest.ts` REST v3 handlers.
- `graphql.ts` GraphQL parser, executor, and resolvers.
- `mcp.ts` MCP tools and JSON-RPC dispatch.
- `forge.ts` shared helpers: global ids, pull request diffs, and squash merges.
- `INTERFACE.md` the exact interface between the build sessions.

## Tests

`test/` holds the harness: `srv.ts` starts the forge on a local port, `test.ts` drives it with the real `git` CLI plus REST, GraphQL, MCP, and fuzz calls, and `run-kit-checks.ts` runs the kit's own conformance checks against a running forge.

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types test/srv.ts &
FORGE_URL=http://127.0.0.1:<port> node --experimental-strip-types test/test.ts
FORGE_URL=http://127.0.0.1:<port> node --experimental-strip-types test/run-kit-checks.ts all
```

## License

MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yk7ez00m&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
