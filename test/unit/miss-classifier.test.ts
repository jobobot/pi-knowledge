// Tests for the zero-result cause classifier and freshness footer.
// Table rows pin the normative copy from plan.20261113.01 §7.2/§7.3 as golden strings;
// legacy-parity constants are transcribed from the T-01 baseline capture (commit ad75d5d).

import { describe, expect, it } from "vitest";
// index.ts loads with only local static imports (pi types are structural shims), so importing
// its exported assemblers in a unit test is safe without mocks or runtime env.
import { buildMissInput, freshnessFooterSuffix, scopesFromRows } from "../../index.ts";
import { classifyMiss, formatIndexAge, type KbScope, type MissInput, type MissVerdict } from "../../src/search/miss.ts";

function kb(overrides: Partial<KbScope> & { name: string }): KbScope {
	return {
		source_path: `/src/${overrides.name}`,
		status: "ready",
		chunk_count: 100,
		age_min: 10,
		...overrides,
	};
}

function baseInput(overrides: Partial<MissInput> & Pick<MissInput, "tool">): MissInput {
	const kbs = overrides.kbs ?? [kb({ name: "docs" })];
	return {
		kb_count: kbs.length,
		known_kb_names: kbs.map((row) => row.name),
		scope_matches: 0,
		indexing_in_flight: false,
		kbs,
		...overrides,
	};
}

function assertVerdictShape(verdict: MissVerdict): void {
	expect(verdict.lines.length).toBeGreaterThanOrEqual(1);
	expect(verdict.lines.length).toBeLessThanOrEqual(2);
	if (verdict.stale_note !== undefined) {
		expect(verdict.stale_note.split("\n")).toHaveLength(1);
	}
}

describe("formatIndexAge", () => {
	it("buckets minutes, hours, and days", () => {
		expect(formatIndexAge(0)).toBe("0m");
		expect(formatIndexAge(42)).toBe("42m");
		expect(formatIndexAge(59)).toBe("59m");
		expect(formatIndexAge(60)).toBe("1h");
		expect(formatIndexAge(1439)).toBe("24h");
		expect(formatIndexAge(1440)).toBe("1d");
		expect(formatIndexAge(2880)).toBe("2d");
	});
	it("clamps invalid input to 0m", () => {
		expect(formatIndexAge(-5)).toBe("0m");
		expect(formatIndexAge(Number.NaN)).toBe("0m");
	});
});

