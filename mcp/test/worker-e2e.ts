/**
 * End-to-end check of the Worker itself (workerd, `npm --prefix mcp run dev`) against a real relay:
 *
 *   node --import jiti/register mcp/test/worker-e2e.ts --host http://127.0.0.1:8899 --mcp http://127.0.0.1:8787 --token <MCP_TOKEN>
 *
 * A fresh vault with one Obsidian device (e2e/client/fullKit.ts); the Worker is paired through POST /setup with a
 * pairing code, then driven only through its MCP endpoint with the MCP SDK client. Pass --replace when the Worker
 * already holds a pairing from an earlier run. Exit 1 on failure.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FullClient } from "../../e2e/client/fullKit";
import { devicePairingCode, onboardVault } from "../../e2e/client/onboard";

const { values } = parseArgs({ options: { host: { type: "string" }, mcp: { type: "string" }, token: { type: "string" }, replace: { type: "boolean" } } });
const host = (values.host ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const mcp = (values.mcp ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = values.token ?? process.env.YAOS_MCP_TOKEN ?? "";
const work = process.env.YAOS_MCP_E2E_DIR ?? join(tmpdir(), "yaos-mcp-e2e");
mkdirSync(work, { recursive: true });

function check(cond: unknown, what: string): asserts cond {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await fn())) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

async function main(): Promise<void> {
	const vault = await onboardVault(host, { devices: 1, label: "mcp-worker", logDir: work });
	const obs = new FullClient({ name: "obs", host, vaultId: vault.vaultId, device: vault.devices[0]!, watcherDelayMs: 50 });
	obs.vault.userWrite("Welcome.md", "# Welcome\n\nwritten in Obsidian\n");
	obs.vault.userWrite("Projects/Plan.md", "- [ ] one\n- [ ] two\n");
	await obs.start();
	await until("Obsidian device uploaded its notes", () => {
		const s = obs.ui.statuses.at(-1);
		return !!s && s.relay.connected && s.counts.outboxFrames === 0 && s.counts.unreceiptedFrames === 0;
	});

	const unauth = await fetch(`${mcp}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	check(unauth.status === 401, "/mcp without the token is refused");
	const badSetup = await fetch(`${mcp}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server: host, code: "x" }) });
	check(badSetup.status === 401, "/setup without the token is refused");

	const code = await devicePairingCode(host, vault.vaultId, vault.devices[0]!.deviceToken);
	const setup = await fetch(`${mcp}/setup`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ server: host, code, ...(values.replace ? { replace: true } : {}) }),
	});
	const setupBody = await setup.json() as { ok?: boolean; vaultId?: string; files?: number; error?: string; warning?: string };
	check(setup.status === 200 && setupBody.ok && setupBody.vaultId === vault.vaultId && setupBody.files === 2, `/setup pairs the Worker with the vault (${JSON.stringify(setupBody)})`);
	const health = await (await fetch(`${mcp}/healthz`)).json() as { paired?: boolean };
	check(health.paired === true, "/healthz reports the pairing");

	const client = new Client({ name: "worker-e2e", version: "0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(`${mcp}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await client.callTool({ name, arguments: args });
		return { text: (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
	};
	const tools = (await client.listTools()).tools.map((t) => t.name).sort();
	check(JSON.stringify(tools) === JSON.stringify(["list_files", "read_file", "search", "vault_info"]), `the Worker offers the read-only tools (${tools.join(", ")})`);
	// A just-created note may still be arriving (its create commits first): read_file says so until it is whole.
	await until("Welcome.md reads whole", async () => (await call("read_file", { path: "Welcome.md" })).text === "# Welcome\n\nwritten in Obsidian\n");
	check(true, "read_file returns the note written in Obsidian");
	check((await call("list_files", { folder: "Projects" })).text.includes("Projects/Plan.md"), "list_files lists a folder");
	check((await call("search", { query: "TWO" })).text.includes("\"line\": 2"), "search finds a line case-insensitively");
	check((await call("read_file", { path: "missing.md" })).isError, "a missing file is an error");
	const info = JSON.parse((await call("vault_info")).text) as { vaultId?: string; notes?: number; readOnly?: boolean };
	check(info.vaultId === vault.vaultId && info.notes === 2 && info.readOnly === true, "vault_info describes the vault");

	obs.vault.userWrite("Welcome.md", "# Welcome\n\nedited in Obsidian\n");
	obs.vault.userWrite("New.md", "a new note\n");
	await until("the Worker sees the edit and the new note", async () =>
		(await call("read_file", { path: "Welcome.md" })).text.includes("edited in Obsidian") && !(await call("read_file", { path: "New.md" })).isError);
	check(true, "the next request sees what Obsidian changed since");

	await client.close();
	await obs.stop();
}

main().then(() => {
	console.log("all checks passed");
	process.exit(0);
}, (e: unknown) => {
	console.error(e instanceof Error ? e.stack : String(e));
	process.exit(1);
});
