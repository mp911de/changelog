/*
 * Copyright 2026-present the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Repository } from "./github-context.js";
import { commitUrl, ticketUrl } from "./links.js";
import type { GenerationSummary, RunProgress } from "./progress.js";
import type {
	LookedUpTarget,
	NotFoundTarget,
	ResolvedTicketReferences,
} from "./resolved-references.js";
import type {
	BlockHandle,
	Cell,
	CommitRow,
	Emphasis,
	ExcludedSection,
	ReferenceItem,
	Renderer,
	Row,
	StepSummary,
} from "./render.js";
import {
	type Aggregate,
	type AggregatedCommit,
	type CommitCandidate,
	targetKey,
	type TicketTarget,
} from "./ticket-references.js";

function plural(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

// A styled count cell, the recurring `{ text: String(n), style }` building block of the run view.
function countCell(value: number, style: Cell["style"]): Cell {
	return { text: String(value), style };
}

// A block title: a verb, an accent count, and the pluralized noun (e.g. "Scanned 3 commits").
function titleLine(verb: string, count: number, noun: string, plurals?: string): Cell[] {
	return [
		{ text: `${verb} ` },
		countCell(count, "accent"),
		{ text: ` ${plural(count, noun, plurals)}` },
	];
}

// A fact line: an accent (or warning) count followed by its faint label, the recurring shape of the
// Scanned and Looked up block notes.
function factLine(count: number, label: string, style: Cell["style"] = "accent"): Cell[] {
	return [countCell(count, style), { text: label, style: "faint" }];
}

/**
 * The semantic Scanned-block facts, derived from Aggregated Ticket References, for the view notes.
 */
interface ScannedSummary {
	readonly missing: number;

	readonly uniqueTargets: number;

	readonly pullRequestTargets: number;
}

/**
 * The Scanned block's collapsed fact lines (shown without commit rows): unique Ticket Targets across
 * every occurrence, unique PullRequest-qualified targets, then ticketless commits last. There is no
 * raw occurrence count. Zero categories are omitted. Ticketless commits use the warning accent, the
 * same highlighting rule the Documented entries ledger applies to its not-found counts.
 */
function scannedFacts(summary: ScannedSummary): Cell[][] {
	const notes: Cell[][] = [];
	if (summary.uniqueTargets > 0) {
		notes.push(
			factLine(
				summary.uniqueTargets,
				` unique ${plural(summary.uniqueTargets, "ticket reference")}`,
			),
		);
	}
	if (summary.pullRequestTargets > 0) {
		notes.push(
			factLine(
				summary.pullRequestTargets,
				` pull request ${plural(summary.pullRequestTargets, "reference")}`,
			),
		);
	}
	if (summary.missing > 0) {
		// A ticketless commit is a release-readiness concern, so point at the flag that lists them.
		notes.push(
			factLine(
				summary.missing,
				` without ${plural(summary.missing, "ticket reference")} (re-run with --show-missing)`,
				"warning",
			),
		);
	}
	return notes;
}

/**
 * One scanned commit reduced to its display fields: the originating commit facts, the Lead Ticket
 * Reference, and the additional reference roles in decreasing display priority. The view expresses
 * order and emphasis intent only; the renderer fits the trailing reference flow to the terminal.
 */
interface ScannedRow {
	readonly sha: string;
	readonly author: string;
	readonly summary: string;

	readonly lead?: TicketTarget;

	readonly candidates: readonly TicketTarget[];
	readonly credits: readonly TicketTarget[];
	readonly demoted: readonly TicketTarget[];
	readonly related: readonly TicketTarget[];

	readonly missing: boolean;
}

/**
 * Build one atomic reference item at a given emphasis, linked to its Ticket Target page.
 */
function referenceItem(
	target: TicketTarget,
	emphasis: Emphasis,
	repo: Repository,
): ReferenceItem {
	return { text: targetKey(target), emphasis, link: ticketUrl(repo, target) };
}

/**
 * One row per scanned commit.
 */
