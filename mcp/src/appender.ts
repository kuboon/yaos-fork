/**
 * Appending frames to the relay, as a device does (docs/client-remake/relay-wire.md §2.6, §3, §4, §5): a streams
 * ticket over HTTP, one socket, VAULT_READY, the APPEND frames in order, then wait for every frame's receipt. Frames on
 * one socket commit in the order sent (§5.1), so a create's ns frame always gets a lower seq than its body.
 *
 * The socket is opened by the caller (`openSocket`): in the Worker through `fetch` with `Upgrade: websocket` (so it can
 * go through the relay's service binding), in Node with the WebSocket global.
 */

import { encodeAppend, parseControl } from "../../src/engine/adapters/relayFrames";
import { normalizeBaseUrl } from "../../src/engine/adapters/relayHttp";

/** A connected socket: messages are buffered until a listener is attached. */
export interface SocketLike {
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	onMessage(listener: (data: string | ArrayBuffer | Uint8Array) => void): void;
	onClose(listener: (code: number, reason: string) => void): void;
}

export type OpenSocket = (url: string) => Promise<SocketLike>;

export interface AppendFrame {
	readonly stream: string;
	readonly clientFrameId: string;
	/** Sealed envelope bytes. */
	readonly payload: Uint8Array;
}

export interface AppendOptions {
	readonly baseUrl: string;
	readonly vaultId: string;
	/** SECRET: the device's bearer token. */
	readonly deviceToken: string;
	/** The epoch the frames were built against: the append is refused when the vault's is another. */
	readonly epoch: string;
	readonly fetch: typeof fetch;
	readonly openSocket: OpenSocket;
	readonly timeoutMs?: number;
}

export class AppendError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "AppendError";
	}
}

/** The committed seq of each frame, by clientFrameId. */
export async function appendFrames(o: AppendOptions, frames: readonly AppendFrame[]): Promise<Map<string, number>> {
	const base = normalizeBaseUrl(o.baseUrl);
	const vaultPath = `${base}/vault/${encodeURIComponent(o.vaultId)}`;
	const res = await o.fetch(`${vaultPath}/auth/ticket`, {
		method: "POST",
		headers: { Authorization: `Bearer ${o.deviceToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ purpose: "streams" }),
	});
	const body = await res.json().catch(() => null) as { ticket?: unknown; error?: unknown } | null;
	if (res.status !== 200 || typeof body?.ticket !== "string") {
		throw new AppendError(typeof body?.error === "string" ? body.error : "ticket_failed", `the relay refused a streams ticket (${res.status})`);
	}
	const url = `${vaultPath.replace(/^http/, "ws")}/ws/streams?ticket=${encodeURIComponent(body.ticket)}&streamsVersion=1`;
	const socket = await o.openSocket(url);
	const want = new Set(frames.map((f) => f.clientFrameId));
	const seqs = new Map<string, number>();
	const sendAll = (): void => {
		for (const f of frames) if (!seqs.has(f.clientFrameId)) socket.send(encodeAppend(f));
	};
	try {
		return await new Promise<Map<string, number>>((resolve, reject) => {
			let ready = false;
			const fail = (code: string, message: string): void => reject(new AppendError(code, message));
			const timer = setTimeout(() => fail("timeout", "the relay did not confirm the write in time"), o.timeoutMs ?? 30_000);
			const done = (): void => {
				clearTimeout(timer);
				resolve(seqs);
			};
			socket.onClose((code, reason) => {
				clearTimeout(timer);
				fail("closed", `the relay closed the socket (${code}${reason ? ` ${reason}` : ""})`);
			});
			socket.onMessage((data) => {
				if (typeof data !== "string") return; // binary: other devices' rows, not ours to read here
				const m = parseControl(data);
				if (!m) return;
				switch (m.type) {
					case "VAULT_READY":
						if (m.vaultEpoch !== o.epoch) return fail("epoch_changed", "the vault was reset or restored meanwhile; try again");
						if (!m.canWrite) return fail("write_forbidden", "this device may not write to the vault");
						ready = true;
						sendAll();
						return;
					case "STREAM_RECEIPTS":
						for (const r of m.receipts) if (want.has(r.clientFrameId)) seqs.set(r.clientFrameId, r.seq);
						if (seqs.size === want.size) done();
						return;
					case "STREAM_APPEND_REJECTED":
						if (want.has(m.clientFrameId)) fail(m.code, `the relay refused the write (${m.code})`);
						return;
					case "VAULT_ERROR":
						if (m.clientFrameIds.some((id) => want.has(id))) fail(m.code, `the relay could not commit the write (${m.code}); try again later`);
						return;
					case "STREAM_RESEND":
						// The relay runtime restarted: unreceipted frames may be gone. Same ids, same bytes: idempotent (§5.4).
						if (ready) sendAll();
						return;
					case "error":
						fail(m.code, `the relay refused the socket (${m.code})`);
						return;
					default:
						return;
				}
			});
		});
	} finally {
		socket.close(1000, "done");
	}
}

/** A SocketLike over a standard (browser / Node) WebSocket that is already open. */
export function wrapWebSocket(ws: WebSocket): SocketLike {
	const queued: (string | ArrayBuffer | Uint8Array)[] = [];
	let listener: ((data: string | ArrayBuffer | Uint8Array) => void) | null = null;
	ws.addEventListener("message", (e: MessageEvent) => {
		const data = e.data as string | ArrayBuffer;
		if (listener) listener(data);
		else queued.push(data);
	});
	return {
		send: (data) => ws.send(data),
		close: (code, reason) => {
			try {
				ws.close(code, reason);
			} catch {
				// already closed
			}
		},
		onMessage: (l) => {
			listener = l;
			for (const d of queued.splice(0)) l(d);
		},
		onClose: (l) => ws.addEventListener("close", (e: CloseEvent) => l(e.code, e.reason)),
	};
}

/** OpenSocket over the WebSocket constructor (Node 22+, browsers). */
export const openWithWebSocket: OpenSocket = (url) => new Promise((resolve, reject) => {
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	const wrapped = wrapWebSocket(ws);
	ws.addEventListener("open", () => resolve(wrapped), { once: true });
	ws.addEventListener("error", () => reject(new AppendError("socket_failed", "could not open the relay socket")), { once: true });
});

/** OpenSocket over `fetch` with `Upgrade: websocket` (a Cloudflare Worker, through a service binding or not). */
export function openWithFetch(doFetch: typeof fetch): OpenSocket {
	return async (url) => {
		const res = await doFetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
		const ws = (res as Response & { webSocket?: WebSocket & { accept(): void } | null }).webSocket;
		if (!ws) throw new AppendError("socket_failed", `the relay did not accept the socket (${res.status})`);
		const wrapped = wrapWebSocket(ws);
		ws.accept();
		return wrapped;
	};
}
