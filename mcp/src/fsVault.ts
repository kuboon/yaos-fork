/**
 * The headless device's disk: VaultPort, ConfigDirPort and HostSideFilePort over plain directories (Node fs), in
 * place of Obsidian's vault (src/host/obsidianVault.ts) and adapter.
 *
 *  - Every mutation in this process (the engine's disk ops and the MCP tools' edits) runs under one lock, so a
 *    precondition is checked and the write done with nothing of ours in between: an exact compare-and-swap against
 *    every writer but another process. Another process's edit landing between the check and the write is the same
 *    accepted gap as ObsidianVault's (its header); the engine re-reads on the next event or scan.
 *  - Writes are atomic: a hidden temp file in the target's folder, then a rename.
 *  - Events (hints, as Obsidian's): after each of our own mutations, and from a recursive fs.watch for edits by
 *    other programs. Dot-folders and the config dir are invisible to list() and events, as in Obsidian.
 *  - Deletes move the file into the vault's `.trash/` folder (the engine never deletes permanently, invariant 2).
 */

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { VaultPath } from "../../src/core/types";
import type { Unsubscribe } from "../../src/ports/common";
import type {
	ConfigDirPort, HostSideFilePort, RenameOutcome, SideFilePath, SideFilePrefix, TrashMode, VaultEvent, VaultPort, VaultStat, WriteOutcome, WritePrecondition,
} from "../../src/ports/vault";
import type { HashOracle } from "../../src/host/hashOracle";
import { invalidVaultPath, parentsOf } from "../../src/host/obsidianApi";

const encoder = new TextEncoder();

export const CONFIG_DIR = ".obsidian";
export const TRASH_DIR = ".trash";

/** One lock for every mutation in this process: callers run one at a time, in arrival order. */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();
	run<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn);
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === "ENOENT" || (e as NodeJS.ErrnoException | null)?.code === "ENOTDIR";
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A vault path segment that Obsidian does not index: dot-files and dot-folders. */
export function hiddenPath(path: string, configDir = CONFIG_DIR): boolean {
	return path.split("/").some((seg) => seg.startsWith(".")) || path === configDir || path.startsWith(`${configDir}/`);
}

let tmpSeq = 0;

async function atomicWrite(abs: string, bytes: Uint8Array): Promise<void> {
	await mkdir(dirname(abs), { recursive: true });
	const tmp = join(dirname(abs), `.yaos-tmp-${process.pid}-${++tmpSeq}`);
	try {
		await writeFile(tmp, bytes);
		await rename(tmp, abs);
	} catch (e) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw e;
	}
}

export interface FsVaultOptions {
	/** The vault folder (created if missing). */
	readonly root: string;
	/** Precondition hashes: the running engine's (main never hashes, src/host/hashOracle.ts). */
	readonly hashes: HashOracle;
	/** Watch the folder for edits by other programs (default true). */
	readonly watch?: boolean;
	readonly log?: (line: string) => void;
}

export class FsVault implements VaultPort {
	readonly configDir = CONFIG_DIR;
	readonly caseInsensitive: boolean;
	readonly lock = new Mutex();
	private readonly listeners = new Set<(event: VaultEvent) => void>();
	private watcher: FSWatcher | null = null;

	private constructor(private readonly opts: FsVaultOptions, caseInsensitive: boolean) {
		this.caseInsensitive = caseInsensitive;
	}

	static async open(opts: FsVaultOptions): Promise<FsVault> {
		await mkdir(opts.root, { recursive: true });
		const vault = new FsVault(opts, await probeCaseInsensitive(opts.root));
		if (opts.watch !== false) vault.startWatching();
		return vault;
	}

	abs(path: string): string {
		return join(this.opts.root, ...path.split("/"));
	}

	private async statOf(path: string): Promise<VaultStat | null> {
		try {
			const s = await fsStat(this.abs(path));
			if (!s.isFile()) return null;
			return { path, size: s.size, mtimeMs: Math.floor(s.mtimeMs), ctimeMs: Math.floor(s.birthtimeMs || s.ctimeMs) };
		} catch (e) {
			if (isMissing(e)) return null;
			throw e;
		}
	}

	private async isDir(path: string): Promise<boolean> {
		try {
			return (await fsStat(this.abs(path))).isDirectory();
		} catch {
			return false;
		}
	}

	// --- VaultPort ------------------------------------------------------------

