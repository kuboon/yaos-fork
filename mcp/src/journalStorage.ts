/**
 * A persistent StoragePort for the headless device: the simulator's in-memory port (src/sim/storage.ts, the
 * IndexedDB-semantics implementation that passes the storage conformance suite) made durable by a write-ahead
 * journal and snapshots in one directory.
 *
 *  - Every successful open (with its store specs) and deleteDatabase is appended to the journal after it happened.
 *  - The writes of a readwrite tx are recorded as the body issues them (serialized at the call, as IndexedDB clones
 *    at put) and appended from the port's commit hook, just before the commit is installed: a tx is in the journal
 *    exactly when it committed, IDB-style auto-commits included. A failed append refuses the commit ("quota").
 *  - Readwrite txs on one database never overlap (the port runs them one at a time and defers the whole body), so
 *    the hook's tx is the one whose body started last on that database.
 *  - `snapshot-<gen>.bin` holds the whole committed state; `journal-<gen>.log` the entries after it. Compaction
 *    writes snapshot gen+1 (temp + rename), then starts journal gen+1 and removes the older files; loading takes the
 *    newest snapshot and only its own journal, so a crash anywhere in between replays nothing twice. A torn last
 *    frame (a crash mid-append) is cut off at load.
 *
 * Frames: 4-byte little-endian length, then a v8.serialize payload. Process crashes lose nothing committed; the
 * appends are not fsynced, so an OS crash can lose the last commits (IndexedDB gives no more on most platforms).
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import type { Unsubscribe } from "../../src/ports/common";
import type { KeyRange, SchemaShape, StorageDb, StorageFailure, StorageKey, StoragePort, StorageTx, StoreName, StoreSpec } from "../../src/ports/storage";
import { MemStoragePort } from "../../src/sim/storage";

type Op =
	| { readonly o: "put"; readonly s: string; readonly v: Uint8Array }
	| { readonly o: "del"; readonly s: string; readonly k: StorageKey }
	| { readonly o: "range"; readonly s: string; readonly r: KeyRange };

type Entry =
	| { readonly t: "open"; readonly db: string; readonly version: number; readonly stores: Readonly<Record<string, StoreSpec>> }
	| { readonly t: "drop"; readonly db: string }
	| { readonly t: "tx"; readonly db: string; readonly ops: readonly Op[] };

/** Compact once the journal passes this many bytes (checked at commits; JournalStorage.open's default). */
export const COMPACT_JOURNAL_BYTES = 64 * 1024 * 1024;

const SNAPSHOT_RE = /^snapshot-(\d+)\.bin$/;

function frame(entry: Entry): Buffer {
	const payload = serialize(entry);
	const head = Buffer.alloc(4);
	head.writeUInt32LE(payload.byteLength, 0);
	return Buffer.concat([head, payload]);
}

/** The whole entries of a journal file and the byte length they cover (a torn tail is not covered). */
function readJournal(path: string): { entries: Entry[]; goodBytes: number } {
	if (!existsSync(path)) return { entries: [], goodBytes: 0 };
	const buf = readFileSync(path);
	const entries: Entry[] = [];
	let at = 0;
	while (at + 4 <= buf.byteLength) {
		const len = buf.readUInt32LE(at);
		if (at + 4 + len > buf.byteLength) break;
		try {
			entries.push(deserialize(buf.subarray(at + 4, at + 4 + len)) as Entry);
		} catch {
			break;
		}
		at += 4 + len;
	}
	return { entries, goodBytes: at };
}

async function replay(mem: MemStoragePort, entries: readonly Entry[]): Promise<void> {
	const handles = new Map<string, StorageDb<SchemaShape>>();
	const handle = async (db: string): Promise<StorageDb<SchemaShape>> => {
		let h = handles.get(db);
		if (!h) {
			h = await mem.open<SchemaShape>(db, Math.max(1, mem.version(db)), {});
			handles.set(db, h);
		}
		return h;
	};
	for (const e of entries) {
		if (e.t === "open") {
			handles.get(e.db)?.close();
			handles.delete(e.db);
			(await mem.open<SchemaShape>(e.db, e.version, e.stores)).close();
		} else if (e.t === "drop") {
			handles.get(e.db)?.close();
			handles.delete(e.db);
			await mem.deleteDatabase(e.db);
		} else {
			const stores = [...new Set(e.ops.map((op) => op.s))];
			if (stores.length === 0) continue;
			const h = await handle(e.db);
			await h.tx(stores, "readwrite", async (tx) => {
				for (const op of e.ops) {
					if (op.o === "put") tx.put(op.s, deserialize(op.v) as object);
					else if (op.o === "del") tx.delete(op.s, op.k);
					else tx.deleteRange(op.s, op.r);
				}
			});
		}
	}
	for (const h of handles.values()) h.close();
}

export class JournalStorage implements StoragePort {
	/** Database name -> the writes of the readwrite body running on it now. */
	private readonly running = new Map<string, Op[]>();
	private fd: number;
	private journalBytes: number;

