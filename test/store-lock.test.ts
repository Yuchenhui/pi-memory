/**
 * Tests for the cross-process store lock.
 *
 * Run:   bun test test/store-lock.test.ts
 *
 * The lock exists because two pi processes pointed at one memory store used to
 * lose writes silently. The interesting properties are therefore: exclusion
 * while held, re-read *inside* the lock, refusal after a crash, and -- most
 * importantly -- that a reader which takes no lock never observes a torn file.
 * All file I/O happens in temp directories.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendToStore,
	isTransientShareError,
	renameWithRetry,
	storeLockDir,
	updateStore,
	withStoreLock,
	writeFileAtomic,
} from "../index.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-lock-"));
	file = path.join(dir, "MEMORY.md");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_MEMORY_LOCK_STALE_MS;
	delete process.env.PI_MEMORY_LOCK_TIMEOUT_MS;
});

describe("withStoreLock", () => {
	test("creates the lock while held and removes it afterwards", () => {
		const lockDir = storeLockDir(file);
		expect(fs.existsSync(lockDir)).toBe(false);
		withStoreLock(file, () => {
			expect(fs.existsSync(lockDir)).toBe(true);
		});
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	test("a second holder is refused instead of interleaving", () => {
		withStoreLock(file, () => {
			expect(() => withStoreLock(file, () => "should not run", 150)).toThrow(/Timed out/);
		});
	});

	test("releases the lock when the critical section throws", () => {
		expect(() =>
			withStoreLock(file, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(fs.existsSync(storeLockDir(file))).toBe(false);
		// The next writer must not be blocked by the failed one.
		expect(withStoreLock(file, () => "ok", 150)).toBe("ok");
	});

	test("never reclaims an ancient orphan, even with the retired stale setting", () => {
		process.env.PI_MEMORY_LOCK_STALE_MS = "1";
		const lockDir = storeLockDir(file);
		fs.mkdirSync(lockDir);
		fs.writeFileSync(path.join(lockDir, "evidence"), "orphan");
		fs.writeFileSync(file, "unchanged");
		const old = new Date(Date.now() - 86_400_000);
		fs.utimesSync(lockDir, old, old);
		expect(() => withStoreLock(file, () => fs.writeFileSync(file, "stolen"), 150)).toThrow(
			/no auto.*reclaim.*confirm.*no writer/i,
		);
		expect(fs.readFileSync(file, "utf-8")).toBe("unchanged");
		expect(fs.readFileSync(path.join(lockDir, "evidence"), "utf-8")).toBe("orphan");
		expect(fs.statSync(lockDir).mtimeMs).toBe(old.getTime());
	});

	test("does not remove a lock with a changed owner token", () => {
		const lockDir = storeLockDir(file);
		withStoreLock(file, () => {
			fs.writeFileSync(path.join(lockDir, "owner"), "another-owner");
		});
		expect(fs.readFileSync(path.join(lockDir, "owner"), "utf-8")).toBe("another-owner");
	});

	test("does not remove a replacement directory, even with a copied token", () => {
		const lockDir = storeLockDir(file);
		withStoreLock(file, () => {
			const token = fs.readFileSync(path.join(lockDir, "owner"), "utf-8");
			fs.renameSync(lockDir, `${lockDir}.old`);
			fs.mkdirSync(lockDir);
			fs.writeFileSync(path.join(lockDir, "owner"), token);
		});
		expect(fs.existsSync(path.join(lockDir, "owner"))).toBe(true);
	});

	test("cleans its directory if owner metadata initialization fails", () => {
		const originalWrite = fs.writeFileSync;
		const write = spyOn(fs, "writeFileSync").mockImplementation((destination) => {
			// Simulate a failure after writing only part of the token.
			originalWrite(destination, "partial", "utf-8");
			throw new Error("metadata write failed");
		});
		try {
			expect(() => withStoreLock(file, () => "must not run")).toThrow("metadata write failed");
		} finally {
			write.mockRestore();
		}
		expect(fs.existsSync(storeLockDir(file))).toBe(false);
	});

	test("cleans its empty directory if owner metadata cannot be opened", () => {
		const open = spyOn(fs, "openSync").mockImplementation(() => {
			throw new Error("metadata open failed");
		});
		try {
			expect(() => withStoreLock(file, () => "must not run")).toThrow("metadata open failed");
		} finally {
			open.mockRestore();
		}
		expect(fs.existsSync(storeLockDir(file))).toBe(false);
	});

	test("rejects invalid timeout configuration before entering or creating a lock", () => {
		for (const value of ["NaN", "Infinity", "-Infinity", "0", "-1", "", "300001"]) {
			process.env.PI_MEMORY_LOCK_TIMEOUT_MS = value;
			expect(() => withStoreLock(file, () => "must not run")).toThrow(/timeout/i);
			expect(fs.existsSync(storeLockDir(file))).toBe(false);
		}
		for (const value of [NaN, Infinity, 0, -1, 300_001]) {
			expect(() => withStoreLock(file, () => "must not run", value)).toThrow(/timeout/i);
		}
		// Invalid budgets must also reject immediately on a contended lock,
		// without altering either the existing lock or the target.
		fs.mkdirSync(storeLockDir(file));
		fs.writeFileSync(file, "unchanged");
		for (const value of ["NaN", "Infinity"]) {
			process.env.PI_MEMORY_LOCK_TIMEOUT_MS = value;
			expect(() => withStoreLock(file, () => fs.writeFileSync(file, "changed"))).toThrow(/timeout/i);
		}
		expect(fs.readFileSync(file, "utf-8")).toBe("unchanged");
		expect(fs.readdirSync(storeLockDir(file))).toEqual([]);
	});

	test("does not steal a lock that is merely fresh", () => {
		process.env.PI_MEMORY_LOCK_STALE_MS = "60_000";
		const lockDir = storeLockDir(file);
		fs.mkdirSync(lockDir);
		try {
			expect(() => withStoreLock(file, () => "stolen", 150)).toThrow(/Timed out/);
		} finally {
			fs.rmSync(lockDir, { recursive: true, force: true });
		}
	});

	test("creates a missing store directory instead of failing the write", () => {
		// mkdir for a lock can come back ENOENT on a volume two endpoints share,
		// when the tree is being created at that exact moment. The write must
		// survive that; the retry is bounded so a genuinely absent path still
		// surfaces as an error rather than spinning.
		const nested = path.join(dir, "does", "not", "exist", "daily", "2026-10-05.md");
		expect(withStoreLock(nested, () => "acquired", 5_000)).toBe("acquired");
		expect(fs.existsSync(path.join(dir, "does", "not", "exist", "daily"))).toBe(true);
	});

	test("never enters while a synchronous holder blocks beyond the former stale threshold", async () => {
		// Atomics.wait blocks the child's event loop: no timer can establish liveness.
		// The contender must time out, not enter while the holder is still working.
		const holderScript = path.join(dir, "holder.mjs");
		fs.writeFileSync(
			holderScript,
			[
				`import fs from "node:fs";`,
				`import { withStoreLock } from ${JSON.stringify(path.resolve(import.meta.dir, "..", "index.ts"))};`,
				`const [file, ms] = process.argv.slice(2);`,
				`withStoreLock(file, () => {`,
				`  fs.writeFileSync(${JSON.stringify(path.join(dir, "acquired"))}, "1");`,
				`  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));`,
				`});`,
			].join("\n"),
			"utf-8",
		);
		const acquired = path.join(dir, "acquired");
		const holder = spawn(process.execPath, [holderScript, file, "1500"], {
			stdio: ["ignore", "ignore", "inherit"],
			env: { ...process.env, PI_MEMORY_LOCK_STALE_MS: "50" },
		});
		const exited = new Promise<number>((resolve, reject) => {
			holder.on("error", reject);
			holder.on("exit", (code) => resolve(code ?? -1));
		});
		// Wait until the holder actually owns the lock.
		for (let i = 0; i < 200 && !fs.existsSync(acquired); i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(fs.existsSync(acquired)).toBe(true);

		process.env.PI_MEMORY_LOCK_STALE_MS = "50";
		let entered = false;
		try {
			expect(() =>
				withStoreLock(
					file,
					() => {
						entered = true;
					},
					400,
				),
			).toThrow(/Timed out/);
			expect(entered).toBe(false);
			expect(fs.existsSync(storeLockDir(file))).toBe(true);
		} finally {
			expect(await exited).toBe(0);
		}
		expect(fs.existsSync(storeLockDir(file))).toBe(false);
		expect(withStoreLock(file, () => "next", 150)).toBe("next");
	});
});

describe("renameWithRetry", () => {
	test("rejects nonfinite or unreasonable retry budgets without calling rename", () => {
		for (const budget of [NaN, Infinity, -1, 300_001]) {
			let called = false;
			expect(() =>
				renameWithRetry("unused", "unused", budget, () => {
					called = true;
				}),
			).toThrow(/budget/i);
			expect(called).toBe(false);
		}
	});

	test("retries a transient share violation and then succeeds", () => {
		const from = path.join(dir, "a.tmp");
		const to = path.join(dir, "b");
		fs.writeFileSync(from, "payload");
		let calls = 0;
		renameWithRetry(from, to, 5_000, (f, t) => {
			calls += 1;
			if (calls < 3) {
				const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			fs.renameSync(f, t);
		});
		expect(calls).toBe(3);
		expect(fs.readFileSync(to, "utf-8")).toBe("payload");
	});

	test("gives up once the budget is spent, and rethrows what is not transient", () => {
		const from = path.join(dir, "a.tmp");
		fs.writeFileSync(from, "payload");
		let calls = 0;
		expect(() =>
			renameWithRetry(from, path.join(dir, "b"), 0, () => {
				calls += 1;
				const err = new Error("EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}),
		).toThrow("EPERM");
		expect(calls).toBe(1);

		expect(() =>
			renameWithRetry(from, path.join(dir, "b"), 5_000, () => {
				throw new Error("no space left on device");
			}),
		).toThrow(/no space left/);
	});

	test("classifies share errors by code, not by message", () => {
		for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]) {
			const err = new Error(code) as NodeJS.ErrnoException;
			err.code = code;
			expect(isTransientShareError(err)).toBe(true);
		}
		for (const code of ["ENOENT", "EISDIR", "EXDEV", undefined]) {
			const err = new Error("nope") as NodeJS.ErrnoException;
			err.code = code;
			expect(isTransientShareError(err)).toBe(false);
		}
		expect(isTransientShareError(new Error("plain"))).toBe(false);
	});
});

describe("writeFileAtomic", () => {
	test("replaces the file and leaves no temp file behind", () => {
		fs.writeFileSync(file, "old");
		writeFileAtomic(file, "new");
		expect(fs.readFileSync(file, "utf-8")).toBe("new");
		expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
});

describe("appendToStore", () => {
	test("merges onto whatever is on disk at the time of the write", () => {
		appendToStore(file, "first");
		// Simulate another process appending between our read and our write: the
		// append below is the re-read-under-lock property, so the result has both.
		appendToStore(file, "second");
		expect(fs.readFileSync(file, "utf-8")).toBe("first\n\nsecond");
	});

	test("returns the content that was there before the append", () => {
		appendToStore(file, "one");
		expect(appendToStore(file, "two")).toBe("one");
	});

	test("does not add a separator to an empty file", () => {
		appendToStore(file, "only");
		expect(fs.readFileSync(file, "utf-8")).toBe("only");
	});
});

describe("updateStore", () => {
	test("hands the transform the content read inside the lock", () => {
		updateStore(file, (existing) => ({ content: `${existing}seed\n`, result: existing }));
		const seen = updateStore(file, (existing) => ({
			content: `${existing}more\n`,
			result: existing,
		}));
		expect(seen).toBe("seed\n");
		expect(fs.readFileSync(file, "utf-8")).toBe("seed\nmore\n");
	});
});

/**
 * The property the whole layer exists for: many processes, one file, no lost
 * writes. Child processes are used rather than threads because the critical
 * section blocks with Atomics.wait, which would deadlock a same-thread loop.
 */
