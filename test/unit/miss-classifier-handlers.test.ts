// Handler-level integration tests: the real index.ts tool handlers against a fake engine.
// Covers plan.20261113.01 §7.7 scenarios 1-5 through the shipped code path, byte-parity of the
// disabled branches against the v0.14.0 baseline strings (scenario 6), and footer on/off header
// parity (scenario 7). Knobs are read at module load, so each case re-imports index.ts with the
// env set (vi.resetModules pattern from extension-lifecycle.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: [] as unknown[],
	diagnostics: [] as Array<{ kb_name: string; stale_files: string[] }>,
	searchResponse: {} as Record<string, unknown>,
	symbolResponse: {} as Record<string, unknown>,
}));

vi.mock("../../src/engine.ts", () => ({
	KnowledgeEngine: class {
		async initialize(): Promise<void> {}
		list(): unknown[] {
			return state.rows;
		}
		diagnose(): Array<{ kb_name: string; stale_files: string[] }> {
			return state.diagnostics;
		}
		async search(): Promise<Record<string, unknown>> {
			return state.searchResponse;
		}
		symbolSearch(): Record<string, unknown> {
			return state.symbolResponse;
		}
		async dispose(): Promise<void> {}
	},
}));

vi.mock("../../src/storage/sqlite.ts", () => ({
	getDefaultKnowledgeDir(): string {
		return "/tmp/pi-knowledge-miss-handlers";
	},
}));

vi.mock("../../src/watcher/file-watcher.ts", () => ({
	getActiveWatcherCount(): number {
		return 0;
	},
	startWatcher(): void {},
	stopAllWatchers(): void {},
}));

type ToolDef = {
	name: string;
	description: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

const ENGINE_SUGGESTIONS = [
	"Try mode 'fast' for exact symbols, mode 'semantic' for pure vector search, or mode 'semantic_hybrid' when weak lexical overlap should not block fused vector results.",
	"Run knowledge_status if the KB should contain this answer.",
];

const LEGACY_SEARCH_ZERO = `No results found.\nSuggestions: ${ENGINE_SUGGESTIONS.join(" | ")}`;
const LEGACY_SYMBOL_ZERO =
	"No symbols found. This may mean the symbol is absent, symbol metadata is missing/stale, " +
	"or the lightweight extractor does not cover this syntax. For important lookups, run " +
	"knowledge_doctor or fallback to knowledge_search mode 'fast'/'adaptive'.";

async function loadTools(env: Record<string, string | undefined>): Promise<Map<string, ToolDef>> {
	vi.resetModules();
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const mod = await import("../../index.ts");
	const tools = new Map<string, ToolDef>();
	const pi = {
		on(): void {},
		registerCommand(): void {},
		registerTool(def: ToolDef): void {
			tools.set(def.name, def);
		},
	} as unknown as Parameters<typeof mod.default>[0];
	mod.default(pi);
	return tools;
}

function tool(tools: Map<string, ToolDef>, name: string): ToolDef {
	const def = tools.get(name);
	if (!def) throw new Error(`Tool ${name} was not registered`);
	return def;
}

function docsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "kb-docs-id",
		name: "docs",
		source_path: "/workdir/notes",
		source_options: null,
		status: "ready",
		chunk_count: 250,
		updated_at: Date.now() - 14 * 60_000,
		...overrides,
	};
}

function zeroSearch(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		results: [],
		total_count: 0,
		has_more: false,
		suggestions: ENGINE_SUGGESTIONS,
		...extra,
	};
}

function resultText(r: Awaited<ReturnType<ToolDef["execute"]>>): string {
	return r.content[0].text;
}

afterEach(() => {
	delete process.env.PI_KNOWLEDGE_MISS_CLASSIFIER;
	delete process.env.PI_KNOWLEDGE_FRESHNESS_FOOTER;
});

