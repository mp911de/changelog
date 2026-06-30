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

import type { Octokit } from "octokit";
import pLimit from "p-limit";

import type { ResolvedTicket, TicketCache } from "./cache.js";
import type { Repository } from "./github-context.js";
import { hasStatus } from "./errors.js";
import { repositoryKey, targetKey, type TicketTarget } from "./ticket-references.js";

export type { ResolvedTicket } from "./cache.js";

// Limit request pressure to reduce secondary rate limiting.
const CONCURRENCY = 10;

export interface TargetLookupOptions {
	readonly octokit: Octokit;
	readonly repo: Repository;
	readonly cache?: TicketCache;
	readonly refresh?: boolean;
}

/**
 * Role-free lookup facts over a batch of deduplicated Ticket Targets: the resolved tickets keyed by
 * {@link targetKey}, the targets GitHub reported missing, and cache provenance. This is the single
 * shape the lookup produces and {@link resolveTicketReferences} joins back to the {@link Aggregate}.
 */
export interface LookupFacts {
	readonly facts: ReadonlyMap<string, ResolvedTicket>;

	readonly notFoundTargets: readonly TicketTarget[];
	readonly cached: number;
	readonly fetched: number;
}

interface TargetFailure {
	readonly target: TicketTarget;
	readonly error: unknown;
}

type TargetOutcome =
	| {
			readonly kind: "resolved";
			readonly key: string;
			readonly ticket: ResolvedTicket;
			readonly source: "cache" | "github";
			readonly cacheEntry?: readonly [string, ResolvedTicket];
	  }
	| { readonly kind: "not-found"; readonly target: TicketTarget }
	| ({ readonly kind: "failed" } & TargetFailure);

/**
 * Focused lookup over deduplicated Ticket Targets.
 */
export function createTargetLookup(options: TargetLookupOptions) {
	const { octokit, repo, cache, refresh } = options;
	const limit = pLimit(CONCURRENCY);

	return async function lookup(targets: readonly TicketTarget[]): Promise<LookupFacts> {
		const outcomes = await Promise.all(
			targets.map((target) =>
				limit(async (): Promise<TargetOutcome> => {
					const repository = target.repository ?? repo;
					const key = repositoryKey(repository, target.id);

					if (cache && !refresh) {
						const hit = cache.get(key);
						if (hit) {
							return {
								kind: "resolved",
								key: targetKey(target),
								ticket: hit,
								source: "cache",
							};
						}
					}

					try {
						const ticket = await fetchTicket(octokit, repository, target.id);
						if (!ticket) {
							return { kind: "not-found", target };
						}
						return {
							kind: "resolved",
							key: targetKey(target),
							ticket,
							source: "github",
							cacheEntry: cache ? [key, ticket] : undefined,
						};
					} catch (error) {
						return { kind: "failed", target, error };
					}
				}),
			),
		);

		// Persist freshly fetched tickets before any lookup failure is surfaced, so a partial run still
		// warms the cache and a retry does not refetch what already succeeded.
		const updates = new Map(
			outcomes.flatMap((outcome) =>
				outcome.kind === "resolved" && outcome.cacheEntry
					? [outcome.cacheEntry]
					: [],
			),
		);
		if (cache && updates.size > 0) {
			await cache.update(updates);
		}

		const failures = outcomes.filter(
			(outcome): outcome is { kind: "failed" } & TargetFailure =>
				outcome.kind === "failed",
		);
		if (failures.length > 0) {
			throw targetLookupFailure(failures);
		}

		const facts = new Map(
			outcomes.flatMap((outcome) =>
				outcome.kind === "resolved"
					? [[outcome.key, outcome.ticket] as const]
					: [],
			),
		);
		const notFoundTargets = outcomes.flatMap((outcome) =>
			outcome.kind === "not-found" ? [outcome.target] : [],
		);
		const cached = outcomes.filter(
			(outcome) => outcome.kind === "resolved" && outcome.source === "cache",
		).length;
		return { facts, notFoundTargets, cached, fetched: facts.size - cached };
	};
}

function targetLookupFailure(failures: readonly TargetFailure[]): Error {
	const ids = failures.map((failure) => targetKey(failure.target)).join(", ");
	const cause = failures[0]!.error;
	const detail = cause instanceof Error ? cause.message : String(cause);
	const noun = failures.length === 1 ? "ticket" : "tickets";
	return new Error(`Failed to look up ${failures.length} ${noun} (${ids}): ${detail}`, {
		cause,
	});
}

async function fetchTicket(
	octokit: Octokit,
	target: Repository,
	id: string,
): Promise<ResolvedTicket | undefined> {
	const issueNumber = Number(id.replace(/^#/, ""));
	try {
		const { data } = await octokit.rest.issues.get({
			owner: target.owner,
			repo: target.repo,
			issue_number: issueNumber,
		});
		return toResolvedTicket(data);
	} catch (error) {
		if (hasStatus(error, 404)) {
			return undefined;
		}
		throw error;
	}
}

// The GitHub issues.get response payload, taken from Octokit's own types so the parser stays honest
// against the real response shape instead of a hand-written subset that could drift.
type IssuePayload = Awaited<ReturnType<Octokit["rest"]["issues"]["get"]>>["data"];

function toResolvedTicket(data: IssuePayload): ResolvedTicket {
	return {
		title: data.title,
		htmlUrl: data.html_url,
		labels: data.labels
			.map((label) => (typeof label === "string" ? label : (label.name ?? "")))
			.filter((name) => name.length > 0),
		pullRequest: data.pull_request != null,
		author: data.user?.login,
	};
}
