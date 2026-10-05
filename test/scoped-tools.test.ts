import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import memoryExtension, {
	_clearEmbedInFlight,
	_clearUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	createScopedMemoryRecord,
	formatMemoryRecord,
	parseMemoryStore,
	type ScopedMemoryIdentity,
	scopedMemoryIdentity,
	scopedVisibleRecords,
	transformScopedRecords,
} from "../index.ts";

let savedTypesafeKey: string | undefined;
beforeEach(() => {
	savedTypesafeKey = process.env.TYPESAFE_API_KEY;
	delete process.env.TYPESAFE_API_KEY;
	_setQmdAvailable(false);
	_setExecFileForTest(((_file: unknown, _args: unknown, _opts: unknown, cb: any) =>
		cb(new Error("fixture offline"), "", "")) as any);
});
afterEach(() => {
	if (savedTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = savedTypesafeKey;
	_clearUpdateTimer();
	_clearEmbedInFlight();
	_setQmdAvailable(false);
	_resetExecFileForTest();
});

const windows: ScopedMemoryIdentity = { source: "windows", project: "project:one", sessionId: "session1" };
const wsl: ScopedMemoryIdentity = { source: "wsl", project: "project:one", sessionId: "session2" };

function record(content: string, identity = windows) {
	return createScopedMemoryRecord(content, identity, {
		scope: "environment",
		environment: identity.source,
		classification: { mechanism: "rule" },
	});
}

describe("scoped record transforms", () => {
	test("shows only applicable frames and preserves exact foreign and legacy bytes", () => {
		const local = record("local");
		const foreign = record("foreign", wsl);
		const legacy = "legacy example\n";
		const store = `${legacy}${formatMemoryRecord(local)}\n\n${formatMemoryRecord(foreign)}`;
		expect(scopedVisibleRecords(store, windows).map((item) => item.content)).toEqual(["local"]);
		const transformed = transformScopedRecords(store, new Set([local.id]));
		expect(transformed).toBe(`${legacy}\n\n${formatMemoryRecord(foreign)}`);
	});

	test("uses parsed offsets rather than matching an identical frame-shaped example", () => {
		const live = record("live");
		const frame = formatMemoryRecord(live);
		const store = `\`\`\`markdown\n${frame}\n\`\`\`\n${frame}`;
		const transformed = transformScopedRecords(store, new Set([live.id]));
		expect(transformed).toBe(`\`\`\`markdown\n${frame}\n\`\`\`\n`);
		expect(parseMemoryStore(transformed).records).toHaveLength(0);
	});

	test("places an append before a malformed tail after valid frames without changing legacy bytes", () => {
		const prior = record("prior");
		const next = record("safe");
		const malformed = "<!-- pi-memory-record:v1:not-base64:20 -->\nambiguous";
		const store = `${formatMemoryRecord(prior)}\n\n${malformed}`;
		const transformed = transformScopedRecords(store, new Set(), new Map(), [next]);
		expect(scopedVisibleRecords(transformed, windows).map((item) => item.content)).toEqual(["prior", "safe"]);
		expect(transformed).toEndWith(malformed);
		expect(transformed.slice(transformed.indexOf(malformed))).toBe(malformed);
	});

	test("places an append outside an unmatched legacy fence", () => {
		const next = record("safe");
		const unmatchedFence = "```markdown\nlegacy fenced example";
		const transformed = transformScopedRecords(unmatchedFence, new Set(), new Map(), [next]);
		expect(scopedVisibleRecords(transformed, windows).map((item) => item.content)).toEqual(["safe"]);
		expect(transformed).toEndWith(unmatchedFence);
	});

	test("registered tools enforce context, scope reads, validate daily dates, and restore by frame ID", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-scoped-"));
		const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
		memoryExtension({ registerTool: (tool: any) => (tools[tool.name] = tool), on: () => {} } as any);
		_setBaseDir(tmp);
		const ctx = { cwd: "/workspace/project", sessionManager: { getSessionId: () => "abcdef123" } };
		try {
			const noCwd = await tools.memory_write.execute(
				"id",
				{ target: "long_term", content: "nope" },
				undefined,
				undefined,
				{},
			);
			expect(noCwd.isError).toBe(true);
			await tools.memory_write.execute(
				"id",
				{ target: "long_term", content: "shared", scope: "shared" },
				undefined,
				undefined,
				ctx,
			);
			const read = await tools.memory_read.execute("id", { target: "long_term" }, undefined, undefined, ctx);
			expect(read.content[0].text).toContain("shared");
			const invalid = await tools.memory_read.execute(
				"id",
				{ target: "daily", date: "../../x" },
				undefined,
				undefined,
				ctx,
			);
			expect(invalid.isError).toBe(true);
			await tools.scratchpad.execute("id", { action: "add", text: "task" }, undefined, undefined, ctx);
			const forgotten = await tools.memory_forget.execute("id", { match: "shared" }, undefined, undefined, ctx);
			const restored = await tools.memory_restore.execute(
				"id",
				{ recoveryId: forgotten.details.recoveryId },
				undefined,
				undefined,
				ctx,
			);
			expect(restored.details.restored).toBe(1);
		} finally {
			_resetBaseDir();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("actual tools preserve foreign and legacy frames across scoped mutations", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-scoped-mixed-"));
		const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
		memoryExtension({ registerTool: (tool: any) => (tools[tool.name] = tool), on: () => {} } as any);
		_setBaseDir(tmp);
		const ctx = { cwd: "/workspace/project", sessionManager: { getSessionId: () => "abcdef123" } };
		const local = scopedMemoryIdentity(ctx.cwd, "local");
		const foreignSource = local.source === "wsl" ? "windows" : "wsl";
		const foreign: ScopedMemoryIdentity = { ...local, source: foreignSource, sessionId: "foreign" };
		const localRecord = record("replace me", local);
		const foreignRecord = record("foreign must survive", foreign);
		const legacy = "legacy bytes must survive\n";
		try {
			fs.writeFileSync(
				path.join(tmp, "MEMORY.md"),
				`${legacy}${formatMemoryRecord(localRecord)}\n\n${formatMemoryRecord(foreignRecord)}`,
			);
			await tools.memory_write.execute(
				"id",
				{ target: "long_term", content: "replacement", mode: "overwrite" },
				null,
				null,
				ctx,
			);
			let memory = fs.readFileSync(path.join(tmp, "MEMORY.md"), "utf8");
			expect(memory).toContain("replacement");
			expect(memory).toContain(legacy);
			expect(memory).toContain(formatMemoryRecord(foreignRecord));
			const forgotten = await tools.memory_forget.execute("id", { match: "replacement" }, null, null, ctx);
			expect(forgotten.details.recoveryId).toBeTruthy();
			memory = fs.readFileSync(path.join(tmp, "MEMORY.md"), "utf8");
			expect(memory).toContain(legacy);
			expect(memory).toContain(formatMemoryRecord(foreignRecord));

			const localOpen = record("- [ ] local open", local);
			const localDone = record("- [x] local done", local);
			const foreignDone = record("- [x] foreign done", foreign);
			fs.writeFileSync(
				path.join(tmp, "SCRATCHPAD.md"),
				`${legacy}${formatMemoryRecord(localOpen)}\n\n${formatMemoryRecord(localDone)}\n\n${formatMemoryRecord(foreignDone)}`,
			);
			const doneMissingText = await tools.scratchpad.execute("id", { action: "done" }, null, null, ctx);
			expect(doneMissingText.isError).toBe(true);
			const undoMissingText = await tools.scratchpad.execute("id", { action: "undo" }, null, null, ctx);
			expect(undoMissingText.isError).toBe(true);
			const clear = await tools.scratchpad.execute("id", { action: "clear_done" }, null, null, ctx);
			expect(clear.details.changed).toBe(1);
			const scratchpad = fs.readFileSync(path.join(tmp, "SCRATCHPAD.md"), "utf8");
			expect(scratchpad).toContain(formatMemoryRecord(foreignDone));
			expect(scratchpad).toContain(legacy);
			expect(scratchpad).toContain("local open");
			expect(scratchpad).not.toContain("local done");
			const listed = await tools.scratchpad.execute("id", { action: "list" }, null, null, ctx);
			expect(listed.content[0].text).toContain("local open");
			expect(listed.content[0].text).not.toContain("foreign done");
			const inspected = await tools.scratchpad.execute("id", { action: "list", inspect: true }, null, null, ctx);
			expect(inspected.content[0].text).toContain("foreign done");

			const foreignRecoveryId = "123e4567-e89b-42d3-a456-426614174000";
			fs.mkdirSync(path.join(tmp, "recovery"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, "recovery", `${foreignRecoveryId}.json`),
				JSON.stringify({
					version: 1,
					id: foreignRecoveryId,
					createdAt: new Date().toISOString(),
					target: "long_term",
					removedContent: [formatMemoryRecord(foreignRecord)],
				}),
			);
			const denied = await tools.memory_restore.execute("id", { recoveryId: foreignRecoveryId }, null, null, ctx);
			expect(denied.isError).toBe(true);
			const recovery = JSON.parse(
				fs.readFileSync(path.join(tmp, "recovery", `${forgotten.details.recoveryId}.json`), "utf8"),
			);
			const codeExample = `\`\`\`markdown\n${recovery.removedContent[0]}\n\`\`\`\n`;
			fs.writeFileSync(
				path.join(tmp, "MEMORY.md"),
				`${codeExample}${fs.readFileSync(path.join(tmp, "MEMORY.md"), "utf8")}`,
			);
			const restored = await tools.memory_restore.execute(
				"id",
				{ recoveryId: forgotten.details.recoveryId },
				null,
				null,
				ctx,
			);
			expect(restored.details.restored).toBe(1);
			const repeat = await tools.memory_restore.execute(
				"id",
				{ recoveryId: forgotten.details.recoveryId },
				null,
				null,
				ctx,
			);
			expect(repeat.details.restored).toBeUndefined();
			for (const tool of Object.values(tools)) {
				if (
					!["memory_write", "memory_forget", "memory_restore", "memory_read", "scratchpad"].includes(
						(tool as any).name,
					)
				)
					continue;
				const params =
					(tool as any).name === "memory_write"
						? { target: "daily", content: "x" }
						: (tool as any).name === "memory_forget"
							? { match: "x" }
							: (tool as any).name === "memory_restore"
								? { recoveryId: foreignRecoveryId }
								: (tool as any).name === "memory_read"
									? { target: "list" }
									: { action: "list" };
				const noContext = await tool.execute("id", params, null, null, {});
				expect(noContext.isError).toBe(true);
			}
		} finally {
			_resetBaseDir();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
