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

import {
	type Aggregate,
	aggregateReferences,
	type ReferenceCommit,
	type ReferenceOccurrence,
	referenceOccurrence,
	type TicketTarget,
	targetKey,
} from "../src/ticket-references.js";

function commit(sha: string, summary = `${sha} summary`): ReferenceCommit {
	return { sha, author: "Author", summary };
}

// The display label the view renders for a role entry: the canonical target key.
function label(entry: { target: TicketTarget } | undefined): string | undefined {
	return entry && targetKey(entry.target);
}

function aggregateOf(
	commits: readonly {
		commit: ReferenceCommit;
		occurrences: readonly ReferenceOccurrence[];
	}[],
) {
	return aggregateReferences(commits);
}

// The deduplicated changelog-purpose targets, in commit-discovery order: derived here from the
// flagged lookup targets the way the pipeline does, so the assertions below read as before.
function changelogTargets(aggregate: Aggregate): readonly TicketTarget[] {
	return aggregate.targets
		.filter((flagged) => flagged.changelog)
		.map((flagged) => flagged.target);
}

describe("aggregated Ticket References (Simple path)", () => {
	it("turns a single Simple occurrence into one Changelog Candidate that is the Lead", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#1234", "Simple")],
			},
		]);

		expect(aggregate.commits).toHaveLength(1);
		const [first] = aggregate.commits;
		expect(label(first?.lead)).toBe("#1234");
		expect(first?.candidates.map(label)).toEqual(["#1234"]);
	});

	it("deduplicates one Ticket Target across several commits into one changelog lookup target", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#1234", "Simple")],
			},
			{
				commit: commit("bbb"),
				occurrences: [referenceOccurrence("#1234", "Simple")],
			},
		]);

		const targets = changelogTargets(aggregate);
		expect(targets).toHaveLength(1);
		expect(targets[0]?.id).toBe("#1234");

		expect(aggregate.commits.map((c) => label(c.lead))).toEqual(["#1234", "#1234"]);
	});

	it("displays a repeated Ticket Target once per commit even when it occurs twice", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#1234", "Simple"),
					referenceOccurrence("#1234", "Simple"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#1234"]);
		expect(changelogTargets(aggregate)).toHaveLength(1);
	});

	it("identifies a Ticket Target by repository plus ticket number", () => {
		const aggregate = aggregateOf([
			{ commit: commit("aaa"), occurrences: [referenceOccurrence("#1", "Simple")] },
			{
				commit: commit("bbb"),
				occurrences: [
					referenceOccurrence("#1", "Simple", {
						owner: "acme",
						repo: "gizmos",
					}),
				],
			},
		]);

		const targets = changelogTargets(aggregate);
		expect(targets).toHaveLength(2);
		expect(targets.map((target) => targetKey(target)).sort()).toEqual([
			"#1",
			"acme/gizmos#1",
		]);
	});

	it("collapses a qualified current-repository reference into the local Ticket Target", () => {
		const current = { owner: "octo", repo: "widgets" };
		const aggregate = aggregateReferences(
			[
				{
					commit: commit("aaa"),
					occurrences: [referenceOccurrence("#12", "Qualified")],
				},
				{
					commit: commit("bbb"),
					occurrences: [
						referenceOccurrence("#12", "Qualified", {
							owner: "Octo",
							repo: "Widgets",
						}),
					],
				},
			],
			current,
		);

		expect(changelogTargets(aggregate).map(targetKey)).toEqual(["#12"]);
		// Both the bare and the qualified current-repository reference collapse to the local key.
		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#12"]);
		expect(aggregate.commits[1]?.candidates.map(label)).toEqual(["#12"]);
	});

	it("makes the first Changelog Candidate in textual order the Lead", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "Simple"),
				],
			},
		]);

		expect(label(aggregate.commits[0]?.lead)).toBe("#10");
		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#10", "#20"]);
	});

	it("retains the oldest occurrence as not-found provenance for a target", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("old", "Oldest sighting"),
				occurrences: [referenceOccurrence("#7", "Simple")],
			},
			{
				commit: commit("new", "Later sighting"),
				occurrences: [referenceOccurrence("#7", "Simple")],
			},
		]);

		const [target] = changelogTargets(aggregate);
		const provenance = aggregate.provenance.get(targetKey(target!));
		expect(provenance?.sha).toBe("old");
		expect(provenance?.summary).toBe("Oldest sighting");
	});
});

