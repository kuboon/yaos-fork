import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as Y from "yjs";
import { identityCrypto, sealEnvelope } from "../../src/core/codec/envelope";
import { encodeBodyUpdateRef, encodeCheckpointContent } from "../../src/core/codec/contents";
import { encodeNsFoldV1 } from "../../src/core/codec/nsFoldV1";
import { encodeNsOps } from "../../src/core/codec/nsOps";
import { CheckpointEncoding, CryptoSuite } from "../../src/core/envelope";
import { foldNsFrame, newNsFoldIndex, newNsFoldState } from "../../src/core/ns/fold";
import { FOLD_RULES_VERSION } from "../../src/core/limits";
import { NS_STREAM, bodyStream, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type NsOp, type StreamName, type VaultPath } from "../../src/core/types";
import type { ReadPage, RelayRow } from "../../src/ports/relay";
import type { RelayAccess } from "../src/relay";
import { EncryptedVaultError, VaultView } from "../src/vaultView";

const VAULT = "vault-under-test";
const DEVICE = "device-aaaaaaaaaaaaaa" as DeviceId;
const crypto0 = identityCrypto();
const id = (): string => randomBytes(16).toString("base64url");
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** An in-memory relay: rows per stream, an optional checkpoint per stream, pages of `pageRows` rows. */
class FakeRelay implements RelayAccess {
	readonly vaultId = VAULT;
	epoch = "epoch-1";
	seq = 0;
	reads = 0;
	readonly rows = new Map<string, RelayRow[]>();
	readonly checkpoints = new Map<string, { coversSeq: number; bytes: Uint8Array }>();
	readonly blobs = new Map<string, Uint8Array>();
	constructor(private readonly pageRows = 2) {}

	async head() {
		return { epoch: this.epoch, headSeq: this.seq };
	}

	async read(epoch: string, stream: StreamName, afterSeq: number, preferCheckpoint: boolean): Promise<ReadPage> {
		assert.equal(epoch, this.epoch);
		this.reads++;
		const ck = this.checkpoints.get(stream) ?? null;
		// R5: the checkpoint when the rows below it are gone (here: always collected), or when preferred and newer.
		const useCk = ck && (preferCheckpoint || afterSeq < ck.coversSeq) && ck.coversSeq > afterSeq ? ck : null;
		const from = useCk ? useCk.coversSeq : afterSeq;
		const all = (this.rows.get(stream) ?? []).filter((r) => r.seq > from && (!ck || r.seq > ck.coversSeq || !useCk));
		const rows = all.slice(0, this.pageRows);
		const last = rows.at(-1)?.seq ?? from;
		return { checkpoint: useCk, rows, lastSeq: this.seq, checkpointSeq: ck?.coversSeq ?? 0, gcSeq: ck?.coversSeq ?? 0, nextAfterSeq: last, more: all.length > rows.length };
	}

	async blob(address: string) {
		return this.blobs.get(address) ?? null;
	}

	async append(stream: StreamName, kind: "nsOps" | "bodyUpdate" | "bodyUpdateRef", content: Uint8Array, frameNo = 0, authorNsSeq = 0): Promise<number> {
		const seq = ++this.seq;
		const clientFrameId = id() as ClientFrameId;
		const sealed = await sealEnvelope(crypto0, {
			vaultId: VAULT,
			binding: { t: "frame", stream, deviceId: DEVICE, clientFrameId },
			inner: { kind, authorNsSeq, flags: 0, frameNo, content },
		});
		const list = this.rows.get(stream) ?? [];
		list.push({ seq, deviceId: DEVICE, clientFrameId, payload: sealed.sealed });
		this.rows.set(stream, list);
		return seq;
	}

	private nsFrameNo = 0;
	/** Every ns frame as the fold takes it (the checkpoint test folds them itself). */
	readonly nsFrames: Parameters<typeof foldNsFrame>[2][] = [];
	async ns(ops: NsOp[]): Promise<number> {
		// The author has folded every ns row so far (a delete or rename older than the entry's last touch is stale).
		const authorNsSeq = this.rows.get(NS_STREAM)?.at(-1)?.seq ?? 0;
		const frameNo = ++this.nsFrameNo;
		const seq = await this.append(NS_STREAM, "nsOps", encodeNsOps(ops), frameNo, authorNsSeq);
		const row = this.rows.get(NS_STREAM)!.at(-1)!;
		this.nsFrames.push({ seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, authorNsSeq, frameNo, ops });
		return seq;
	}

	async checkpoint(stream: StreamName, encoding: number, coversSeq: number, state: Uint8Array): Promise<void> {
		const content = encodeCheckpointContent({ encoding: encoding as never, coversSeq, foldRulesVersion: FOLD_RULES_VERSION, state });
		const sealed = await sealEnvelope(crypto0, { vaultId: VAULT, binding: { t: "checkpoint", stream, coversSeq }, inner: { kind: "checkpoint", authorNsSeq: 0, flags: 0, frameNo: 0, content } });
		this.checkpoints.set(stream, { coversSeq, bytes: sealed.sealed });
	}
}

/** A note: its ns create and its body (one Yjs update per edit). */
async function createNote(relay: FakeRelay, path: string, text: string): Promise<{ docId: DocId; doc: Y.Doc }> {
	const docId = id() as DocId;
	const bytes = new TextEncoder().encode(text);
	await relay.ns([{ t: "create", docId, kind: "markdown", path: path as VaultPath, contentHash: sha(bytes) as ContentHash, size: bytes.length }]);
	const doc = new Y.Doc();
	doc.getText("text").insert(0, text);
	await relay.append(bodyStream(docId), "bodyUpdate", Y.encodeStateAsUpdate(doc));
	return { docId, doc };
}