describe("classifyMiss cause table", () => {
	const rows: Array<{ title: string; input: MissInput; expected: string }> = [
		{
			title: "no-kbs (search)",
			input: baseInput({ tool: "search", kb_count: 0, known_kb_names: [], kbs: [] }),
			expected: "No results: no knowledge bases are indexed yet. Use knowledge_add to index a directory, file, or URL.",
		},
		{
			title: "no-kbs (symbol)",
			input: baseInput({ tool: "symbol", kb_count: 0, known_kb_names: [], kbs: [] }),
			expected: "No results: no knowledge bases are indexed yet. Use knowledge_add to index a directory, file, or URL.",
		},
		{
			title: "kb-not-found (search)",
			input: baseInput({
				tool: "search",
				requested_kb_id: "missing",
				known_kb_names: ["docs", "notes"],
			}),
			expected:
				'No results: kb_id "missing" matches no knowledge base (known: docs, notes). Fix the kb_id or omit it to search all KBs.',
		},
		{
			title: "kb-not-found (symbol)",
			input: baseInput({ tool: "symbol", requested_kb_id: "missing", known_kb_names: ["docs"] }),
			expected:
				'No results: kb_id "missing" matches no knowledge base (known: docs). Fix the kb_id or omit it to search all KBs.',
		},
		{
			title: "scope-empty",
			input: baseInput({
				tool: "search",
				scope_filter: "/elsewhere/project",
				scope_matches: 0,
				kbs: [kb({ name: "docs", source_path: "/workdir/notes" })],
				known_kb_names: ["docs"],
			}),
			expected:
				'No results: no indexed KB covers "/elsewhere/project" (sources: /workdir/notes). Index that path with knowledge_add, or drop the filter.',
		},
		{
			title: "indexing-in-flight",
			input: baseInput({
				tool: "search",
				indexing_in_flight: true,
				kbs: [kb({ name: "big", status: "indexing", chunk_count: 512 })],
				known_kb_names: ["big"],
			}),
			expected: 'No results yet: "big" is still indexing (512 chunks so far). Retry after it finishes.',
		},
		{
			title: "threshold-filtered",
			input: baseInput({
				tool: "search",
				mode_used: "hybrid",
				min_hybrid: 0.18,
				retrieved_candidates: 40,
				filtered_candidates: 0,
			}),
			expected: 'No results: 40 candidates retrieved, all below min_hybrid 0.18. Try mode "semantic_hybrid".',
		},
		{
			title: "threshold-filtered, semantic_hybrid already used",
			input: baseInput({
				tool: "search",
				mode_used: "semantic_hybrid",
				min_hybrid: 0.4,
				retrieved_candidates: 12,
				filtered_candidates: 0,
			}),
			expected: 'No results: 12 candidates retrieved, all below min_hybrid 0.4. Try mode "semantic".',
		},
		{
			title: "threshold-filtered, both suggestions attempted",
			input: baseInput({
				tool: "search",
				mode_used: "semantic_hybrid",
				retry_modes: ["semantic"],
				min_hybrid: 0.25,
				retrieved_candidates: 8,
				filtered_candidates: 0,
			}),
			expected: "No results: 8 candidates retrieved, all below min_hybrid 0.25.",
		},
		{
			title: "no-overlap, both modes untried",
			input: baseInput({
				tool: "search",
				mode_used: "hybrid",
				retrieved_candidates: 0,
				filtered_candidates: 0,
				min_hybrid: 0.18,
			}),
			expected:
				'No results: 0 candidates for this query (indexed: 100 chunks). Try mode "semantic" or "deep", or rephrase with terms from the target files.',
		},
		{
			title: "no-overlap, scoped to one KB",
			input: baseInput({
				tool: "search",
				requested_kb_id: "docs",
				mode_used: "hybrid",
				retrieved_candidates: 0,
				filtered_candidates: 0,
				min_hybrid: 0.18,
			}),
			expected:
				'No results: 0 candidates for this query in "docs" (indexed: 100 chunks). Try mode "semantic" or "deep", or rephrase with terms from the target files.',
		},
		{
			title: "no-overlap, semantic and deep attempted",
			input: baseInput({
				tool: "search",
				mode_used: "semantic",
				retry_modes: ["deep"],
				retrieved_candidates: 0,
				filtered_candidates: 0,
			}),
			expected:
				"No results: 0 candidates for this query (indexed: 100 chunks). Rephrase with terms from the target files.",
		},
		{
			title: "search no-match fallback",
			input: baseInput({
				tool: "search",
				mode_used: "hybrid",
				retrieved_candidates: 20,
				filtered_candidates: 5,
			}),
			expected:
				"No results: candidates were retrieved and ranked, but none passed final filtering. Try a broader mode or different terms.",
		},
		{
			title: "symbol no-match, exact flag",
			input: baseInput({ tool: "symbol", exact_requested: true }),
			expected:
				"No symbols matched. The lookup requires an exact normalized name — retry with exact=false. Check symbol presence with knowledge_status.",
		},
		{
			title: "symbol no-match, scoped",
			input: baseInput({ tool: "symbol", requested_kb_id: "docs" }),
			expected:
				"No symbols matched in \"docs\". The lightweight extractor does not cover all syntax — knowledge_symbol_search has fixed kinds only, or try knowledge_search mode 'fast'. Check symbol presence with knowledge_status.",
		},
	];

	for (const row of rows) {
		it(row.title, () => {
			const verdict = classifyMiss(row.input);
			expect(verdict.lines).toEqual([row.expected]);
			assertVerdictShape(verdict);
		});
	}

	it("priority: kb-not-found beats scope-empty beats indexing beats counters", () => {
		const verdict = classifyMiss(
			baseInput({
				tool: "search",
				requested_kb_id: "missing",
				known_kb_names: ["docs"],
				scope_filter: "/nope",
				scope_matches: 0,
				indexing_in_flight: true,
				retrieved_candidates: 0,
				filtered_candidates: 0,
			}),
		);
		expect(verdict.lines[0]).toContain('kb_id "missing" matches no knowledge base');
	});

	it("mode recommendations never name an attempted mode", () => {
		for (const attempted of ["semantic", "deep", "semantic_hybrid", "hybrid"]) {
			const noOverlap = classifyMiss(
				baseInput({
					tool: "search",
					mode_used: attempted,
					retrieved_candidates: 0,
					filtered_candidates: 0,
					min_hybrid: 0.18,
				}),
			);
			expect(noOverlap.lines.join(" ")).not.toContain(`"${attempted}"`);
			const threshold = classifyMiss(
				baseInput({
					tool: "search",
					mode_used: attempted,
					retrieved_candidates: 4,
					filtered_candidates: 0,
					min_hybrid: 0.18,
				}),
			);
			expect(threshold.lines.join(" ")).not.toContain(`"${attempted}"`);
		}
	});
});

