// src/search/miss.ts — deterministic zero-result cause classification for retrieval tools.
//
// Pure module: no Date, no process.env, no I/O. Every fact arrives via MissInput from the
// call-site assembler, so output is golden-stable and table-testable. Classification is
// first-match-wins over a fixed priority chain; exactly one primary cause is produced,
// optionally followed by an independent staleness note.
//
// Delivery contract: plan.20261113.01 §7 (cause keys, copy, caps) — copy strings here are
// normative and pinned by test/unit/miss-classifier.test.ts golden assertions.

export interface KbScope {
	name: string;
	// null for text/url sources — scope-agnostic: never contributes a coverage negative.
	source_path: string | null;
	status: "ready" | "indexing" | "error" | "stale";
	chunk_count: number;
	// Math.round((now - updated_at) / 60_000) — same formula as src/status.ts, computed by the assembler.
	age_min: number;
	// Omitted (undefined) unless > 0 by the assembler.
	stale_files?: number;
}

export interface MissInput {
	tool: "search" | "symbol";
	kb_count: number;
	known_kb_names: string[];
	// Assembler contract: the raw kb_id param when it resolves to no KB (drives `kb-not-found`),
	// otherwise the resolved KB's display name (drives "{ in ... }" interpolations), otherwise undefined.
	requested_kb_id?: string;
	// path_pattern (search) | file_pattern (symbol).
	scope_filter?: string;
	// Count of KBs whose scope covers scope_filter (assembler-computed; null-source KBs count as covering).
	scope_matches: number;
	mode_used?: string;
	retry_modes?: string[];
	min_hybrid?: number;
	// Absent for tool: "symbol".
	retrieved_candidates?: number;
	filtered_candidates?: number;
	// Symbol tool only.
	exact_requested?: boolean;
	indexing_in_flight: boolean;
	kbs: KbScope[];
	// Audit L-3: when set, the staleness note considers only KBs named here (the ones actually in
	// the searched scope). Undefined = all KBs (unscoped searches). Optional field; the plan's
	// frozen interface predates the audit and the deviation is recorded in the delivery report.
	note_kb_names?: string[];
}

export interface MissVerdict {
	// Exactly one primary cause line, plus at most one action line (kept on a single line
	// per §7.2 templates; the array allows a future two-line cause without an interface change).
	lines: string[];
	stale_note?: string;
}

const MAX_LISTED_NAMES = 6;
const MAX_LINE_CHARS = 140;
const STALE_AGE_MIN = 1440;

// Compact index age: minutes below an hour, hours below a day, days beyond.
export function formatIndexAge(ageMin: number): string {
	const safe = Number.isFinite(ageMin) && ageMin > 0 ? ageMin : 0;
	if (safe < 60) return `${Math.round(safe)}m`;
	if (safe < 1440) return `${Math.round(safe / 60)}h`;
	return `${Math.round(safe / 1440)}d`;
}

