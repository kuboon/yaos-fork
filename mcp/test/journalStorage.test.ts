import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SchemaShape, StorageDb } from "../../src/ports/storage";
import { DB_SCHEMA_VERSION, STORE, STORE_SPECS } from "../../src/engine/store/schema";
import { JournalStorage } from "../src/journalStorage";

type Kv = { readonly kv: { readonly record: { readonly k: number; readonly v: unknown; readonly g: number }; readonly key: number; readonly indexes: "byG" } };
const KV_SPECS = { kv: { keyPath: "k", indexes: { byG: { keyPath: "g", unique: false } } } } as const;

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "yaos-journal-"));
}

async function dump(db: StorageDb<Kv>): Promise<unknown[]> {
	return db.tx(["kv"], "readonly", (tx) => tx.getAll("kv"));
}

describe("JournalStorage", () => {
	it("keeps every committed tx across a reopen, and nothing of an aborted or failed one", async () => {
		const dir = tmp();
		try {
			const port = await JournalStorage.open(dir);
			const db = await port.open<Kv>("db", 1, KV_SPECS);
			await db.tx(["kv"], "readwrite", async (tx) => {
				for (let k = 0; k < 20; k++) tx.put("kv", { k, v: { bytes: new Uint8Array([k, 1, 2]), list: [k, "x"] }, g: k % 3 });
			});
			await db.tx(["kv"], "readwrite", async (tx) => {
				tx.delete("kv", 3);
				tx.deleteRange("kv", { lower: 10, upper: 14 });
			});
			await assert.rejects(db.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 100, v: null, g: 0 });
				tx.abort();
			}));
			await assert.rejects(db.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 101, v: null, g: 0 });
				throw new Error("body failed");
			}));
			// A record mutated after put is journaled as it was put (IndexedDB clones at put).
			await db.tx(["kv"], "readwrite", async (tx) => {
				const rec = { k: 50, v: "before", g: 1 };
				tx.put("kv", rec);
				(rec as { v: string }).v = "after";
			});
			const before = await dump(db);
			db.close();
			port.close();

			const again = await JournalStorage.open(dir);
			const db2 = await again.open<Kv>("db", 1, KV_SPECS);
			assert.deepEqual(await dump(db2), before);
			assert.equal(((await db2.tx(["kv"], "readonly", (tx) => tx.get("kv", 50))) as { v: string }).v, "before");
			assert.deepEqual(await db2.tx(["kv"], "readonly", (tx) => tx.getAllByIndex("kv", "byG", { lower: 2, upper: 2 })), (before as { g: number }[]).filter((r) => r.g === 2));
			db2.close();
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replays upgrades and database deletes, and runs the engine's real schema", async () => {
		const dir = tmp();
		try {
			const port = await JournalStorage.open(dir);
			const gone = await port.open<Kv>("gone", 1, KV_SPECS);
			await gone.tx(["kv"], "readwrite", async (tx) => tx.put("kv", { k: 1, v: 1, g: 1 }));
			gone.close();
			await port.deleteDatabase("gone");
			const yaos = await port.open<SchemaShape>("yaos3:v:e:i", DB_SCHEMA_VERSION, STORE_SPECS);
			await yaos.tx([STORE.meta], "readwrite", async (tx) => tx.put(STORE.meta, { key: "cursor", vaultSeq: 7, headSeqSeen: 9 }));
			yaos.close();
			port.close();

			const again = await JournalStorage.open(dir);
			assert.deepEqual(await again.listDatabases(), ["yaos3:v:e:i"]);
			const y2 = await again.open<SchemaShape>("yaos3:v:e:i", DB_SCHEMA_VERSION, STORE_SPECS);
			assert.deepEqual(await y2.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "cursor")), { key: "cursor", vaultSeq: 7, headSeqSeen: 9 });
			y2.close();
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("compacts at open: one snapshot and an empty journal, the older generation removed", async () => {
		const dir = tmp();
		try {
			for (let round = 0; round < 3; round++) {
				const port = await JournalStorage.open(dir);
				const db = await port.open<Kv>("db", 1, KV_SPECS);
				await db.tx(["kv"], "readwrite", async (tx) => tx.put("kv", { k: round, v: round, g: 0 }));
				db.close();
				port.close();
			}
			const files = readdirSync(dir).sort();
			assert.equal(files.filter((f) => f.startsWith("snapshot-")).length, 1);
			assert.equal(files.filter((f) => f.startsWith("journal-")).length, 1);
			const port = await JournalStorage.open(dir);
			const db = await port.open<Kv>("db", 1, KV_SPECS);
			assert.deepEqual((await dump(db)).map((r) => (r as { k: number }).k), [0, 1, 2]);
			db.close();
			port.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("compacts while running once the journal passes its threshold, and loses nothing", async () => {
		const dir = tmp();
		try {
			const port = await JournalStorage.open(dir, { compactBytes: 2048 });
			const db = await port.open<Kv>("db", 1, KV_SPECS);
			for (let k = 0; k < 200; k++) await db.tx(["kv"], "readwrite", async (tx) => tx.put("kv", { k, v: "x".repeat(100), g: k % 5 }));
			await db.tx(["kv"], "readwrite", async (tx) => tx.deleteRange("kv", { lower: 50, upper: 149 }));
			const gens = readdirSync(dir).filter((f) => f.startsWith("snapshot-"));
			assert.equal(gens.length, 1);
			assert.notEqual(gens[0], "snapshot-1.bin", "compacted after the one at open");
			const before = await dump(db);
			db.close();
			port.close();
			const again = await JournalStorage.open(dir);
			const db2 = await again.open<Kv>("db", 1, KV_SPECS);
			assert.deepEqual(await dump(db2), before);
			assert.equal(before.length, 100);
			db2.close();
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cuts a torn last frame (a crash mid-append) and keeps the whole ones", async () => {
		const dir = tmp();
		try {
			const port = await JournalStorage.open(dir);
			const db = await port.open<Kv>("db", 1, KV_SPECS);
			await db.tx(["kv"], "readwrite", async (tx) => tx.put("kv", { k: 1, v: "kept", g: 0 }));
			db.close();
			port.close();
			const journal = readdirSync(dir).find((f) => f.startsWith("journal-"))!;
			appendFileSync(join(dir, journal), Buffer.from([200, 0, 0, 0, 1, 2, 3]));

			const again = await JournalStorage.open(dir);
			const db2 = await again.open<Kv>("db", 1, KV_SPECS);
			assert.deepEqual(await dump(db2), [{ k: 1, v: "kept", g: 0 }]);
			await db2.tx(["kv"], "readwrite", async (tx) => tx.put("kv", { k: 2, v: "after", g: 0 }));
			db2.close();
			again.close();
			const third = await JournalStorage.open(dir);
			const db3 = await third.open<Kv>("db", 1, KV_SPECS);
			assert.deepEqual((await dump(db3)).map((r) => (r as { k: number }).k), [1, 2]);
			db3.close();
			third.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("journals an IndexedDB-style auto-commit (the body awaited something foreign)", async () => {
		const dir = tmp();
		try {
			const port = await JournalStorage.open(dir);
			const db = await port.open<Kv>("db", 1, KV_SPECS);
			await db.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 1, v: "early", g: 0 });
				await new Promise((r) => setTimeout(r, 5));
				try {
					tx.put("kv", { k: 2, v: "late", g: 0 });
				} catch {
					// tx-inactive, as IndexedDB
				}
			}).catch(() => undefined);
			db.close();
			port.close();
			const again = await JournalStorage.open(dir);
			const db2 = await again.open<Kv>("db", 1, KV_SPECS);
			assert.deepEqual(await dump(db2), [{ k: 1, v: "early", g: 0 }]);
			db2.close();
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
