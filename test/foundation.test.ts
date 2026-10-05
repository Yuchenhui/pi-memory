import { describe, expect, test } from "bun:test";
import {
	classifyMemoryCandidate,
	detectMemorySource,
	filterApplicableRecords,
	formatMemoryRecord,
	type MemoryRecord,
	parseMemoryStore,
	projectIdFromWorkspace,
	renderMemoryInspection,
	renderVisibleMemoryRecords,
} from "../index.ts";

const WINDOWS = { source: "windows", project: "project:shared" } as const;

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		version: 1,
		id: "b381dfe4-a111-4ed2-8a84-8e8934f8b693",
		createdAt: "2026-10-05T12:00:00.000Z",
		sessionId: "deadbeef",
		source: "windows",
		scope: "shared",
		classification: { mechanism: "rule" },
		content: "I prefer dark mode.",
		...overrides,
	};
}

describe("phase 1 memory record foundation", () => {
	test("detects Windows, WSL, native Linux, and unknown only from runtime evidence", () => {
		expect(detectMemorySource("win32", "10.0.26100")).toBe("windows");
		expect(detectMemorySource("linux", "5.15.153.1-microsoft-standard-WSL2")).toBe("wsl");
		expect(detectMemorySource("linux", "6.8.0-51-generic")).toBe("linux");
		expect(detectMemorySource("darwin", "24.0.0")).toBe("unknown");
	});

	test("uses an explicit ID or a normalized absolute workspace identity, never a basename", () => {
		expect(projectIdFromWorkspace("C:\\Work\\alpha", { PI_MEMORY_PROJECT_ID: "team-alpha" })).toBe(
			"explicit:team-alpha",
		);
		expect(projectIdFromWorkspace("/work/alpha")).not.toBe(projectIdFromWorkspace("/other/alpha"));
		expect(projectIdFromWorkspace("/work/alpha/")).toBe(projectIdFromWorkspace("/work/alpha"));
		expect(projectIdFromWorkspace("C:\\Work\\alpha\\")).toBe(projectIdFromWorkspace("C:\\Work\\alpha"));
		expect(projectIdFromWorkspace("\\workspace")).toBeUndefined();
		expect(projectIdFromWorkspace("/workspace")).toBeDefined();
		expect(projectIdFromWorkspace("alpha")).toBeUndefined();
	});

	test("does not serialize parser-only raw or offset helpers as metadata", () => {
		const parsed = parseMemoryStore(formatMemoryRecord(record())).records[0]!;
		expect(formatMemoryRecord(parsed)).not.toContain("raw");
		expect(formatMemoryRecord(parsed)).not.toContain("startOffset");
	});

	test("round-trips Unicode and CRLF bodies without accepting embedded forged markers", () => {
		const body = "第一行\r\n<!-- pi-memory-record:v1:forged:9 -->\r\n```\r\n🌈\r\n```";
		const formatted = formatMemoryRecord(record({ content: body }));
		const parsed = parseMemoryStore(`legacy bytes\r\n${formatted}`);
		expect(parsed.records).toHaveLength(1);
		expect(parsed.records[0]?.content).toBe(body);
		expect(parsed.legacySpans).toEqual(["legacy bytes\r\n"]);
		expect(parsed.records[0]?.raw).toBe(formatted);
		expect(parsed.records[0]).toMatchObject({
			startOffset: Buffer.byteLength("legacy bytes\r\n"),
			endOffset: Buffer.byteLength(`legacy bytes\r\n${formatted}`),
		});
	});

	test("rejects malformed or unknown framing as legacy verbatim", () => {
		const malformed = "<!-- pi-memory-record:v2:eyJ2ZXJzaW9uIjoyfQ:2 -->\nok";
		const parsed = parseMemoryStore(malformed);
		expect(parsed.records).toEqual([]);
		expect(parsed.legacySpans).toEqual([malformed]);
	});

	test("does not promote framing examples in legacy fences or after a corrupt outer frame", () => {
		const nested = formatMemoryRecord(record({ content: "must remain legacy" }));
		const fenced = `# Example\n\`\`\`markdown\n${nested}\n\`\`\``;
		expect(parseMemoryStore(fenced)).toEqual({ records: [], legacySpans: [fenced] });
		expect(parseMemoryStore(`~~~markdown\n${nested}\n~~~`).records).toHaveLength(0);
		expect(parseMemoryStore(`\`\`\`\`markdown\n\`\`\`\n${nested}\n\`\`\`\``).records).toHaveLength(0);

		const corruptThenNested = `<!-- pi-memory-record:v1:not-base64:20 -->\n${nested}`;
		expect(parseMemoryStore(corruptThenNested)).toEqual({ records: [], legacySpans: [corruptThenNested] });
	});

	test("rejects invalid UTF-8 body boundaries and unknown shared provenance", () => {
		const unicode = formatMemoryRecord(record({ content: "🌈" }));
		const splitUnicodeLength = unicode.replace(/:(\d+) -->/, ":3 -->");
		expect(parseMemoryStore(splitUnicodeLength)).toEqual({ records: [], legacySpans: [splitUnicodeLength] });
		expect(() => formatMemoryRecord(record({ source: "unknown", scope: "shared" }))).toThrow(
			"Invalid memory record metadata",
		);
		expect(() => formatMemoryRecord(record({ scope: "environment", environment: "wsl" }))).toThrow(
			"Invalid memory record metadata",
		);
	});

	test("only exposes shared, matching environment, and matching environment plus project", () => {
		const records = [
			record({ id: "00000000-0000-4000-8000-000000000001", scope: "shared" }),
			record({ id: "00000000-0000-4000-8000-000000000002", scope: "environment", environment: "windows" }),
			record({ id: "00000000-0000-4000-8000-000000000003", scope: "environment", environment: "wsl" }),
			record({
				id: "00000000-0000-4000-8000-000000000004",
				scope: "project",
				environment: "windows",
				project: "project:shared",
			}),
			record({
				id: "00000000-0000-4000-8000-000000000005",
				scope: "project",
				environment: "windows",
				project: "project:other",
			}),
		];
		expect(filterApplicableRecords(records, WINDOWS).map((item) => item.id)).toEqual([
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
			"00000000-0000-4000-8000-000000000004",
		]);
		expect(renderVisibleMemoryRecords(records, WINDOWS)).toContain("[source: windows | scope: shared]");
		expect(renderMemoryInspection({ records, legacySpans: ["old untagged text"] })).toContain("reference records");
	});

	test("sends the original candidate only and falls back source-local for low confidence", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const result = await classifyMemoryCandidate({
			content: "Keep answers concise — 机密原文",
			source: "windows",
			fetch: async (url, init) => {
				calls.push({ url: String(url), init });
				return new Response(
					JSON.stringify({
						answers: {
							applicability: {
								type: "choice",
								choice: "shared",
								confidence: 0.2,
								probabilities: { shared: 0.6, environment: 0.2, project: 0.2 },
							},
						},
					}),
				);
			},
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(JSON.parse(String(calls[0]?.init?.body)).state).toBe("Keep answers concise — 机密原文");
		expect(JSON.stringify(calls[0]?.init?.body)).not.toContain("test-key");
		expect(result.scope).toBe("environment");
		expect(result.classification.mechanism).toBe("fallback");
	});

	test("falls back promptly when cancellation occurs before or during a signal-ignoring response", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		let called = false;
		const beforeFetch = await classifyMemoryCandidate({
			content: "I prefer concise answers.",
			source: "windows",
			signal: alreadyAborted.signal,
			fetch: async () => {
				called = true;
				return new Response(
					JSON.stringify({
						answers: {
							applicability: {
								type: "choice",
								choice: "shared",
								confidence: 0.99,
								probabilities: { shared: 0.01, environment: 0.98, project: 0.01 },
							},
						},
					}),
				);
			},
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(called).toBe(false);
		expect(beforeFetch).toMatchObject({ scope: "environment", classification: { mechanism: "fallback" } });

		const duringFetch = new AbortController();
		setTimeout(() => duringFetch.abort(), 5);
		const fetchStarted = Date.now();
		const fetchResult = await classifyMemoryCandidate({
			content: "I prefer concise answers.",
			source: "windows",
			signal: duringFetch.signal,
			fetch: async () => new Promise<Response>(() => {}),
			timeoutMs: 100,
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(Date.now() - fetchStarted).toBeLessThan(50);
		expect(fetchResult).toMatchObject({ scope: "environment", classification: { mechanism: "fallback" } });

		const response = new Response("{}");
		response.json = () => new Promise<unknown>(() => {});
		const duringBody = await classifyMemoryCandidate({
			content: "I prefer concise answers.",
			source: "windows",
			fetch: async () => response,
			timeoutMs: 10,
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(duringBody).toMatchObject({ scope: "environment", classification: { mechanism: "fallback" } });

		const delayedResponse = new Response("{}");
		delayedResponse.json = () => new Promise<unknown>(() => {});
		const totalStarted = Date.now();
		await classifyMemoryCandidate({
			content: "I prefer concise answers.",
			source: "windows",
			fetch: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return delayedResponse;
			},
			timeoutMs: 30,
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(Date.now() - totalStarted).toBeLessThan(45);
	});

	test("rejects contradictory Choice distributions", async () => {
		const result = await classifyMemoryCandidate({
			content: "I prefer concise answers.",
			source: "windows",
			fetch: async () =>
				new Response(
					JSON.stringify({
						answers: {
							applicability: {
								type: "choice",
								choice: "shared",
								confidence: 0.99,
								probabilities: { shared: 0.01, environment: 0.98, project: 0.01 },
							},
						},
					}),
				),
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(result).toMatchObject({ scope: "environment", classification: { mechanism: "fallback" } });
	});

	test("uses a validated high-confidence JEV Choice result", async () => {
		const result = await classifyMemoryCandidate({
			content: "I prefer concise answers.",
			source: "windows",
			fetch: async () =>
				new Response(
					JSON.stringify({
						answers: {
							applicability: {
								type: "choice",
								choice: "shared",
								confidence: 0.95,
								probabilities: { shared: 0.96, environment: 0.02, project: 0.02 },
							},
						},
					}),
				),
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(result).toMatchObject({ scope: "shared", classification: { mechanism: "jev", confidence: 0.95 } });
	});

	test("hard runtime evidence prevents JEV from broadening an explicit shared request", async () => {
		let called = false;
		const result = await classifyMemoryCandidate({
			content: "Run C:\\Users\\me\\tool.exe after startup.",
			source: "windows",
			explicitScope: "shared",
			fetch: async () => {
				called = true;
				throw new Error("must not fetch");
			},
			env: { TYPESAFE_API_KEY: "test-key" },
		});
		expect(called).toBe(false);
		expect(result.scope).toBe("environment");
		expect(result.classification.mechanism).toBe("rule");
		expect(result.reason).toContain("source-local");
	});
});