function joinCapped(names: string[]): string {
	const shown = names.slice(0, MAX_LISTED_NAMES);
	const rest = names.length - shown.length;
	return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

// §7.2 interpolation cap: a line pushed over the budget by its interpolated list falls back
// to the same copy with the list omitted — never truncate mid-sentence.
function withListFallback(line: string, fallback: string): string {
	return line.length > MAX_LINE_CHARS ? fallback : line;
}

function attemptedModes(input: MissInput): Set<string> {
	const modes = new Set<string>();
	if (input.mode_used) modes.add(input.mode_used);
	for (const mode of input.retry_modes ?? []) modes.add(mode);
	return modes;
}

function untriedModesPhrase(candidates: string[], attempted: Set<string>): string | undefined {
	const fresh = candidates.filter((candidate) => !attempted.has(candidate));
	if (fresh.length === 0) return undefined;
	return fresh.map((mode) => `"${mode}"`).join(" or ");
}

// Audit L-4 note: the threshold cause deliberately prefers ONE mode (semantic_hybrid first,
// semantic only as its fallback) per §7.2 copy; no-overlap lists all untried modes. Different
// intent, hence no shared helper.
function preferredUntriedMode(candidates: string[], attempted: Set<string>): string | undefined {
	return candidates.find((candidate) => !attempted.has(candidate));
}

function scopeKb(input: MissInput): KbScope | undefined {
	if (!input.requested_kb_id) return undefined;
	return input.kbs.find((kb) => kb.name === input.requested_kb_id);
}

function inScopeKbPhrase(input: MissInput): string {
	return input.requested_kb_id ? ` in "${input.requested_kb_id}"` : "";
}

type Cause = { key: string; line: string };

function primaryCause(input: MissInput): Cause {
	// Priority chain (§7.1): no-kbs → kb-not-found → scope-empty → indexing-in-flight →
	// threshold-filtered → no-overlap → no-match.
	if (input.kb_count === 0) {
		return {
			key: "no-kbs",
			line: "No results: no knowledge bases are indexed yet. Use knowledge_add to index a directory, file, or URL.",
		};
	}

	if (input.requested_kb_id && !input.known_kb_names.includes(input.requested_kb_id)) {
		const known = joinCapped(input.known_kb_names);
		return {
			key: "kb-not-found",
			line: withListFallback(
				`No results: kb_id "${input.requested_kb_id}" matches no knowledge base (known: ${known}). Fix the kb_id or omit it to search all KBs.`,
				`No results: kb_id "${input.requested_kb_id}" matches no knowledge base. Fix the kb_id or omit it to search all KBs.`,
			),
		};
	}

	if (input.scope_filter && input.scope_matches === 0) {
		const scopeList = input.kbs.map((kb) => kb.source_path).filter((p): p is string => p !== null);
		const sources = joinCapped(scopeList);
		if (scopeList.length === 0) {
			// All KBs are scope-agnostic (text/url): nothing to enumerate, no coverage claim detail.
			return {
				key: "scope-empty",
				line: `No results: no indexed KB covers "${input.scope_filter}". Index that path with knowledge_add, or drop the filter.`,
			};
		}
		return {
			key: "scope-empty",
			line: withListFallback(
				`No results: no indexed KB covers "${input.scope_filter}" (sources: ${sources}). Index that path with knowledge_add, or drop the filter.`,
				`No results: no indexed KB covers "${input.scope_filter}". Index that path with knowledge_add, or drop the filter.`,
			),
		};
	}

	if (input.indexing_in_flight) {
		const indexing = input.kbs.find((kb) => kb.status === "indexing");
		if (indexing) {
			// Audit L-2 (documented as-is): this cause deliberately outranks counter facts; the
			// chunk_count shown is the in-flight KB's progress, not the candidate pool size.
			return {
				key: "indexing-in-flight",
				line: `No results yet: "${indexing.name}" is still indexing (${indexing.chunk_count} chunks so far). Retry after it finishes.`,
			};
		}
		// Flag set without a visible indexing row (assembler race): fall through to the next rule.
	}

	if (input.tool === "search") {
		const attempted = attemptedModes(input);
		if ((input.retrieved_candidates ?? 0) === 0) {
			const indexed = scopeKb(input)?.chunk_count ?? input.kbs.reduce((sum, kb) => sum + kb.chunk_count, 0);
			const phrase = untriedModesPhrase(["semantic", "deep"], attempted);
			const action = phrase
				? `Try mode ${phrase}, or rephrase with terms from the target files.`
				: "Rephrase with terms from the target files.";
			return {
				key: "no-overlap",
				line: `No results: 0 candidates for this query${inScopeKbPhrase(input)} (indexed: ${indexed} chunks). ${action}`,
			};
		}
		if ((input.filtered_candidates ?? 0) === 0) {
			const minHybrid = input.min_hybrid === undefined ? "the score threshold" : input.min_hybrid;
			const suggestion = preferredUntriedMode(["semantic_hybrid", "semantic"], attempted);
			const action = suggestion ? ` Try mode "${suggestion}".` : "";
			return {
				key: "threshold-filtered",
				line: `No results: ${input.retrieved_candidates} candidates retrieved, all below min_hybrid ${minHybrid}.${action}`,
			};
		}
		// Audit M-2/M-3: this fallback is mainline — reached when rerank/pagination or the
		// file-type/path metadata filters empty the page after scoring. Copy now names the actual
		// removers, and the mode advice obeys the dedup rule (no "broader" beyond 'deep').
		if (input.scope_filter) {
			return {
				key: "no-match",
				line: "No results: candidates were retrieved and ranked, but none matched the file-type/path filters. Widen the filter or rephrase.",
			};
		}
		const base = `No results: candidates were retrieved and ranked, but none passed final filtering${inScopeKbPhrase(input)}.`;
		const fallbackAction = attempted.has("deep")
			? " Rephrase with terms from the target files."
			: " Try a broader mode or different terms.";
		return { key: "no-match", line: `${base}${fallbackAction}` };
	}

	// Symbol tool: no candidate counters exist on its response by design (§7.2), so the
	// remaining cause is a plain no-match with the exact-flag action. The §7.2 template's optional
	// "{query}" segment is not expressible through the frozen MissInput interface (no query field)
	// and is omitted — braces in the template denote optionality; recorded as a plan deviation.
	// Audit L-5 (kept by design): the non-exact action names the extractor limit and knowledge_search
	// mode 'fast' as fixed in-app text; determinism beats dynamic kind lists (plan §T-04).
	const matched = `No symbols matched${inScopeKbPhrase(input)}.`;
	const action =
		input.exact_requested === true
			? " The lookup requires an exact normalized name — retry with exact=false."
			: " The lightweight extractor does not cover all syntax — knowledge_symbol_search has fixed kinds only, or try knowledge_search mode 'fast'.";
	return { key: "no-match", line: `${matched}${action} Check symbol presence with knowledge_status.` };
}

// §7.3 — independent of the primary cause; at most one note line, stale_files variant preferred.
// Audit L-3: when note_kb_names is set, only those KBs can be the note subject, so a miss scoped
// to a fresh KB is never annotated with an unrelated KB's staleness.
function staleNote(input: MissInput): string | undefined {
	const relevant = input.note_kb_names ? input.kbs.filter((kb) => input.note_kb_names?.includes(kb.name)) : input.kbs;
	const withStale = relevant.find((kb) => (kb.stale_files ?? 0) > 0);
	if (withStale) {
		return `"${withStale.name}" has ${withStale.stale_files} files changed after indexing — knowledge_update refreshes without re-adding.`;
	}
	const aged = relevant.find((kb) => kb.age_min > STALE_AGE_MIN);
	if (aged) {
		return `"${aged.name}" was last indexed ${formatIndexAge(aged.age_min)}; knowledge_update refreshes it.`;
	}
	return undefined;
}

export function classifyMiss(input: MissInput): MissVerdict {
	const cause = primaryCause(input);
	const verdict: MissVerdict = { lines: [cause.line] };
	// Audit M-1: a staleness note contradicts `no-kbs` (nothing exists to refresh) and adds noise
	// to `kb-not-found` (the named filter is the whole story). Suppress the note for both.
	if (cause.key !== "no-kbs" && cause.key !== "kb-not-found") {
		const note = staleNote(input);
		if (note) verdict.stale_note = note;
	}
	return verdict;
}
