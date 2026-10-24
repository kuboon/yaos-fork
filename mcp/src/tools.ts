/**
 * The MCP tools over the headless device's vault folder. Reads come from the folder the engine keeps in sync;
 * writes are edits on this device's disk, made under the vault's lock (fsVault.ts) and announced as vault events, so
 * the engine merges them into the vault like any edit on any device (device.ts header).
 *
 * Paths are vault paths ("folder/note.md"): no leading slash, no "." or ".." segments, and nothing hidden (dot-files,
 * dot-folders, the config dir, the trash): the tools never reach outside the synced files.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { invalidVaultPath } from "../../src/host/obsidianApi";
import type { BrakeReport } from "../../src/core/types";
import type { StatusSnapshot } from "../../src/protocol/status";
import type { WriteOutcome } from "../../src/ports/vault";
import { hiddenPath, type FsVault } from "./fsVault";

/** What the tools need from the device (HeadlessDevice, or a test double). */
export interface ToolHost {
	readonly vault: FsVault;
	status(): StatusSnapshot | null;
	notices(): readonly { readonly at: string; readonly level: string; readonly code: string; readonly message: string }[];
	brakes(): readonly BrakeReport[];
	/** A full rescan now (HostRuntime.command reconcileNow). */
	syncNow(): Promise<void>;
	resolveBrake(brakeId: string, approve: boolean): Promise<void>;
}

/** Largest file read_file returns. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Default and largest number of search hits. */
export const SEARCH_DEFAULT_RESULTS = 50;
export const SEARCH_MAX_RESULTS = 500;
const SEARCHABLE = /\.(md|markdown|txt|canvas|json|csv|ya?ml)$/i;

class ToolError extends Error {}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function text(value: string): CallToolResult {
	return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): CallToolResult {
	return text(JSON.stringify(value, null, 2));
}

/** A vault path the tools may touch, or a ToolError. */
export function checkPath(path: string): string {
	const p = path.normalize("NFC");
	const bad = invalidVaultPath(p);
	if (bad) throw new ToolError(`invalid path ${JSON.stringify(path)}: ${bad}`);
	if (hiddenPath(p)) throw new ToolError(`invalid path ${JSON.stringify(path)}: hidden files and folders are not synced`);
	return p;
}

function folderPrefix(folder: string | undefined): string {
	if (folder === undefined || folder === "" || folder === "/") return "";
	return `${checkPath(folder.replace(/\/+$/, ""))}/`;
}

function failed(o: Extract<WriteOutcome, { ok: false }>, path: string): never {
	if (o.reason === "precondition") throw new ToolError(`${path} already exists`);
	throw new ToolError(`could not write ${path}: ${o.message}`);
}

async function readText(vault: FsVault, path: string): Promise<string> {
	const st = await vault.stat(path);
	if (!st) throw new ToolError(`${path} does not exist`);
	if (st.size > MAX_READ_BYTES) throw new ToolError(`${path} is ${st.size} bytes, more than read_file returns (${MAX_READ_BYTES})`);
	const bytes = await vault.readBytes(path);
	try {
		return strictUtf8.decode(bytes);
	} catch {
		throw new ToolError(`${path} is not a UTF-8 text file (${st.size} bytes)`);
	}
}

function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	return fn().catch((e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] }));
}

function count(haystack: string, needle: string): number {
	let n = 0;
	for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
	return n;
}

