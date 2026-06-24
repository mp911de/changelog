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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChangelogConfig } from "../src/config.js";
import type { ResolvedTicket } from "../src/lookup.js";
import { runPipeline } from "../src/pipeline.js";
import type { RunProgress, RunProgressEvent } from "../src/progress.js";
import { type LookupTarget, targetKey } from "../src/ticket-references.js";
import { FixtureRepo } from "./fixture-repo.js";

function recordingProgress(): { events: RunProgressEvent[] } & RunProgress {
	const events: RunProgressEvent[] = [];
	return {
		events,
		emit(event) {
			events.push(event);
		},
	};
}

function mockLookup(tickets: Record<string, ResolvedTicket>) {
	return async (targets: readonly LookupTarget[]) => {
		const facts = new Map<string, ResolvedTicket>();
		const notFoundTargets = [];
		for (const { target } of targets) {
			const key = targetKey(target);
			const ticket = tickets[key] ?? tickets[target.id];
			if (ticket) {
				facts.set(key, ticket);
			} else {
				notFoundTargets.push(target);
			}
		}
		return { facts, notFoundTargets, cached: 0, fetched: facts.size };
	};
}

const config: ChangelogConfig = {
	sections: [
		{ title: ":star: New Features", labels: ["enhancement"], summary: "features" },
		{
			title: ":lady_beetle: Bug Fixes",
			labels: ["bug", "regression"],
			summary: "bugs",
		},
	],
	excludeLabels: ["type: task"],
	team: ["octocat"],
};

function ticket(id: string, title: string, labels: readonly string[]): ResolvedTicket {
	return {
		title,
		htmlUrl: `https://example.test/${id.replace("#", "")}`,
		labels,
		pullRequest: false,
		author: "octocat",
	};
}