describe("classifyMiss caps and notes", () => {
	it("name lists cap at 6 with +N more", () => {
		const many = Array.from({ length: 8 }, (_, i) => `k${i}`);
		const verdict = classifyMiss(
			baseInput({
				tool: "search",
				requested_kb_id: "missing",
				known_kb_names: many,
				kbs: many.map((n) => kb({ name: n })),
			}),
		);
		expect(verdict.lines[0]).toContain("k5, +2 more");
		expect(verdict.lines[0]).not.toContain("k6");
	});

	it("over-long interpolated lists fall back to the list-free copy", () => {
		const longNames = Array.from({ length: 6 }, (_, i) => `very-long-knowledge-base-name-${i}`);
		const verdict = classifyMiss(
			baseInput({
				tool: "search",
				requested_kb_id: "missing",
				known_kb_names: longNames,
				kbs: longNames.map((n) => kb({ name: n })),
			}),
		);
		expect(verdict.lines[0]).not.toContain("(known:");
		expect(verdict.lines[0]).toContain("matches no knowledge base");
	});

	it("stale_files note is preferred over the age note and appears beside any cause", () => {
		const verdict = classifyMiss(
			baseInput({
				tool: "search",
				kbs: [kb({ name: "docs", stale_files: 3, age_min: 5000 })],
			}),
		);
		expect(verdict.stale_note).toBe(
			'"docs" has 3 files changed after indexing — knowledge_update refreshes without re-adding.',
		);
	});

	it("age note only past one day", () => {
		const fresh = classifyMiss(baseInput({ tool: "search", kbs: [kb({ name: "docs", age_min: 1440 })] }));
		expect(fresh.stale_note).toBeUndefined();
		const aged = classifyMiss(baseInput({ tool: "search", kbs: [kb({ name: "docs", age_min: 1441 })] }));
		expect(aged.stale_note).toBe('"docs" was last indexed 1d; knowledge_update refreshes it.');
	});

	it("classifyMiss is pure: repeated calls agree and input is not mutated", () => {
		const input = baseInput({
			tool: "search",
			mode_used: "hybrid",
			retrieved_candidates: 9,
			filtered_candidates: 0,
			min_hybrid: 0.18,
			kbs: [kb({ name: "docs", stale_files: 2 })],
		});
		const snapshot = JSON.parse(JSON.stringify(input));
		const first = classifyMiss(input);
		const second = classifyMiss(input);
		expect(second).toEqual(first);
		expect(JSON.stringify(input)).toBe(JSON.stringify(snapshot));
	});
});

// ── Assembler helpers exported from index.ts ──────────────────────────────────────────────────

type RowFixture = {
	id: string;
	name: string;
	source_path: string | null;
	source_options: string | null;
	status: "ready" | "indexing" | "error" | "stale";
	chunk_count: number;
	updated_at: number;
};

function row(overrides: Partial<RowFixture> & { name: string }): RowFixture {
	return {
		id: `id-${overrides.name}`,
		source_path: `/base/${overrides.name}`,
		source_options: null,
		status: "ready",
		chunk_count: 10,
		updated_at: 0,
		...overrides,
	};
}

type RowsArg = Parameters<typeof buildMissInput>[1];
type ScopeRowsArg = Parameters<typeof scopesFromRows>[0];

