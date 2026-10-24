/**
 * yaos-mcp: a headless YAOS device that serves its vault over a remote MCP endpoint, without Obsidian.
 *
 *   yaos-mcp pair  --server <url> --code <pairing code> [--name <device name>] [--state <dir>]
 *   yaos-mcp serve [--state <dir>] [--vault <dir>] [--port <n>] [--bind <addr>]      (YAOS_MCP_TOKEN required)
 *   yaos-mcp token
 *
 * Environment: YAOS_MCP_STATE, YAOS_MCP_VAULT, YAOS_MCP_PORT, YAOS_MCP_BIND, YAOS_MCP_TOKEN. See mcp/README.md.
 */

import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HeadlessDevice } from "./device";
import { pair } from "./pair";
import { MIN_TOKEN_CHARS, startServer } from "./server";
import { StateFile } from "./state";
import type { ToolHost } from "./tools";

const VERSION = "0.1.0";

const log = (line: string): void => {
	process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

const USAGE = `usage:
  yaos-mcp pair  --server <url> --code <pairing code> [--name <device name>] [--state <dir>]
  yaos-mcp serve [--state <dir>] [--vault <dir>] [--port <n>] [--bind <addr>]   (YAOS_MCP_TOKEN required)
  yaos-mcp token`;

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	const { values } = parseArgs({
		args: rest,
		options: {
			server: { type: "string" }, code: { type: "string" }, name: { type: "string" },
			state: { type: "string" }, vault: { type: "string" }, port: { type: "string" }, bind: { type: "string" },
		},
		strict: true,
	});
	const stateDir = resolve(values.state ?? process.env.YAOS_MCP_STATE ?? "yaos-mcp-state");
	const state = new StateFile(stateDir);

	switch (command) {
		case "pair": {
			if (!values.server || !values.code) throw new Error(`pair needs --server and --code\n${USAGE}`);
			const r = await pair({ host: values.server, pairingCode: values.code, deviceName: values.name ?? "MCP" }, state, log);
			log(`paired as "${r.grantName}" with vault ${r.vaultId}; state in ${stateDir}`);
			return;
		}
		case "token":
			process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
			return;
		case "serve": {
			const token = process.env.YAOS_MCP_TOKEN ?? "";
			if (token.length < MIN_TOKEN_CHARS) throw new Error(`set YAOS_MCP_TOKEN to a secret of at least ${MIN_TOKEN_CHARS} characters (\`yaos-mcp token\` makes one)`);
			const vaultDir = resolve(values.vault ?? process.env.YAOS_MCP_VAULT ?? join(stateDir, "vault"));
			const port = Number(values.port ?? process.env.YAOS_MCP_PORT ?? 8787);
			const bind = values.bind ?? process.env.YAOS_MCP_BIND ?? "127.0.0.1";
			const device = await HeadlessDevice.open({ vaultDir, state, log });
			const host: ToolHost = {
				vault: device.vault,
				status: () => device.ui.status,
				notices: () => device.ui.notices,
				brakes: () => device.ui.brakes,
				syncNow: async () => {
					await device.runtime.command({ t: "reconcileNow" });
				},
				resolveBrake: async (brakeId, approve) => {
					await device.runtime.command(approve ? { t: "approveBrake", brakeId } : { t: "rejectBrake", brakeId });
				},
			};
			await device.start();
			const server = await startServer({ host, token, port, bind, version: VERSION, log });
			log(`serving vault ${vaultDir} at http://${bind}:${port}/mcp`);
			let stopping = false;
			const stop = (): void => {
				if (stopping) return;
				stopping = true;
				log("stopping");
				server.close();
				device.stop().then(() => process.exit(0), (e: unknown) => {
					log(`stop failed: ${e instanceof Error ? e.message : String(e)}`);
					process.exit(1);
				});
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
			return;
		}
		default:
			throw new Error(USAGE);
	}
}

main(process.argv.slice(2)).catch((e: unknown) => {
	log(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