describe("runPipeline", () => {
	let repo: FixtureRepo;

	beforeEach(() => {
		repo = FixtureRepo.create();
	});

	afterEach(() => {
		repo.cleanup();
	});

	it("returns only the Changelog Document", async () => {
		const from = repo.commit("Initial commit");
		repo.commit("#101 Add widgets");
		repo.commit("#102 Fix gadget");
		repo.commit("#404 Vanished issue");
		repo.commit("Chore: no reference here");

		const document = await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			lookup: mockLookup({
				"#101": ticket("#101", "Add widgets", ["enhancement"]),
				"#102": ticket("#102", "Fix gadget", ["bug"]),
			}),
		});

		expect(document).toBe(
			"## :star: New Features\n" +
				"- Add widgets. [#101](https://example.test/101)\n" +
				"\n" +
				"## :lady_beetle: Bug Fixes\n" +
				"- Fix gadget. [#102](https://example.test/102)\n",
		);
	});

	it("keeps tickets with the same id in different repositories distinct", async () => {
		const from = repo.commit("Initial commit");
		repo.commit("#1 Local change");
		repo.commit("Cross-repository change\n\nCloses acme/gizmos#1");

		const document = await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			lookup: mockLookup({
				"#1": ticket("#1", "Local change", ["enhancement"]),
				"acme/gizmos#1": ticket("#1", "Cross-repository change", ["enhancement"]),
			}),
		});

		expect(document).toContain("Local change. [#1](https://example.test/1)");
		expect(document).toContain(
			"Cross-repository change. [acme/gizmos#1](https://example.test/1)",
		);
	});

	it("does not look up a cross-repository reference outside followReferences", async () => {
		const from = repo.commit("base");
		repo.commit("Local change\n\nCloses #1");
		repo.commit("Allowed cross-repo\n\nCloses octo/extras#5");
		repo.commit("Forbidden cross-repo\n\nCloses forbidden/repo#9");

		const known: Record<string, ResolvedTicket> = {
			"#1": ticket("#1", "Local change", ["enhancement"]),
			"octo/extras#5": ticket("#5", "Allowed cross repo", ["enhancement"]),
			"forbidden/repo#9": ticket("#9", "Forbidden cross repo", ["enhancement"]),
		};
		const looked: string[] = [];
		const lookup = async (targets: readonly LookupTarget[]) => {
			const facts = new Map<string, ResolvedTicket>();
			const notFoundTargets = [];
			for (const { target } of targets) {
				const key = targetKey(target);
				looked.push(key);
				if (known[key]) {
					facts.set(key, known[key]);
				} else {
					notFoundTargets.push(target);
				}
			}
			return { facts, notFoundTargets, cached: 0, fetched: facts.size };
		};

		const progress = recordingProgress();
		const document = await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config: { ...config, followReferences: ["octo/*"] },
			all: false,
			progress,
			lookup,
		});

		// The forbidden cross-repository reference never reaches lookup, while same-org and current
		// references do.
		expect(looked).toContain("#1");
		expect(looked).toContain("octo/extras#5");
		expect(looked).not.toContain("forbidden/repo#9");

		// It is reported as excluded (not a not-found candidate) and contributes no entry.
		const event = progress.events.find(
			(candidate) => candidate.type === "looking-up-complete",
		);
		const resolved =
			event?.type === "looking-up-complete" ? event.resolved : undefined;
		expect(resolved?.excluded.map((target) => targetKey(target))).toEqual([
			"forbidden/repo#9",
		]);
		expect(resolved?.candidateNotFound).toEqual([]);
		expect(document).toContain("Allowed cross repo. [octo/extras#5]");
		expect(document).not.toContain("Forbidden cross repo");
	});

	it("emits the three visible stages in order and proves there is no Parsing stage", async () => {
		const from = repo.commit("Initial commit");
		repo.commit("#101 Add widgets");
		repo.commit("#102 Fix gadget");
		repo.commit("#404 Vanished issue");

		const progress = recordingProgress();
		await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: mockLookup({
				"#101": ticket("#101", "Add widgets", ["enhancement"]),
				"#102": ticket("#102", "Fix gadget", ["bug"]),
			}),
		});

		const starts = progress.events
			.filter((event) => event.type === "stage-start")
			.map((event) => event.stage);
		expect(starts).toEqual(["Scanning", "Looking up", "Generating"]);
		expect(starts).not.toContain("Parsing");
	});

	it("carries Aggregated, Resolved, and the generation summary on the completion events", async () => {
		const from = repo.commit("Initial commit");
		repo.commit("#101 Add widgets");
		repo.commit("#102 Fix gadget");
		repo.commit("#404 Vanished issue");

		const progress = recordingProgress();
		await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: mockLookup({
				"#101": ticket("#101", "Add widgets", ["enhancement"]),
				"#102": ticket("#102", "Fix gadget", ["bug"]),
			}),
		});

		const scanning = progress.events.find(
			(event) => event.type === "scanning-complete",
		);
		expect(scanning).toMatchObject({ commits: 3 });
		expect(
			scanning?.type === "scanning-complete" &&
				scanning.aggregate.targets
					.filter((flagged) => flagged.changelog)
					.map((flagged) => flagged.target.id),
		).toEqual(["#101", "#102", "#404"]);

		const lookedUp = progress.events.find(
			(event) => event.type === "looking-up-complete",
		);
		expect(
			lookedUp?.type === "looking-up-complete" && lookedUp.resolved.entries.length,
		).toBe(2);

		const generating = progress.events.find(
			(event) => event.type === "generating-complete",
		);
		expect(
			generating?.type === "generating-complete" &&
				generating.summary.documentedEntries,
		).toBe(2);
	});

	it("reports candidate and credit-only not-found failures separately", async () => {
		const from = repo.commit("base");

		repo.commit("Backport\n\nCloses #404\n\nOriginal pull request: #500");

		const progress = recordingProgress();
		await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: mockLookup({}),
		});

		const lookedUp = progress.events.find(
			(event) => event.type === "looking-up-complete",
		);
		if (lookedUp?.type !== "looking-up-complete") {
			throw new Error("missing looking-up-complete event");
		}
		expect(
			lookedUp.resolved.candidateNotFound.map((failure) => failure.target.id),
		).toEqual(["#404"]);
		expect(
			lookedUp.resolved.creditNotFound.map((failure) => failure.target.id),
		).toEqual(["#500"]);
	});

	it("does not promote a demoted lower tier when the selected candidate fails to resolve", async () => {
		const from = repo.commit("base");

		repo.commit("Work\n\nCloses #404\n\nSee also #99");

		const progress = recordingProgress();
		const document = await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: mockLookup({
				"#99": ticket("#99", "Demoted should not appear", ["enhancement"]),
			}),
		});

		expect(document).toBe("");
		const lookedUp = progress.events.find(
			(event) => event.type === "looking-up-complete",
		);
		expect(
			lookedUp?.type === "looking-up-complete" && lookedUp.resolved.entries,
		).toEqual([]);
	});

	it("documents only rendered entries, not excluded ones that were still looked up", async () => {
		const from = repo.commit("Initial commit");
		repo.commit("#101 Add widgets");
		repo.commit("#102 Housekeeping");

		const progress = recordingProgress();
		await runPipeline({
			from,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: mockLookup({
				"#101": ticket("#101", "Add widgets", ["enhancement"]),
				"#102": ticket("#102", "Housekeeping", ["type: task"]),
			}),
		});

		const lookedUp = progress.events.find(
			(event) => event.type === "looking-up-complete",
		);
		expect(
			lookedUp?.type === "looking-up-complete" && lookedUp.resolved.entries.length,
		).toBe(2);
		const generating = progress.events.find(
			(event) => event.type === "generating-complete",
		);
		expect(
			generating?.type === "generating-complete" &&
				generating.summary.documentedEntries,
		).toBe(1);
	});

	it("fails the active stage when scanning fails", async () => {
		repo.commit("Initial commit");
		const progress = recordingProgress();

		await expect(
			runPipeline({
				from: "missing-from",
				to: "missing-to",
				cwd: repo.dir,
				repository: { owner: "octo", repo: "widgets" },
				config,
				all: false,
				progress,
				lookup: mockLookup({}),
			}),
		).rejects.toThrow();

		const lifecycle = progress.events.filter((event) => event.type !== "stage-debug");
		expect(lifecycle).toEqual([
			{ type: "stage-start", stage: "Scanning" },
			{ type: "stage-failed", stage: "Scanning" },
		]);
	});

	it("files git trace lines under the Scanning stage", async () => {
		const base = repo.commit("base");
		repo.commit("#1 Add things");
		const progress = recordingProgress();

		await runPipeline({
			from: base,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: mockLookup({}),
		});

		const scanningDebug = progress.events.filter(
			(event) => event.type === "stage-debug" && event.stage === "Scanning",
		);
		expect(
			scanningDebug.some(
				(event) =>
					event.type === "stage-debug" && event.line.startsWith("git log "),
			),
		).toBe(true);
	});

	it("files GitHub trace lines under the Looking up stage", async () => {
		const base = repo.commit("base");
		repo.commit("#1 Add things");
		const progress = recordingProgress();

		await runPipeline({
			from: base,
			to: "HEAD",
			cwd: repo.dir,
			repository: { owner: "octo", repo: "widgets" },
			config,
			all: false,
			progress,
			lookup: async (targets, debug) => {
				debug?.("GET /repos/o/r/issues/1 → 200");
				return {
					facts: new Map(),
					notFoundTargets: targets.map((purposed) => purposed.target),
					cached: 0,
					fetched: 0,
				};
			},
		});

		const lookingUpDebug = progress.events.filter(
			(event) => event.type === "stage-debug" && event.stage === "Looking up",
		);
		expect(
			lookingUpDebug.some(
				(event) =>
					event.type === "stage-debug" &&
					event.line === "GET /repos/o/r/issues/1 → 200",
			),
		).toBe(true);
	});
});
