/** HTTP helpers of the Worker (worker.ts): a Worker entry module may export only handlers and classes. */

export const VERSION = "0.2.0";
/** Shortest MCP_TOKEN the Worker accepts. */
export const MIN_TOKEN_CHARS = 32;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function digest(s: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time comparison of the presented token with MCP_TOKEN (by their digests). */
export async function tokenMatches(presented: string | null, token: string): Promise<boolean> {
	if (!presented || token.length < MIN_TOKEN_CHARS) return false;
	const [a, b] = await Promise.all([digest(presented), digest(token)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

/**
 * The token a client presents: `Authorization: Bearer <token>`, or `X-API-Key: <token>` for clients that keep the
 * Authorization header for OAuth (a claude.ai custom connector's own headers cannot be Authorization).
 */
export const presentedToken = (req: Request): string | null =>
	/^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() || req.headers.get("x-api-key")?.trim() || null;
