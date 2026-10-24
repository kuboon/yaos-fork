/**
 * `yaos-mcp pair`: enrolls the headless device with a one-time pairing code, exactly as the plugin's pair modal
 * does (src/host/ui/pairing.ts: capabilities check, then POST /enroll with a grant secret drawn here), and saves the
 * grant to the state folder. The engine registers this install's store under the grant at its first start.
 */

import { randomBytes } from "node:crypto";
import { pairDevice, prepareEnrollment, type HttpRequest, type HttpResponse } from "../../src/host/ui/pairing";
import type { StateFile } from "./state";

/** pairing.ts RequestFn over fetch. */
export async function fetchRequest(req: HttpRequest): Promise<HttpResponse> {
	const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
	const text = await res.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	return { status: res.status, json, headers };
}

export interface PairInput {
	readonly host: string;
	readonly pairingCode: string;
	readonly deviceName: string;
}

/** Pairs and writes the state file. Refuses when the state folder already holds a pairing. */
export async function pair(input: PairInput, state: StateFile, log: (line: string) => void): Promise<{ readonly vaultId: string; readonly grantName: string }> {
	if (state.read()) throw new Error(`${state.path} already holds a pairing. Use another --state folder, or remove it first.`);
	const attempt = prepareEnrollment(input, (n) => new Uint8Array(randomBytes(n)));
	const identity = await pairDevice(attempt, { request: fetchRequest, randomBytes: (n) => new Uint8Array(randomBytes(n)), onProgress: log });
	state.write({ v: 1, ...identity, local: {} });
	return { vaultId: identity.vaultId, grantName: identity.grantName };
}
