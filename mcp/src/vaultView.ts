/**
 * A read-only view of a vault, assembled on demand from the relay's logs (docs/architecture.md §3): the namespace
 * from the `ns` stream (checkpoint, then rows, through the engine's own fold), and a note's text from its `b:` / `c:`
 * stream (checkpoint, then Yjs updates, large ones fetched from the blob store).
 *
 * Nothing here writes to the relay. The pieces are the engine's: envelope open (src/core/codec/envelope.ts), the
 * ns checkpoint codec and fold (src/core/codec/nsFoldV1.ts, src/core/ns/fold.ts), the canvas projection
 * (src/engine/reconcile/canvasDoc.ts). What is read is kept in memory and brought up to date incrementally: each
 * call reads only the rows after what it already holds. An epoch change (an operator reset or restore) starts over.
 *
 * Plain (suite 0) vaults only: an end-to-end encrypted row does not open (EncryptedVaultError).
 *
 * Not reproduced: an epoch migration's "old deletes" (DESIGN §c.12), which devices re-apply to a note right after a
 * restore; until a device has done so, a restored note may read here with text the restore point had deleted.
 */

import * as Y from "yjs";
import { CheckpointEncoding, CryptoSuite } from "../../src/core/envelope";
import { identityCrypto, openEnvelope } from "../../src/core/codec/envelope";
import { decodeBodyUpdateRef, decodeCheckpointContent } from "../../src/core/codec/contents";
import { decodeNsFoldV1 } from "../../src/core/codec/nsFoldV1";
import { decodeNsOps } from "../../src/core/codec/nsOps";
import { bytesToHex } from "../../src/core/codec/lib0";
import { buildIndex, foldNsFrame, newNsFoldIndex, newNsFoldState } from "../../src/core/ns/fold";
import { NS_STREAM, docStream, type DeviceId, type DocId, type DocKind, type NsEntry, type NsFoldIndex, type NsFoldState, type StreamName, type VaultPath } from "../../src/core/types";
import { pathKey } from "../../src/core/paths/pathKey";
import type { ReadPage, RelayRow } from "../../src/ports/relay";
import { projectCanvasBytes } from "../../src/engine/reconcile/canvasDoc";
import type { RelayAccess } from "./relay";

const crypto0 = identityCrypto();

export class EncryptedVaultError extends Error {
	constructor() {
		super("this vault is end-to-end encrypted; the YAOS MCP serves plain vaults only");
		this.name = "EncryptedVaultError";
	}
}

export interface FileEntry {
	readonly path: string;
	readonly kind: DocKind;
	/** blob (attachment) entries: their size in bytes; notes: null (the size is only known once read). */
	readonly size: number | null;
}

export type ReadResult =
	/** complete false: part of the content has not reached the relay yet, or an update in the blob store did not fetch. */
	| { readonly ok: true; readonly path: string; readonly kind: "markdown" | "canvas"; readonly text: string; readonly complete: boolean }
	| { readonly ok: false; readonly reason: "not-found" | "attachment" | "invalid-canvas"; readonly message: string };

interface DocState {
	readonly doc: Y.Doc;
	readonly stream: StreamName;
	/** Last seq applied (checkpoint coversSeq or row seq). */
	seq: number;
	/** Body refs that did not resolve: the text lacks those updates. */
	missingRefs: number;
}

/** Docs kept in memory, least recently used dropped first. */
export const DOC_CACHE_LIMIT = 300;

const sha256Hex = async (bytes: Uint8Array): Promise<string> => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

export class VaultView {
	private epoch: string | null = null;
	private ns: NsFoldState = newNsFoldState();
	private index: NsFoldIndex = newNsFoldIndex();
	private readonly docs = new Map<DocId, DocState>();

	constructor(private readonly relay: RelayAccess) {}

