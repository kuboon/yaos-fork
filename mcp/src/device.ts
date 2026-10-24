/**
 * The headless device: one paired YAOS install that runs without Obsidian. It is the plugin's own stack, with
 * Node in place of Obsidian and the browser:
 *
 *  - HostRuntime (src/host/hostRuntime.ts), the plugin's main-thread runtime, over FsVault / FsConfigDir /
 *    FsSideFiles (fsVault.ts), a workspace with no editor views and a fixed desktop platform;
 *  - the composed engine (createEngine) on the in-process carrier (Node has no Blob-URL worker), with the
 *    production adapters webEngine.ts uses: WebSocket relay, relay HTTP, HTTP blob store (through nodeXhr), the
 *    identity adapter for suite 0, web clock / hash / random; storage is JournalStorage (journalStorage.ts) in the
 *    state folder instead of IndexedDB.
 *
 * So the engine owns every CRDT, merge and namespace decision exactly as on any other device: a file the MCP tools
 * write is an edit on this device's disk, which the engine diffs against the synced base and merges into the note's
 * Yjs document (DESIGN §f.3); remote changes come back as engine disk writes.
 *
 * Plain (suite 0) vaults only: the device is pinned to suite 0 (e2ee-design §12.4) and stores no vault key; an
 * end-to-end encrypted vault refuses it (KeyRefused) and nothing is written.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BrakeReport, VaultId } from "../../src/core/types";
import { createNoopCrypto } from "../../src/engine/adapters/noopCrypto";
import { createRelayHttp } from "../../src/engine/adapters/relayHttp";
import { probeHttpBlob, startupBlob } from "../../src/engine/adapters/httpBlob";
import { createWebClock } from "../../src/engine/adapters/webClock";
import { createWebHash } from "../../src/engine/adapters/webHash";
import { createWebRandom } from "../../src/engine/adapters/webRandom";
import { createWsRelayPort } from "../../src/engine/adapters/wsRelay";
import { createEngine } from "../../src/engine/compose/protocolEngine";
import { engineHashOracle } from "../../src/host/hashOracle";
import { HostRuntime } from "../../src/host/hostRuntime";
import { createHostKeys } from "../../src/host/keys/hostKeys";
import { lineageOf, loadInstallRecord, saveStoreIdentity, sanitizeInstallRecord, installRecordKey, type InstallStorage } from "../../src/host/installRecord";
import { DEFAULT_ENGINE_SETTINGS } from "../../src/host/ui/api";
import type { EngineCarrier } from "../../src/host/engineHost";
import type { DeviceId } from "../../src/core/types";
import type { DeviceState, IdentityPort } from "../../src/ports/identity";
import type { LifecycleEvent, PlatformPort } from "../../src/ports/platform";
import type { WorkspacePort } from "../../src/ports/workspace";
import type { ProtocolError } from "../../src/protocol/errors";
import { createInlinePair } from "../../src/protocol/inlineTransport";
import type { EngineSettings } from "../../src/protocol/messages";
import type { StatusSnapshot } from "../../src/protocol/status";
import { FsConfigDir, FsSideFiles, FsVault, CONFIG_DIR } from "./fsVault";
import { JournalStorage } from "./journalStorage";
import { nodeXhr } from "./nodeXhr";
import type { StateFile } from "./state";

export const CLIENT_VERSION = "headless-mcp";

const NO_VIEWS: WorkspacePort = { listMarkdownViews: () => [], onViewEvent: () => () => undefined };

const PLATFORM: PlatformPort = {
	info: { os: "linux", isMobile: false, isTablet: false, hardwareConcurrency: 4, deviceMemoryGiB: null, workerSupported: false },
	isVisible: () => true,
	isOnline: () => true,
	onLifecycle: (_listener: (event: LifecycleEvent) => void) => () => undefined,
};

/** What the device reports, newest last (bounded). */
export interface DeviceUi {
	status: StatusSnapshot | null;
	brakes: BrakeReport[];
	notices: { readonly at: string; readonly level: string; readonly code: string; readonly message: string }[];
	fatal: ProtocolError | null;
}

const MAX_NOTICES = 50;

export interface HeadlessDeviceOptions {
	/** The vault folder: the synced files live here. */
	readonly vaultDir: string;
	readonly state: StateFile;
	readonly settings?: Partial<EngineSettings>;
	readonly log: (line: string) => void;
}

export class HeadlessDevice {
	private constructor(
		readonly vault: FsVault,
		readonly runtime: HostRuntime,
		readonly ui: DeviceUi,
		private readonly storage: JournalStorage,
	) {}

