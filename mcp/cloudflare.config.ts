import { bindings, defineConfig, exports } from "cf/config";

// YAOS_RELAY_WORKER: the relay Worker's name when it runs on the same Cloudflare account (a Worker cannot fetch
// another Worker of its own account by URL; this binds it as a service instead). Leave unset, or "none", for a relay
// elsewhere.
const relayWorker = process.env.YAOS_RELAY_WORKER && process.env.YAOS_RELAY_WORKER !== "none" ? process.env.YAOS_RELAY_WORKER : undefined;

export default defineConfig(() => ({
	worker: {
		name: process.env.YAOS_MCP_WORKER_NAME ?? "yaos-mcp",
		compatibilityDate: "2026-04-07",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "src/worker.ts",
		env: {
			VAULT: bindings.durableObject({ worker: process.env.YAOS_MCP_WORKER_NAME ?? "yaos-mcp", exportName: "VaultReader" }),
			MCP_TOKEN: bindings.secret(),
			...(relayWorker ? { RELAY: bindings.worker({ worker: relayWorker }) } : {}),
		},
		exports: {
			VaultReader: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