describe("knowledge_search handler", () => {
	it("scenario 1: unknown kb_id → kb-not-found cause", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.searchResponse = zeroSearch({ mode_used: "hybrid" });
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: "on" });
		const text = resultText(
			await tool(tools, "knowledge_search").execute("t", { query: "x", kb_id: "missing" }, undefined, undefined, {}),
		);
		expect(text).toContain("No results found.");
		expect(text).toContain('kb_id "missing" matches no knowledge base (known: docs)');
		expect(text).not.toContain("Suggestions:");
	});

	it("scenario 2: path_pattern outside every source → scope-empty cause", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.searchResponse = zeroSearch();
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: "on" });
		const text = resultText(
			await tool(tools, "knowledge_search").execute(
				"t",
				{ query: "x", path_pattern: "/elsewhere/project" },
				undefined,
				undefined,
				{},
			),
		);
		expect(text).toContain('no indexed KB covers "/elsewhere/project" (sources: /workdir/notes)');
	});

	it("scenario 4: retrieved but all below threshold → threshold-filtered cause", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.searchResponse = zeroSearch({
			mode_used: "hybrid",
			tuning: {
				min_hybrid_score: 0.18,
				retrieved_candidates: 40,
				filtered_candidates: 0,
			},
		});
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: "on" });
		const text = resultText(
			await tool(tools, "knowledge_search").execute("t", { query: "x" }, undefined, undefined, {}),
		);
		expect(text).toContain('40 candidates retrieved, all below min_hybrid 0.18. Try mode "semantic_hybrid".');
	});

	it("scenario 6: classifier off → byte-identical v0.14.0 zero-result text", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.searchResponse = zeroSearch();
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: "off" });
		const text = resultText(
			await tool(tools, "knowledge_search").execute("t", { query: "x" }, undefined, undefined, {}),
		);
		expect(text).toBe(LEGACY_SEARCH_ZERO);
	});

	it("scenario 6b: unset env defaults to classifier on", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.searchResponse = zeroSearch();
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: undefined });
		const text = resultText(
			await tool(tools, "knowledge_search").execute("t", { query: "x", kb_id: "missing" }, undefined, undefined, {}),
		);
		expect(text).toContain("matches no knowledge base");
	});

	it("scenario 7: footer on appends aggregated suffix before the header colon", async () => {
		state.rows = [docsRow({ name: "a", source_path: "/workdir/a" }), docsRow({ name: "b", source_path: "/workdir/b" })];
		state.diagnostics = [
			{ kb_name: "a", stale_files: ["p.ts", "q.ts"] },
			{ kb_name: "b", stale_files: [] },
		];
		state.searchResponse = {
			results: [
				{
					content: "c",
					file_path: "a/x.ts",
					file_type: "typescript",
					kb_name: "a",
					score: 0.9,
					snippet: "s",
					start_line: 1,
					end_line: 2,
				},
				{
					content: "c",
					file_path: "b/y.ts",
					file_type: "typescript",
					kb_name: "b",
					score: 0.8,
					snippet: "s",
					start_line: 1,
					end_line: 2,
				},
			],
			total_count: 2,
			has_more: false,
		};
		const tools = await loadTools({ PI_KNOWLEDGE_FRESHNESS_FOOTER: "true" });
		const text = resultText(
			await tool(tools, "knowledge_search").execute("t", { query: "x" }, undefined, undefined, {}),
		);
		expect(text.startsWith("2 results (showing 2) · fresh: 14m · stale: 2 files:")).toBe(true);
	});

	it("footer off → hit header byte-identical to baseline", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [{ kb_name: "docs", stale_files: ["p.ts"] }];
		state.searchResponse = {
			results: [
				{
					content: "c",
					file_path: "a/x.ts",
					file_type: "typescript",
					kb_name: "docs",
					score: 0.9,
					snippet: "s",
					start_line: 1,
					end_line: 2,
				},
			],
			total_count: 1,
			has_more: false,
			mode_used: "hybrid",
		};
		const tools = await loadTools({ PI_KNOWLEDGE_FRESHNESS_FOOTER: undefined });
		const text = resultText(
			await tool(tools, "knowledge_search").execute("t", { query: "x" }, undefined, undefined, {}),
		);
		expect(text.startsWith("1 results (showing 1) — mode: hybrid:")).toBe(true);
	});
});

describe("knowledge_symbol_search handler", () => {
	it("scenario 5: exact miss → no-match cause with exact-flag action", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.symbolResponse = { results: [], total_count: 0, has_more: false };
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: "on" });
		const text = resultText(
			await tool(tools, "knowledge_symbol_search").execute(
				"t",
				{ query: "foo", exact: true },
				undefined,
				undefined,
				{},
			),
		);
		expect(text).toContain("No symbols matched.");
		expect(text).toContain("retry with exact=false");
	});

	it("scenario 6: classifier off → byte-identical v0.14.0 blob", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [];
		state.symbolResponse = { results: [], total_count: 0, has_more: false };
		const tools = await loadTools({ PI_KNOWLEDGE_MISS_CLASSIFIER: "false" });
		const text = resultText(
			await tool(tools, "knowledge_symbol_search").execute("t", { query: "foo" }, undefined, undefined, {}),
		);
		expect(text).toBe(LEGACY_SYMBOL_ZERO);
	});

	it("footer on → symbol header carries the same suffix", async () => {
		state.rows = [docsRow()];
		state.diagnostics = [{ kb_name: "docs", stale_files: ["z.ts"] }];
		state.symbolResponse = {
			results: [
				{
					name: "foo",
					kind: "function",
					file_path: "src/a.ts",
					file_type: "typescript",
					kb_name: "docs",
					start_line: 1,
					end_line: 3,
					text: "t",
					indexed_at: 0,
				},
			],
			total_count: 1,
			has_more: false,
		};
		const tools = await loadTools({ PI_KNOWLEDGE_FRESHNESS_FOOTER: "1" });
		const text = resultText(
			await tool(tools, "knowledge_symbol_search").execute("t", { query: "foo" }, undefined, undefined, {}),
		);
		expect(text.startsWith("1 symbol result(s) · fresh: 14m · stale: 1 files:")).toBe(true);
	});
});
