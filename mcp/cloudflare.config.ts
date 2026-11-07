import { bindings, defineConfig, exports } from "cf/config";

// YAOS_RELAY_WORKER: the relay Worker's name when it runs on the same Cloudflare account (a Worker cannot fetch
// another Worker of its own account by URL; this binds it as a service instead). Leave unset, or "none", for a relay
// elsewhere.
const relayWorker = process.env.YAOS_RELAY_WORKER && process.env.YAOS_RELAY_WORKER !== "none" ? process.env.YAOS_RELAY_WORKER : undefined;

// MCP_TOKEN is a secret set on the Worker itself (dashboard: Settings → Variables and Secrets, type Secret; or
// `cf workers secrets update`). It is not declared here on purpose: a declared secret makes `cf deploy` refuse to
// deploy until it is set, while the Worker itself says what is missing (/healthz tokenConfigured, and /mcp and
// /setup refuse with a message). Deploys keep the Worker's secrets.
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