function commitRows(commits: readonly ScannedRow[], repo: Repository): CommitRow[] {
	return commits.map((commit) => {
		const seen = new Set<string>();
		if (commit.lead) {
			seen.add(targetKey(commit.lead));
		}
		const references: ReferenceItem[] = [];
		const addRole = (targets: readonly TicketTarget[], emphasis: Emphasis) => {
			for (const target of targets) {
				const key = targetKey(target);
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				references.push(referenceItem(target, emphasis, repo));
			}
		};
		addRole(commit.candidates, "candidate");
		addRole(commit.credits, "credit");
		addRole(commit.demoted, "demoted");
		addRole(commit.related, "related");
		return {
			sha: {
				text: commit.sha.slice(0, 7),
				style: commit.missing ? "warning" : "accent",
				link: commitUrl(repo, commit.sha),
			},
			author: commit.author,
			summary: commit.summary,
			lead: commit.lead ? referenceItem(commit.lead, "lead", repo) : undefined,
			references,
		};
	});
}

/**
 * Cache provenance shown as block items: how many tickets were served from the local cache vs.
 * loaded from GitHub. Both counts use the accent so the number stands out from its faint
 * label; the label words distinguish the cheap cache path from a fresh fetch.
 */
function lookupNotes(cached: number, fetched: number): Cell[][] {
	const notes: Cell[][] = [];
	if (cached > 0) {
		notes.push(factLine(cached, " cached"));
	}
	if (fetched > 0) {
		notes.push(factLine(fetched, " fetched"));
	}
	return notes;
}

/**
 * A flat, comma-separated flow of every looked-up target for the verbose lookup-outcome listing.
 * Each reference is a complete, clickable atomic item, accent when resolved and warning when not
 * found; the renderer wraps the flow to the terminal width without truncating any reference.
 */
function lookedUpReferences(
	outcomes: readonly LookedUpTarget[],
	repo: Repository,
): Cell[] {
	return outcomes.map(({ target, found }) => ({
		text: targetKey(target),
		style: found ? "accent" : "warning",
		link: ticketUrl(repo, target),
	}));
}

function notFoundRows(references: readonly NotFoundTarget[], repo: Repository): Row[] {
	return references.map((failure) => ({
		cells: [
			{
				text: failure.commit.sha.slice(0, 7),
				style: "accent",
				link: commitUrl(repo, failure.commit.sha),
			},
			{
				text: targetKey(failure.target),
				style: "warning",
				link: ticketUrl(repo, failure.target),
			},
			{ text: failure.commit.summary, style: "faint" },
		],
	}));
}

/**
 * The accumulated run facts the ledger summarizes once generation completes.
 */
interface LedgerFacts {
	readonly commits: number;
	readonly uniqueTargets: number;
	readonly candidateNotFound: number;
	readonly creditNotFound: number;
	readonly summary: GenerationSummary;
}

/**
 * The stats ledger: labels form the stable left edge and non-zero counts align on the right.
 * Candidate not-found and credit-only not-found counts stay distinct, both using the warning accent
 * with everything else in accent. Ticketless commits are reported once in the Scanned block, not here.
 */
function ledgerRows(facts: LedgerFacts): Row[] {
	const entries: Array<[number, string, Cell["style"]]> = [
		[facts.commits, plural(facts.commits, "commit"), "accent"],
		...[...facts.summary.sectionCounts].map(
			([bucket, value]): [number, string, Cell["style"]] => [
				value,
				bucket,
				"accent",
			],
		),
		[facts.uniqueTargets, plural(facts.uniqueTargets, "ticket reference"), "accent"],
		[facts.candidateNotFound, "tickets not found", "warning"],
		[facts.creditNotFound, "credit-only tickets not found", "warning"],
		[
			facts.summary.contributorCount,
			plural(facts.summary.contributorCount, "contributor"),
			"accent",
		],
	];
	return entries
		.filter(([value]) => value > 0)
		.map(([value, label, style]) => ({
			cells: [
				{ text: label, style: "faint" },
				{
					text: String(value),
					style,
					align: "right",
					bold: true,
				},
			],
		}));
}

export function finalLine(output: string, outputUrl: string): Cell[] {
	return [{ text: "Created " }, { text: output, link: outputUrl }];
}

/**
 * How much commit detail the Scanned block lists, normalized by the CLI before the run lifecycle.
 */
export type CommitDetail = "none" | "missing" | "all";

