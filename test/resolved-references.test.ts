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

import { describe, expect, it } from "vitest";

import type { ResolvedTicket } from "../src/lookup.js";
import { resolveTicketReferences } from "../src/resolved-references.js";
import {
	aggregateReferences,
	type ReferenceCommit,
	type ReferenceOccurrence,
	referenceOccurrence,
	targetKey,
	type TicketTarget,
} from "../src/ticket-references.js";

function commit(sha: string, summary = `${sha} summary`): ReferenceCommit {
	return { sha, author: "Author", summary };
}

function aggregateOf(
	commits: readonly {
		commit: ReferenceCommit;
		occurrences: readonly ReferenceOccurrence[];
	}[],
) {
	return aggregateReferences(commits);
}

function ticket(extra: Partial<ResolvedTicket> = {}): ResolvedTicket {
	return {
		title: extra.title ?? "A change",
		htmlUrl: extra.htmlUrl ?? "https://example.test/1",
		labels: extra.labels ?? [],
		pullRequest: extra.pullRequest ?? false,
		author: extra.author,
	};
}

function facts(entries: Record<string, ResolvedTicket>): {
	facts: ReadonlyMap<string, ResolvedTicket>;
	notFoundTargets: readonly TicketTarget[];
	cached: number;
	fetched: number;
} {
	return {
		facts: new Map(Object.entries(entries)),
		notFoundTargets: [],
		cached: 0,
		fetched: Object.keys(entries).length,
	};
}

describe("resolveTicketReferences", () => {
	it("reports followReferences-excluded targets separately, not as looked up or not found", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#1", "Qualified"),
					referenceOccurrence("#9", "Qualified", {
						owner: "forbidden",
						repo: "repo",
					}),
				],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({ "#1": ticket({ title: "Local change", labels: ["enhancement"] }) }),
			[{ id: "#9", repository: { owner: "forbidden", repo: "repo" } }],
		);

		// The excluded cross-repository target is held out of lookup and produces no entry.
		expect(resolved.excluded.map((target) => targetKey(target))).toEqual([
			"forbidden/repo#9",
		]);
		expect(resolved.lookedUp.map((t) => targetKey(t.target))).toEqual(["#1"]);
		expect(resolved.entries.map((e) => targetKey(e.target))).toEqual(["#1"]);
		// It is not a not-found failure either.
		expect(resolved.candidateNotFound).toEqual([]);
		expect(resolved.creditNotFound).toEqual([]);
	});

	it("produces one Changelog Entry per resolved candidate, in commit-discovery order", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "Qualified"),
				],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#10": ticket({ title: "Ten", htmlUrl: "u10", labels: ["bug"] }),
				"#20": ticket({
					title: "Twenty",
					htmlUrl: "u20",
					labels: ["enhancement"],
				}),
			}),
		);

		expect(resolved.entries.map((e) => [targetKey(e.target), e.title])).toEqual([
			["#10", "Ten"],
			["#20", "Twenty"],
		]);
		expect(resolved.entries[0]?.htmlUrl).toBe("u10");
		expect(resolved.entries[0]?.labels).toEqual(["bug"]);
	});

	it("does not create a Changelog Entry for a credit-only target", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#10": ticket({ title: "Ten" }),
				"#20": ticket({
					title: "Credit only",
					author: "contrib",
					pullRequest: true,
				}),
			}),
		);

		expect(resolved.entries.map((e) => targetKey(e.target))).toEqual(["#10"]);
		expect(resolved.authors).toEqual(["contrib"]);
	});

	it("credits a PullRequest target even when GitHub reports it as an issue", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#20", "PullRequest")],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#20": ticket({ author: "contrib", pullRequest: false }),
			}),
		);

		expect(resolved.authors).toEqual(["contrib"]);
	});

	it("credits a candidate target when GitHub reports it as a pull request", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#10", "Qualified")],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#10": ticket({ author: "contrib", pullRequest: true }),
			}),
		);

		expect(resolved.authors).toEqual(["contrib"]);
	});

	it("does not credit a candidate target that GitHub reports as a plain issue", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#10", "Qualified")],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#10": ticket({ author: "contrib", pullRequest: false }),
			}),
		);

		expect(resolved.authors).toEqual([]);
	});

	it("orders author facts run-wide, before deduplication, retaining GitHub's spelling", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "PullRequest"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#10": ticket({ author: "Bob", pullRequest: true }),
				"#20": ticket({ author: "alice", pullRequest: true }),
			}),
		);

		expect(resolved.authors).toEqual(["Bob", "alice"]);
	});

	it("separates candidate not-found failures from credit-only not-found failures", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("cand", "Candidate sighting"),
				occurrences: [referenceOccurrence("#10", "Qualified")],
			},
			{
				commit: commit("cred", "Credit sighting"),
				occurrences: [
					referenceOccurrence("#30", "Qualified"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		const resolved = resolveTicketReferences(aggregate, {
			facts: new Map([["#30", ticket({ title: "Found" })]]),
			notFoundTargets: [{ id: "#10" }, { id: "#20" }],
			cached: 0,
			fetched: 1,
		});

		expect(resolved.candidateNotFound.map((f) => targetKey(f.target))).toEqual([
			"#10",
		]);
		expect(resolved.candidateNotFound[0]?.commit.summary).toBe("Candidate sighting");
		expect(resolved.creditNotFound.map((f) => targetKey(f.target))).toEqual(["#20"]);
		expect(resolved.creditNotFound[0]?.commit.summary).toBe("Credit sighting");
	});

	it("carries cache provenance counts through", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#10", "Qualified")],
			},
		]);

		const resolved = resolveTicketReferences(aggregate, {
			facts: new Map([["#10", ticket()]]),
			notFoundTargets: [],
			cached: 3,
			fetched: 4,
		});

		expect(resolved.cached).toBe(3);
		expect(resolved.fetched).toBe(4);
	});

	it("emits one author fact per target even when it is both candidate and credit", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		const resolved = resolveTicketReferences(
			aggregate,
			facts({
				"#20": ticket({ author: "contrib", pullRequest: true, title: "Both" }),
			}),
		);

		expect(resolved.entries.map((entry) => targetKey(entry.target))).toEqual(["#20"]);
		expect(resolved.authors).toEqual(["contrib"]);
	});
});
