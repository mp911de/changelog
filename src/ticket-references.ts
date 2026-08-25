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

export type ReferenceQualifier =
	"Qualified" | "PullRequest" | "See" | "Simple" | "Related";

export interface ReferenceOccurrence {
	readonly id: string;
	readonly qualifier: ReferenceQualifier;
	readonly repository?: Repository;
}

function normalizeOccurrenceId(id: string): string {
	if (id.toLowerCase().startsWith("gh-")) {
		return `#${id.substring(3)}`;
	}
	return id;
}

export function referenceOccurrence(
	id: string,
	qualifier: ReferenceQualifier,
	repository?: Repository,
): ReferenceOccurrence {
	const normalized = normalizeOccurrenceId(id);
	return repository
		? { id: normalized, qualifier, repository }
		: { id: normalized, qualifier };
}

/**
 * The commit a Ticket Reference occurrence originates from, reduced to the context Ticket
 * References needs for display and provenance. Commits are supplied oldest-first.
 */
export interface ReferenceCommit {
	readonly sha: string;
	readonly author: string;
	readonly summary: string;
}

/**
 * A distinct GitHub issue or pull request, identified by repository plus ticket number.
 */
export interface TicketTarget {
	readonly id: string;
	readonly repository?: Repository;
}

/**
 * The fully-qualified key for a ticket within a repository. Takes the {@link Repository} whole so
 * owner and repo cannot be transposed at the call site.
 */
export function repositoryKey(repository: Repository, id: string): string {
	return `${repository.owner}/${repository.repo}${id}`;
}

/**
 * Stable identity for a Ticket Target: repository plus ticket number, or the bare id for the
 * current repository. Delegates to {@link repositoryKey} so it shares the cache key spelling and
 * lookup and cache line up.
 */
export function targetKey(target: TicketTarget): string {
	return target.repository ? repositoryKey(target.repository, target.id) : target.id;
}

/**
 * A value collection for Ticket Targets keyed by their domain identity, preserving first-seen order.
 */
export class TicketTargetSet {
	private readonly targets = new Map<string, TicketTarget>();

	static from(targets: Iterable<TicketTarget>): TicketTargetSet {
		return new TicketTargetSet(targets);
	}

	constructor(targets: Iterable<TicketTarget> = []) {
		for (const target of targets) {
			this.add(target);
		}
	}

	get size(): number {
		return this.targets.size;
	}

	add(target: TicketTarget): boolean {
		const key = targetKey(target);
		if (this.targets.has(key)) {
			return false;
		}
		this.targets.set(key, target);
		return true;
	}

	has(target: TicketTarget): boolean {
		return this.targets.has(targetKey(target));
	}

	delete(target: TicketTarget): boolean {
		return this.targets.delete(targetKey(target));
	}

	values(): TicketTarget[] {
		return [...this.targets.values()];
	}
}

export interface CommitReferences {
	readonly commit: ReferenceCommit;
	readonly occurrences: readonly ReferenceOccurrence[];
}

export interface AggregatedCommit {
	readonly commit: ReferenceCommit;
	readonly lead: TicketTarget | undefined;
	readonly candidates: readonly TicketTarget[];
	readonly credits: readonly TicketTarget[];
	readonly demoted: readonly TicketTarget[];
	readonly related: readonly TicketTarget[];
}

/**
 * A deduplicated Ticket Target, flagged with what it is needed for: a Changelog Entry
 * ({@code changelog}), Contributor Credit ({@code credit}), or both. Demoted and Related references
 * are needed for neither and never reach lookup.
 */
export interface LookupTarget {
	readonly target: TicketTarget;
	readonly changelog: boolean;
	readonly credit: boolean;
}

/**
 * The immutable, aggregated result of Ticket References, as plain data. It owns Simple Changelog
 * Candidate selection, per-commit display order, run-wide Ticket Target deduplication, the flagged
 * targets, and oldest-occurrence provenance.
 */
export interface Aggregate {
	readonly commits: readonly AggregatedCommit[];

	/**
	 * Every deduplicated Ticket Target needed for changelog and/or credit, in commit-discovery
	 * (first-appearance) order. Demoted and Related references are excluded.
	 */
	readonly targets: readonly LookupTarget[];

	/**
	 * Ticket Targets that can suppress changelog entry roles after followReferences has removed
	 * excluded targets. They originate from Original Pull Request credit for commits with a Closing or
	 * See reference.
	 */
	readonly suppressionCandidateTargets: readonly TicketTarget[];

	/**
	 * The oldest commit that produced an occurrence of each looked-up target, keyed by
	 * {@link targetKey}, for not-found provenance.
	 */
	readonly provenance: ReadonlyMap<string, ReferenceCommit>;
}

/**
 * Aggregate one commit's parser output at a time into the immutable {@link Aggregate}. Commits are
 * supplied oldest-first so the first sighting of a target is its oldest provenance. When supplied,
 * {@code currentRepository} canonicalizes explicitly qualified references to the current repository
 * while their occurrence spelling remains available for display.
 */