	async list(): Promise<readonly VaultStat[]> {
		const out: VaultStat[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(dir === "" ? this.opts.root : this.abs(dir), { withFileTypes: true });
			} catch (e) {
				if (isMissing(e)) return;
				throw e;
			}
			for (const ent of entries) {
				const path = dir === "" ? ent.name : `${dir}/${ent.name}`;
				if (hiddenPath(path, this.configDir)) continue;
				if (ent.isDirectory()) await walk(path);
				else if (ent.isFile()) {
					const s = await this.statOf(path);
					if (s) out.push(s);
				}
			}
		};
		await walk("");
		return out;
	}

	stat(path: string): Promise<VaultStat | null> {
		return this.statOf(path);
	}

	async readBytes(path: string): Promise<Uint8Array> {
		const b = await readFile(this.abs(path));
		return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	}

	private async check(path: string, cur: VaultStat | null, pre: WritePrecondition): Promise<boolean> {
		switch (pre.t) {
			case "any":
				return true;
			case "absent":
				return cur === null;
			case "fingerprint":
			case "hash": {
				if (cur === null) return false;
				const bytes = await this.readBytes(path);
				const [v] = await this.opts.hashes.hash([{ path, want: pre.t === "fingerprint" ? "fingerprint" : "contentHash", bytes }]);
				if (!v) throw new Error("hash oracle returned no value");
				return v.hash === (pre.t === "fingerprint" ? pre.fingerprint : pre.hash);
			}
		}
	}

	private async parentFile(path: string): Promise<string | null> {
		for (const p of parentsOf(path)) if (await this.statOf(p)) return p;
		return null;
	}

	write(path: VaultPath, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome> {
		return this.lock.run(() => this.writeLocked(path, data, precondition));
	}

	/** write() for a caller that already holds the lock (the MCP tools' read-modify-write). */
	async writeLocked(path: string, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome> {
		const bad = invalidVaultPath(path);
		if (bad) return { ok: false, reason: "invalid-path", current: null, message: bad };
		if (await this.isDir(path)) return { ok: false, reason: "io", current: null, message: "target is a folder" };
		const pf = await this.parentFile(path);
		if (pf !== null) return { ok: false, reason: "parent-is-file", current: await this.statOf(pf), message: `parent ${pf} is a file` };
		try {
			const cur = await this.statOf(path);
			if (!(await this.check(path, cur, precondition))) return { ok: false, reason: "precondition", current: cur, message: `precondition ${precondition.t} failed` };
			await atomicWrite(this.abs(path), typeof data === "string" ? encoder.encode(data) : data);
			const after = await this.statOf(path);
			if (!after) return { ok: false, reason: "io", current: null, message: "written file vanished" };
			this.emit(cur ? { t: "modify", path, stat: after } : { t: "create", path, stat: after });
			return { ok: true, stat: after };
		} catch (e) {
			return { ok: false, reason: "io", current: null, message: message(e) };
		}
	}

	rename(from: string, to: VaultPath, precondition: WritePrecondition): Promise<RenameOutcome> {
		return this.lock.run(() => this.renameLocked(from, to, precondition));
	}

	async renameLocked(from: string, to: string, precondition: WritePrecondition): Promise<RenameOutcome> {
		const bad = invalidVaultPath(to);
		if (bad) return { ok: false, reason: "io", message: `invalid target: ${bad}` };
		const src = await this.statOf(from);
		if (!src) return { ok: false, reason: "source-missing", message: "source missing" };
		const caseOnly = this.caseInsensitive && from.toLowerCase() === to.toLowerCase() && from !== to;
		if (!caseOnly && ((await this.statOf(to)) || (await this.isDir(to)))) return { ok: false, reason: "target-exists", message: "target exists" };
		const pf = await this.parentFile(to);
		if (pf !== null) return { ok: false, reason: "io", message: `parent ${pf} is a file` };
		try {
			if (!(await this.check(from, src, precondition))) return { ok: false, reason: "precondition", message: `precondition ${precondition.t} failed` };
			await mkdir(dirname(this.abs(to)), { recursive: true });
			await rename(this.abs(from), this.abs(to));
		} catch (e) {
			return { ok: false, reason: "io", message: message(e) };
		}
		const moved = await this.statOf(to);
		if (!moved) return { ok: false, reason: "io", message: "renamed file vanished" };
		this.emit({ t: "rename", from, to, stat: moved });
		return { ok: true, stat: moved };
	}

	trash(path: string, _mode: TrashMode, precondition: WritePrecondition): Promise<RenameOutcome> {
		return this.lock.run(() => this.trashLocked(path, precondition));
	}

	async trashLocked(path: string, precondition: WritePrecondition): Promise<RenameOutcome> {
		const f = await this.statOf(path);
		if (!f) return { ok: false, reason: "source-missing", message: "source missing" };
		try {
			if (!(await this.check(path, f, precondition))) return { ok: false, reason: "precondition", message: `precondition ${precondition.t} failed` };
			let target = `${TRASH_DIR}/${path}`;
			for (let n = 1; (await this.statOf(target)) || (await this.isDir(target)); n++) target = `${TRASH_DIR}/${path} ${n}`;
			await mkdir(dirname(this.abs(target)), { recursive: true });
			await rename(this.abs(path), this.abs(target));
		} catch (e) {
			return { ok: false, reason: "io", message: message(e) };
		}
		this.emit({ t: "delete", path });
		return { ok: true, stat: f };
	}

	removeEmptyFolder(path: VaultPath): Promise<void> {
		return this.lock.run(async () => {
			if (invalidVaultPath(path) || hiddenPath(path, this.configDir)) return;
			// rmdir refuses a folder with anything in it, hidden files included: no content can be lost.
			await rmdir(this.abs(path)).catch(() => undefined);
		});
	}

	onEvent(listener: (event: VaultEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		this.watcher?.close();
		this.watcher = null;
	}

	// --- internals ------------------------------------------------------------

	private emit(event: VaultEvent): void {
		const path = event.t === "rename" ? event.to : event.path;
		if (hiddenPath(path, this.configDir) && (event.t !== "rename" || hiddenPath(event.from, this.configDir))) return;
		// Asynchronously, as Obsidian delivers vault events after the operation returned.
		setImmediate(() => {
			for (const l of [...this.listeners]) l(event);
		});
	}

	private startWatching(): void {
		try {
			this.watcher = watch(this.opts.root, { recursive: true }, (_type, name) => {
				if (typeof name !== "string" || name === "") return;
				const path = name.split(sep).join("/");
				if (hiddenPath(path, this.configDir)) return;
				void this.statOf(path).then((s) => {
					if (s) this.emit({ t: "modify", path, stat: s });
					else void this.isDir(path).then((d) => {
						if (!d) this.emit({ t: "delete", path });
					});
				}, () => undefined);
			});
			this.watcher.on("error", (e) => this.opts.log?.(`vault watcher stopped: ${message(e)}`));
		} catch (e) {
			// No recursive watch on this platform: other programs' edits are found by the periodic full scan.
			this.opts.log?.(`vault watcher unavailable: ${message(e)}`);
		}
	}
}

async function probeCaseInsensitive(root: string): Promise<boolean> {
	const probe = join(root, `.yaos-case-probe-${process.pid}`);
	await writeFile(probe, "");
	try {
		await fsStat(join(root, `.YAOS-CASE-PROBE-${process.pid}`));
		return true;
	} catch {
		return false;
	} finally {
		await rm(probe, { force: true });
	}
}

/** `<vault>/<configDir>/`: config-relative paths (settings sync, DESIGN §j.3). */
export class FsConfigDir implements ConfigDirPort {
	constructor(private readonly root: string) {}

	private abs(path: string): string {
		return join(this.root, ...path.split("/").filter((s) => s !== ""));
	}

	async list(dir: string) {
		try {
			const entries = await readdir(this.abs(dir), { withFileTypes: true });
			const prefix = dir === "" ? "" : `${dir.replace(/\/$/, "")}/`;
			const out = [];
			for (const ent of entries) {
				if (ent.name.startsWith(".yaos-tmp-")) continue;
				const path = prefix + ent.name;
				const s = await fsStat(this.abs(path));
				out.push({ path, size: s.isFile() ? s.size : 0, mtimeMs: Math.floor(s.mtimeMs), isFolder: s.isDirectory() });
			}
			return out;
		} catch (e) {
			if (isMissing(e)) return [];
			throw e;
		}
	}

	async readBytes(path: string): Promise<Uint8Array | null> {
		try {
			const b = await readFile(this.abs(path));
			return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
		} catch (e) {
			if (isMissing(e)) return null;
			throw e;
		}
	}

	writeBytes(path: string, bytes: Uint8Array): Promise<void> {
		return atomicWrite(this.abs(path), bytes);
	}

	async remove(path: string): Promise<void> {
		await rm(this.abs(path), { force: true });
	}
}

/** The side-file store (`<deviceId>/<name>`, identity-per-store §5.2) under the device's state folder. */
export class FsSideFiles implements HostSideFilePort {
	constructor(private readonly root: string) {}

	private abs(path: string): string {
		if (invalidVaultPath(path)) throw new Error(`bad side-file path ${JSON.stringify(path)}`);
		return join(this.root, ...path.split("/"));
	}

	async read(path: SideFilePath): Promise<Uint8Array | null> {
		try {
			const b = await readFile(this.abs(path));
			return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
		} catch (e) {
			if (isMissing(e)) return null;
			throw e;
		}
	}

	write(path: SideFilePath, bytes: Uint8Array): Promise<void> {
		return atomicWrite(this.abs(path), bytes);
	}

	async remove(path: SideFilePath): Promise<void> {
		await rm(this.abs(path), { force: true });
	}

	async list(prefix: SideFilePrefix): Promise<readonly SideFilePath[]> {
		const dir = prefix.replace(/\/$/, "");
		try {
			const names = await readdir(this.abs(dir));
			return names.filter((n) => !n.startsWith(".yaos-tmp-")).map((n) => `${prefix}${n}` as SideFilePath);
		} catch (e) {
			if (isMissing(e)) return [];
			throw e;
		}
	}
}
