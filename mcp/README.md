# yaos-mcp: read and write a YAOS vault over remote MCP, without Obsidian

`yaos-mcp` is a headless YAOS device. You pair it with a vault like any other device. It keeps a synced copy of the
vault in a folder, and serves that folder to AI clients as a remote MCP server over Streamable HTTP with a bearer
token.

It runs the plugin's own engine (`src/engine`) and host runtime (`src/host/hostRuntime.ts`) in Node, with Node
stand-ins for Obsidian (`src/fsVault.ts`) and IndexedDB (`src/journalStorage.ts`). It is not a separate
implementation of the sync protocol.

## How edits merge (CRDT)

The server is an opaque relay, and all merging happens on devices. This device is one of them:

- **Remote changes** arrive as Yjs updates. The engine merges them and writes the result into the vault folder.
- **An MCP write** (`write_file`, `edit_file`, ...) is an edit on this device's disk. The engine handles it like an
  edit any other program makes to an Obsidian vault:
  - It compares the file with the last synced version (three trees: remote, local and synced).
  - It applies the difference to the note's Yjs document as a minimal diff3 (DESIGN §f.3).
  - It sends the result to the relay.
- **Concurrent edits** on other devices merge character by character.
- **Engine disk writes** carry a precondition, so they never overwrite an MCP write they have not seen. The engine
  re-reads the file and merges instead.
- **Renames and deletes** go through the namespace fold, the same as on every device. A delete leaves a recoverable
  copy in each device's trash.

## Limits

- **Plain vaults only.** End-to-end encrypted (suite 1) vaults are refused: this device is pinned to suite 0 and
  holds no vault key.
- **Text files only.** The tools read and write UTF-8 text files: notes, canvases, JSON and similar. Attachments
  still sync into the vault folder, but no tool reads them.
- **No settings sync.** The device does not sync Obsidian settings.

## Install

The package is built from this repository. Node 22 or later is required.

```sh
npm ci                 # repository root (the shared sources and esbuild)
npm ci --prefix mcp
npm --prefix mcp run build      # -> mcp/dist/yaos-mcp.mjs (one file; copy it anywhere with Node)
```

## Pair

1. On a device that is already paired, open YAOS settings and choose **Pair another device**. Alternatively, open
   the server console and use **Pair a device** on the vault.
2. Copy the pairing code. A code works once and expires after 15 minutes.
3. Run:

```sh
node mcp/dist/yaos-mcp.mjs pair --server https://yaos.example.workers.dev --code <pairing code> --name "MCP" --state ./yaos-mcp-state
```

The state folder holds the pairing grant (`device.json`, mode 0600), the local store and the side files. Keep it
private. To unpair, revoke the device in the console and delete the folder.

## Serve

```sh
export YAOS_MCP_TOKEN=$(node mcp/dist/yaos-mcp.mjs token)   # keep it; clients send it
node mcp/dist/yaos-mcp.mjs serve --state ./yaos-mcp-state --port 8787
```

| Option | Environment | Default |
|---|---|---|
| `--state <dir>` | `YAOS_MCP_STATE` | `./yaos-mcp-state` |
| `--vault <dir>` | `YAOS_MCP_VAULT` | `<state>/vault` |
| `--port <n>` | `YAOS_MCP_PORT` | `8787` |
| `--bind <addr>` | `YAOS_MCP_BIND` | `127.0.0.1` |
| (none) | `YAOS_MCP_TOKEN` | required, 32 characters or more |

- **Endpoint.** The MCP endpoint is `/mcp`. `/healthz` answers without a token.
- **Exposing it.** The server speaks plain HTTP. To reach it from outside the machine, put it behind TLS (a reverse
  proxy, Cloudflare Tunnel, Tailscale and so on), because every request carries the token.
- **Lifetime.** Keep the process running, for example under systemd or Docker. While it runs, the folder stays in
  sync.
- **Editing the folder directly.** Other programs may edit the vault folder too. The device notices their edits
  through a file watcher and a periodic full scan.

### Connect a client

Claude Code:

```sh
claude mcp add --transport http yaos https://mcp.example.com/mcp --header "Authorization: Bearer $YAOS_MCP_TOKEN"
```

Any MCP client that supports Streamable HTTP and custom headers works the same way. A claude.ai custom connector
needs OAuth, which this server does not offer yet.

## Tools

| Tool | What it does |
|---|---|
| `list_files` | Lists files (path, size, modified time), optionally under a folder. |
| `read_file` | Reads a text file. |
| `write_file` | Creates or replaces a file. With `create_only`, it refuses to replace an existing file. |
| `edit_file` | Replaces an exact string. The string must occur once, unless `replace_all` is set. |
| `append_file` | Appends text, creating the file if missing. |
| `move_file` | Moves or renames a file. Links in other notes are not rewritten. |
| `delete_file` | Deletes a file. Each device keeps a copy in its trash. |
| `search` | Case-insensitive substring or regex search over text files. Returns matching lines. |
| `sync_status` | Relay connection, catch-up position, pending uploads, safety brakes and notices. |
| `sync_now` | Rescans and reconciles now. |
| `resolve_brake` | Approves or rejects a held plan that would delete or replace many files. |

- **Allowed paths.** Paths are vault paths such as `Daily/2026-10-24.md`. Hidden paths (dot-files, `.obsidian`,
  `.trash`) and `..` are refused.
- **Serialized writes.** All writes from the tools and from the engine run under one lock, so a read-modify-write
  (`edit_file`, `append_file`) never interleaves with an engine write.

## Development

```sh
npm --prefix mcp run typecheck
npm --prefix mcp test                          # journal storage unit tests
(cd server && npx wrangler dev --port 8787)    # a local relay, in another shell
node --import jiti/register mcp/test/e2e.ts --host http://127.0.0.1:8787
```

The e2e test creates a fresh vault and adds two devices to it: an Obsidian device (simulated, from
`e2e/client/fullKit.ts`) and this device. It drives this device only through MCP. It checks:

- sync in both directions;
- concurrent edits of one note merging;
- move and delete;
- token checks and path checks;
- after a restart, the device resumes the same store and syncs edits made while it was down.