async function edit(relay: FakeRelay, docId: DocId, doc: Y.Doc, fn: (t: Y.Text) => void): Promise<void> {
	const before = Y.encodeStateVector(doc);
	fn(doc.getText("text"));
	await relay.append(bodyStream(docId), "bodyUpdate", Y.encodeStateAsUpdate(doc, before));
}

describe("VaultView", () => {
	it("folds the namespace and reads notes across pages, then catches up incrementally", async () => {
		const relay = new FakeRelay(2);
		const a = await createNote(relay, "A.md", "alpha\n");
		const b = await createNote(relay, "Folder/B.md", "beta\n");
		await edit(relay, a.docId, a.doc, (t) => t.insert(t.length, "more\n"));
		await relay.ns([{ t: "rename", docId: b.docId, path: "Folder/Renamed.md" as VaultPath }]);
		const view = new VaultView(relay);
		await view.refresh();
		assert.deepEqual(view.files().map((f) => f.path), ["A.md", "Folder/Renamed.md"]);
		assert.deepEqual(await view.read("A.md"), { ok: true, path: "A.md", kind: "markdown", text: "alpha\nmore\n", complete: true });

		await relay.ns([{ t: "delete", docId: a.docId, baseBodySeq: relay.seq }]);
		await edit(relay, b.docId, b.doc, (t) => t.insert(0, "# "));
		const readsBefore = relay.reads;
		await view.refresh();
		assert.deepEqual(view.files().map((f) => f.path), ["Folder/Renamed.md"]);
		assert.equal((await view.read("folder/renamed.md").then((r) => (r.ok ? r.text : r.message))), "# beta\n");
		assert.ok(relay.reads - readsBefore <= 3, `incremental: ${relay.reads - readsBefore} reads`);
		assert.equal((await view.read("A.md")).ok, false);
	});

	it("starts from checkpoints and applies only the rows after them", async () => {
		const relay = new FakeRelay(10);
		const a = await createNote(relay, "A.md", "one\n");
		await edit(relay, a.docId, a.doc, (t) => t.insert(t.length, "two\n"));
		// ns checkpoint: the fold of every ns row so far.
		const state = newNsFoldState();
		const index = newNsFoldIndex();
		for (const f of relay.nsFrames) foldNsFrame(state, index, f);
		await relay.checkpoint(NS_STREAM, CheckpointEncoding.nsFoldV1, state.coversSeq, encodeNsFoldV1(state));
		await relay.checkpoint(bodyStream(a.docId), CheckpointEncoding.yjsStateV1, relay.seq, Y.encodeStateAsUpdate(a.doc));
		await edit(relay, a.docId, a.doc, (t) => t.insert(t.length, "three\n"));
		const view = new VaultView(relay);
		await view.refresh();
		const r = await view.read("A.md");
		assert.ok(r.ok);
		assert.equal(r.text, "one\ntwo\nthree\n");
	});

	it("fetches an update stored in the blob store, and flags a note whose ref is missing", async () => {
		const relay = new FakeRelay();
		const a = await createNote(relay, "A.md", "x\n");
		const before = Y.encodeStateVector(a.doc);
		a.doc.getText("text").insert(2, "big\n");
		const update = Y.encodeStateAsUpdate(a.doc, before);
		await relay.append(bodyStream(a.docId), "bodyUpdateRef", encodeBodyUpdateRef({ hash: sha(update) as ContentHash, size: update.length }));
		const view = new VaultView(relay);
		await view.refresh();
		const missing = await view.read("A.md");
		assert.ok(missing.ok && !missing.complete && missing.text === "x\n");
		relay.blobs.set(sha(update), update);
		const found = await view.read("A.md");
		assert.ok(found.ok && found.complete && found.text === "x\nbig\n", "the missing ref is retried on the next read");
	});

	it("says a note is still arriving while its create has no body yet", async () => {
		const relay = new FakeRelay();
		const docId = id() as DocId;
		await relay.ns([{ t: "create", docId, kind: "markdown", path: "New.md" as VaultPath, contentHash: sha(new TextEncoder().encode("hi\n")) as ContentHash, size: 3 }]);
		const view = new VaultView(relay);
		await view.refresh();
		const r = await view.read("New.md");
		assert.ok(r.ok && r.text === "" && !r.complete);
	});

	it("starts over on a new epoch (an operator reset or restore)", async () => {
		const relay = new FakeRelay();
		await createNote(relay, "Old.md", "old\n");
		const view = new VaultView(relay);
		await view.refresh();
		assert.equal(view.files().length, 1);
		relay.epoch = "epoch-2";
		relay.rows.clear();
		relay.seq = 0;
		await createNote(relay, "New.md", "new\n");
		await view.refresh();
		assert.deepEqual(view.files().map((f) => f.path), ["New.md"]);
	});

	it("refuses an end-to-end encrypted vault", async () => {
		const relay = new FakeRelay();
		await createNote(relay, "A.md", "a\n");
		// Rewrite the ns row's header to suite 1 (key epoch 1): it no longer opens under suite 0.
		const row = relay.rows.get(NS_STREAM)![0]!;
		const payload = row.payload.slice();
		payload[1] = CryptoSuite.aes256gcm;
		payload[2] = 1;
		relay.rows.set(NS_STREAM, [{ ...row, payload }]);
		await assert.rejects(new VaultView(relay).refresh(), EncryptedVaultError);
	});
});
