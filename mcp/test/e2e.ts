/**
 * End-to-end check of the read-only reader against a real relay (`wrangler dev` in server/):
 *
 *   node --import jiti/register mcp/test/e2e.ts --host http://127.0.0.1:8787
 *
 * A fresh vault with one Obsidian device (a full client over a simulated Obsidian vault, e2e/client/fullKit.ts,
 * tuned to write checkpoints after a few rows) writes notes, a canvas, an attachment and a note large enough to go
 * through the blob store. The reader is paired as `/setup` pairs it (setup.ts) and must read back exactly what the
 * device has on disk: first from scratch (checkpoints, then rows), then incrementally after edits, a rename and a
 * delete; a second, fresh reader must agree with the first. Exit 1 on failure.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { FullClient } from "../../e2e/client/fullKit";
import { devicePairingCode, onboardVault } from "../../e2e/client/onboard";
import type { ReadPage } from "../../src/ports/relay";
import assert from "node:assert/strict";
import { openWithWebSocket } from "../src/appender";
import { createNote } from "../src/create";
import { createRelayAccess, type RelayAccess } from "../src/relay";
import { pairReader } from "../src/setup";
import { VaultView } from "../src/vaultView";

const { values } = parseArgs({ options: { host: { type: "string" } } });
const host = (values.host ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
// The relay's operator key lives in this folder's 0600 context file (onboard.ts): kept across runs, so a claimed local
// relay can make another vault.
const work = process.env.YAOS_MCP_E2E_DIR ?? join(tmpdir(), "yaos-mcp-e2e");
mkdirSync(work, { recursive: true });

function check(cond: unknown, what: string): asserts cond {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 90_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await fn())) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** The relay access, counting the checkpoints its reads returned. */
function counted(inner: RelayAccess): RelayAccess & { checkpoints: number; reads: number } {
	const c = {
		vaultId: inner.vaultId,
		checkpoints: 0,
		reads: 0,
		head: () => inner.head(),
		blob: (a: string) => inner.blob(a),
		async read(...a: Parameters<RelayAccess["read"]>): Promise<ReadPage> {
			const p = await inner.read(...a);
			c.reads++;
			if (p.checkpoint) c.checkpoints++;
			return p;
		},
	};
	return c;
}

/** Every visible file of the simulated Obsidian vault that the reader should show as text. */
function expectedTexts(obs: FullClient): Map<string, string> {
	const out = new Map<string, string>();
	for (const [path, text] of obs.vault.snapshot()) if (path.endsWith(".md") || path.endsWith(".canvas")) out.set(path, text);
	return out;
}

async function sameAsObsidian(view: VaultView, obs: FullClient): Promise<string | null> {
	await view.refresh();
	const want = expectedTexts(obs);
	const files = view.files().filter((f) => f.kind !== "blob");
	if (files.length !== want.size) return `reader lists ${files.length} notes, Obsidian has ${want.size}`;
	for (const [path, text] of want) {
		const r = await view.read(path);
		if (!r.ok) return `${path}: ${r.message}`;
		// A canvas reads as the engine's canonical projection (its own key order): compare it as data.
		const same = r.kind === "canvas" ? isDeepStrictEqual(JSON.parse(r.text), JSON.parse(text)) : r.text === text;
		if (!same) return `${path}: text differs (${r.text.length} vs ${text.length} chars)`;
		if (!r.complete) return `${path}: incomplete`;
	}
	return null;
}

async function settled(obs: FullClient): Promise<boolean> {
	const s = obs.ui.statuses.at(-1);
	return !!s && s.relay.connected && s.counts.outboxFrames === 0 && s.counts.unreceiptedFrames === 0 && s.counts.pendingBlobs === 0 && s.vaultSeq >= s.headSeq;
}