describe("aggregated Ticket References (candidate ranking)", () => {
	it("selects a Qualified reference over a Simple one and demotes the Simple", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "Qualified"),
				],
			},
		]);

		const [first] = aggregate.commits;
		expect(first?.candidates.map(label)).toEqual(["#20"]);
		expect(label(first?.lead)).toBe("#20");

		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual(["#20"]);
	});

	it("selects PullRequest references over Simple ones when no Qualified reference exists", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#20"]);
		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual(["#20"]);
	});

	it("makes every reference in the highest tier a Changelog Candidate, in textual order", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "Qualified"),
					referenceOccurrence("#30", "Simple"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#10", "#20"]);
		expect(label(aggregate.commits[0]?.lead)).toBe("#10");

		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual([
			"#10",
			"#20",
		]);
	});

	it("excludes a Related reference from candidate selection when a stronger reference exists", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "Related"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#10"]);
		expect(aggregate.commits[0]?.related.map(label)).toEqual(["#20"]);
		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual(["#10"]);
	});

	it("never makes a Related-only commit's reference a Changelog Candidate", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [referenceOccurrence("#10", "Related")],
			},
		]);

		expect(aggregate.commits[0]?.candidates).toEqual([]);
		expect(aggregate.commits[0]?.lead).toBeUndefined();
		expect(aggregate.commits[0]?.related.map(label)).toEqual(["#10"]);
		expect(changelogTargets(aggregate)).toEqual([]);
	});

	it("selects a See reference over a bare Simple reference in the same commit", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "See"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#20"]);
		expect(label(aggregate.commits[0]?.lead)).toBe("#20");
		expect(aggregate.commits[0]?.demoted.map(label)).toEqual(["#10"]);
		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual(["#20"]);
	});

	it("keeps the demoted Simple tier out of changelog lookup targets so failure cannot promote it", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "Simple"),
				],
			},
		]);

		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual(["#10"]);
		expect(aggregate.commits[0]?.demoted.map(label)).toEqual(["#20"]);
	});

	it("retains Related references as per-commit diagnostics without making them lookup targets", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "Related"),
				],
			},
		]);

		expect(aggregate.commits[0]?.related.map(label)).toEqual(["#20"]);

		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual(["#10"]);
	});

	it("makes the lead display-only while every equal-rank candidate still becomes a lookup target", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "Qualified"),
				],
			},
		]);

		expect(label(aggregate.commits[0]?.lead)).toBe("#10");
		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#10", "#20"]);

		expect(changelogTargets(aggregate).map((target) => target.id)).toEqual([
			"#10",
			"#20",
		]);
	});
});

describe("aggregated Ticket References (Credit References and lookup purposes)", () => {
	it("keeps a PullRequest reference a Credit Reference when a Qualified candidate wins the commit", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#10"]);
		expect(aggregate.commits[0]?.credits.map(label)).toEqual(["#20"]);

		expect(aggregate.targets).toEqual([
			{ target: { id: "#10" }, changelog: true, credit: false },
			{ target: { id: "#20" }, changelog: false, credit: true },
		]);
	});

	it("gives a PullRequest reference combined purpose when it is also the winning candidate", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Simple"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		expect(aggregate.commits[0]?.candidates.map(label)).toEqual(["#20"]);
		expect(aggregate.commits[0]?.credits.map(label)).toEqual(["#20"]);
		expect(aggregate.targets).toEqual([
			{ target: { id: "#20" }, changelog: true, credit: true },
		]);
	});

	it("collects every lookup target with its purpose, deduplicated run-wide", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "PullRequest"),
				],
			},
		]);

		const targets = aggregate.targets;
		expect(targets.map((t) => [t.target.id, t.changelog, t.credit])).toEqual([
			["#10", true, false],
			["#20", false, true],
		]);
	});

	it("never gives a Related or demoted reference a lookup purpose", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("aaa"),
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#20", "Simple"),
					referenceOccurrence("#30", "Related"),
				],
			},
		]);

		expect(aggregate.targets.map((t) => t.target.id)).toEqual(["#10"]);
	});

	it("retains the oldest occurrence as provenance for a credit-only target", () => {
		const aggregate = aggregateOf([
			{
				commit: commit("old", "Oldest credit sighting"),
				occurrences: [referenceOccurrence("#7", "PullRequest")],
			},
			{
				commit: commit("new", "Later credit sighting"),
				occurrences: [referenceOccurrence("#7", "PullRequest")],
			},
		]);

		const [target] = aggregate.targets;
		const provenance = aggregate.provenance.get(targetKey(target!.target));
		expect(provenance?.sha).toBe("old");
		expect(provenance?.summary).toBe("Oldest credit sighting");
	});
});
