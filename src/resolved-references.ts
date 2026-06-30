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

import type { LookupFacts, ResolvedTicket } from "./lookup.js";
import {
	type Aggregate,
	type ReferenceCommit,
	targetKey,
	type TicketTarget,
} from "./ticket-references.js";

export interface ChangelogEntry {
	readonly target: TicketTarget;
	readonly title: string;
	readonly htmlUrl: string;
	readonly labels: readonly string[];
}

export interface NotFoundTarget {
	readonly target: TicketTarget;
	readonly commit: ReferenceCommit;
}

export interface LookedUpTarget {
	readonly target: TicketTarget;
	readonly found: boolean;
}

/**
 * The immutable join of an {@link Aggregate} with GitHub lookup facts. It owns resolved Changelog
 * Entries, ordered author facts for Contributor Credit, the distinct candidate and credit-only
 * not-found failures, and cache provenance.
 */
export interface ResolvedTicketReferences {
	readonly entries: readonly ChangelogEntry[];
	// Author logins in run-wide target order, with GitHub's spelling, before deduplication.
	readonly authors: readonly string[];
	// Every Ticket Target looked up (changelog and credit purposes), with its resolution outcome.
	// The Looked up block counts and lists these, so cached + fetched never exceeds its length.
	readonly lookedUp: readonly LookedUpTarget[];

	// Cross-repository targets held back by followReferences: never looked up, never an entry or a
	// credit, and reported separately so a limited reference is not mistaken for a not-found one.
	readonly excluded: readonly TicketTarget[];
	readonly candidateNotFound: readonly NotFoundTarget[];
	readonly creditNotFound: readonly NotFoundTarget[];
	readonly cached: number;
	readonly fetched: number;
}

/**
 * Join {@link aggregate} with {@link lookup} facts. Each candidate target with facts becomes a
 * Changelog Entry. Author facts follow the credit rule: a credit-purpose target is always credited
 * (the commit's PullRequest qualifier is authoritative), and a changelog-only candidate is credited
 * only when GitHub reports it as a pull request. Not-found failures are split by whether the target
 * carried a changelog purpose (candidate) or only a credit purpose. Targets in {@code excluded} were
 * held back by followReferences: they are never looked up, never become entries or credits, and are
 * reported separately from looked-up and not-found targets.
 */
export function resolveTicketReferences(
	aggregate: Aggregate,
	lookup: LookupFacts,
	excluded: readonly TicketTarget[] = [],
): ResolvedTicketReferences {
	const entries: ChangelogEntry[] = [];
	const authors: string[] = [];
	const lookedUp: LookedUpTarget[] = [];
	const excludedKeys = new Set(excluded.map(targetKey));
	const excludedTargets: TicketTarget[] = [];
	const flagsByKey = new Map(aggregate.targets.map((t) => [targetKey(t.target), t]));

	for (const { target, changelog, credit } of aggregate.targets) {
		if (excludedKeys.has(targetKey(target))) {
			excludedTargets.push(target);
			continue;
		}
		const facts = lookup.facts.get(targetKey(target));
		lookedUp.push({ target, found: facts !== undefined });
		if (!facts) {
			continue;
		}
		if (changelog) {
			entries.push({
				target,
				title: facts.title,
				htmlUrl: facts.htmlUrl,
				labels: facts.labels,
			});
		}
		if (earnsCredit(credit, facts) && facts.author) {
			authors.push(facts.author);
		}
	}

	const candidateNotFound: NotFoundTarget[] = [];
	const creditNotFound: NotFoundTarget[] = [];
	// Split not-found failures: credit-only when the target was needed for credit but not changelog,
	// otherwise a candidate, so the ledger reports the two outcomes distinctly.
	for (const target of lookup.notFoundTargets) {
		const failure = toNotFound(aggregate, target);
		const flags = flagsByKey.get(targetKey(target));
		if (flags?.credit && !flags.changelog) {
			creditNotFound.push(failure);
		} else {
			candidateNotFound.push(failure);
		}
	}

	return {
		entries,
		authors,
		lookedUp,
		excluded: excludedTargets,
		candidateNotFound,
		creditNotFound,
		cached: lookup.cached,
		fetched: lookup.fetched,
	};
}

/**
 * The Contributor Credit rule in one place: a credit-flagged target is always credited (the commit's
 * PullRequest qualifier is authoritative), and a changelog-only candidate is credited only when
 * GitHub reports it as a pull request.
 */
function earnsCredit(credit: boolean, facts: ResolvedTicket): boolean {
	return credit || facts.pullRequest;
}

function toNotFound(aggregate: Aggregate, target: TicketTarget): NotFoundTarget {
	const commit = aggregate.provenance.get(targetKey(target));
	// A looked-up target always originates from a scanned commit; missing provenance is a bug, not input.
	if (!commit) {
		throw new Error(`No commit provenance recorded for ${targetKey(target)}.`);
	}
	return { target, commit };
}