describe("concurrent writers", () => {
	const WORKERS = 6;
	const PER_WORKER = 15;

	test(`${WORKERS} processes x ${PER_WORKER} appends all survive`, async () => {
		const script = path.join(dir, "writer.ts");
		fs.writeFileSync(
			script,
			[
				`import { appendToStore } from ${JSON.stringify(path.resolve(import.meta.dir, "..", "index.ts"))};`,
				`const [file, tag, n] = process.argv.slice(2);`,
				`for (let i = 0; i < Number(n); i++) appendToStore(file, \`\${tag}-\${i}\`);`,
			].join("\n"),
			"utf-8",
		);
		fs.writeFileSync(file, "");

		await Promise.all(
			Array.from(
				{ length: WORKERS },
				(_, w) =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(process.execPath, [script, file, `w${w}`, String(PER_WORKER)], {
							stdio: ["ignore", "pipe", "pipe"],
						});
						let stderr = "";
						child.stderr.on("data", (c) => {
							stderr += String(c);
						});
						child.on("error", reject);
						child.on("exit", (code) =>
							code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}: ${stderr}`)),
						);
					}),
			),
		);

		const final = fs.readFileSync(file, "utf-8");
		const entries = final.split("\n\n").filter((e) => e.trim());
		expect(entries.length).toBe(WORKERS * PER_WORKER);
		for (let w = 0; w < WORKERS; w++) {
			for (let i = 0; i < PER_WORKER; i++) {
				expect(final).toContain(`w${w}-${i}`);
			}
		}
		// And a lock-free reader never sees a torn entry.
		for (const entry of entries) {
			expect(entry).toMatch(/^w\d+-\d+$/);
		}
	});

	test("a lock-free reader in another process only ever sees whole files", async () => {
		// Same shape as the benchmark: the reader takes no lock and polls in a
		// separate process. With rename in place every read lands on one complete
		// version; truncating in place made ~99% of these reads torn.
		const target = path.join(dir, "torn.md");
		const readerScript = path.join(dir, "reader.mjs");
		fs.writeFileSync(
			readerScript,
			[
				`import fs from "node:fs";`,
				`const [file, deadline] = process.argv.slice(2);`,
				`let reads = 0, torn = 0;`,
				`const until = Date.now() + Number(deadline);`,
				`while (Date.now() < until) {`,
				`  const text = fs.readFileSync(file, "utf-8");`,
				`  reads++;`,
				`  const kinds = new Set(text.split("\\n").filter(Boolean));`,
				`  if (kinds.size !== 1) torn++;`,
				`}`,
				`process.stdout.write(JSON.stringify({ reads, torn }));`,
			].join("\n"),
			"utf-8",
		);

		const versions = ["v1\n".repeat(400), "v2\n".repeat(400), "v3\n".repeat(400)];
		fs.writeFileSync(target, versions[0]);
		const reader = spawn(process.execPath, [readerScript, target, "2500"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		reader.stdout.on("data", (c) => {
			out += String(c);
		});

		// Hammer the target for as long as the reader polls.
		const until = Date.now() + 2200;
		let round = 0;
		while (Date.now() < until) {
			writeFileAtomic(target, versions[round++ % versions.length]);
		}
		const exit = await new Promise<number>((resolve) => reader.on("exit", (code) => resolve(code ?? -1)));
		expect(exit).toBe(0);
		const summary = JSON.parse(out) as { reads: number; torn: number };
		expect(summary.reads).toBeGreaterThan(100);
		expect(summary.torn).toBe(0);
	});
});
