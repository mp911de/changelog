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

import type { RefKind } from "../src/git.js";
import type { RunProgressEvent } from "../src/progress.js";
import type {
	BlockHandle,
	Cell,
	HeaderFields,
	Renderer,
	Row,
	StepSummary,
} from "../src/render.js";
import { resolveTicketReferences } from "../src/resolved-references.js";
import {
	collectTicketReferences,
	type CommitReferences,
	referenceOccurrence,
} from "../src/ticket-references.js";
import {
	createDebugView,
	createRunView,
	finalLine,
	headerFields,
	type RunViewOptions,
} from "../src/view.js";

const repo = { owner: "octo", repo: "widgets" };

function text(cells: readonly Cell[]): string {
	return cells.map((cell) => cell.text).join("");
}

describe("finalLine", () => {
	it("links the output path", () => {
		const cells = finalLine("release-notes.md", "file:///x");
		expect(text(cells)).toBe("Created release-notes.md");
		expect(cells.find((cell) => cell.text === "release-notes.md")?.link).toBe(
			"file:///x",
		);
	});
});

describe("headerFields", () => {
	const sdc = { owner: "spring-projects", repo: "spring-data-commons" };
	const base = {
		repo: sdc,
		version: "0.1.0",
		from: "4.0.0",
		to: "HEAD",
		fromKind: "tag" as RefKind,
		toKind: "head" as RefKind,
		fromSha: "",
		toSha: "a".repeat(40),
		output: "release-notes.md",
		outputUrl: "file:///x",
	};
	const prefix = "https://github.com/spring-projects/spring-data-commons";

	it("links a tag from, the head commit for a HEAD to, and the resolved range sha", () => {
		const { range } = headerFields(base);
		expect(range[0]?.link).toBe(`${prefix}/releases/tag/4.0.0`);
		expect(range[2]?.link).toBe(`${prefix}/commit/${"a".repeat(40)}`);
		expect(range[4]?.text).toBe("a".repeat(7));
		expect(range[4]?.link).toBe(`${prefix}/commit/${"a".repeat(40)}`);
		expect(text(range)).toBe(`4.0.0..HEAD (${"a".repeat(7)})`);
	});

	it("links each revision by its git-resolved kind, not its spelling", () => {
		const linkFor = (ref: string, kind: RefKind, sha = "") =>
			headerFields({
				...base,
				from: ref,
				fromKind: kind,
				fromSha: sha,
			}).range[0]?.link;
		// A tag named like a branch still links to its release page, and a branch that does not
		// end in .x still links to its tree: the kind comes from git, not the name.
		expect(linkFor("7.0.x", "tag")).toBe(`${prefix}/releases/tag/7.0.x`);
		expect(linkFor("release/7.0", "branch")).toBe(`${prefix}/tree/release/7.0`);
		expect(linkFor("main", "branch")).toBe(`${prefix}/tree/main`);
		expect(linkFor("282f9c3", "commit")).toBe(`${prefix}/commit/282f9c3`);
		expect(linkFor("HEAD", "head", "b".repeat(40))).toBe(
			`${prefix}/commit/${"b".repeat(40)}`,
		);
	});

	it("exposes the short repo name, links the repository home, and links the output", () => {
		const fields = headerFields(base);
		expect(fields.repoName).toBe("spring-data-commons");
		expect(fields.repoUrl).toBe(
			"https://github.com/spring-projects/spring-data-commons",
		);
		expect(fields.repository[0]?.text).toBe("spring-projects/spring-data-commons");
		expect(fields.repository[0]?.link).toBe(
			"https://github.com/spring-projects/spring-data-commons",
		);
		expect(fields.output[0]?.link).toBe("file:///x");
	});
});

interface RecordedBlock {
	label: string;
	debug: string[];
	summary?: StepSummary;
	failure?: string;
	discarded?: boolean;
}

function mockRenderer(): { blocks: RecordedBlock[] } & Renderer {
	const blocks: RecordedBlock[] = [];
	return {
		blocks,
		start(label: string): BlockHandle {
			const block: RecordedBlock = { label, debug: [] };
			blocks.push(block);
			return {
				debug: (line) => block.debug.push(line),
				succeed: (summary) => {
					block.summary = summary;
				},
				fail: (title) => {
					block.failure = title;
				},
				discard: () => {
					block.discarded = true;
				},
			};
		},
		headerBox: (_fields: HeaderFields) => undefined,
		line: (_cells: readonly Cell[]) => undefined,
		success: (_cells: readonly Cell[]) => undefined,
		blank: () => undefined,
		dispose: () => undefined,
	};
}