describe("assembler helpers", () => {
	const NOW = 60_000 * 30;

	it("scopesFromRows maps age formula and stale_files from diagnostics", () => {
		const rows = [row({ name: "a", updated_at: NOW - 120 * 60_000 }), row({ name: "b", updated_at: NOW - 5 * 60_000 })];
		const scopes = scopesFromRows(
			rows as unknown as ScopeRowsArg,
			[
				{ kb_name: "a", stale_files: ["x.ts", "y.ts"] },
				{ kb_name: "b", stale_files: [] },
			],
			NOW,
		);
		expect(scopes[0]).toEqual({
			name: "a",
			source_path: "/base/a",
			status: "ready",
			chunk_count: 10,
			age_min: 120,
			stale_files: 2,
		});
		expect(scopes[1].stale_files).toBeUndefined();
	});

	it("resolveKbParam: matches id, matches name, else raw param", () => {
		const rows = [row({ name: "docs" })] as unknown as RowsArg;
		expect(buildMissInput("search", rows, [], { kb_id: "id-docs" }, {}).requested_kb_id).toBe("docs");
		expect(buildMissInput("search", rows, [], { kb_id: "docs" }, {}).requested_kb_id).toBe("docs");
		expect(buildMissInput("search", rows, [], { kb_id: "nope" }, {}).requested_kb_id).toBe("nope");
		expect(buildMissInput("search", rows, [], {}, {}).requested_kb_id).toBeUndefined();
	});

	it("scope_matches: substring either direction, null source covers, excludes shrink only", () => {
		const rows = [
			row({ name: "a", source_path: "/workdir/hckrtools" }),
			row({
				name: "b",
				source_path: "/workdir",
				source_options: JSON.stringify({ exclude_paths: ["hckrtools/agent-tools/archive"] }),
			}),
			row({ name: "c", source_path: null }),
		] as unknown as RowsArg;
		// A broad filter overlapping b's uncovered scope stays a match even though it is a
		// string-prefix of b's exclude: shrink applies only when the filter lies entirely
		// inside the excluded subtree.
		const covered = buildMissInput("search", rows, [], { scope_filter: "/workdir/hckrtools" }, {});
		expect(covered.scope_matches).toBe(3);
		// A filter entirely inside the excluded subtree: b shrinks out; a still intersects its
		// own source_path; the scope-agnostic c always covers.
		const excluded = buildMissInput("search", rows, [], { scope_filter: "/workdir/hckrtools/agent-tools/archive" }, {});
		expect(excluded.scope_matches).toBe(2);
		// A pattern outside every concrete source still counts the scope-agnostic KB.
		const outside = buildMissInput("search", rows, [], { scope_filter: "/elsewhere" }, {});
		expect(outside.scope_matches).toBe(1);
		// No filter → zero (rule inactive).
		expect(buildMissInput("search", rows, [], {}, {}).scope_matches).toBe(0);
	});

	it("indexing_in_flight propagates from any row", () => {
		const rows = [row({ name: "a" }), row({ name: "b", status: "indexing" })] as unknown as RowsArg;
		expect(buildMissInput("search", rows, [], {}, {}).indexing_in_flight).toBe(true);
	});

	it("tuning counters are copied only when present", () => {
		const rows = [row({ name: "a" })] as unknown as RowsArg;
		const withTuning = buildMissInput(
			"search",
			rows,
			[],
			{},
			{
				mode_used: "hybrid",
				tuning: { min_hybrid_score: 0.18, retrieved_candidates: 5, filtered_candidates: 0 },
			},
		);
		expect(withTuning.retrieved_candidates).toBe(5);
		expect(withTuning.filtered_candidates).toBe(0);
		expect(withTuning.min_hybrid).toBe(0.18);
		const without = buildMissInput("search", rows, [], {}, {});
		expect(without.retrieved_candidates).toBeUndefined();
	});

	it("freshness footer: worst-case age, summed stale, omitted segment at zero", () => {
		const scopes = [
			kb({ name: "a", age_min: 14, stale_files: 2 }),
			kb({ name: "b", age_min: 90 }),
			kb({ name: "c", age_min: 5 }),
		];
		expect(freshnessFooterSuffix(scopes, ["a", "b"])).toBe(" · fresh: 2h · stale: 2 files");
		expect(freshnessFooterSuffix(scopes, ["a"])).toBe(" · fresh: 14m · stale: 2 files");
		expect(freshnessFooterSuffix(scopes, ["b"])).toBe(" · fresh: 2h");
		expect(freshnessFooterSuffix(scopes, ["zz"])).toBe("");
	});
});
