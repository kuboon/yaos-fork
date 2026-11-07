# yaos-mcp: read a YAOS vault over remote MCP, without Obsidian

`yaos-mcp` is a Cloudflare Worker that serves one YAOS vault, read-only, as a remote MCP server (Streamable
HTTP, bearer token). It needs no Obsidian and no always-on process. Each request reads from the relay only what
changed since the previous request, and answers from that.

## How it reads the vault

The YAOS server is an opaque relay. It stores each vault as logs of changes and never interprets them (see
[docs/architecture.md](../docs/architecture.md) §3). The vault's files exist only on devices, which fold those logs.
This Worker does the same folding, on demand:

- **Files.** The `ns` stream lists every file. The Worker reads its checkpoint, then the rows after it, and folds them
  with the engine's own namespace fold (`src/core/ns/fold.ts`). That gives each path's note id.
- **Note text.** A note's `b:` stream (`c:` for a canvas) holds its Yjs history: a checkpoint, then updates. Large
  updates sit in the blob store, and the Worker fetches them from there. The Worker merges all of this into a Yjs
  document, which yields the note's text. A canvas reads as the engine's own JSON projection
  (`src/engine/reconcile/canvasDoc.ts`).
- **Caching.** What has been read stays in one Durable Object's memory. Consecutive requests therefore read only the
  rows after what the Worker already holds. An operator reset or restore starts a new epoch, and the view starts
  over.

The Worker never writes to the relay. It is paired like a device and registered under its own pairing grant, so the
console lists it and **Revoke** cuts it off.

## Limits

- **Plain vaults only.** An end-to-end encrypted vault refuses to open: the Worker holds no vault key.
- **Read-only.** Notes and canvases read as text. Attachments are listed with their size but not read.
- **Notes still arriving.** A note's create can commit before its first content does. A note that reads empty
  while it was created with content is flagged as incomplete; read it again shortly.
- **After a restore.** Right after an operator restore, a note may read with text the restore point had deleted,
  until a device has synced it again (DESIGN §c.12 "old deletes" are not re-applied here).
- **Search cost.** `search` reads every note the first time. It stops after 2,000 notes.

## Deploy

This Worker is separate from the YAOS server: it gets its own URL, such as `https://yaos-mcp.<subdomain>.workers.dev`.

### With Workers Builds (no terminal)

Cloudflare can build and deploy this Worker from the repository on every push.

1. In the Cloudflare dashboard, create a Worker named `yaos-mcp`. Under **Settings → Build**, connect it to this
   repository. Use the default branch as its production branch.
2. Set the build:

   | Setting | Value |
   |---|---|
   | Root directory | `mcp` |
   | Build command | `npm ci --prefix .. && npm ci` |
   | Deploy command | `npx cf deploy` |
   | Build variable `YAOS_RELAY_WORKER` | The relay Worker's name on the same account (for example `yaos`). Leave it unset, or `none`, when the relay runs on another account. |

3. Under **Settings → Variables and Secrets**, add `MCP_TOKEN` with type **Secret** (not under Build → Variables): a
   random string of 32 characters or more, which you make yourself. MCP clients send it, and `/setup` asks for it.
   A deploy does not need it, but the Worker refuses every request until it is set; `/healthz` shows
   `"tokenConfigured": true` once the Worker sees it; otherwise its `tokenState` says why (`missing`, `too-short`, or
   `not-a-string` for a binding of another type).
4. A push to the production branch now deploys the Worker. To deploy without a push, use **Retry build** on its
   latest build. Then pair the Worker (step 3 below).

### From a terminal

1. Install the dependencies (repository root and this folder) and deploy:

   ```sh
   npm ci && npm ci --prefix mcp
   cd mcp
   node -e "console.log('MCP_TOKEN=' + require('crypto').randomBytes(32).toString('base64url'))" > .env.production
   npx cf deploy --secrets-file .env.production
   ```

2. **If the relay runs on the same Cloudflare account,** deploy with `YAOS_RELAY_WORKER=<relay worker name>` (for
   example `yaos`). A Worker cannot fetch another Worker of its own account by URL, so this binds the relay as a
   service instead.

3. **Pair the Worker with a vault.**
   1. On a device that is already paired, open YAOS settings and choose **Pair another device**. Alternatively, open
      the server console and use **Pair a device** on the vault.
   2. Open `https://<worker>/setup`.
   3. Enter the server URL, the pairing code and the MCP token. The code works once and expires after 15 minutes.

   With curl instead of the form:

   ```sh
   curl -X POST https://<worker>/setup -H "Authorization: Bearer $MCP_TOKEN" -H "content-type: application/json" \
     -d '{"server":"https://yaos.example.workers.dev","code":"<pairing code>"}'
   ```

   To pair another vault later, add `"replace": true`, then revoke the old device in its console.

## Connect a client

Claude Code:

```sh
claude mcp add --transport http yaos https://<worker>/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

A claude.ai custom connector reserves the `Authorization` header for OAuth: give it a custom header
`X-API-Key` with the `MCP_TOKEN` value instead (the Worker accepts either header). This Worker has no OAuth.

Any MCP client that supports Streamable HTTP and custom headers works the same way.

## Tools

| Tool | What it does |
|---|---|
| `list_files` | Lists files (path, kind; size for attachments), optionally under a folder. |
| `read_file` | Reads a note or a canvas as text. Paths match the way the vault matches them (case and Unicode form). |
| `search` | Case-insensitive substring or regex search over notes and canvases. Returns matching lines. |
| `vault_info` | Which vault this is, the relay's head and the namespace position, and the number of files by kind. |

## Development

```sh
npm --prefix mcp run typecheck
npm --prefix mcp test                                  # vault view unit tests (a fake relay)
(cd server && npx wrangler dev --port 8899)            # a local relay
(cd mcp && echo "MCP_TOKEN=<32+ chars>" > .dev.vars && npx cf dev)   # the Worker, on :8787
node --import jiti/register mcp/test/e2e.ts --host http://127.0.0.1:8899
node --import jiti/register mcp/test/worker-e2e.ts --host http://127.0.0.1:8899 --mcp http://127.0.0.1:8787 --token <MCP_TOKEN>
```

The two e2e scripts each create a fresh vault with an Obsidian device (simulated, `e2e/client/fullKit.ts`):

- `e2e.ts` reads the vault from scratch through checkpoints and the blob store, then incrementally after edits, a
  rename and a delete. It checks every note and canvas against the device's disk.
- `worker-e2e.ts` pairs the running Worker through `/setup` and drives it only through MCP.
