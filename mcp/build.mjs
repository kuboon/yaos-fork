// yaos-mcp build: one ESM bundle for Node, dist/yaos-mcp.mjs, from src/main.ts and the plugin sources it shares
// (../src). esbuild comes from the repository root's devDependencies: run `npm ci` at the root and here first.
import esbuild from "../node_modules/esbuild/lib/main.js";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const outfile = `${ROOT}dist/yaos-mcp.mjs`;

await esbuild.build({
	absWorkingDir: ROOT,
	entryPoints: ["src/main.ts"],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	// Some dependencies are CommonJS and call require(): give the ESM bundle one.
	banner: { js: "#!/usr/bin/env node\nimport { createRequire as __yaosCreateRequire } from 'node:module';\nconst require = __yaosCreateRequire(import.meta.url);" },
	legalComments: "none",
	logLevel: "info",
});
chmodSync(outfile, 0o755);
