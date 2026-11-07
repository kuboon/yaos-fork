/**
 * Creating a new note, the only write the reader makes. It is what any device sends for a file that appeared on its
 * disk (DESIGN §c.14 E1, §d.4 live creates): one `ns` frame with a `create` op, then the note's body as one Yjs update
 * on its `b:` stream, both on one socket so the create commits first (appender.ts).
 *
 * - The text is canonical markdown (markdown-lf-v1: one leading BOM dropped, CRLF / CR -> LF), the form devices keep
 *   in the note's Y.Text "text"; the create carries its ContentHash and byte size.
 * - The ns frame's frameNo is above both this device's stored counter and the fold's replay window for it
 *   (e2ee-design §8.2), and is stored before sending, so no frameNo is ever reused.
 * - Only a path that is free in the namespace this view folded: an existing note is never touched. A create that
 *   races another device's at the same path is decided by the fold like any device's (an identical file merges,
 *   otherwise a suffix such as "Note (2).md"); the result reports where the note ended up.
 *
 * Markdown notes up to MAX_CREATE_BYTES only: a larger body would go through the blob store, and canvases and
 * attachments are not created here.
 */

import * as Y from "yjs";
import { identityCrypto, sealEnvelope } from "../../src/core/codec/envelope";
import { encodeNsOps } from "../../src/core/codec/nsOps";
import { bytesToHex } from "../../src/core/codec/lib0";
import { newClientFrameId, newDocId } from "../../src/core/codec/ids";
import { canonicalizeMarkdown, markdownCanonicalBytes } from "../../src/core/hash/markdownLf";
import { MAX_INLINE_UPDATE_BYTES } from "../../src/core/limits";
import { pathInvalidReason } from "../../src/core/paths/validate";
import { NS_STREAM, bodyStream, kindOfPath, type ContentHash, type DeviceId, type VaultPath } from "../../src/core/types";
import { createWebRandom } from "../../src/engine/adapters/webRandom";
import { appendFrames, type AppendOptions } from "./appender";
import type { VaultView } from "./vaultView";

/** Largest note (canonical UTF-8 bytes) created inline; a larger body would need the blob store. */
export const MAX_CREATE_BYTES = 512 * 1024;

const crypto0 = identityCrypto();
const random = createWebRandom();

export class CreateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CreateError";
	}
}

export interface CreateDeps {
	readonly view: VaultView;
	readonly deviceId: string;
	/** Reserves the next ns frameNo, at least `floor` + 1, durably, and returns it. */
	reserveFrameNo(floor: number): Promise<number>;
	/** Everything appendFrames needs but the epoch, which comes from the view. */
	readonly append: Omit<AppendOptions, "epoch">;
}

export interface Created {
	/** Where the note is now: the path asked for, or another one the fold chose (a suffix after a race). */
	readonly path: string;
	readonly docId: string;
	/** live: the note exists; merged: an identical file created elsewhere at the same time absorbed it. */
	readonly state: "live" | "merged" | "deleted" | "unknown";
	readonly bytes: number;
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

export async function createNote(d: CreateDeps, rawPath: string, text: string): Promise<Created> {
	const path = rawPath.normalize("NFC").replace(/^\/+/, "");
	const bad = pathInvalidReason(path);
	if (bad) throw new CreateError(`invalid path ${JSON.stringify(rawPath)}: ${bad}`);
	if (path.split("/").some((seg) => seg.startsWith("."))) throw new CreateError(`invalid path ${JSON.stringify(rawPath)}: hidden files and folders are not synced`);
	if (kindOfPath(path as VaultPath) !== "markdown") throw new CreateError(`only notes (.md) can be created: ${path}`);
	const canonical = canonicalizeMarkdown(text);
	const bytes = markdownCanonicalBytes(canonical);
	if (bytes.length > MAX_CREATE_BYTES) throw new CreateError(`the note is ${bytes.length} bytes, more than ${MAX_CREATE_BYTES} can be created`);

	await d.view.refresh();
	const existing = d.view.entryAt(path);
	if (existing) throw new CreateError(`${existing.path} already exists; this server only creates new notes`);
	const epoch = d.view.currentEpoch!;
	const authorNsSeq = d.view.nsSeq;

	const docId = newDocId(random);
	const contentHash = (await sha256Hex(bytes)) as ContentHash;
	const nsFrameId = newClientFrameId(random);
	const frames = [];
	const frameNo = await d.reserveFrameNo(d.view.replayEdge(d.deviceId));
	const ns = await sealEnvelope(crypto0, {
		vaultId: d.append.vaultId,
		binding: { t: "frame", stream: NS_STREAM, deviceId: d.deviceId as DeviceId, clientFrameId: nsFrameId },
		inner: { kind: "nsOps", authorNsSeq, flags: 0, frameNo, content: encodeNsOps([{ t: "create", docId, kind: "markdown", path: path as VaultPath, contentHash, size: bytes.length }]) },
	});
	frames.push({ stream: NS_STREAM as string, clientFrameId: nsFrameId as string, payload: ns.sealed });
	if (canonical.length > 0) {
		// The note's whole initial content as one Yjs update of a fresh doc, as a device's first merge of a new file.
		const doc = new Y.Doc();
		doc.getText("text").insert(0, canonical);
		const update = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		if (update.length > MAX_INLINE_UPDATE_BYTES) throw new CreateError("the note is too large to create inline");
		const bodyFrameId = newClientFrameId(random);
		const stream = bodyStream(docId);
		const body = await sealEnvelope(crypto0, {
			vaultId: d.append.vaultId,
			binding: { t: "frame", stream, deviceId: d.deviceId as DeviceId, clientFrameId: bodyFrameId },
			inner: { kind: "bodyUpdate", authorNsSeq, flags: 0, frameNo: 0, content: update },
		});
		frames.push({ stream: stream as string, clientFrameId: bodyFrameId as string, payload: body.sealed });
	}
	await appendFrames({ ...d.append, epoch }, frames);

	await d.view.refresh();
	const e = d.view.entryById(docId);
	if (!e) return { path, docId, state: "unknown", bytes: bytes.length };
	const winner = e.state === "merged" && e.aliasOf ? d.view.entryById(e.aliasOf) : null;
	return { path: (winner ?? e).path, docId, state: e.state, bytes: bytes.length };
}