async function main(): Promise<void> {
	const vault = await onboardVault(host, { devices: 1, label: "mcp-read", logDir: work });
	const obs = new FullClient({
		name: "obs", host, vaultId: vault.vaultId, device: vault.devices[0]!, watcherDelayMs: 50,
		tuning: { checkpoint: { rows: 3, bytes: 4096, idleMs: 300, settleMs: 300, hardRows: 6, hardBytes: 64 * 1024, fallbackMs: 1000, nsRows: 3, nsBytes: 4096 } },
	});
	obs.vault.userWrite("Welcome.md", "# Welcome\n\nwritten in Obsidian\n");
	obs.vault.userWrite("Projects/Plan.md", "- [ ] one\n- [ ] two\n");
	obs.vault.userWrite("Projects/日本語のノート.md", "日本語の本文\n二行目\n");
	obs.vault.userWrite("Board.canvas", JSON.stringify({ nodes: [{ id: "a1", type: "text", text: "hello", x: 0, y: 0, width: 200, height: 60 }], edges: [] }, null, "\t"));
	obs.vault.externalWrite("assets/pixel.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
	await obs.start();
	// Many small edits: enough rows for checkpoints on ns and on the body.
	for (let i = 0; i < 12; i++) {
		obs.vault.userWrite(`Log/${String(i).padStart(2, "0")}.md`, `entry ${i}\n`);
		obs.vault.userWrite("Projects/Plan.md", `- [ ] one\n- [ ] two\n- [x] step ${i}\n`);
		await new Promise((r) => setTimeout(r, 150));
	}
	// Over the inline frame limit: the update rides the blob store, the log carries a bodyUpdateRef.
	obs.vault.userWrite("Big.md", `# Big\n${"0123456789abcdef".repeat(70_000)}\n`);
	await until("Obsidian device uploaded everything", () => settled(obs));
	await new Promise((r) => setTimeout(r, 3000)); // checkpoint settle
	await until("Obsidian device settled again", () => settled(obs));

	const code = await devicePairingCode(host, vault.vaultId, vault.devices[0]!.deviceToken);
	const id = await pairReader({ host, pairingCode: code, name: "MCP" }, fetch);
	check(id.vaultId === vault.vaultId && id.deviceToken.length >= 32, "setup pairs and registers the reader");

	const relay = counted(createRelayAccess({ baseUrl: host, vaultId: id.vaultId, deviceToken: id.deviceToken }));
	const view = new VaultView(relay);
	const first = await sameAsObsidian(view, obs);
	check(first === null, `a fresh reader reads every note and canvas exactly as Obsidian has it${first ? ` (${first})` : ""}`);
	check(relay.checkpoints > 0, `the reads used relay checkpoints (${relay.checkpoints})`);
	const files = view.files();
	check(files.some((f) => f.path === "assets/pixel.png" && f.kind === "blob" && f.size === 11), "attachments are listed with their size");
	check(!(await view.read("assets/pixel.png")).ok, "an attachment is not read as text");
	const folded = await view.read("projects/plan.md");
	const nfd = await view.read("Projects/日本語のノート.md".normalize("NFD"));
	check(folded.ok && folded.path === "Projects/Plan.md" && nfd.ok, "paths match by the vault's own path key (case and Unicode form)");
	const big = await view.read("Big.md");
	check(big.ok && big.text.length > 1_000_000 && big.complete, "a note stored through the blob store reads whole");

	// Incremental: edits, a rename and a delete on the Obsidian side.
	const readsBefore = relay.reads;
	obs.vault.userWrite("Welcome.md", "# Welcome\n\nedited in Obsidian\n");
	obs.vault.userRename("Projects/Plan.md", "Archive/Plan.md");
	obs.vault.userDelete("Log/00.md");
	await until("Obsidian device uploaded the changes", async () => (await settled(obs)) && obs.vault.textOf("Archive/Plan.md") !== null);
	await new Promise((r) => setTimeout(r, 500));
	await until("the reader catches up", async () => (await sameAsObsidian(view, obs)) === null, 30_000);
	check(true, "after an edit, a rename and a delete, the same reader catches up");
	check(view.entryAt("Projects/Plan.md") === null && view.entryAt("Archive/Plan.md") !== null, "the rename moved the note");
	check(relay.reads - readsBefore < 40, `catching up read only what changed (${relay.reads - readsBefore} reads)`);

	const second = new VaultView(createRelayAccess({ baseUrl: host, vaultId: id.vaultId, deviceToken: id.deviceToken }));
	const again = await sameAsObsidian(second, obs);
	check(again === null, `a second fresh reader agrees${again ? ` (${again})` : ""}`);

	// Creating notes (the one write): it reaches the Obsidian device's disk, and existing paths are refused.
	let frameNo = 0;
	const deps = {
		view, deviceId: id.deviceId,
		reserveFrameNo: async (floor: number) => (frameNo = Math.max(frameNo, floor) + 1),
		append: { baseUrl: host, vaultId: id.vaultId, deviceToken: id.deviceToken, fetch, openSocket: openWithWebSocket },
	};
	const made = await createNote(deps, "Inbox/from-mcp.md", "# From MCP\r\n\r\ncreated by the reader\r\n");
	check(made.state === "live" && made.path === "Inbox/from-mcp.md", `create_file commits a live note (${JSON.stringify(made)})`);
	await until("the new note reaches Obsidian", () => obs.vault.textOf("Inbox/from-mcp.md") === "# From MCP\n\ncreated by the reader\n");
	check(true, "the new note appears on the Obsidian device's disk with its text (line endings canonical)");
	const back = await view.read("Inbox/from-mcp.md");
	check(back.ok && back.complete && back.text === "# From MCP\n\ncreated by the reader\n", "the reader reads its own note back");
	const empty = await createNote(deps, "Inbox/empty.md", "");
	await until("the empty note reaches Obsidian", () => obs.vault.textOf("Inbox/empty.md") === "");
	check(empty.state === "live", "an empty note is created too");
	await assert.rejects(createNote(deps, "Welcome.md", "x"), /already exists/);
	await assert.rejects(createNote(deps, "welcome.MD", "x"), /already exists/);
	check(true, "a path that exists (in any case) is refused, and the existing note is untouched");
	check(obs.vault.textOf("Welcome.md")?.includes("edited in Obsidian"), "the existing note kept its text");
	await assert.rejects(createNote(deps, "pic.png", "x"), /only notes/);
	await assert.rejects(createNote(deps, ".obsidian/x.md", "x"), /invalid path/);
	check(true, "non-notes and hidden paths are refused");
	for (let i = 0; i < 3; i++) await createNote(deps, `Inbox/burst-${i}.md`, `burst ${i}\n`);
	await until("three more notes reach Obsidian", () => [0, 1, 2].every((i) => obs.vault.textOf(`Inbox/burst-${i}.md`) === `burst ${i}\n`));
	check(frameNo >= 5, `consecutive creates use increasing frameNos (${frameNo})`);
	await new Promise((r) => setTimeout(r, 1500));
	const third = new VaultView(createRelayAccess({ baseUrl: host, vaultId: id.vaultId, deviceToken: id.deviceToken }));
	const final = await sameAsObsidian(third, obs);
	check(final === null, `a fresh reader agrees with Obsidian after the creates${final ? ` (${final})` : ""}`);
	// The created note is an ordinary note on the device: an edit there syncs back like any other.
	obs.vault.userWrite("Inbox/from-mcp.md", "# From MCP\n\ncreated by the reader\nedited in Obsidian\n");
	await until("the device's edit of the created note reaches the reader", async () => {
		await third.refresh();
		const r = await third.read("Inbox/from-mcp.md");
		return r.ok && r.text.endsWith("edited in Obsidian\n");
	});
	check(true, "an Obsidian edit of a note created over MCP syncs back");
	const status = obs.ui.statuses.at(-1);
	check(status?.counts.quarantinedRows === 0 && status.counts.frozenDocs === 0, `the Obsidian device quarantined no row and froze no doc (${status?.counts.quarantinedRows}, ${status?.counts.frozenDocs})`);

	await obs.stop();
}

main().then(() => {
	console.log("all checks passed");
	process.exit(0);
}, (e: unknown) => {
	console.error(e instanceof Error ? e.stack : String(e));
	process.exit(1);
});
