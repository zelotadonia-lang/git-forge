# git-forge

A standalone, GitHub-compatible git forge. One Node process, standard library
only, no git binary, no network at runtime.

- Git smart HTTP at `/{owner}/{repo}.git`: upload-pack protocol v2 (v0 fallback),
  receive-pack v0. Clone, fetch, push, shallow clone, annotated tags.
- REST v3 under `/api/v3`: repositories, branches, commits, contents, labels,
  issues, comments, pull requests and squash merges.
- GraphQL v4 at `/api/graphql` and MCP at `/mcp` (session B).

## Run

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
then polls `$MAKEFUN_ENV_URL/done` until the trial ends and exits 0.
`MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry.

## Layout

- `main.ts` — entry lifecycle (bind, register, wait for done).
- `app.ts` — HTTP routing.
- `store.ts` — in-memory git objects, refs and REST resources.
- `git.ts` — pkt-line codec, packfiles, upload-pack and receive-pack.
- `rest.ts` — REST v3 handlers.
- `INTERFACE.md` — the exact interface between the build sessions.

## Tests

`../test/` holds the harness: `srv.ts` starts the forge on a local port,
`test.ts` drives it with the real `git` CLI and REST calls.

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types ../test/srv.ts &
# in another shell, with the server's port in FORGE_URL:
FORGE_URL=http://127.0.0.1:<port> node --experimental-strip-types ../test/test.ts
```

## License

MIT.
