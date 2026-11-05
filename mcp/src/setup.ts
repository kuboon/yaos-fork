/**
 * Pairing the reader with a vault: the plugin's own enrollment (src/host/ui/pairing.ts: a pairing grant bought with a
 * one-time code), then the registration of one device under that grant (identity-per-store §3.2, §4: the credentials
 * a store mints, src/engine/compose/storeIdentity.ts). The reader then reads as that device. It never appends, so it
 * syncs nothing; the console lists it under the grant's name, and revoking it there cuts the reader off.
 */

import { retireKeyHash, mintCredentials } from "../../src/engine/compose/storeIdentity";
import { createRelayHttp } from "../../src/engine/adapters/relayHttp";
import { createWebHash } from "../../src/engine/adapters/webHash";
import { createWebRandom } from "../../src/engine/adapters/webRandom";
import { pairDevice, prepareEnrollment, type HttpRequest, type HttpResponse } from "../../src/host/ui/pairing";

/** The reader's identity, kept in its Durable Object. SECRET: grantSecret, deviceToken, retireKey. */
export interface ReaderIdentity {
	readonly v: 1;
	readonly host: string;
	readonly vaultId: string;
	readonly grantId: string;
	readonly grantName: string;
	readonly grantSecret: string;
	readonly deviceId: string;
	readonly deviceToken: string;
	readonly retireKey: string;
	readonly pairedAt: string;
}

/** pairing.ts RequestFn over `doFetch`. */
function requestOver(doFetch: typeof fetch) {
	return async (req: HttpRequest): Promise<HttpResponse> => {
		const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		const raw = await res.text();
		let json: unknown = null;
		try {
			json = raw ? JSON.parse(raw) : null;
		} catch {
			json = null;
		}
		return { status: res.status, json };
	};
}

export async function pairReader(input: { readonly host: string; readonly pairingCode: string; readonly name: string }, doFetch: typeof fetch): Promise<ReaderIdentity> {
	const random = createWebRandom();
	const randomBytes = (n: number) => random.bytes(n);
	const attempt = prepareEnrollment({ host: input.host, pairingCode: input.pairingCode, deviceName: input.name }, randomBytes);
	// pairing.ts's default sleep is window.setTimeout: a Worker has no window.
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const grant = await pairDevice(attempt, { request: requestOver(doFetch), randomBytes, sleep });
	const creds = mintCredentials(random);
	const http = createRelayHttp({ baseUrl: grant.host, credential: creds.deviceToken, fetch: doFetch });
	const reg = await http.registerDevice(grant.vaultId, grant.grantSecret, {
		deviceId: creds.deviceId, deviceToken: creds.deviceToken, retireKeyHash: await retireKeyHash(createWebHash(), creds.retireKey),
	});
	if (!reg.ok) throw new Error(`the server refused to register the reader (${reg.reason})`);
	return {
		v: 1, host: grant.host, vaultId: grant.vaultId, grantId: grant.grantId, grantName: grant.grantName, grantSecret: grant.grantSecret,
		deviceId: creds.deviceId, deviceToken: creds.deviceToken, retireKey: creds.retireKey, pairedAt: new Date().toISOString(),
	};
}
