/**
 * The remote MCP endpoint: MCP Streamable HTTP (stateless: a fresh server and transport per request) at `/mcp`,
 * behind a bearer token, plus an unauthenticated `/healthz`. Run it behind TLS (a reverse proxy or a tunnel) when it
 * is reachable from anywhere but this machine: the token travels in every request.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, type ToolHost } from "./tools";

/** Shortest bearer token serve accepts. */
export const MIN_TOKEN_CHARS = 32;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time check of `Authorization: Bearer <token>`. */
export function authorized(header: string | undefined, token: string): boolean {
	const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
	return m !== null && timingSafeEqual(digest(m[1]!.trim()), digest(token));
}

export interface ServeOptions {
	readonly host: ToolHost;
	readonly token: string;
	readonly port: number;
	readonly bind: string;
	readonly version: string;
	readonly log: (line: string) => void;
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

export function startServer(o: ServeOptions): Promise<Server> {
	if (o.token.length < MIN_TOKEN_CHARS) throw new Error(`the bearer token must be at least ${MIN_TOKEN_CHARS} characters`);
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/healthz") {
			const s = o.host.status();
			reply(res, 200, { ok: true, phase: s?.phase ?? "starting", relayConnected: s?.relay.connected ?? false });
			return;
		}
		if (url.pathname !== "/mcp") {
			reply(res, 404, { error: "not_found" });
			return;
		}
		if (!authorized(req.headers.authorization, o.token)) {
			reply(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
			return;
		}
		const mcp = new McpServer({ name: "yaos", version: o.version });
		registerTools(mcp, o.host);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => {
			void transport.close();
			void mcp.close();
		});
		mcp.connect(transport)
			.then(() => transport.handleRequest(req, res))
			.catch((e: unknown) => {
				o.log(`mcp request failed: ${e instanceof Error ? e.message : String(e)}`);
				if (!res.headersSent) reply(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
			});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(o.port, o.bind, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}
