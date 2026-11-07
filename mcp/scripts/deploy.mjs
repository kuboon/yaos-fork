#!/usr/bin/env node
// Workers Builds deploy command (`npm run deploy:ci`): `cf deploy` with MCP_TOKEN passed as the Worker's secret.
//
// A cf deploy makes a version with the bindings of cloudflare.config.ts only, so a secret set in the dashboard does
// not survive the next deploy. The token therefore comes from the build's environment (a Workers Builds build
// variable of type Secret, MCP_TOKEN) and goes into every deploy through a temporary --secrets-file. Without it the
// deploy still runs, and the Worker reports the token missing (/healthz tokenState).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = process.env.MCP_TOKEN ?? "";
const args = ["cf", "deploy", ...process.argv.slice(2)];
let dir = null;
if (token) {
	if (/[\r\n]/.test(token)) {
		console.error("MCP_TOKEN must be one line");
		process.exit(1);
	}
	dir = mkdtempSync(join(tmpdir(), "yaos-mcp-secrets-"));
	const file = join(dir, "secrets.env");
	writeFileSync(file, `MCP_TOKEN=${token}\n`, { mode: 0o600 });
	args.push("--secrets-file", file);
	console.log("deploying with MCP_TOKEN from the build environment");
} else {
	console.warn("MCP_TOKEN is not in the build environment: deploying without it (the Worker will refuse requests until it is set)");
}
const r = spawnSync("npx", args, { stdio: "inherit" });
if (dir) rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
