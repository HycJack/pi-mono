import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keylen, options, (error, derivedKey) => {
			if (error) reject(error);
			else resolve(derivedKey);
		});
	});
}

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const TOKEN_LENGTH = 32;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface AccountRecord {
	readonly username: string;
	readonly createdAt: number;
	/** scrypt params and hash encoded as `scrypt$N$r$p$saltHex$hashHex`. */
	readonly passwordHash: string;
}

export interface SessionToken {
	readonly token: string;
	readonly username: string;
	readonly expiresAt: number;
}

export interface AccountStoreOptions {
	readonly path: string;
}

export interface AccountStore {
	createUser(username: string, password: string): Promise<void>;
	verifyPassword(username: string, password: string): Promise<boolean>;
	hasUser(username: string): Promise<boolean>;
	issueToken(username: string): SessionToken;
	resolveToken(token: string): string | undefined;
	revokeToken(token: string): void;
	listUsers(): Promise<readonly string[]>;
}

function encodePasswordHash(hash: Buffer, salt: Buffer): string {
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function parsePasswordHash(encoded: string): { salt: Buffer; hash: Buffer } | undefined {
	const parts = encoded.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
	const [, , , , saltHex, hashHex] = parts;
	return { salt: Buffer.from(saltHex ?? "", "hex"), hash: Buffer.from(hashHex ?? "", "hex") };
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_LENGTH);
	const hash = await scryptAsync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return encodePasswordHash(hash, salt);
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const parsed = parsePasswordHash(encoded);
	if (parsed === undefined) return false;
	const candidate = await scryptAsync(password, parsed.salt, parsed.hash.length, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
	});
	return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

/** JSON-file-backed account store with in-memory bearer tokens. */
export class FileAccountStore implements AccountStore {
	readonly #path: string;
	#records = new Map<string, AccountRecord>();
	#tokens = new Map<string, SessionToken>();
	#loaded: Promise<void>;

	constructor(options: AccountStoreOptions) {
		this.#path = options.path;
		this.#loaded = this.#load();
	}

	async #load(): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
		let raw: string;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error(`Invalid account store in ${this.#path}`);
		for (const entry of parsed) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				typeof (entry as AccountRecord).username !== "string" ||
				typeof (entry as AccountRecord).passwordHash !== "string" ||
				typeof (entry as AccountRecord).createdAt !== "number"
			) {
				throw new Error(`Invalid account record in ${this.#path}`);
			}
			this.#records.set((entry as AccountRecord).username, entry as AccountRecord);
		}
	}

	async #persist(): Promise<void> {
		await writeFile(this.#path, JSON.stringify([...this.#records.values()], null, "\t"), {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	async createUser(username: string, password: string): Promise<void> {
		if (username.length === 0) throw new Error("Username must not be empty");
		if (password.length < 8) throw new Error("Password must be at least 8 characters");
		await this.#loaded;
		if (this.#records.has(username)) throw new Error(`User ${username} already exists`);
		const record: AccountRecord = {
			username,
			createdAt: Date.now(),
			passwordHash: await hashPassword(password),
		};
		this.#records.set(username, record);
		await this.#persist();
	}

	async hasUser(username: string): Promise<boolean> {
		await this.#loaded;
		return this.#records.has(username);
	}

	async verifyPassword(username: string, password: string): Promise<boolean> {
		await this.#loaded;
		const record = this.#records.get(username);
		if (record === undefined) return false;
		return verifyPassword(password, record.passwordHash);
	}

	issueToken(username: string): SessionToken {
		const token = randomBytes(TOKEN_LENGTH).toString("hex");
		const entry: SessionToken = {
			token,
			username,
			expiresAt: Date.now() + TOKEN_TTL_MS,
		};
		this.#tokens.set(token, entry);
		return entry;
	}

	resolveToken(token: string): string | undefined {
		const entry = this.#tokens.get(token);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.#tokens.delete(token);
			return undefined;
		}
		return entry.username;
	}

	revokeToken(token: string): void {
		this.#tokens.delete(token);
	}

	async listUsers(): Promise<readonly string[]> {
		await this.#loaded;
		return [...this.#records.keys()];
	}
}
