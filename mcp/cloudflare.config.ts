import { bindings, defineConfig, exports } from "cf/config";

// YAOS_RELAY_WORKER: the relay Worker's name when it runs on the same Cloudflare account (a Worker cannot fetch
// another Worker of its own account by URL; this binds it as a service instead). Leave unset, or "none", for a relay
// elsewhere.
const relayWorker = process.env.YAOS_RELAY_WORKER && process.env.YAOS_RELAY_WORKER !== "none" ? process.env.YAOS_RELAY_WORKER : undefined;

// MCP_TOKEN is the Worker's secret, passed on every deploy (scripts/deploy.mjs, from the build's environment): a cf
// deploy makes the version with this file's bindings only, so a secret set in the dashboard does not survive it. It is
// not declared here, so a deploy without it still runs; the Worker then says what is missing (/healthz tokenState,
// and /mcp and /setup refuse with a message).
export default defineConfig(() => ({
	worker: {
		name: process.env.YAOS_MCP_WORKER_NAME ?? "yaos-mcp",
		compatibilityDate: "2026-04-07",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "src/worker.ts",
		env: {
			VAULT: bindings.durableObject({ worker: process.env.YAOS_MCP_WORKER_NAME ?? "yaos-mcp", exportName: "VaultReader" }),
			...(relayWorker ? { RELAY: bindings.worker({ worker: relayWorker }) } : {}),
		},
		exports: {
			VaultReader: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
