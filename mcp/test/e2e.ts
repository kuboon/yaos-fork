/**
 * End-to-end check of the headless MCP device against a real relay (`wrangler dev` in server/):
 *
 *   node --import jiti/register mcp/test/e2e.ts --host http://127.0.0.1:8787
 *
 * A fresh vault holds one Obsidian device (a full client over a simulated Obsidian vault, e2e/client/fullKit.ts)
 * and the headless device, paired with a code exactly as `yaos-mcp pair` does, and driven only through its MCP
 * endpoint with the MCP SDK client. Checks: Obsidian -> MCP, MCP -> Obsidian (write, edit, append, move, delete),
 * concurrent edits of one note on both sides merge, and a restart of the headless device resumes its store (same
 * device id) and syncs an edit made on its disk while it was down. Exit 1 on failure.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FullClient } from "../../e2e/client/fullKit";
import { devicePairingCode, onboardVault } from "../../e2e/client/onboard";
import { HeadlessDevice } from "../src/device";
import { pair } from "../src/pair";
import { startServer } from "../src/server";
import { StateFile } from "../src/state";
import type { ToolHost } from "../src/tools";

const { values } = parseArgs({ options: { host: { type: "string" }, keep: { type: "boolean" } } });
const host = (values.host ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const work = mkdtempSync(join(tmpdir(), "yaos-mcp-e2e-"));
const lines: string[] = [];
const log = (line: string) => {
	lines.push(line);
	if (process.env.YAOS_MCP_E2E_VERBOSE) process.stderr.write(`${line}\n`);
};
const token = randomBytes(32).toString("base64url");
const port = 18000 + Math.floor(Math.random() * 1000);

function check(cond: unknown, what: string): asserts cond {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`ok - ${what}`);
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

async function startHeadless(state: StateFile, vaultDir: string) {
	const device = await HeadlessDevice.open({ vaultDir, state, log: (l) => log(`[mcp] ${l}`) });
	const toolHost: ToolHost = {
		vault: device.vault,
		status: () => device.ui.status,
		notices: () => device.ui.notices,
		brakes: () => device.ui.brakes,
		syncNow: async () => void (await device.runtime.command({ t: "reconcileNow" })),
		resolveBrake: async (brakeId, approve) => void (await device.runtime.command(approve ? { t: "approveBrake", brakeId } : { t: "rejectBrake", brakeId })),
	};
	await device.start();
	const server = await startServer({ host: toolHost, token, port, bind: "127.0.0.1", version: "e2e", log: (l) => log(`[http] ${l}`) });
	const client = new Client({ name: "e2e", version: "0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
	const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
		const r = await client.callTool({ name, arguments: args });
		const content = r.content as { type: string; text?: string }[];
		return { text: content.map((c) => c.text ?? "").join(""), isError: r.isError === true };
	};
	const stop = async () => {
		await client.close();
		await new Promise((r) => server.close(r));
		await device.stop();
	};
	return { device, call, stop };
}

async function main(): Promise<void> {
	const vault = await onboardVault(host, { devices: 1, label: "mcp", logDir: work });
	const obs = new FullClient({ name: "obs", host, vaultId: vault.vaultId, device: vault.devices[0]!, watcherDelayMs: 50 });
	obs.vault.userWrite("Welcome.md", "# Welcome\n\nwritten in Obsidian\n");
	obs.vault.userWrite("Notes/shared.md", "line 1\nline 2\nline 3\n");
	await obs.start();

	const state = new StateFile(join(work, "mcp-state"));
	const vaultDir = join(work, "mcp-vault");
	const code = await devicePairingCode(host, vault.vaultId, vault.devices[0]!.deviceToken);
	await pair({ host, pairingCode: code, deviceName: "MCP" }, state, (l) => log(`[pair] ${l}`));
	check(state.read()?.vaultId === vault.vaultId, "pair stored the vault's grant");

	let h = await startHeadless(state, vaultDir);

	// Bearer auth.
	const anon = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	check(anon.status === 401, "a request without the token is refused");

	// Obsidian -> MCP.
	const welcome = await until("Welcome.md reaches the headless device", async () => {
		const r = await h.call("read_file", { path: "Welcome.md" });
		return !r.isError && r.text;
	});
	check(welcome.includes("written in Obsidian"), "read_file returns the note written in Obsidian");
	const listed = await h.call("list_files");
	check(listed.text.includes("Notes/shared.md"), "list_files lists the vault");
	const found = await h.call("search", { query: "LINE 2" });
	check(found.text.includes("\"line\": 2"), "search finds a line case-insensitively");
	check((await h.call("read_file", { path: "../etc/passwd" })).isError, "a path outside the vault is refused");
	check((await h.call("read_file", { path: ".obsidian/app.json" })).isError, "a hidden path is refused");

	// MCP -> Obsidian.
	check(!(await h.call("write_file", { path: "Inbox/from-mcp.md", content: "hello from MCP\n" })).isError, "write_file succeeds");
	await until("Inbox/from-mcp.md reaches Obsidian", () => obs.vault.textOf("Inbox/from-mcp.md") === "hello from MCP\n");
	check(true, "a file written over MCP appears in Obsidian");
	check((await h.call("write_file", { path: "Inbox/from-mcp.md", content: "x", create_only: true })).isError, "create_only refuses an existing file");
	await h.call("append_file", { path: "Inbox/from-mcp.md", content: "appended\n" });
	await until("append reaches Obsidian", () => obs.vault.textOf("Inbox/from-mcp.md") === "hello from MCP\nappended\n");
	check(true, "append_file syncs");

	// Concurrent edits of one note: Obsidian edits line 1 while MCP edits line 3.
	await until("shared.md on the headless device", async () => !(await h.call("read_file", { path: "Notes/shared.md" })).isError);
	obs.vault.userWrite("Notes/shared.md", "line 1 (obsidian)\nline 2\nline 3\n");
	const edit = await h.call("edit_file", { path: "Notes/shared.md", old_string: "line 3", new_string: "line 3 (mcp)" });
	check(!edit.isError, "edit_file succeeds");
	const merged = "line 1 (obsidian)\nline 2\nline 3 (mcp)\n";
	await until("both edits merge in Obsidian", () => obs.vault.textOf("Notes/shared.md") === merged);
	await until("both edits merge on the headless device", async () => (await h.call("read_file", { path: "Notes/shared.md" })).text === merged);
	check(true, "concurrent edits on both sides merge into one text on both devices");

	// Move and delete.
	check(!(await h.call("move_file", { from: "Inbox/from-mcp.md", to: "Archive/from-mcp.md" })).isError, "move_file succeeds");
	await until("move reaches Obsidian", () => obs.vault.textOf("Archive/from-mcp.md") !== null && obs.vault.textOf("Inbox/from-mcp.md") === null);
	check(true, "a move over MCP is a rename in Obsidian");
	check(!(await h.call("delete_file", { path: "Welcome.md" })).isError, "delete_file succeeds");
	await until("delete reaches Obsidian", () => obs.vault.textOf("Welcome.md") === null);
	check(obs.vault.trashed.some((t) => t.path === "Welcome.md"), "a delete over MCP goes to Obsidian's trash");

	const status = JSON.parse((await h.call("sync_status")).text) as { relayConnected: boolean; phase: string };
	check(status.relayConnected, `sync_status reports the relay connected (phase ${status.phase})`);

	// Restart: the store is resumed from the journal; an edit made on disk while down syncs.
	const deviceIdBefore = state.read()?.local;
	await h.stop();
	writeFileSync(join(vaultDir, "Notes", "offline.md"), "edited while the MCP device was down\n");
	h = await startHeadless(state, vaultDir);
	check(JSON.stringify(state.read()?.local) === JSON.stringify(deviceIdBefore), "the restarted device resumes the same store (no new device registered)");
	await until("the offline edit reaches Obsidian", () => obs.vault.textOf("Notes/offline.md") === "edited while the MCP device was down\n");
	check(true, "an edit made on disk while the device was down syncs after restart");
	obs.vault.userWrite("after-restart.md", "still in sync\n");
	await until("a new Obsidian note reaches the restarted device", async () => (await h.call("read_file", { path: "after-restart.md" })).text === "still in sync\n");
	check(true, "the restarted device keeps receiving");

	await h.stop();
	await obs.stop();
}

main().then(() => {
	if (!values.keep) rmSync(work, { recursive: true, force: true });
	console.log("all checks passed");
	process.exit(0);
}, (e: unknown) => {
	console.error(e instanceof Error ? e.stack : String(e));
	console.error(`--- log tail (${work}) ---\n${lines.slice(-60).join("\n")}`);
	process.exit(1);
});
