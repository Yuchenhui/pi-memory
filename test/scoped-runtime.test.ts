import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import extension, {
	_clearEmbedInFlight,
	_clearUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_resetMemorySnapshot,
	_resetSummaryCompleteForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	_setSummaryCompleteForTest,
	createScopedMemoryRecord,
	formatMemoryRecord,
	parseMemoryStore,
	resolveMemoryCandidate,
	scopedMemoryIdentity,
	todayStr,
} from "../index.ts";

let tmp: string;
let hooks: Record<string, (...args: any[]) => Promise<any>>;
let tools: Record<string, any>;
let savedEnv: Record<string, string | undefined>;
const ctx = { cwd: "/workspace/one", sessionManager: { getSessionId: () => "runtime-session" } };
const identity = scopedMemoryIdentity(ctx.cwd, "runtime-session");
function frame(
	content: string,
	scope: "environment" | "project" | "shared" = "environment",
	source = identity.source,
	project = identity.project,
) {
	return formatMemoryRecord(
		createScopedMemoryRecord(
			content,
			{ ...identity, source, project },
			{
				scope,
				...(scope === "shared" ? {} : { environment: source }),
				...(scope === "project" ? { project } : {}),
				classification: { mechanism: "rule" },
			},
		),
	);
}
const execute = (name: string, params: object, context: any = ctx) =>
	tools[name].execute("fixture", params, undefined, undefined, context);
const text = (result: any) => result?.content?.map((item: any) => item.text ?? "").join("\n") ?? "";

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-runtime-"));
	_setBaseDir(tmp);
	_resetMemorySnapshot();
	_setQmdAvailable(false);
	_setExecFileForTest(((_file: any, _args: any, _opts: any, cb: any) =>
		cb(new Error("fixture offline"), "", "")) as any);
	savedEnv = {};
	for (const key of [
		"PI_MEMORY_CLASSIFIER",
		"TYPESAFE_API_KEY",
		"PI_MEMORY_SNAPSHOT",
		"PI_MEMORY_NO_SEARCH",
		"PI_MEMORY_EXIT_SUMMARY",
		"PI_MEMORY_EXIT_SUMMARY_MODEL",
		"PI_MEMORY_QMD_UPDATE",
	])
		savedEnv[key] = process.env[key];
	delete process.env.TYPESAFE_API_KEY;
	delete process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;
	process.env.PI_MEMORY_EXIT_SUMMARY = "1";
	process.env.PI_MEMORY_SNAPSHOT = "stable";
	process.env.PI_MEMORY_NO_SEARCH = "1";
	hooks = {};
	tools = {};
	extension({
		on: (name: string, fn: any) => {
			hooks[name] = fn;
		},
		registerTool: (tool: any) => {
			tools[tool.name] = tool;
		},
	} as any);
	fs.mkdirSync(path.join(tmp, "daily"));
});
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	_clearUpdateTimer();
	_clearEmbedInFlight();
	_setQmdAvailable(false);
	_resetExecFileForTest();
	_resetSummaryCompleteForTest();
	_resetMemorySnapshot();
	_resetBaseDir();
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("registered runtime injection filters frames and rechecks same-size restored-mtime replacements and cwd", async () => {
	const first = frame("visible-one", "project");
	const file = path.join(tmp, "MEMORY.md");
	fs.writeFileSync(file, `legacy-secret\n${first}`);
	const event = { systemPrompt: "system", prompt: "hello" };
	const a = await hooks.before_agent_start(event, ctx);
	expect(a.systemPrompt).toContain("visible-one");
	expect(a.systemPrompt).not.toContain("legacy-secret");
	const stat = fs.statSync(file);
	fs.writeFileSync(file, `legacy-secret\n${first.replace("visible-one", "visible-two")}`);
	fs.utimesSync(file, stat.atime, stat.mtime);
	const b = await hooks.before_agent_start(event, ctx);
	expect(b.systemPrompt).toContain("visible-two");
	expect(b.systemPrompt).not.toContain("visible-one");
	expect((await hooks.before_agent_start(event, ctx)).systemPrompt).toBe(b.systemPrompt);
	fs.appendFileSync(file, "\nlegacy extra secret");
	expect((await hooks.before_agent_start(event, ctx)).systemPrompt).toBe(b.systemPrompt);
	expect(await hooks.before_agent_start(event, { ...ctx, cwd: "/workspace/two" })).toBeUndefined();
	expect(await hooks.before_agent_start(event, {})).toBeUndefined();
	fs.unlinkSync(file);
	expect(await hooks.before_agent_start(event, ctx)).toBeUndefined();
});