	static async open(o: HeadlessDeviceOptions): Promise<HeadlessDevice> {
		const saved = o.state.read();
		if (!saved) throw new Error("This device is not paired. Run `yaos-mcp pair` first.");
		const clock = createWebClock();
		const storage = await JournalStorage.open(join(o.state.dir, "store"));
		// Obsidian's vault-scoped localStorage, where the plugin keeps the install record (identity-per-store §2.4).
		const installStorage: InstallStorage = {
			load: (key) => o.state.read()?.local[key],
			save: (key, value) => o.state.update((s) => ({ ...s, local: { ...s.local, [key]: value } })),
		};
		const rec = loadInstallRecord(installStorage, saved.vaultId, (n) => randomBytes(n));
		let device: HeadlessDevice | null = null;
		const request = (body: Parameters<HostRuntime["engine"]["request"]>[0]) => {
			if (!device) return Promise.reject(new Error("engine not started"));
			return device.runtime.engine.request(body);
		};
		const vault = await FsVault.open({ root: o.vaultDir, hashes: engineHashOracle(request), log: o.log });
		const settings = (): EngineSettings => ({ ...DEFAULT_ENGINE_SETTINGS, syncSettings: false, trashMode: "obsidian-trash", ...o.settings });
		const keys = createHostKeys({ store: null, pin: () => ({ suite: 0 }), creating: () => false });
		const ui: DeviceUi = { status: null, brakes: [], notices: [], fatal: null };
		const notice = (level: string, code: string, message: string) => {
			ui.notices.push({ at: new Date().toISOString(), level, code, message });
			if (ui.notices.length > MAX_NOTICES) ui.notices.shift();
			o.log(`${level} ${code}: ${message}`);
		};
		const runtime = new HostRuntime({
			clock, vault, configDir: new FsConfigDir(join(o.vaultDir, CONFIG_DIR)), sideFiles: new FsSideFiles(join(o.state.dir, "side")),
			workspace: NO_VIEWS, platform: PLATFORM,
			identity: {
				vaultId: saved.vaultId as VaultId,
				deviceLabel: saved.grantName,
				relay: { url: saved.host, grantSecret: saved.grantSecret },
				installKey: rec.installKey,
				lineage: lineageOf(rec),
				predecessor: sanitizeInstallRecord(installStorage.load(installRecordKey(saved.vaultId)))?.current ?? null,
			},
			settings,
			keys,
			createCarrier: () => device!.inlineCarrier(storage, o.log, (grantSecret) => o.state.update((s) => ({ ...s, grantSecret }))),
			pingEnabled: true,
			log: (line) => o.log(`host: ${line}`),
			ui: {
				onStatus: (s) => { ui.status = s; },
				onBrake: (b) => {
					ui.brakes = [...ui.brakes.filter((x) => x.id !== b.id), b].slice(-10);
					notice("warn", "brake", `safety brake ${b.id} (${b.reason}, ${b.heldCount} files): held until approved or rejected`);
				},
				onNotice: notice,
				onCarrier: () => undefined,
				onFatal: (e) => {
					ui.fatal = e;
					notice("error", e.code, e.message);
				},
				onStoreIdentity: (deviceId, retireKey) => saveStoreIdentity(installStorage, saved.vaultId, rec.installKey, deviceId, retireKey),
				onGrantSecret: (grantSecret) => o.state.update((s) => ({ ...s, grantSecret })),
			},
		});
		device = new HeadlessDevice(vault, runtime, ui, storage);
		return device;
	}

	private inlineCarrier(storage: JournalStorage, log: (line: string) => void, onGrant: (secret: string) => void): EngineCarrier {
		const pair = createInlinePair();
		const engineLog = (line: string) => log(`engine: ${line}`);
		const handle = createEngine(pair.engine, {
			carrier: "inline",
			clientVersion: CLIENT_VERSION,
			log: engineLog,
			tzOffsetMinutes: () => -new Date().getTimezoneOffset(),
			makePorts: async (config) => {
				const clock = createWebClock();
				const hash = createWebHash();
				const random = createWebRandom();
				// SECRET: the store's device token, set once the engine found or minted the store (identity-per-store §4).
				let token = "";
				const credential = (): string => token;
				const relay = createWsRelayPort({ baseUrl: config.relay.url, credential, clock, random });
				const blobOpts = { baseUrl: config.relay.url, vaultId: config.vaultId, credential, clock, xhr: nodeXhr };
				const blob = await startupBlob(blobOpts, engineLog);
				if (config.crypto.suite !== 0) throw new Error("the headless device runs plain (suite 0) vaults only");
				const http = createRelayHttp({ baseUrl: config.relay.url, credential, clock });
				// SECRET: the install's pairing grant; a rotation's secret replaces it (identity-per-store §3.4).
				let grantSecret = config.relay.grantSecret;
				const identity: IdentityPort = {
					register: (body) => (grantSecret ? http.registerDevice(config.vaultId, grantSecret, body) : Promise.resolve({ ok: false, reason: "no-grant", retryAfterMs: null })),
					use: (deviceToken) => {
						token = deviceToken;
					},
					retire: (body) => http.retireDevice(config.vaultId, body),
					status: async (ids) => (token ? ((await http.deviceStatus(config.vaultId, ids)) as ReadonlyMap<DeviceId, DeviceState> | null) : null),
					fetchGrant: () => (token ? http.fetchGrant(config.vaultId) : Promise.resolve({ ok: false, reason: "no-store" })),
					useGrant: (secret) => {
						grantSecret = secret;
						onGrant(secret);
					},
				};
				return { relay, storage, clock, random, crypto: createNoopCrypto(hash), hash, blob, probeBlob: () => probeHttpBlob(blobOpts), identity };
			},
		});
		return {
			kind: "inline",
			transport: pair.host,
			dispose: () => {
				handle.dispose();
				pair.host.close();
			},
		};
	}

	start(): Promise<void> {
		return this.runtime.start();
	}

	async stop(): Promise<void> {
		await this.runtime.stop();
		this.vault.close();
		this.storage.close();
	}
}