export function registerTools(server: McpServer, host: ToolHost): void {
	const { vault } = host;

	server.registerTool("list_files", {
		title: "List files",
		description: "Lists the synced files of the vault (path, size in bytes, modification time). Optionally only those under a folder.",
		inputSchema: { folder: z.string().optional().describe("Vault folder, e.g. \"Projects\"; omit for the whole vault") },
		annotations: { readOnlyHint: true },
	}, ({ folder }) => guard(async () => {
		const prefix = folderPrefix(folder);
		const files = (await vault.list())
			.filter((s) => s.path.startsWith(prefix))
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((s) => ({ path: s.path, size: s.size, modified: new Date(s.mtimeMs).toISOString() }));
		return json({ count: files.length, files });
	}));

	server.registerTool("read_file", {
		title: "Read file",
		description: "Reads a text file (a note, canvas, ...) of the vault.",
		inputSchema: { path: z.string().describe("Vault path, e.g. \"Daily/2026-10-24.md\"") },
		annotations: { readOnlyHint: true },
	}, ({ path }) => guard(async () => text(await readText(vault, checkPath(path)))));

	server.registerTool("write_file", {
		title: "Write file",
		description: "Creates a text file, or replaces its whole content. The change syncs to every device; concurrent edits elsewhere are merged.",
		inputSchema: {
			path: z.string().describe("Vault path, e.g. \"Inbox/idea.md\""),
			content: z.string(),
			create_only: z.boolean().optional().describe("Fail instead of replacing an existing file"),
		},
	}, ({ path, content, create_only }) => guard(async () => {
		const p = checkPath(path);
		const o = await vault.write(p, content, create_only ? { t: "absent" } : { t: "any" });
		if (!o.ok) failed(o, p);
		return text(`wrote ${p} (${o.stat.size} bytes)`);
	}));

	server.registerTool("edit_file", {
		title: "Edit file",
		description: "Replaces an exact piece of text in a text file. old_string must occur exactly once unless replace_all is set.",
		inputSchema: {
			path: z.string(),
			old_string: z.string().min(1),
			new_string: z.string(),
			replace_all: z.boolean().optional(),
		},
	}, ({ path, old_string, new_string, replace_all }) => guard(async () => {
		const p = checkPath(path);
		return vault.lock.run(async () => {
			const cur = await readText(vault, p);
			const n = count(cur, old_string);
			if (n === 0) throw new ToolError(`old_string not found in ${p}`);
			if (n > 1 && !replace_all) throw new ToolError(`old_string occurs ${n} times in ${p}; give more context or set replace_all`);
			const next = replace_all ? cur.split(old_string).join(new_string) : cur.replace(old_string, () => new_string);
			const o = await vault.writeLocked(p, next, { t: "any" });
			if (!o.ok) failed(o, p);
			return text(`edited ${p} (${n} replacement${n === 1 ? "" : "s"})`);
		});
	}));

	server.registerTool("append_file", {
		title: "Append to file",
		description: "Appends text to the end of a text file, creating it if missing.",
		inputSchema: { path: z.string(), content: z.string() },
	}, ({ path, content }) => guard(async () => {
		const p = checkPath(path);
		return vault.lock.run(async () => {
			const cur = (await vault.stat(p)) ? await readText(vault, p) : "";
			const o = await vault.writeLocked(p, cur + content, { t: "any" });
			if (!o.ok) failed(o, p);
			return text(`appended to ${p} (${o.stat.size} bytes)`);
		});
	}));

	server.registerTool("move_file", {
		title: "Move or rename file",
		description: "Moves or renames a file. Links in other notes are not rewritten.",
		inputSchema: { from: z.string(), to: z.string() },
	}, ({ from, to }) => guard(async () => {
		const f = checkPath(from);
		const t = checkPath(to);
		const o = await vault.lock.run(() => vault.renameLocked(f, t, { t: "any" }));
		if (!o.ok) throw new ToolError(o.reason === "source-missing" ? `${f} does not exist` : o.reason === "target-exists" ? `${t} already exists` : `could not move ${f}: ${o.message}`);
		return text(`moved ${f} -> ${t}`);
	}));

	server.registerTool("delete_file", {
		title: "Delete file",
		description: "Deletes a file on every device. Each device keeps a recoverable copy in its trash.",
		inputSchema: { path: z.string() },
		annotations: { destructiveHint: true },
	}, ({ path }) => guard(async () => {
		const p = checkPath(path);
		const o = await vault.lock.run(() => vault.trashLocked(p, { t: "any" }));
		if (!o.ok) throw new ToolError(o.reason === "source-missing" ? `${p} does not exist` : `could not delete ${p}: ${o.message}`);
		return text(`deleted ${p}`);
	}));

	server.registerTool("search", {
		title: "Search notes",
		description: "Full-text search over the vault's text files (case-insensitive substring, or a regular expression). Returns matching lines.",
		inputSchema: {
			query: z.string().min(1),
			regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression"),
			folder: z.string().optional(),
			max_results: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional(),
		},
		annotations: { readOnlyHint: true },
	}, ({ query, regex, folder, max_results }) => guard(async () => {
		const prefix = folderPrefix(folder);
		const limit = max_results ?? SEARCH_DEFAULT_RESULTS;
		let re: RegExp | null = null;
		if (regex) {
			try {
				re = new RegExp(query, "i");
			} catch (e) {
				throw new ToolError(`bad regular expression: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const needle = query.toLowerCase();
		const hits: { path: string; line: number; text: string }[] = [];
		const files = (await vault.list()).filter((s) => s.path.startsWith(prefix) && SEARCHABLE.test(s.path) && s.size <= MAX_READ_BYTES).sort((a, b) => a.path.localeCompare(b.path));
		outer: for (const f of files) {
			let body: string;
			try {
				body = strictUtf8.decode(await vault.readBytes(f.path));
			} catch {
				continue;
			}
			const lines = body.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (re ? re.test(line) : line.toLowerCase().includes(needle)) {
					hits.push({ path: f.path, line: i + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
					if (hits.length >= limit) break outer;
				}
			}
		}
		return json({ count: hits.length, truncated: hits.length >= limit, hits });
	}));

	server.registerTool("sync_status", {
		title: "Sync status",
		description: "The headless device's sync state: relay connection, how far it has caught up, pending uploads, safety brakes and recent notices.",
		annotations: { readOnlyHint: true },
	}, () => guard(async () => {
		const s = host.status();
		return json({
			phase: s?.phase ?? "starting",
			relayConnected: s?.relay.connected ?? false,
			caughtUp: s ? s.vaultSeq >= s.headSeq : false,
			vaultSeq: s?.vaultSeq ?? null,
			headSeq: s?.headSeq ?? null,
			bootstrap: s?.bootstrap ?? null,
			pending: s ? { outboxFrames: s.counts.outboxFrames, unreceiptedFrames: s.counts.unreceiptedFrames, diskOps: s.counts.pendingDiskOps, blobs: s.counts.pendingBlobs } : null,
			lastSyncedAt: s?.lastSyncedAtMs ? new Date(s.lastSyncedAtMs).toISOString() : null,
			e2ee: s?.e2ee ?? null,
			brake: s?.brake ?? null,
			brakes: host.brakes(),
			notices: host.notices().slice(-10),
		});
	}));

	server.registerTool("sync_now", {
		title: "Sync now",
		description: "Rescans the vault folder and reconciles it with the relay now (normally automatic).",
	}, () => guard(async () => {
		await host.syncNow();
		return text("reconcile started");
	}));

	server.registerTool("resolve_brake", {
		title: "Approve or reject a safety brake",
		description: "The engine holds a plan that would delete or replace many files until it is approved or rejected (see sync_status). Approve only when the change is intended.",
		inputSchema: { brake_id: z.string(), approve: z.boolean() },
		annotations: { destructiveHint: true },
	}, ({ brake_id, approve }) => guard(async () => {
		await host.resolveBrake(brake_id, approve);
		return text(`${approve ? "approved" : "rejected"} brake ${brake_id}`);
	}));
}