test("registered search uses authoritative applicable candidate evidence, not qmd payloads or unsafe paths", async () => {
	fs.writeFileSync(
		path.join(tmp, "MEMORY.md"),
		[
			"legacy-secret",
			frame("local-evidence"),
			frame("shared-evidence", "shared"),
			frame("foreign-secret", "environment", "windows"),
			frame("project-secret", "project", identity.source, "other"),
		].join("\n\n"),
	);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memory-outside-"));
	try {
		fs.writeFileSync(path.join(outside, "outside.md"), frame("outside-secret"));
		fs.symlinkSync(path.join(outside, "outside.md"), path.join(tmp, "daily", "2026-01-01.md"));
		const replies = [
			{
				file: "qmd://pi-memory/MEMORY.md",
				snippet: "foreign-secret adjacent legacy-secret",
				title: "untrusted-title",
			},
			{ path: pathToFileURL(path.join(tmp, "MEMORY.md")).href, content: "untrusted-content" },
			{ file: "qmd://other/MEMORY.md", snippet: "wrong-collection" },
			{ path: "../outside.md", snippet: "traversal" },
			{ path: "daily/2026-01-01.md", snippet: "symlink" },
			{ path: "daily/2026-99-99.md", snippet: "invalid-date" },
			{ path: "#unknown-document", snippet: "unresolvable" },
		];
		_setQmdAvailable(true);
		_setExecFileForTest(((_file: any, args: string[], _opts: any, cb: any) =>
			cb(null, args[0] === "collection" ? "pi-memory" : JSON.stringify(replies), "")) as any);
		const result = await execute("memory_search", { query: "topic", limit: 25, mode: "semantic" });
		const rendered = text(result);
		expect(rendered).toContain("local-evidence");
		expect(rendered).toContain("shared-evidence");
		for (const secret of [
			"foreign-secret",
			"legacy-secret",
			"project-secret",
			"outside-secret",
			"untrusted-title",
			"untrusted-content",
			"wrong-collection",
			"traversal",
			"unresolvable",
		])
			expect(rendered).not.toContain(secret);
		expect(result.details.count).toBe(1);
		expect(resolveMemoryCandidate("qmd://pi-memory/%2e%2e/outside.md")).toBeUndefined();
		expect(resolveMemoryCandidate(path.join(outside, "outside.md"))).toBeUndefined();
		process.env.PI_MEMORY_SNAPSHOT = "per-turn";
		delete process.env.PI_MEMORY_NO_SEARCH;
		const injected = await hooks.before_agent_start({ systemPrompt: "base", prompt: "topic" }, ctx);
		expect(injected.systemPrompt).toContain("Candidate file");
		expect(injected.systemPrompt).not.toContain("foreign-secret");
		_setExecFileForTest(((_file: any, _args: any, _opts: any, cb: any) =>
			cb(new Error("foreign-secret raw qmd failure"), "", "")) as any);
		expect(text(await execute("memory_search", { query: "topic" }))).not.toContain("foreign-secret");
		expect((await execute("memory_search", { query: "topic" }, {})).isError).toBe(true);
	} finally {
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("default inventory filters daily files; inspection warns and status reports scoped counts", async () => {
	fs.writeFileSync(
		path.join(tmp, "MEMORY.md"),
		[
			"legacy-secret",
			frame("local"),
			frame("foreign-secret", "environment", "windows"),
			frame("project-secret", "project", identity.source, "other"),
		].join("\n\n"),
	);
	fs.writeFileSync(
		path.join(tmp, "SCRATCHPAD.md"),
		[frame("- [ ] local-task"), frame("- [ ] foreign-task", "environment", "windows")].join("\n\n"),
	);
	fs.writeFileSync(path.join(tmp, "daily", "2026-01-01.md"), frame("local-day"));
	fs.writeFileSync(path.join(tmp, "daily", "2026-01-02.md"), frame("foreign-day", "environment", "windows"));
	fs.writeFileSync(path.join(tmp, "daily", "2026-01-03.md"), "legacy-day");
	fs.writeFileSync(path.join(tmp, "daily", "2026-99-99.md"), "invalid-day");
	expect((await execute("memory_read", { target: "list" })).details.files).toEqual(["2026-01-01.md"]);
	const inspect = await execute("memory_read", { target: "list", inspect: true });
	expect(inspect.details.files).toHaveLength(3);
	expect(text(inspect)).toContain("REFERENCE-ONLY");
	const status = await execute("memory_status", {});
	expect(status.details.applicable).toBe(3);
	expect(status.details.total).toBe(7);
	expect(status.details.legacy).toBe(2);
	expect(status.details.scratchpadOpen).toBe(1);
	expect(text(status)).toContain(fs.realpathSync(tmp));
	expect(text(status)).not.toContain("foreign-secret");
	expect(text(status)).not.toContain("foreign-task");
	expect((await execute("memory_status", {}, {})).isError).toBe(true);
});

test("compact frames only applicable open work and daily evidence, with actual provenance", async () => {
	fs.writeFileSync(
		path.join(tmp, "SCRATCHPAD.md"),
		[
			"legacy-secret",
			frame("- [ ] local-work", "project"),
			frame("- [x] completed-work"),
			frame("- [ ] foreign-secret", "environment", "windows"),
			frame("- [ ] mismatch-secret", "project", identity.source, "other"),
		].join("\n\n"),
	);
	const daily = path.join(tmp, "daily", `${todayStr()}.md`);
	fs.writeFileSync(
		daily,
		[frame("applicable-day"), frame("foreign-day-secret", "environment", "windows")].join("\n\n"),
	);
	await hooks.session_before_compact({}, ctx);
	const records = parseMemoryStore(fs.readFileSync(daily, "utf8")).records;
	const handoff = records.find((record) => record.content.includes("Session Handoff"))!;
	expect(handoff.source).toBe(identity.source);
	expect(handoff.scope).toBe("project");
	expect(handoff.project).toBe(identity.project);
	expect(handoff.content).toContain("local-work");
	expect(handoff.content).toContain("applicable-day");
	for (const secret of ["legacy-secret", "completed-work", "foreign-secret", "mismatch-secret", "foreign-day-secret"])
		expect(handoff.content).not.toContain(secret);
	const before = fs.readFileSync(daily, "utf8");
	await hooks.session_before_compact({}, {});
	expect(fs.readFileSync(daily, "utf8")).toBe(before);
});

test("shutdown provider work is outside lock and appends original generated text as source-local frame", async () => {
	const original = "## Decisions\nOriginal generated decision.\n\n## Lessons\nNone.\n";
	let calls = 0;
	_setSummaryCompleteForTest((async () => {
		calls++;
		expect(fs.readdirSync(path.join(tmp, "daily")).some((file) => file.includes("lock"))).toBe(false);
		// A concurrent writer lands while generation is in flight. The commit
		// must re-read instead of overwriting this new frame.
		fs.writeFileSync(
			path.join(tmp, "daily", `${todayStr()}.md`),
			frame("other-writer-secret", "environment", "windows"),
		);
		return { content: [{ type: "text", text: original }] };
	}) as any);
	const shutdownCtx = {
		...ctx,
		model: { provider: "fixture", id: "offline" },
		modelRegistry: { getApiKey: async () => "fixture-only" },
		sessionManager: {
			...ctx.sessionManager,
			getBranch: () =>
				Array.from({ length: 4 }, (_, i) => ({
					type: "message",
					message: {
						role: i % 2 ? "assistant" : "user",
						content: [{ type: "text", text: "fixture dialogue" }],
						timestamp: 1,
					},
				})),
		},
	};
	await hooks.session_shutdown({ reason: "quit" }, shutdownCtx);
	expect(calls).toBe(1);
	const records = parseMemoryStore(fs.readFileSync(path.join(tmp, "daily", `${todayStr()}.md`), "utf8")).records;
	expect(records).toHaveLength(2);
	expect(records[0].content).toBe("other-writer-secret");
	expect(records[1].source).toBe(identity.source);
	expect(records[1].scope).not.toBe("shared");
	expect(records[1].sessionId).toBe(identity.sessionId);
	expect(records[1].content).toContain(original);
	expect(records[1].content).not.toContain("other-writer-secret");
	await hooks.session_shutdown({ reason: "quit" }, { ...shutdownCtx, cwd: undefined });
	expect(calls).toBe(1);
});

test("malformed and legacy stores are inspectable but never ambient or compacted", async () => {
	const malformed = "<!-- pi-memory-record:v1:not-base64:15 -->\nmalformed-secret";
	fs.writeFileSync(path.join(tmp, "MEMORY.md"), malformed);
	fs.writeFileSync(path.join(tmp, "SCRATCHPAD.md"), "- [ ] legacy-secret");
	fs.writeFileSync(path.join(tmp, "daily", `${todayStr()}.md`), "legacy-day-secret");
	expect(await hooks.before_agent_start({ systemPrompt: "base" }, ctx)).toBeUndefined();
	expect(text(await execute("memory_read", { target: "long_term" }))).not.toContain("malformed-secret");
	const inspected = text(await execute("memory_read", { target: "long_term", inspect: true }));
	expect(inspected).toContain("REFERENCE-ONLY");
	expect(inspected).toContain("malformed-secret");
	await hooks.session_before_compact({}, ctx);
	expect(fs.readFileSync(path.join(tmp, "daily", `${todayStr()}.md`), "utf8")).toBe("legacy-day-secret");
});

test("forget and restore refresh registered context without resurrecting hidden facts", async () => {
	const file = path.join(tmp, "MEMORY.md");
	fs.writeFileSync(
		file,
		["legacy-secret", frame("visible-forget"), frame("foreign-secret", "environment", "windows")].join("\n\n"),
	);
	const event = { systemPrompt: "base" };
	expect((await hooks.before_agent_start(event, ctx)).systemPrompt).toContain("visible-forget");
	const forgotten = await execute("memory_forget", { match: "visible-forget" });
	expect(text(forgotten)).not.toContain("foreign-secret");
	expect(await hooks.before_agent_start(event, ctx)).toBeUndefined();
	const restored = await execute("memory_restore", { recoveryId: forgotten.details.recoveryId });
	expect(restored.details.restored).toBe(1);
	const prompt = (await hooks.before_agent_start(event, ctx)).systemPrompt;
	expect(prompt).toContain("visible-forget");
	expect(prompt).not.toContain("foreign-secret");
	expect(prompt).not.toContain("legacy-secret");
	const beforeRepeat = fs.readFileSync(file, "utf8");
	expect(text(await execute("memory_restore", { recoveryId: forgotten.details.recoveryId }))).toContain(
		"already restored",
	);
	expect(fs.readFileSync(file, "utf8")).toBe(beforeRepeat);
});