	/** Catches the namespace up with the relay (and starts over on a new epoch). Returns the head seq it saw. */
	async refresh(): Promise<{ readonly epoch: string; readonly headSeq: number; readonly nsSeq: number }> {
		const { epoch, headSeq } = await this.relay.head();
		if (epoch !== this.epoch) {
			this.epoch = epoch;
			this.ns = newNsFoldState();
			this.index = newNsFoldIndex();
			this.docs.clear();
		}
		await this.readStream(NS_STREAM, this.ns.coversSeq, this.ns.coversSeq === 0, async (page) => {
			if (page.checkpoint && page.checkpoint.coversSeq > this.ns.coversSeq) {
				const state = await this.openNsCheckpoint(page.checkpoint.coversSeq, page.checkpoint.bytes);
				if (state) {
					this.ns = state;
					this.index = buildIndex(state);
				}
			}
			for (const row of page.rows) {
				if (row.seq <= this.ns.coversSeq) continue;
				const frame = await this.openNsRow(row);
				foldNsFrame(this.ns, this.index, frame);
			}
			return this.ns.coversSeq;
		});
		return { epoch, headSeq, nsSeq: this.ns.coversSeq };
	}

	/** The epoch of what this view holds (null before the first refresh). */
	get currentEpoch(): string | null {
		return this.epoch;
	}

	/** The namespace seq this view has folded through: a writer's authorNsSeq. */
	get nsSeq(): number {
		return this.ns.coversSeq;
	}

	/** Highest ns frameNo the fold accepted from `deviceId` (its replay window edge, e2ee-design §8.2), 0 if none. */
	replayEdge(deviceId: string): number {
		return this.ns.replay.get(deviceId as DeviceId)?.r ?? 0;
	}

	/** The entry of `docId`, whatever its state. Call refresh() first. */
	entryById(docId: string): NsEntry | null {
		return this.ns.entries.get(docId as DocId) ?? null;
	}