export function aggregateReferences(
	collected: readonly CommitReferences[],
	currentRepository?: Repository,
): Aggregate {
	// Oldest-first provenance: the first commit that produced a lookup target wins, regardless of
	// which role caused the lookup.
	const provenance = new Map<string, ReferenceCommit>();
	// Run-wide lookup purpose per target. Changelog selection and Credit References are independent,
	// so a target can accumulate both purposes.
	const changelog = new Map<string, TicketTarget>();
	const credit = new Map<string, TicketTarget>();
	const suppressionCandidateTargets = new TicketTargetSet();

	const noteTarget = (target: TicketTarget, commit: ReferenceCommit): void => {
		const key = targetKey(target);
		if (!provenance.has(key)) {
			provenance.set(key, commit);
		}
	};

	const commits: AggregatedCommit[] = collected.map(({ commit, occurrences }) => {
		// Candidate ranking is per commit: the highest non-empty tier supplies every Changelog
		// Candidate and demotes the rest. Related references stay outside candidate selection.
		const tier = highestCandidateTier(occurrences);
		const pullRequestsAreCreditOnly = tier === "Qualified" || tier === "See";

		const candidates = new TicketTargetSet();
		const credits = new TicketTargetSet();
		const demoted = new TicketTargetSet();
		const related = new TicketTargetSet();
		for (const occurrence of occurrences) {
			const target = toTarget(occurrence, currentRepository);
			// A PullRequest occurrence is a Credit Reference independently of candidate selection.
			if (occurrence.qualifier === "PullRequest") {
				noteTarget(target, commit);
				credit.set(targetKey(target), target);
				credits.add(target);
				if (pullRequestsAreCreditOnly) {
					suppressionCandidateTargets.add(target);
				}
			}
			if (occurrence.qualifier === tier) {
				noteTarget(target, commit);
				changelog.set(targetKey(target), target);
				candidates.add(target);
				continue;
			}
			if (occurrence.qualifier === "Related") {
				related.add(target);
				continue;
			}
			if (occurrence.qualifier === "PullRequest") {
				continue;
			}
			demoted.add(target);
		}
		const candidateTargets = candidates.values();
		return {
			commit,
			lead: candidateTargets[0],
			candidates: candidateTargets,
			credits: credits.values(),
			demoted: demoted.values(),
			related: related.values(),
		};
	});

	// Commit-discovery order: each target keeps the position of its first appearance (oldest commit,
	// textual order within it) and is never reordered by id. A later commit re-citing the same
	// ticket has already been recorded, so it does not move.
	return {
		commits,
		targets: buildLookupTargets(changelog, credit),
		suppressionCandidateTargets: suppressionCandidateTargets.values(),
		provenance,
	};
}

/**
 * Merge the changelog and credit target maps into one list in commit-discovery order: changelog
 * targets in first-appearance order, then any credit-only targets, each flagged by the maps it
 * appears in. A target in both maps keeps its earliest position.
 */
function buildLookupTargets(
	changelog: ReadonlyMap<string, TicketTarget>,
	credit: ReadonlyMap<string, TicketTarget>,
): LookupTarget[] {
	const merged = new Map<string, TicketTarget>([...changelog, ...credit]);
	return [...merged].map(([key, target]) => ({
		target,
		changelog: changelog.has(key),
		credit: credit.has(key),
	}));
}

// The Reference Qualifiers with their strength rank (higher is stronger) and candidate eligibility:
// the single source of truth for ranking. `candidate: false` marks Related as supporting context
// that never becomes a Changelog Candidate, even when no stronger tier exists. `satisfies Record`
// makes a missing qualifier a compile error, so ranking can never silently yield undefined.
const QUALIFIERS = {
	Qualified: { rank: 4, candidate: true },
	See: { rank: 3, candidate: true },
	PullRequest: { rank: 2, candidate: true },
	Related: { rank: 1, candidate: false },
	Simple: { rank: 0, candidate: true },
} satisfies Record<ReferenceQualifier, { rank: number; candidate: boolean }>;

export function qualifierRank(qualifier: ReferenceQualifier): number {
	return QUALIFIERS[qualifier].rank;
}

const CANDIDATE_TIERS: readonly ReferenceQualifier[] = (
	Object.keys(QUALIFIERS) as ReferenceQualifier[]
)
	.filter((qualifier) => QUALIFIERS[qualifier].candidate)
	.sort((left, right) => QUALIFIERS[right].rank - QUALIFIERS[left].rank);

/**
 * The highest non-empty candidate tier for one commit's occurrences, or {@code undefined} when the
 * commit has no candidate-tier occurrence (including a commit whose only references are Related).
 * Candidate-eligible references outside the returned tier are demoted; Related references are never
 * candidates and always stay diagnostic.
 */
function highestCandidateTier(
	occurrences: readonly ReferenceOccurrence[],
): ReferenceQualifier | undefined {
	return CANDIDATE_TIERS.find((tier) =>
		occurrences.some((occurrence) => occurrence.qualifier === tier),
	);
}

function toTarget(
	occurrence: ReferenceOccurrence,
	currentRepository: Repository | undefined,
): TicketTarget {
	const repository = occurrence.repository;
	return repository && !sameRepository(repository, currentRepository)
		? { id: occurrence.id, repository: occurrence.repository }
		: { id: occurrence.id };
}

function sameRepository(left: Repository, right: Repository | undefined): boolean {
	return (
		right !== undefined &&
		left.owner.toLowerCase() === right.owner.toLowerCase() &&
		left.repo.toLowerCase() === right.repo.toLowerCase()
	);
}
