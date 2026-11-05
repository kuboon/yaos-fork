/**
 * What the read-only reader needs from the relay, over its HTTP routes only (no streams socket): the vault's current
 * epoch and head, paged stream reads, and blob GETs. Authenticated as one registered device (its bearer token).
 *
 * Reads go through the engine's own HTTP adapter (src/engine/adapters/relayHttp.ts), so the binary read reply is
 * decoded exactly as on every device. `fetch` may be a service binding's, for a relay Worker on the same account.
 */

import type { ReadPage } from "../../src/ports/relay";
import type { StreamName } from "../../src/core/types";
import { createRelayHttp, normalizeBaseUrl } from "../../src/engine/adapters/relayHttp";

export interface RelayAccess {
	readonly vaultId: string;
	/** The vault's current epoch and head seq (relay-wire §1: seqs mean nothing across epochs). */
	head(): Promise<{ readonly epoch: string; readonly headSeq: number }>;
	read(epoch: string, stream: StreamName, afterSeq: number, preferCheckpoint: boolean): Promise<ReadPage>;
	/** A blob's bytes by address, null when the store has none (or there is no store). */
	blob(address: string): Promise<Uint8Array | null>;
}

export class RelayError extends Error {
	constructor(readonly status: number, readonly code: string | null, message: string) {
		super(message);
		this.name = "RelayError";
	}
}

export interface RelayOptions {
	readonly baseUrl: string;
	readonly vaultId: string;
	/** SECRET: the registered device's bearer token. */
	readonly deviceToken: string;
	readonly fetch?: typeof fetch;
}

export function createRelayAccess(o: RelayOptions): RelayAccess {
	const base = normalizeBaseUrl(o.baseUrl);
	const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));
	const http = createRelayHttp({ baseUrl: base, credential: o.deviceToken, fetch: doFetch });
	const auth = { Authorization: `Bearer ${o.deviceToken}` };
	const vaultPath = (rest: string) => `${base}/vault/${encodeURIComponent(o.vaultId)}${rest}`;
	return {
		vaultId: o.vaultId,
		async head() {
			// One feed entry is enough: the reply names the epoch and the head (relay-wire §6).
			const res = await doFetch(vaultPath("/streams/feed?after=0&limit=1"), { headers: auth });
			const body = await res.json().catch(() => null) as { vaultEpoch?: unknown; head?: unknown; error?: unknown } | null;
			if (res.status !== 200 || !body || typeof body.vaultEpoch !== "string" || typeof body.head !== "number") {
				const code = body && typeof body.error === "string" ? body.error : null;
				throw new RelayError(res.status, code, `relay feed failed (${res.status}${code ? ` ${code}` : ""})`);
			}
			return { epoch: body.vaultEpoch, headSeq: body.head };
		},
		read(epoch, stream, afterSeq, preferCheckpoint) {
			return http.read(o.vaultId, epoch, stream, afterSeq, preferCheckpoint, null);
		},
		async blob(address) {
			const res = await doFetch(vaultPath(`/blobs/${encodeURIComponent(address)}`), { headers: auth });
			if (res.status === 404 || res.status === 503) return null;
			if (res.status !== 200) throw new RelayError(res.status, null, `blob read failed (${res.status})`);
			return new Uint8Array(await res.arrayBuffer());
		},
	};
}
