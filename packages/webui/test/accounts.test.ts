import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAccountStore } from "../src/server/accounts.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "webui-accounts-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileAccountStore", () => {
	it("creates users with scrypt password hashes", async () => {
		const dir = await tempDir();
		const accounts = new FileAccountStore({ path: join(dir, "accounts.json") });
		await accounts.createUser("alice", "password-123");
		await accounts.createUser("bob", "password-456");
		expect(await accounts.hasUser("alice")).toBe(true);
		expect(await accounts.hasUser("bob")).toBe(true);
		expect(await accounts.verifyPassword("alice", "password-123")).toBe(true);
		expect(await accounts.verifyPassword("alice", "wrong")).toBe(false);
		expect(await accounts.verifyPassword("carol", "password-123")).toBe(false);
		expect(await accounts.listUsers()).toEqual(["alice", "bob"]);
	});

	it("persists accounts across reloads", async () => {
		const dir = await tempDir();
		const path = join(dir, "accounts.json");
		{
			const accounts = new FileAccountStore({ path });
			await accounts.createUser("alice", "password-123");
		}
		{
			const reloaded = new FileAccountStore({ path });
			expect(await reloaded.hasUser("alice")).toBe(true);
			expect(await reloaded.verifyPassword("alice", "password-123")).toBe(true);
		}
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("password-123");
		expect(raw).toContain("scrypt$");
	});

	it("rejects duplicate usernames and short passwords", async () => {
		const dir = await tempDir();
		const accounts = new FileAccountStore({ path: join(dir, "accounts.json") });
		await accounts.createUser("alice", "password-123");
		await expect(accounts.createUser("alice", "other-pass-1")).rejects.toThrow(/already exists/);
		await expect(accounts.createUser("bob", "short")).rejects.toThrow(/at least 8/);
	});

	it("issues and resolves bearer tokens with expiry", async () => {
		const dir = await tempDir();
		const accounts = new FileAccountStore({ path: join(dir, "accounts.json") });
		await accounts.createUser("alice", "password-123");
		const token = accounts.issueToken("alice");
		expect(accounts.resolveToken(token.token)).toBe("alice");
		const unknown = accounts.issueToken("nobody");
		expect(accounts.resolveToken(unknown.token)).toBe("nobody");
		accounts.revokeToken(token.token);
		expect(accounts.resolveToken(token.token)).toBeUndefined();
	});
});