	/** Live entries, by path. Call refresh() first. */
	files(): FileEntry[] {
		const out: FileEntry[] = [];
		for (const docId of this.index.byPathKey.values()) {
			const e = this.ns.entries.get(docId);
			if (!e || e.state !== "live") continue;
			out.push({ path: e.path, kind: e.kind, size: e.kind === "blob" ? (e.blob?.size ?? e.createSize) : null });
		}
		return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	/** The live entry at `path`, matched by the fold's own path key (its case and Unicode rules). Call refresh() first. */
	entryAt(path: string): NsEntry | null {
		const docId = this.index.byPathKey.get(pathKey(path as VaultPath));
		const e = docId ? this.ns.entries.get(docId) : undefined;
		return e && e.state === "live" ? e : null;
	}

	/** A note's or canvas's current text. Call refresh() first. */
	async read(path: string): Promise<ReadResult> {
		const e = this.entryAt(path);
		if (!e) return { ok: false, reason: "not-found", message: `${path} does not exist` };
		if (e.kind === "blob") return { ok: false, reason: "attachment", message: `${path} is an attachment (${e.blob?.size ?? e.createSize} bytes), not a text file` };
		const d = await this.loadDoc(e.docId, e.kind);
		// A ref that did not resolve is retried on the next read: the doc is not kept.
		if (d.missingRefs > 0) this.docs.delete(e.docId);
		// The create commits before the note's first body frame does: an empty note created with content is still arriving.
		const arriving = (text: string) => text === "" && e.createSize > 0;
		if (e.kind === "markdown") {
			const text = d.doc.getText("text").toString();
			return { ok: true, path: e.path, kind: "markdown", text, complete: d.missingRefs === 0 && !arriving(text) };
		}
		const p = projectCanvasBytes(d.doc);
		if (!p.ok) return { ok: false, reason: "invalid-canvas", message: `${path}: ${p.reason}` };
		return { ok: true, path: e.path, kind: "canvas", text: p.text, complete: d.missingRefs === 0 && d.seq > 0 };
	}

	private async loadDoc(docId: DocId, kind: "markdown" | "canvas"): Promise<DocState> {
		let d = this.docs.get(docId);
		if (d) this.docs.delete(docId); // re-inserted below: most recently used last
		else d = { doc: new Y.Doc(), stream: docStream(kind, docId)!, seq: 0, missingRefs: 0 };
		this.docs.set(docId, d);
		while (this.docs.size > DOC_CACHE_LIMIT) {
			const oldest = this.docs.keys().next().value!;
			this.docs.get(oldest)?.doc.destroy();
			this.docs.delete(oldest);
		}
		const cur = d;
		await this.readStream(cur.stream, cur.seq, cur.seq === 0, async (page) => {
			if (page.checkpoint && page.checkpoint.coversSeq > cur.seq) {
				// A body checkpoint is a Yjs state: union it in (CRDT), whatever this doc already holds.
				const state = await this.openBodyCheckpoint(cur.stream, page.checkpoint.coversSeq, page.checkpoint.bytes);
				if (state) Y.applyUpdate(cur.doc, state);
				cur.seq = page.checkpoint.coversSeq;
			}
			for (const row of page.rows) {
				if (row.seq <= cur.seq) continue;
				const update = await this.openBodyRow(cur, row);
				if (update) Y.applyUpdate(cur.doc, update);
				cur.seq = row.seq;
			}
			return cur.seq;
		});
		return cur;
	}

	/** Pages through `stream` after `afterSeq`; `apply` returns the seq to continue after. */
	private async readStream(stream: StreamName, afterSeq: number, preferCheckpoint: boolean, apply: (page: ReadPage) => Promise<number>): Promise<void> {
		let after = afterSeq;
		let prefer = preferCheckpoint;
		for (;;) {
			const page = await this.relay.read(this.epoch!, stream, after, prefer);
			const reached = await apply(page);
			if (!page.more) return;
			after = Math.max(reached, page.nextAfterSeq);
			prefer = false;
		}
	}

	private async open(binding: Parameters<typeof openEnvelope>[1]["binding"], bytes: Uint8Array) {
		const r = await openEnvelope(crypto0, { vaultId: this.relay.vaultId, binding, bytes });
		if (!r.ok && r.header && r.header.suite !== CryptoSuite.none) throw new EncryptedVaultError();
		return r;
	}

	private async openNsCheckpoint(coversSeq: number, bytes: Uint8Array): Promise<NsFoldState | null> {
		const r = await this.open({ t: "checkpoint", stream: NS_STREAM, coversSeq }, bytes);
		if (!r.ok) return null;
		const ck = decodeCheckpointContent(r.inner.content);
		if (!ck || ck.encoding !== CheckpointEncoding.nsFoldV1 || ck.coversSeq !== coversSeq) return null;
		const state = decodeNsFoldV1(ck.state);
		return state && state.coversSeq === coversSeq ? state : null;
	}

	/** An ns row as the fold takes it; a row that does not open or decode folds as empty (DESIGN §c.3, as the engine does). */
	private async openNsRow(row: RelayRow) {
		const base = { seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId };
		const r = await this.open({ t: "frame", stream: NS_STREAM, deviceId: row.deviceId, clientFrameId: row.clientFrameId }, row.payload);
		const ops = r.ok && r.inner.kind === "nsOps" ? decodeNsOps(r.inner.content) : null;
		if (!r.ok || !ops) return { ...base, authorNsSeq: 0, frameNo: 0, ops: [] };
		return { ...base, authorNsSeq: r.inner.authorNsSeq, frameNo: r.inner.frameNo, ops };
	}

	private async openBodyCheckpoint(stream: StreamName, coversSeq: number, bytes: Uint8Array): Promise<Uint8Array | null> {
		const r = await this.open({ t: "checkpoint", stream, coversSeq }, bytes);
		if (!r.ok) return null;
		const ck = decodeCheckpointContent(r.inner.content);
		if (!ck || ck.coversSeq !== coversSeq || ck.encoding !== CheckpointEncoding.yjsStateV1) return null;
		return ck.state;
	}

	private async openBodyRow(d: DocState, row: RelayRow): Promise<Uint8Array | null> {
		const r = await this.open({ t: "frame", stream: d.stream, deviceId: row.deviceId, clientFrameId: row.clientFrameId }, row.payload);
		if (!r.ok) return null;
		if (r.inner.kind === "bodyUpdate" || r.inner.kind === "canvasUpdate") return r.inner.content;
		if (r.inner.kind !== "bodyUpdateRef") return null;
		const ref = decodeBodyUpdateRef(r.inner.content);
		// Suite 0: the blob address is the update's sha256, and the stored bytes are the update itself.
		const bytes = ref ? await this.relay.blob(ref.hash) : null;
		if (!ref || !bytes || bytes.length !== ref.size || (await sha256Hex(bytes)) !== ref.hash) {
			d.missingRefs++;
			return null;
		}
		return bytes;
	}
}
