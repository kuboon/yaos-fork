/**
 * The MCP tools: reading, and creating new notes (create.ts). Each call first brings the vault view up to date with the relay (vaultView.ts refresh),
 * so a tool always answers from the vault as committed at that moment.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Created } from "./create";
import type { VaultView } from "./vaultView";

/** Default and largest number of search hits. */
export const SEARCH_DEFAULT_RESULTS = 50;
export const SEARCH_MAX_RESULTS = 500;
/** Notes search reads at most (each read is one relay request the first time). */
export const SEARCH_MAX_NOTES = 2000;

class ToolError extends Error {}

function text(value: string): CallToolResult {
	return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): CallToolResult {
	return text(JSON.stringify(value, null, 2));
}

function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	return fn().catch((e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] }));
}

function folderPrefix(folder: string | undefined): string {
	const f = (folder ?? "").normalize("NFC").replace(/^\/+|\/+$/g, "");
	return f === "" ? "" : `${f}/`;
}

/** What the tools need: the view, the device's own state for vault_info, and creating a note. */
export interface ToolHost {
	view(): Promise<VaultView>;
	info(): Promise<Record<string, unknown>>;
	create(path: string, content: string): Promise<Created>;
}

export function registerTools(server: McpServer, host: ToolHost): void {
	server.registerTool("list_files", {
		title: "List files",
		description: "Lists the vault's files (notes, canvases and attachments), optionally only those under a folder.",
		inputSchema: { folder: z.string().optional().describe("Vault folder, e.g. \"Projects\"; omit for the whole vault") },
		annotations: { readOnlyHint: true },
	}, ({ folder }) => guard(async () => {
		const view = await host.view();
		const prefix = folderPrefix(folder);
		const files = view.files().filter((f) => f.path.startsWith(prefix));
		return json({ count: files.length, files });
	}));

	server.registerTool("read_file", {
		title: "Read file",
		description: "Reads a note (.md) or canvas (.canvas) of the vault as text.",
		inputSchema: { path: z.string().describe("Vault path, e.g. \"Daily/2026-11-04.md\"") },
		annotations: { readOnlyHint: true },
	}, ({ path }) => guard(async () => {
		const view = await host.view();
		const r = await view.read(path.normalize("NFC").replace(/^\/+/, ""));
		if (!r.ok) throw new ToolError(r.message);
		return r.complete ? text(r.text) : { content: [{ type: "text", text: r.text }, { type: "text", text: "(warning: this text may be incomplete: part of the note has not reached the server yet, or could not be fetched from its attachment store; read it again shortly)" }] };
	}));

	server.registerTool("search", {
		title: "Search notes",
		description: "Full-text search over the vault's notes and canvases (case-insensitive substring, or a regular expression). Returns matching lines.",
		inputSchema: {
			query: z.string().min(1),
			regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression"),
			folder: z.string().optional(),
			max_results: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional(),
		},
		annotations: { readOnlyHint: true },
	}, ({ query, regex, folder, max_results }) => guard(async () => {
		const view = await host.view();
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
		const notes = view.files().filter((f) => f.kind !== "blob" && f.path.startsWith(prefix));
		const hits: { path: string; line: number; text: string }[] = [];
		let scanned = 0;
		outer: for (const f of notes) {
			if (scanned >= SEARCH_MAX_NOTES) break;
			scanned++;
			const r = await view.read(f.path);
			if (!r.ok) continue;
			const lines = r.text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (re ? re.test(line) : line.toLowerCase().includes(needle)) {
					hits.push({ path: f.path, line: i + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
					if (hits.length >= limit) break outer;
				}
			}
		}
		return json({ count: hits.length, truncated: hits.length >= limit || scanned < notes.length, notesScanned: scanned, hits });
	}));

	server.registerTool("create_file", {
		title: "Create note",
		description: "Creates a new note (.md) in the vault; it syncs to every device. Fails if a file already exists at the path: existing notes are never changed.",
		inputSchema: {
			path: z.string().describe("Vault path of the new note, e.g. \"Inbox/idea.md\""),
			content: z.string().describe("The note's markdown text"),
		},
	}, ({ path, content }) => guard(async () => {
		const r = await host.create(path, content);
		if (r.state === "merged") return text(`an identical note was created at ${r.path} at the same time; they are one note now`);
		if (r.path !== path.normalize("NFC").replace(/^\/+/, "")) return text(`created ${r.path} (another file took the requested path at the same moment)`);
		return text(`created ${r.path} (${r.bytes} bytes)`);
	}));

	server.registerTool("vault_info", {
		title: "Vault info",
		description: "Which vault this server reads, how far the relay's log goes, and how many files it holds.",
		annotations: { readOnlyHint: true },
	}, () => guard(async () => json(await host.info())));
}