function summaryText(summary: StepSummary | undefined): {
	title: string;
	notes: string[];
	rows: string[];
	flow: string[];
} {
	const rowText = (rows: readonly Row[] = []): string[] =>
		rows.map((row) => row.cells.map((cell) => cell.text).join(" "));
	return {
		title: text(summary?.title ?? []),
		notes: (summary?.notes ?? []).map((note) => text(note)),
		rows: rowText(summary?.rows),
		flow: (summary?.flow ?? []).map((cell) => cell.text),
	};
}

function commits(entries: readonly CommitReferences[]) {
	return collectTicketReferences(entries).aggregate();
}

describe("createRunView", () => {
	const aggregate = commits([
		{
			commit: { sha: "a".repeat(40), author: "Ada", summary: "#101 Add widgets" },
			occurrences: [referenceOccurrence("#101", "Simple")],
		},
		{
			commit: { sha: "b".repeat(40), author: "Bo", summary: "Bump build" },
			occurrences: [],
		},
	]);
	const resolved = resolveTicketReferences(aggregate, {
		facts: new Map([
			[
				"#101",
				{
					title: "Add widgets",
					htmlUrl: "https://example.test/101",
					labels: ["enhancement"],
					pullRequest: false,
					author: "ada",
				},
			],
		]),
		notFoundTargets: [],
		cached: 1,
		fetched: 0,
	});

	function run(
		events: RunProgressEvent[],
		options: RunViewOptions = {
			repo,
			commitDetail: "none",
			showLookupOutcomes: false,
		},
	) {
		const renderer = mockRenderer();
		const view = createRunView(renderer, options);
		for (const event of events) {
			view.emit(event);
		}
		return renderer;
	}

	it("hides stage-bound debug traces unless the view is in debug mode", () => {
		const events: RunProgressEvent[] = [
			{ type: "stage-start", stage: "Scanning" },
			{ type: "stage-debug", stage: "Scanning", line: "git log 4.0.0..4.0.4" },
			{ type: "scanning-complete", stage: "Scanning", commits: 2, aggregate },
		];

		expect(run(events).blocks[0]?.debug).toEqual([]);

		const debugView = run(events, {
			repo,
			commitDetail: "none",
			showLookupOutcomes: false,
			debug: true,
		});
		expect(debugView.blocks[0]?.debug).toEqual(["git log 4.0.0..4.0.4"]);
	});

	it("renders Scanned facts without commit rows by default", () => {
		const renderer = run([
			{ type: "stage-start", stage: "Scanning" },
			{ type: "scanning-complete", stage: "Scanning", commits: 2, aggregate },
		]);
		const scanned = summaryText(renderer.blocks[0]?.summary);
		expect(renderer.blocks[0]?.label).toBe("Scanning");
		expect(scanned.title).toBe("Scanned 2 commits");
		expect(scanned.notes).toEqual([
			"1 unique ticket reference",
			"1 without ticket reference (re-run with --show-missing)",
		]);
		expect(renderer.blocks[0]?.summary?.commitRows).toBeUndefined();
	});

	it("pluralizes each block title and marks its count as accent", () => {
		const single = commits([
			{
				commit: { sha: "a".repeat(40), author: "Ada", summary: "#101 One" },
				occurrences: [referenceOccurrence("#101", "Simple")],
			},
		]);
		const scanned = run([
			{ type: "stage-start", stage: "Scanning" },
			{
				type: "scanning-complete",
				stage: "Scanning",
				commits: 1,
				aggregate: single,
			},
		]).blocks[0]?.summary;
		expect(text(scanned?.title ?? [])).toBe("Scanned 1 commit");
		// The count, not the surrounding words, carries the accent intent.
		expect(scanned?.title.find((cell) => cell.text === "1")?.style).toBe("accent");

		const documented = (entries: number) =>
			run([
				{ type: "stage-start", stage: "Generating" },
				{
					type: "generating-complete",
					stage: "Generating",
					summary: {
						documentedEntries: entries,
						sectionCounts: new Map(),
						contributorCount: 0,
					},
				},
			]).blocks[0]?.summary;
		expect(text(documented(1)?.title ?? [])).toBe("Documented 1 entry");
		expect(text(documented(2)?.title ?? [])).toBe("Documented 2 entries");
		expect(documented(2)?.title.find((cell) => cell.text === "2")?.style).toBe(
			"accent",
		);

		const lookedUp = run([
			{ type: "stage-start", stage: "Looking up" },
			{ type: "looking-up-complete", stage: "Looking up", resolved },
		]).blocks[0]?.summary;
		expect(text(lookedUp?.title ?? [])).toBe("Looked up 1 ticket");
		expect(lookedUp?.title.find((cell) => cell.text === "1")?.style).toBe("accent");
	});

	it("lists unique targets then pull requests then ticketless last, omitting zero categories", () => {
		// Two distinct targets, one of them a pull-request credit, plus a ticketless commit, so all
		// three Scanned fact lines appear with no raw occurrence count.
		const mixed = commits([
			{
				commit: { sha: "a".repeat(40), author: "Ada", summary: "Closes #1" },
				occurrences: [referenceOccurrence("#1", "Qualified")],
			},
			{
				commit: { sha: "b".repeat(40), author: "Bo", summary: "Merge #2" },
				occurrences: [referenceOccurrence("#2", "PullRequest")],
			},
			{
				commit: { sha: "c".repeat(40), author: "Cy", summary: "Bump build" },
				occurrences: [],
			},
		]);
		const scanned = run([
			{ type: "stage-start", stage: "Scanning" },
			{
				type: "scanning-complete",
				stage: "Scanning",
				commits: 3,
				aggregate: mixed,
			},
		]).blocks[0]?.summary;
		const notes = summaryText(scanned).notes;
		expect(notes).toEqual([
			"2 unique ticket references",
			"1 pull request reference",
			"1 without ticket reference (re-run with --show-missing)",
		]);
		// The ticketless count is the attention accent; nothing reports a raw occurrence total.
		expect(scanned?.notes?.at(-1)?.[0]?.style).toBe("warning");
	});

	it("lists only missing commits with a warning sha for the missing commit detail", () => {
		const renderer = run(
			[
				{ type: "stage-start", stage: "Scanning" },
				{ type: "scanning-complete", stage: "Scanning", commits: 2, aggregate },
			],
			{ repo, commitDetail: "missing", showLookupOutcomes: false },
		);
		const rows = renderer.blocks[0]?.summary?.commitRows ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.sha.text).toBe("b".repeat(7));
		expect(rows[0]?.sha.style).toBe("warning");
	});

	it("lists every commit for the all commit detail", () => {
		const renderer = run(
			[
				{ type: "stage-start", stage: "Scanning" },
				{ type: "scanning-complete", stage: "Scanning", commits: 2, aggregate },
			],
			{ repo, commitDetail: "all", showLookupOutcomes: false },
		);
		expect(renderer.blocks[0]?.summary?.commitRows).toHaveLength(2);
	});

	// The newest commit is listed first, so commitRows[0] is the last commit supplied to the aggregate.
	function newestCommitRow(aggregate: ReturnType<typeof commits>) {
		return run(
			[
				{ type: "stage-start", stage: "Scanning" },
				{ type: "scanning-complete", stage: "Scanning", commits: 1, aggregate },
			],
			{
				repo,
				commitDetail: "all",
				showLookupOutcomes: false,
			},
		).blocks[0]?.summary?.commitRows?.[0];
	}

	it("marks a referenced commit's sha as accent and emits the lead as a complete atomic reference", () => {
		const referenced = commits([
			{
				commit: { sha: "b".repeat(40), author: "Ada", summary: "Add widgets" },
				occurrences: [referenceOccurrence("#101", "Qualified")],
			},
		]);
		const row = newestCommitRow(referenced);
		expect(row?.sha.style).toBe("accent");
		expect(row?.sha.link).toBe(
			`https://github.com/octo/widgets/commit/${"b".repeat(40)}`,
		);
		expect(row?.summary).toBe("Add widgets");
		expect(row?.lead?.text).toBe("#101");
		expect(row?.lead?.emphasis).toBe("lead");
		expect(row?.lead?.link).toBe("https://github.com/octo/widgets/issues/101");
		expect(row?.references).toEqual([]);
	});

	it("never substring-truncates a cross-repository lead reference", () => {
		const crossRepo = commits([
			{
				commit: { sha: "c".repeat(40), author: "Ed", summary: "Bump build" },
				occurrences: [
					referenceOccurrence("#1234", "Qualified", {
						owner: "spring-projects",
						repo: "spring-data-build",
					}),
				],
			},
		]);
		const row = newestCommitRow(crossRepo);
		expect(row?.lead?.text).toBe("spring-projects/spring-data-build#1234");
		expect(row?.lead?.link).toBe(
			"https://github.com/spring-projects/spring-data-build/issues/1234",
		);
	});

	it("maps reference roles to the five emphasis levels in display-priority then textual order", () => {
		// #10/#11 Qualified are the top tier (lead then candidate); #20 PullRequest is a credit; #30
		// See is a demoted weaker candidate tier; #40/#41 Related are diagnostic context.
		const roles = commits([
			{
				commit: { sha: "e".repeat(40), author: "Mo", summary: "Wire it up" },
				occurrences: [
					referenceOccurrence("#10", "Qualified"),
					referenceOccurrence("#11", "Qualified"),
					referenceOccurrence("#20", "PullRequest"),
					referenceOccurrence("#30", "See"),
					referenceOccurrence("#40", "Related"),
					referenceOccurrence("#41", "Related"),
				],
			},
		]);
		const row = newestCommitRow(roles);
		expect(row?.lead?.text).toBe("#10");
		expect(row?.lead?.emphasis).toBe("lead");
		expect(row?.references.map((item) => [item.text, item.emphasis])).toEqual([
			["#11", "candidate"],
			["#20", "credit"],
			["#30", "demoted"],
			["#40", "related"],
			["#41", "related"],
		]);
	});

	it("displays a Ticket Target once even when it is both a Changelog Candidate and a Credit", () => {
		// #3461 is both the lead candidate (Qualified) and a pull-request credit; it must not repeat.
		const both = commits([
			{
				commit: {
					sha: "f".repeat(40),
					author: "Mark Paluch",
					summary: "Simplify code and tests.",
				},
				occurrences: [
					referenceOccurrence("#3461", "Qualified"),
					referenceOccurrence("#3461", "PullRequest"),
					referenceOccurrence("#3459", "Related"),
				],
			},
		]);
		const row = newestCommitRow(both);
		expect(row?.lead?.text).toBe("#3461");
		expect(row?.lead?.emphasis).toBe("lead");
		expect(row?.references.map((item) => [item.text, item.emphasis])).toEqual([
			["#3459", "related"],
		]);
	});

	it("lists cache provenance with an accent count, omitting a zero count", () => {
		const fetchedOnly = resolveTicketReferences(aggregate, {
			facts: new Map([
				[
					"#101",
					{
						title: "Add widgets",
						htmlUrl: "https://example.test/101",
						labels: [],
						pullRequest: false,
						author: "ada",
					},
				],
			]),
			notFoundTargets: [],
			cached: 0,
			fetched: 3,
		});
		const summary = run([
			{ type: "stage-start", stage: "Looking up" },
			{ type: "looking-up-complete", stage: "Looking up", resolved: fetchedOnly },
		]).blocks[0]?.summary;
		// The cached line is omitted at zero; the count is accent and its label is faint.
		expect(summaryText(summary).notes).toEqual(["3 fetched"]);
		expect(summary?.notes?.[0]?.[0]?.style).toBe("accent");
		expect(summary?.notes?.[0]?.[1]?.style).toBe("faint");
	});

	it("renders the Looked up block with cache provenance", () => {
		const renderer = run([
			{ type: "stage-start", stage: "Looking up" },
			{ type: "looking-up-complete", stage: "Looking up", resolved },
		]);
		const lookedUp = summaryText(renderer.blocks[0]?.summary);
		expect(lookedUp.title).toBe("Looked up 1 ticket");
		expect(lookedUp.notes).toEqual(["1 cached"]);
	});

	it("reports followReferences-excluded targets with a warning count and an accent listing on show-all", () => {
		const withExcluded = commits([
			{
				commit: { sha: "c".repeat(40), author: "Cy", summary: "Closes #1" },
				occurrences: [
					referenceOccurrence("#1", "Qualified"),
					referenceOccurrence("#9", "Qualified", {
						owner: "forbidden",
						repo: "repo",
					}),
				],
			},
		]);
		const resolvedExcluded = resolveTicketReferences(
			withExcluded,
			{
				facts: new Map([
					[
						"#1",
						{
							title: "Local",
							htmlUrl: "https://h/1",
							labels: [],
							pullRequest: false,
							author: "ada",
						},
					],
				]),
				notFoundTargets: [],
				cached: 1,
				fetched: 0,
			},
			[{ id: "#9", repository: { owner: "forbidden", repo: "repo" } }],
		);
		const events: RunProgressEvent[] = [
			{ type: "stage-start", stage: "Looking up" },
			{
				type: "looking-up-complete",
				stage: "Looking up",
				resolved: resolvedExcluded,
			},
		];

		// show-all: a warning count, with the excluded references listed as accent like the
		// looked-up ones. The excluded target is outside the looked-up title count.
		const verbose = run(events, {
			repo,
			commitDetail: "all",
			showLookupOutcomes: true,
		}).blocks[0]?.summary;
		expect(text(verbose?.title ?? [])).toBe("Looked up 1 ticket");
		expect(text(verbose?.excluded?.label ?? [])).toBe("1 excluded");
		expect(verbose?.excluded?.label[0]?.style).toBe("warning");
		expect((verbose?.excluded?.flow ?? []).map((cell) => cell.text)).toEqual([
			"forbidden/repo#9",
		]);
		expect(verbose?.excluded?.flow?.[0]?.style).toBe("accent");

		// Without show-all the count still appears, but the references are not listed.
		const plain = run(events).blocks[0]?.summary;
		expect(text(plain?.excluded?.label ?? [])).toBe("1 excluded");
		expect(plain?.excluded?.flow).toBeUndefined();
	});

	it("counts every looked-up target in the title, including credit-only pull requests", () => {
		const withCredit = commits([
			{
				commit: { sha: "c".repeat(40), author: "Cy", summary: "Closes #1" },
				occurrences: [
					referenceOccurrence("#1", "Qualified"),
					referenceOccurrence("#2", "PullRequest"),
				],
			},
		]);
		const resolvedWithCredit = resolveTicketReferences(withCredit, {
			facts: new Map([
				[
					"#1",
					{
						title: "Fix",
						htmlUrl: "https://h/1",
						labels: [],
						pullRequest: false,
						author: "ada",
					},
				],
				[
					"#2",
					{
						title: "PR",
						htmlUrl: "https://h/2",
						labels: [],
						pullRequest: true,
						author: "bo",
					},
				],
			]),
			notFoundTargets: [],
			cached: 2,
			fetched: 0,
		});
		const renderer = run(
			[
				{ type: "stage-start", stage: "Looking up" },
				{
					type: "looking-up-complete",
					stage: "Looking up",
					resolved: resolvedWithCredit,
				},
			],
			{ repo, commitDetail: "all", showLookupOutcomes: true },
		);
		const lookedUp = summaryText(renderer.blocks[0]?.summary);
		expect(resolvedWithCredit.entries).toHaveLength(1);
		expect(lookedUp.title).toBe("Looked up 2 tickets");
		expect(lookedUp.notes).toEqual(["2 cached"]);

		expect([...(lookedUp.flow ?? [])].sort()).toEqual(["#1", "#2"]);
	});

	it("lists every lookup outcome as an atomic flow when showing lookup outcomes", () => {
		const failing = commits([
			{
				commit: {
					sha: "c".repeat(40),
					author: "Cy",
					summary: "Closes #101 and #404",
				},
				occurrences: [
					referenceOccurrence("#101", "Qualified"),
					referenceOccurrence("#404", "Qualified"),
				],
			},
		]);
		const failingResolved = resolveTicketReferences(failing, {
			facts: new Map([
				[
					"#101",
					{
						title: "Add widgets",
						htmlUrl: "https://example.test/101",
						labels: [],
						pullRequest: false,
						author: "ada",
					},
				],
			]),
			notFoundTargets: [{ id: "#404" }],
			cached: 0,
			fetched: 1,
		});
		const renderer = run(
			[
				{ type: "stage-start", stage: "Looking up" },
				{
					type: "looking-up-complete",
					stage: "Looking up",
					resolved: failingResolved,
				},
			],
			{ repo, commitDetail: "all", showLookupOutcomes: true },
		);
		const summary = renderer.blocks[0]?.summary;

		expect(summaryText(summary).flow).toEqual(["#101", "#404"]);
		const found = summary?.flow?.find((cell) => cell.text === "#101");
		const notFound = summary?.flow?.find((cell) => cell.text === "#404");
		expect(found?.style).toBe("accent");
		expect(notFound?.style).toBe("warning");
		expect(found?.link).toBe("https://github.com/octo/widgets/issues/101");

		// The not-found row links the originating commit sha as accent, marks the reference as
		// warning and links it to the ticket page, and renders the commit summary faint.
		expect(summaryText(summary).rows).toEqual([
			`${"c".repeat(7)} #404 Closes #101 and #404`,
		]);
		const notFoundRow = summary?.rows?.[0];
		expect(notFoundRow?.cells[0]?.style).toBe("accent");
		expect(notFoundRow?.cells[0]?.link).toBe(
			`https://github.com/octo/widgets/commit/${"c".repeat(40)}`,
		);
		expect(notFoundRow?.cells[1]?.text).toBe("#404");
		expect(notFoundRow?.cells[1]?.style).toBe("warning");
		expect(notFoundRow?.cells[1]?.link).toBe(
			"https://github.com/octo/widgets/issues/404",
		);
		expect(notFoundRow?.cells[2]?.style).toBe("faint");
	});

	it("renders the Generated ledger with distinct candidate and credit-only failures", () => {
		const failing = commits([
			{
				commit: { sha: "c".repeat(40), author: "Cy", summary: "Backport" },
				occurrences: [
					referenceOccurrence("#404", "Qualified"),
					referenceOccurrence("#500", "PullRequest"),
				],
			},
		]);
		const failingResolved = resolveTicketReferences(failing, {
			facts: new Map(),
			notFoundTargets: failing.targets().map((purposed) => purposed.target),
			cached: 0,
			fetched: 0,
		});
		const renderer = run([
			{ type: "stage-start", stage: "Scanning" },
			{
				type: "scanning-complete",
				stage: "Scanning",
				commits: 1,
				aggregate: failing,
			},
			{ type: "stage-start", stage: "Looking up" },
			{
				type: "looking-up-complete",
				stage: "Looking up",
				resolved: failingResolved,
			},
			{ type: "stage-start", stage: "Generating" },
			{
				type: "generating-complete",
				stage: "Generating",
				summary: {
					documentedEntries: 0,
					sectionCounts: new Map(),
					contributorCount: 0,
				},
			},
		]);
		const generated = summaryText(renderer.blocks[2]?.summary);
		expect(generated.title).toBe("Documented 0 entries");
		expect(generated.rows).toContain("tickets not found 1");
		expect(generated.rows).toContain("credit-only tickets not found 1");
	});

	it("shows the Preparing success line only in debug mode, discarding it otherwise", () => {
		const events: RunProgressEvent[] = [
			{ type: "stage-start", stage: "Preparing" },
			{ type: "preparing-complete", stage: "Preparing" },
		];

		const plain = run(events);
		expect(plain.blocks[0]?.summary).toBeUndefined();
		expect(plain.blocks[0]?.discarded).toBe(true);

		const debugView = run(events, {
			repo,
			commitDetail: "none",
			showLookupOutcomes: false,
			debug: true,
		});
		expect(text(debugView.blocks[0]?.summary?.title ?? [])).toBe("Prepared context");
		expect(debugView.blocks[0]?.discarded).toBeUndefined();
	});

	it("renders a stage failure as a failed block", () => {
		const renderer = run([
			{ type: "stage-start", stage: "Looking up" },
			{ type: "stage-failed", stage: "Looking up" },
		]);
		expect(renderer.blocks[0]?.failure).toBe("Looking up failed");
		expect(renderer.blocks[0]?.summary).toBeUndefined();
	});

	it("files stage-bound debug lines under the stage block in debug mode", () => {
		const renderer = run(
			[
				{ type: "stage-start", stage: "Scanning" },
				{ type: "stage-debug", stage: "Scanning", line: "git log a..b" },
				{ type: "scanning-complete", stage: "Scanning", commits: 2, aggregate },
			],
			{ repo, commitDetail: "none", showLookupOutcomes: false, debug: true },
		);
		expect(renderer.blocks[0]?.debug).toEqual(["git log a..b"]);
	});
});

describe("createDebugView", () => {
	it("writes only stage-bound debug lines, with no chrome", () => {
		const lines: string[] = [];
		const view = createDebugView((line) => lines.push(line));
		view.emit({ type: "stage-start", stage: "Scanning" });
		view.emit({ type: "stage-debug", stage: "Scanning", line: "git log a..b" });
		view.emit({
			type: "scanning-complete",
			stage: "Scanning",
			commits: 1,
			aggregate: commits([]),
		});
		view.emit({
			type: "stage-debug",
			stage: "Looking up",
			line: "GET /repos/o/r/issues/1 → 200",
		});
		expect(lines).toEqual(["git log a..b", "GET /repos/o/r/issues/1 → 200"]);
	});
});
