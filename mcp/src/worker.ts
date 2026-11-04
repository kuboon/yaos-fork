/**
 * yaos-mcp: a read-only remote MCP server for one YAOS vault, as a Cloudflare Worker. No Obsidian and no always-on
 * process: each request reads what changed on the relay since the last one and answers from that (vaultView.ts).
 *
 * Routes:
 *   /mcp      MCP Streamable HTTP (stateless JSON responses), `Authorization: Bearer <MCP_TOKEN>`.
 *   /setup    GET: a small form; POST (form or JSON {server, code, name?, replace?}) with the token: pairs the reader
 *             with a vault using a one-time pairing code (setup.ts).
 *   /healthz  unauthenticated liveness: whether a vault is paired.
 *
 * One Durable Object (VaultReader, named "default") holds the reader's identity in its storage and the vault view in
 * memory, so consecutive requests only read the relay's new rows.
 */

import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRelayAccess } from "./relay";
import { pairReader, type ReaderIdentity } from "./setup";
import { SETUP_PAGE } from "./setupPage";
import { registerTools } from "./tools";
import { VaultView } from "./vaultView";
import { MIN_TOKEN_CHARS, VERSION, bearerOf, json, tokenMatches } from "./http";

export interface Env {
	readonly VAULT: DurableObjectNamespace<VaultReader>;
	/** SECRET: the bearer token MCP clients send, and the setup form asks for. */
	readonly MCP_TOKEN: string;
	/** Optional service binding to the relay Worker (a Worker cannot fetch another Worker of the same account by URL). */
	readonly RELAY?: Fetcher;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const reader = env.VAULT.get(env.VAULT.idFromName("default"));
		if (url.pathname === "/healthz") return reader.fetch(req);
		if (url.pathname === "/setup" && req.method === "GET") return new Response(SETUP_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/setup" && req.method === "POST") return reader.fetch(req);
		if (url.pathname !== "/mcp") return json(404, { error: "not_found" });
		if (env.MCP_TOKEN.length < MIN_TOKEN_CHARS) return json(500, { error: "MCP_TOKEN is not set (or shorter than 32 characters)" });
		if (!(await tokenMatches(bearerOf(req), env.MCP_TOKEN))) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
		return reader.fetch(req);
	},
} satisfies ExportedHandler<Env>;

export class VaultReader extends DurableObject<Env> {
	private view: VaultView | null = null;
	private identity: ReaderIdentity | null | undefined = undefined;

	private relayFetch(): typeof fetch {
		const relay = this.env.RELAY;
		return relay ? (input, init) => relay.fetch(input, init) : (input, init) => fetch(input, init);
	}

	private async loadIdentity(): Promise<ReaderIdentity | null> {
		if (this.identity === undefined) this.identity = (await this.ctx.storage.get<ReaderIdentity>("identity")) ?? null;
		return this.identity;
	}

	/** The view, caught up with the relay. */
	private async freshView(): Promise<VaultView> {
		const id = await this.loadIdentity();
		if (!id) throw new Error("No vault is paired yet. Open /setup on this server and pair it with a pairing code.");
		this.view ??= new VaultView(createRelayAccess({ baseUrl: id.host, vaultId: id.vaultId, deviceToken: id.deviceToken, fetch: this.relayFetch() }));
		await this.view.refresh();
		return this.view;
	}

	override async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/healthz") {
			const id = await this.loadIdentity();
			return json(200, { ok: true, paired: id !== null, vaultId: id?.vaultId ?? null });
		}
		if (url.pathname === "/setup") return this.setup(req);
		return this.mcp(req);
	}

	private async mcp(req: Request): Promise<Response> {
		const server = new McpServer({ name: "yaos", version: VERSION });
		registerTools(server, {
			view: () => this.freshView(),
			info: async () => {
				const id = await this.loadIdentity();
				if (!id) return { paired: false };
				const view = await this.freshView();
				const r = await view.refresh();
				const files = view.files();
				return {
					paired: true, server: id.host, vaultId: id.vaultId, deviceName: id.grantName, pairedAt: id.pairedAt,
					epoch: r.epoch, headSeq: r.headSeq, namespaceSeq: r.nsSeq,
					files: files.length, notes: files.filter((f) => f.kind === "markdown").length, canvases: files.filter((f) => f.kind === "canvas").length,
					attachments: files.filter((f) => f.kind === "blob").length, readOnly: true,
				};
			},
		});
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		await server.connect(transport);
		try {
			return await transport.handleRequest(req);
		} finally {
			void server.close();
		}
	}

	private async setup(req: Request): Promise<Response> {
		const form: Record<string, unknown> = {};
		if (req.headers.get("content-type")?.includes("application/json")) Object.assign(form, await req.json().catch(() => ({})));
		else (await req.formData().catch(() => new FormData())).forEach((v, k) => { form[k] = v; });
		const presented = bearerOf(req) ?? (typeof form.token === "string" ? form.token : null);
		if (!(await tokenMatches(presented, this.env.MCP_TOKEN))) return json(401, { error: "unauthorized: the MCP token is missing or wrong" });
		const server = typeof form.server === "string" ? form.server.trim() : "";
		const code = typeof form.code === "string" ? form.code.trim() : "";
		const name = typeof form.name === "string" && form.name.trim() ? form.name.trim() : "MCP (read-only)";
		const replace = form.replace === true || form.replace === "on" || form.replace === "true";
		if (!server || !code) return json(400, { error: "server and code are required" });
		if ((await this.loadIdentity()) && !replace) return json(409, { error: "a vault is already paired; send replace to pair another one (revoke the old device in its console)" });
		let identity: ReaderIdentity;
		try {
			identity = await pairReader({ host: server, pairingCode: code, name }, this.relayFetch());
		} catch (e) {
			return json(400, { error: e instanceof Error ? e.message : String(e) });
		}
		await this.ctx.storage.put("identity", identity);
		this.identity = identity;
		this.view = null;
		try {
			const view = await this.freshView();
			return json(200, { ok: true, vaultId: identity.vaultId, deviceName: identity.grantName, files: view.files().length });
		} catch (e) {
			// Paired, but the first read failed (for example an end-to-end encrypted vault): say why.
			return json(200, { ok: true, vaultId: identity.vaultId, deviceName: identity.grantName, warning: e instanceof Error ? e.message : String(e) });
		}
	}
}
