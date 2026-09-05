import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { Server as PiServer } from "@earendil-works/pi-server";
import { FileAccountStore } from "./accounts.ts";
import { createWebuiHost } from "./host.ts";
import { createWebuiServer, type WebuiServer } from "./websocket-server.ts";

export interface StartWebuiOptions {
	readonly accountsPath?: string;
	readonly sessionsRoot?: string;
	/** Base directory for accounts and sessions (defaults to ~/.pi/webui). */
	readonly dataRoot?: string;
	readonly staticDir?: string;
	readonly port?: number;
	readonly hostname?: string;
	readonly serverId?: ServerId | string;
	readonly username?: string;
	readonly password?: string;
	readonly createUser?: boolean;
	/** Custom baseline model catalog merged under each user's configured providers. */
	readonly models?: Models;
	/** Explicit session default model; wins over catalog selection. */
	readonly model?: Model<Api>;
	/** Skill extensions directory (SKILL.md) advertised to every session. */
	readonly skillsDir?: string;
}

export interface RunningWebui {
	readonly server: WebuiServer;
	readonly serverId: ServerId;
	readonly accounts: FileAccountStore;
	close(): Promise<void>;
}

interface UserRuntime {
	readonly server: PiServer;
	readonly host: Awaited<ReturnType<typeof createWebuiHost>>;
}

function resolveServerId(value: ServerId | string | undefined): ServerId {
	if (value !== undefined) {
		const normalized = String(value);
		if (isServerId(normalized)) return normalized;
		throw new Error(`Invalid server ID: ${value}`);
	}
	return randomUUID();
}

/**
 * Start the multi-user web server. Each authenticated user gets a fully
 * isolated runtime: its own session repository directory and its own pi-server
 * `Server` + `ServerHost`, so users can only ever see and operate the sessions
 * they created. Existing accounts are provisioned eagerly at startup and new
 * registrations provision synchronously before the register response returns.
 * `username`/`password` are optional bootstrap credentials: when provided with
 * `createUser`, the account is created on first start (idempotent). Each user's
 * session default model comes from their configured providers (see Settings) or
 * the builtin catalog when nothing is configured.
 */
export async function startWebui(options: StartWebuiOptions = {}): Promise<RunningWebui> {
	const dataRoot = options.dataRoot ?? join(homedir(), ".pi", "webui");
	await mkdir(dataRoot, { recursive: true, mode: 0o700 });
	const accounts = new FileAccountStore({ path: options.accountsPath ?? join(dataRoot, "accounts.json") });
	if (options.username !== undefined && options.password !== undefined && options.createUser === true) {
		if (!(await accounts.hasUser(options.username))) {
			await accounts.createUser(options.username, options.password);
		}
	}

	// No startup hard failure here: providers configured later from Settings must
	// be able to make the server usable. Session creation reports the error.
	const baseline = options.models ?? builtinModels();
	if (options.model === undefined && (await baseline.getAvailable().catch(() => [] as Model<Api>[])).length === 0) {
		console.warn("[webui] No model available yet; add a provider in Settings to create sessions.");
	}

	const sessionsRoot = options.sessionsRoot ?? join(dataRoot, "sessions");
	const serverId = resolveServerId(options.serverId);
	const users = new Map<string, UserRuntime>();

	const buildUser = async (username: string): Promise<void> => {
		if (users.has(username)) return;
		const webuiHost = await createWebuiHost({
			sessionsRoot,
			username,
			models: baseline,
			model: options.model,
			skillsDir: options.skillsDir,
		});
		const server = new PiServer(webuiHost.host, {
			serverId,
			listeners: [],
			onError: (error) =>
				console.error(
					`[webui pi-server ${username}] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
				),
		});
		users.set(username, { server, host: webuiHost });
	};

	// Provision every existing account up front so upgrades resolve synchronously.
	for (const username of await accounts.listUsers()) {
		await buildUser(username).catch((error: unknown) => {
			console.error(`Failed to provision user ${username}:`, error);
		});
	}

	const server = await createWebuiServer({
		serverId,
		accounts,
		serverForUser: (username) => {
			const user = users.get(username);
			if (user === undefined) {
				throw new Error(`User runtime for ${username} is not provisioned`);
			}
			return user.server;
		},
		onUserRegistered: buildUser,
		staticDir: options.staticDir,
		port: options.port,
		hostname: options.hostname,
	});
	return {
		server,
		serverId,
		accounts,
		async close() {
			await server.close();
			for (const user of users.values()) {
				await user.host.close().catch(() => {});
			}
		},
	};
}
