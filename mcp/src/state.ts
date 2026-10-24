/**
 * The headless device's own record, `<state>/device.json` (mode 0600): what the plugin keeps in data.json (the
 * pairing grant, src/host/ui/api.ts PairedIdentity) and in Obsidian's vault-scoped localStorage (the install
 * record, src/host/installRecord.ts). SECRET: grantSecret and the install record's retire key; never log this file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PairedIdentity } from "../../src/host/ui/api";

export interface DeviceState extends PairedIdentity {
	readonly v: 1;
	/** Obsidian's localStorage stand-in (installRecord.ts keys). */
	readonly local: Readonly<Record<string, unknown>>;
}

export class StateFile {
	readonly path: string;

	constructor(readonly dir: string) {
		this.path = join(dir, "device.json");
	}

	read(): DeviceState | null {
		if (!existsSync(this.path)) return null;
		const raw = JSON.parse(readFileSync(this.path, "utf8")) as DeviceState;
		return raw.v === 1 ? raw : null;
	}

	write(state: DeviceState): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.path);
	}

	update(fn: (s: DeviceState) => DeviceState): void {
		const cur = this.read();
		if (!cur) throw new Error("device state missing");
		this.write(fn(cur));
	}
}