	private constructor(private readonly dir: string, private mem: MemStoragePort, private gen: number, private readonly compactBytes: number) {
		this.fd = openSync(this.journalPath(gen), "a");
		this.journalBytes = 0;
		mem.setCommitHook((info) => {
			const ops = this.running.get(info.db);
			this.running.delete(info.db);
			if (!ops || ops.length === 0) return "commit";
			try {
				if (this.journalBytes >= this.compactBytes) this.compact();
				this.append({ t: "tx", db: info.db, ops });
				return "commit";
			} catch {
				return "quota";
			}
		});
	}

	/** Loads the newest snapshot and its journal from `dir` (created if missing), then compacts. */
	static async open(dir: string, options: { readonly compactBytes?: number } = {}): Promise<JournalStorage> {
		mkdirSync(dir, { recursive: true });
		const gens = readdirSync(dir).map((f) => SNAPSHOT_RE.exec(f)?.[1]).filter((g): g is string => g !== undefined).map(Number).sort((a, b) => b - a);
		const gen = gens[0] ?? 0;
		const snapPath = join(dir, `snapshot-${gen}.bin`);
		const state = existsSync(snapPath) ? (deserialize(readFileSync(snapPath)) as { state: unknown[] }).state : [];
		const mem = MemStoragePort.fromCommittedState(state);
		const journal = join(dir, `journal-${gen}.log`);
		const { entries, goodBytes } = readJournal(journal);
		if (existsSync(journal)) truncateSync(journal, goodBytes);
		await replay(mem, entries);
		const port = new JournalStorage(dir, mem, gen, options.compactBytes ?? COMPACT_JOURNAL_BYTES);
		port.compact();
		return port;
	}

	private journalPath(gen: number): string {
		return join(this.dir, `journal-${gen}.log`);
	}

	private append(entry: Entry): void {
		const bytes = frame(entry);
		writeSync(this.fd, bytes);
		this.journalBytes += bytes.byteLength;
	}

	/** Snapshot of the committed state as gen+1, then an empty journal for it; older files go. Synchronous. */
	private compact(): void {
		const next = this.gen + 1;
		const tmp = join(this.dir, `snapshot-${next}.tmp`);
		writeFileSync(tmp, serialize({ state: this.mem.committedState() }));
		const fd = openSync(tmp, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, join(this.dir, `snapshot-${next}.bin`));
		closeSync(this.fd);
		this.fd = openSync(this.journalPath(next), "w");
		this.journalBytes = 0;
		for (const f of readdirSync(this.dir)) {
			const m = /^(?:snapshot|journal)-(\d+)\.(?:bin|log)$/.exec(f);
			if (m && Number(m[1]) < next) rmSync(join(this.dir, f), { force: true });
		}
		this.gen = next;
	}

	async open<S extends SchemaShape>(name: string, version: number, stores: Readonly<Record<StoreName<S>, StoreSpec>>): Promise<StorageDb<S>> {
		const db = await this.mem.open<S>(name, version, stores);
		this.append({ t: "open", db: name, version, stores });
		return this.wrapDb(db);
	}

	async deleteDatabase(name: string): Promise<void> {
		await this.mem.deleteDatabase(name);
		this.append({ t: "drop", db: name });
	}

	listDatabases(): Promise<readonly string[]> {
		return this.mem.listDatabases();
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}

	/** Closes the journal (process exit). Later calls fail. */
	close(): void {
		this.mem.setCommitHook(() => "crash-before");
		closeSync(this.fd);
	}

	private wrapDb<S extends SchemaShape>(db: StorageDb<S>): StorageDb<S> {
		return {
			name: db.name,
			close: () => db.close(),
			onLost: (listener: (failure: StorageFailure) => void): Unsubscribe => db.onLost(listener),
			tx: <T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T> =>
				db.tx(stores, mode, (inner) => {
					if (mode === "readonly") return body(inner);
					const ops: Op[] = [];
					this.running.set(db.name, ops);
					return body(recordingTx(inner, ops));
				}),
		};
	}
}

/** `inner` with every write that it accepted recorded into `ops`. */
function recordingTx<S extends SchemaShape>(inner: StorageTx<S>, ops: Op[]): StorageTx<S> {
	return {
		get: (store, key) => inner.get(store, key),
		getAll: (store, range, limit) => inner.getAll(store, range, limit),
		getAllKeys: (store, range, limit) => inner.getAllKeys(store, range, limit),
		getAllByIndex: (store, index, range, limit) => inner.getAllByIndex(store, index, range, limit),
		count: (store, range) => inner.count(store, range),
		countByIndex: (store, index, range) => inner.countByIndex(store, index, range),
		put: (store, record) => {
			inner.put(store, record);
			ops.push({ o: "put", s: store, v: serialize(record) });
		},
		delete: (store, key) => {
			inner.delete(store, key);
			ops.push({ o: "del", s: store, k: structuredClone(key) });
		},
		deleteRange: (store, range) => {
			inner.deleteRange(store, range);
			ops.push({ o: "range", s: store, r: structuredClone(range) });
		},
		abort: () => inner.abort(),
	};
}