export interface RunViewOptions {
	readonly commitDetail: CommitDetail;

	readonly showLookupOutcomes: boolean;

	readonly debug?: boolean;
}

/**
 * Build a Run Progress sink that renders the full run view, linking commits and tickets against
 * {@code repo} (resolved before the view is built). It translates ordered semantic events into
 * renderer block lifecycle calls and accumulates run facts so the Generating block can render the
 * stats ledger. It opens at Scanning; the repo-free Preparing stage is rendered by
 * {@link createPreparingView} before this view is built. The CLI decides whether to use it at all.
 */
export function createRunView(
	renderer: Renderer,
	repo: Repository,
	options: RunViewOptions,
): RunProgress {
	let block: BlockHandle | undefined;

	let scanned:
		| (ScannedSummary & {
				commits: number;
				aggregate: Aggregate;
		  })
		| undefined;
	let resolved: ResolvedTicketReferences | undefined;

	return {
		emit(event) {
			switch (event.type) {
				case "stage-start":
					block = renderer.start(event.stage);
					return;
				case "stage-debug":
					if (options.debug) {
						block?.debug(event.line);
					}
					return;
				case "stage-failed":
					block?.fail(`${event.stage} failed`);
					block = undefined;
					return;
				case "scanning-complete": {
					scanned = {
						commits: event.commits,
						aggregate: event.aggregate,
						...scannedSummary(event.aggregate),
					};
					block?.succeed(scannedSummaryView(scanned, repo, options));
					block = undefined;
					return;
				}
				case "looking-up-complete": {
					resolved = event.resolved;
					block?.succeed(lookedUpView(resolved, repo, options));
					block = undefined;
					return;
				}
				case "generating-complete": {
					block?.succeed(generatedView(event.summary, scanned, resolved));
					block = undefined;
					return;
				}
			}
		},
	};
}

/**
 * Build a Run Progress sink for debug-only mode: emit only stage-bound debug lines to {@code write},
 * with no headers, progress blocks, durations, or completion output. It consumes the same event
 * model as the full view.
 */
export function createDebugView(write: (line: string) => void): RunProgress {
	return {
		emit(event) {
			if (event.type === "stage-debug") {
				write(event.line);
			}
		},
	};
}

/**
 * Build a Run Progress sink for the Preparing stage, which runs before the repository is resolved and
 * so cannot use the repo-linked {@link createRunView}. It shows the stage spinner and, in debug mode,
 * the stage's trace and a "Prepared context" line; outside debug mode the completed stage is
 * discarded silently so the visible view opens at the header box.
 */
export function createPreparingView(renderer: Renderer, debug: boolean): RunProgress {
	let block: BlockHandle | undefined;
	return {
		emit(event) {
			switch (event.type) {
				case "stage-start":
					block = renderer.start(event.stage);
					return;
				case "stage-debug":
					if (debug) {
						block?.debug(event.line);
					}
					return;
				case "stage-failed":
					block?.fail(`${event.stage} failed`);
					block = undefined;
					return;
				case "preparing-complete":
					if (debug) {
						block?.succeed({ title: [{ text: "Prepared context" }] });
					} else {
						block?.discard();
					}
					block = undefined;
					return;
			}
		},
	};
}

/**
 * Every distinct Ticket Target across one commit's display roles.
 */
function commitTargets(commit: AggregatedCommit): CommitCandidate[] {
	return [
		...commit.candidates,
		...commit.credits,
		...commit.demoted,
		...commit.related,
	];
}

/**
 * Whether a commit carries no Ticket Reference occurrence of any qualifier. Sums the role-array
 * lengths directly rather than building a combined array just to measure it.
 */
function isMissing(commit: AggregatedCommit): boolean {
	return (
		commit.candidates.length +
			commit.credits.length +
			commit.demoted.length +
			commit.related.length ===
		0
	);
}

/**
 * Reduce Aggregated Ticket References to the semantic Scanned-block facts.
 */
function scannedSummary(aggregate: Aggregate): ScannedSummary {
	const unique = new Set<string>();
	const pullRequest = new Set<string>();
	let missing = 0;
	for (const commit of aggregate.commits) {
		if (isMissing(commit)) {
			missing += 1;
		}
		for (const candidate of commitTargets(commit)) {
			unique.add(targetKey(candidate.target));
		}
		for (const credit of commit.credits) {
			pullRequest.add(targetKey(credit.target));
		}
	}
	return { missing, uniqueTargets: unique.size, pullRequestTargets: pullRequest.size };
}

/**
 * Reduce one aggregated commit to its display row, newest commits first for the listing.
 */
function scannedRows(aggregate: Aggregate): ScannedRow[] {
	const targets = (candidates: readonly CommitCandidate[]): TicketTarget[] =>
		candidates.map((candidate) => candidate.target);

	return [...aggregate.commits].reverse().map((commit) => ({
		sha: commit.commit.sha,
		author: commit.commit.author,
		summary: commit.commit.summary,
		lead: commit.lead?.target,

		candidates: targets(commit.candidates.slice(1)),
		credits: targets(commit.credits),
		demoted: targets(commit.demoted),
		related: targets(commit.related),
		missing: isMissing(commit),
	}));
}

function scannedSummaryView(
	scanned: { commits: number; aggregate: Aggregate } & ScannedSummary,
	repo: Repository,
	options: RunViewOptions,
): StepSummary {
	const title = titleLine("Scanned", scanned.commits, "commit");
	const rows = scannedRows(scanned.aggregate);
	if (options.commitDetail === "all") {
		return { title, commitRows: commitRows(rows, repo) };
	}
	if (options.commitDetail === "missing") {
		return { title, commitRows: commitRows(rows.filter((row) => row.missing), repo) };
	}
	return { title, notes: scannedFacts(scanned) };
}

function lookedUpView(
	resolved: ResolvedTicketReferences,
	repo: Repository,
	options: RunViewOptions,
): StepSummary {
	const notFound = [...resolved.candidateNotFound, ...resolved.creditNotFound];
	// "Looked up" counts every Ticket Target that crossed the lookup seam, not just changelog
	// entries: a credit-only pull request is looked up too, so cached + fetched reconcile against it.
	const title = titleLine("Looked up", resolved.lookedUp.length, "ticket");
	return {
		title,
		notes: lookupNotes(resolved.cached, resolved.fetched),
		rows: notFoundRows(notFound, repo),
		flow: options.showLookupOutcomes
			? lookedUpReferences(resolved.lookedUp, repo)
			: undefined,
		excluded: excludedSection(resolved.excluded, repo, options.showLookupOutcomes),
	};
}

/**
 * The "N excluded" section for the Looked up block: a warning-accent count of the references held
 * back by followReferences, plus the excluded references themselves (accent, like the looked-up ones)
 * when the verbose outcome listing is requested. Absent when nothing was excluded.
 */
function excludedSection(
	excluded: readonly TicketTarget[],
	repo: Repository,
	showLookupOutcomes: boolean,
): ExcludedSection | undefined {
	if (excluded.length === 0) {
		return undefined;
	}
	return {
		label: factLine(excluded.length, " excluded", "warning"),
		flow: showLookupOutcomes ? excludedReferences(excluded, repo) : undefined,
	};
}

/**
 * A flat flow of the followReferences-excluded targets, rendered accent and linked like the looked-up
 * references: being excluded is a configuration choice, not a lookup failure.
 */
function excludedReferences(excluded: readonly TicketTarget[], repo: Repository): Cell[] {
	return excluded.map((target) => ({
		text: targetKey(target),
		style: "accent",
		link: ticketUrl(repo, target),
	}));
}

function generatedView(
	summary: GenerationSummary,
	scanned: ({ commits: number } & ScannedSummary) | undefined,
	resolved: ResolvedTicketReferences | undefined,
): StepSummary {
	const facts: LedgerFacts = {
		commits: scanned?.commits ?? 0,
		uniqueTargets: scanned?.uniqueTargets ?? 0,
		candidateNotFound: resolved?.candidateNotFound.length ?? 0,
		creditNotFound: resolved?.creditNotFound.length ?? 0,
		summary,
	};
	return {
		title: titleLine("Documented", summary.documentedEntries, "entry", "entries"),
		rows: ledgerRows(facts),
	};
}
