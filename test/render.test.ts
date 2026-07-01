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

import type { Capabilities, HeaderFields } from "../src/render.js";
import { createRenderer, formatDuration } from "../src/render.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function stripAnsi(text: string): string {
	return text
		.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "")
		.replace(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, "g"), "");
}

function capture(extra: Record<string, unknown> = {}) {
	let out = "";
	const stream = {
		write: (chunk: string) => {
			out += chunk;
		},
		isTTY: false,
		...extra,
	};
	return { stream, get: () => out };
}

const plain: Capabilities = { level: 0, tty: false, hyperlinks: false };
const truecolor: Capabilities = { level: 3, tty: false, hyperlinks: true };

describe("formatDuration", () => {
	it("uses ms below a second and one-decimal seconds above", () => {
		expect(formatDuration(8)).toBe("8 ms");
		expect(formatDuration(999)).toBe("999 ms");
		expect(formatDuration(1000)).toBe("1.0 s");
		expect(formatDuration(4120)).toBe("4.1 s");
	});
});

describe("static reporter", () => {
	it("renders a glyph header with column-aligned detail rows and a trailing blank", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain })
			.start("Scanning commits")
			.succeed({
				title: [
					{ text: "Scanned " },
					{ text: "3", style: "accent" },
					{ text: " commits" },
				],
				rows: [
					{
						cells: [
							{ text: "abc1234" },
							{ text: "Ada" },
							{ text: "Fix flaky retry" },
						],
					},
					{
						cells: [
							{ text: "def5678" },
							{ text: "Bartholomew" },
							{ text: "Bump dependency" },
						],
					},
				],
			});
		const lines = get().split("\n");
		expect(lines[0]).toBe("✔ Scanned 3 commits");
		expect(lines[1]!.startsWith("  └ abc1234")).toBe(true);
		expect(lines[2]!.startsWith("    def5678")).toBe(true);

		expect(lines[1]!.indexOf("Fix flaky retry")).toBe(
			lines[2]!.indexOf("Bump dependency"),
		);

		expect(lines[lines.length - 2]).toBe("");
	});

	it("renders inline notes above a label-first ledger", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain })
			.start("x")
			.succeed({
				title: [{ text: "Generated 33 entries" }],
				notes: [[{ text: "5" }, { text: " cached" }]],
				rows: [
					{ cells: [{ text: "commits" }, { text: "56", align: "right" }] },
					{ cells: [{ text: "bugs" }, { text: "8", align: "right" }] },
				],
			});
		const lines = get().split("\n");
		expect(lines[0]).toBe("✔ Generated 33 entries");
		expect(lines[1]).toBe("  └ 5 cached");
		expect(lines[2]).toBe("    commits  56");
		expect(lines[3]).toBe("    bugs      8");
	});

	it("emits no ANSI and no durations off a TTY", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain })
			.start("x")
			.succeed({ title: [{ text: "done" }] });
		expect(get()).not.toContain(ESC);
		expect(get()).not.toMatch(/\d+ ms|\d+\.\d+ s/);
	});

	it("renders control characters in cell text as inert text", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain }).line([
			{ text: `before${ESC}]52;c;payload${BEL}\nafter` },
		]);

		expect(get()).toBe("before]52;c;payloadafter\n");
		expect(get()).not.toContain(ESC);
		expect(get()).not.toContain(BEL);
	});

	it("realizes accent colors and OSC-8 links at truecolor", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: truecolor })
			.start("x")
			.succeed({
				title: [{ text: "Looked up " }, { text: "61", style: "accent" }],
				rows: [
					{
						cells: [
							{ text: "abc1234", link: "https://h/c" },
							{
								text: "#1",
								style: "warning",
							},
						],
					},
				],
			});
		expect(get()).toContain(`${ESC}[38;2;137;180;250m`);
		expect(get()).toContain(`${ESC}[38;2;237;167;87m`);
		expect(get()).toContain(`${ESC}]8;;https://h/c`);
	});

	it("does not create a hyperlink from a URL containing terminal controls", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: truecolor }).line([
			{ text: "safe", link: `https://example.test/${BEL}${ESC}]52;c;payload` },
		]);

		expect(get()).toBe("safe\n");
		expect(get()).not.toContain("]8;;");
		expect(get()).not.toContain("]52;");
	});

	it("fails a block with a cross and the failure title", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain })
			.start("Scanning commits")
			.fail("Scanning commits failed");
		expect(get().split("\n")[0]).toBe("✖ Scanning commits failed");
	});
});

describe("header box", () => {
	const fields: HeaderFields = {
		repository: {
			owner: "octo",
			repo: "widgets",
			url: "https://github.com/octo/widgets",
		},
		version: "0.1.0",
		build: { sha: "abc1234" },
		repositoryLine: [{ text: "octo/widgets" }],
		range: [{ text: "4.0.0..HEAD" }, { text: " (abc1234)", style: "faint" }],
		output: [{ text: "release-notes.md", link: "file:///repo/release-notes.md" }],
	};

	it("renders plain label: value lines with no box off a TTY", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain }).headerBox(fields);
		expect(get()).not.toContain(ESC);
		expect(get()).not.toContain("╭");
		expect(get()).toContain(">_ widgets › changelog (v0.1.0 · abc1234)");
		expect(get()).toContain("repository: octo/widgets");
		expect(get()).toContain("range: 4.0.0..HEAD (abc1234)");
		expect(get()).toContain("output: release-notes.md");
	});

	it("sanitizes control characters in a plain header", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain }).headerBox({
			...fields,
			repository: {
				...fields.repository,
				repo: `wid${ESC}]52;c;payload${BEL}\ngets`,
			},
			repositoryLine: [{ text: `octo/${ESC}widgets` }],
		});

		expect(get()).not.toContain(ESC);
		expect(get()).not.toContain(BEL);
		expect(get()).toContain(">_ wid]52;c;payloadgets › changelog");
		expect(get()).toContain("repository: octo/widgets");
	});

	it("draws a rounded box of equal visible width in color", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: truecolor }).headerBox(fields);
		const out = get();
		expect(out).toContain("╭");
		expect(out).toContain("╰");
		const rows = stripAnsi(out)
			.split("\n")
			.filter((row) => row.trimEnd().length > 0);
		expect(new Set(rows.map((row) => row.length)).size).toBe(1);
	});
});

describe("commit reference flow", () => {
	function live(columns: number) {
		return capture({ isTTY: true, columns });
	}

	function visibleLines(out: string): string[] {
		return stripAnsi(out)
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""))
			.filter((line) => line.length > 0);
	}

	const noColorTty: Capabilities = { level: 0, tty: true, hyperlinks: false };

	it("renders the lead and additional references as complete atomic values in order", () => {
		const { stream, get } = live(120);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Scanned 1 commit" }],
				commitRows: [
					{
						sha: { text: "abc1234" },
						author: "Ada",
						summary: "Add widgets",
						lead: { text: "#101", emphasis: "lead" },
						references: [
							{ text: "#102", emphasis: "candidate" },
							{ text: "#90", emphasis: "credit" },
						],
					},
				],
			});
		const row = visibleLines(get()).find((line) => line.includes("abc1234"));
		expect(row).toBeDefined();
		expect(row).toContain("abc1234");
		expect(row).toContain("Ada");
		expect(row).toContain("Add widgets");

		expect(row!.indexOf("#101")).toBeLessThan(row!.indexOf("#102"));
		expect(row!.indexOf("#102")).toBeLessThan(row!.indexOf("#90"));
		expect(row).not.toContain("more");
	});

	const fourRefs: import("../src/render.js").CommitRow = {
		sha: { text: "abc1234" },
		author: "Ada",
		summary: "Add widgets",
		lead: { text: "#101", emphasis: "lead" },
		references: [
			{ text: "#102", emphasis: "candidate" },
			{ text: "#103", emphasis: "candidate" },
			{ text: "#104", emphasis: "candidate" },
		],
	};

	function rowAt(
		columns: number,
		commitRows: readonly import("../src/render.js").CommitRow[],
	): string {
		const { stream, get } = live(columns);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows,
			});
		return visibleLines(get()).find((line) => line.includes("abc1234"))!;
	}

	function rowsAt(
		columns: number,
		commitRows: readonly import("../src/render.js").CommitRow[],
	): string[] {
		const { stream, get } = live(columns);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows,
			});
		return visibleLines(get());
	}

	it("separates the sha and author columns with two spaces and aligns authors across rows", () => {
		const lines = rowsAt(120, [
			{
				sha: { text: "282f9c3" },
				author: "Mark Paluch",
				summary: "Release version 4.0.1",
				lead: { text: "#1", emphasis: "lead" },
				references: [],
			},
			{
				sha: { text: "a3cbc1e" },
				author: "Ada Lovelace",
				summary: "Short",
				lead: { text: "#2", emphasis: "lead" },
				references: [],
			},
			{ sha: { text: "7c9ab70" }, author: "Bo", summary: "Tiny", references: [] },
		]);
		const shaRow = (sha: string) => lines.find((line) => line.includes(sha))!;

		expect(shaRow("282f9c3")).toContain("282f9c3  Mark Paluch");

		const summaryAt = (line: string, summary: string) => line.indexOf(summary);
		const columns = [
			summaryAt(shaRow("282f9c3"), "Release version 4.0.1"),
			summaryAt(shaRow("a3cbc1e"), "Short"),
			summaryAt(shaRow("7c9ab70"), "Tiny"),
		];
		expect(new Set(columns).size).toBe(1);
	});

	it("renders the references of a commit that has no lead", () => {
		const row = rowAt(120, [
			{
				sha: { text: "abc1234" },
				author: "Ada",
				summary: "See note",
				references: [{ text: "#3423", emphasis: "related" }],
			},
		]);

		expect(row).toContain("#3423");
	});

	it("keeps the author column intact so the summary is the only field that truncates", () => {
		const lines = rowsAt(60, [
			{
				sha: { text: "a3cbc1e" },
				author: "Mark Paluch",
				summary: "Refine repositoryBaseClass property configuration and more",
				lead: { text: "#1", emphasis: "lead" },
				references: [],
			},
			{
				sha: { text: "7c9ab70" },
				author: "Bo",
				summary: "Short",
				lead: { text: "#2", emphasis: "lead" },
				references: [],
			},
		]);
		const row = lines.find((line) => line.includes("a3cbc1e"))!;

		expect(row).toContain("Mark Paluch");
		expect(row).not.toContain("……");
		expect((row.match(/…/g) ?? []).length).toBeLessThanOrEqual(1);
	});

	it("stops adding references and shows an omission marker when the next one does not fit", () => {
		const row = rowAt(52, [fourRefs]);
		expect(row).toContain("#101");
		expect(row).toContain("#102");
		expect(row).not.toContain("#103");
		expect(row).not.toContain("#104");
		expect(row).toContain("and 2 more");
	});

	it("reserves the omission marker even when it displaces one more complete reference", () => {
		const row = rowAt(51, [fourRefs]);
		expect(row).not.toContain("#102");
		expect(row).toContain("and 3 more");
		expect(row).toContain("#101");
	});

	it("truncates the summary before the author, keeping the author and lead intact", () => {
		const row = rowAt(45, [
			{
				sha: { text: "abc1234" },
				author: "Bartholomew",
				summary: "A long descriptive summary line here",
				lead: { text: "#101", emphasis: "lead" },
				references: [],
			},
		]);
		expect(row).toContain("Bartholomew");
		expect(row).toContain("#101");
		expect(row).toContain("…");
		expect(row).not.toContain("A long descriptive summary line here");
	});

	it("omits additional references before shrinking free text below its minimum", () => {
		const row = rowAt(47, [
			{
				sha: { text: "abc1234" },
				author: "Ada",
				summary: "Add widgets",
				lead: { text: "#101", emphasis: "lead" },
				references: [
					{ text: "#102", emphasis: "candidate" },
					{ text: "#103", emphasis: "candidate" },
				],
			},
		]);
		expect(row).toContain("Add widgets");
		expect(row).not.toContain("…");
		expect(row).toContain("#101");
		expect(row).not.toContain("#102");
		expect(row).toContain("and 2 more");
	});

	it("wraps the lead to an indented continuation line when it cannot otherwise fit", () => {
		const { stream, get } = live(25);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows: [
					{
						sha: { text: "abc1234" },
						author: "Ada",
						summary: "Add widgets and more",
						lead: { text: "#101", emphasis: "lead" },
						references: [],
					},
				],
			});
		const lines = visibleLines(get());
		const core = lines.find((line) => line.includes("abc1234"))!;
		const continuation = lines.find((line) => line.includes("#101"))!;

		expect(core).not.toContain("#101");
		expect(continuation).not.toContain("abc1234");
		expect(continuation.trimStart()).toBe("#101");

		expect(continuation.length - continuation.trimStart().length).toBeGreaterThan(
			core.length - core.trimStart().length,
		);
	});

	it("renders a single reference wider than the terminal intact (overflow)", () => {
		const wide = "spring-projects/spring-data-relational#2245";
		const { stream, get } = live(20);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows: [
					{
						sha: { text: "abc1234" },
						author: "Ada",
						summary: "Bump build",
						lead: { text: wide, emphasis: "lead" },
						references: [],
					},
				],
			});

		expect(stripAnsi(get())).toContain(wide);
	});

	it("colors the five emphasis levels and the omission marker on a descending gray ladder", () => {
		const { stream, get } = capture({ isTTY: true, columns: 50 });
		createRenderer(stream, {
			capabilities: { level: 3, tty: true, hyperlinks: true },
			durations: false,
		})
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows: [
					{
						sha: { text: "abc1234" },
						author: "Ada",
						summary: "s",
						lead: { text: "#1", emphasis: "lead", link: "https://h/1" },
						references: [
							{ text: "#2", emphasis: "candidate" },
							{ text: "#3", emphasis: "credit" },
							{ text: "#4", emphasis: "demoted" },
							{ text: "#5", emphasis: "related" },
							{ text: "#6", emphasis: "related" },
						],
					},
				],
			});
		const out = get();
		expect(out).toContain(`${ESC}[38;2;137;180;250m`);
		expect(out).toContain(`${ESC}[38;2;147;153;178m`);
		expect(out).toContain(`${ESC}[38;2;127;132;156m`);
		expect(out).toContain(`${ESC}[38;2;108;112;134m`);

		expect(out).toContain(`${ESC}[2m`);

		expect(out).toContain(`${ESC}]8;;https://h/1`);
	});

	it("renders every reference with no marker, color, or duration off a TTY", () => {
		const { stream, get } = capture();
		createRenderer(stream, { capabilities: plain })
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows: [
					{
						sha: { text: "abc1234" },
						author: "Ada",
						summary: "Add widgets",
						lead: { text: "#101", emphasis: "lead" },
						references: [
							{ text: "#102", emphasis: "candidate" },
							{ text: "#103", emphasis: "credit" },
							{ text: "#104", emphasis: "demoted" },
						],
					},
				],
			});
		const out = get();
		for (const ref of ["#101", "#102", "#103", "#104"]) {
			expect(out).toContain(ref);
		}
		expect(out).not.toContain("more");
		expect(out).not.toContain(ESC);
		expect(out).not.toMatch(/\d+ ms|\d+\.\d+ s/);
	});

	it("preserves all reference text when colors collapse on a limited-color terminal", () => {
		const { stream, get } = capture({ isTTY: true, columns: 80 });
		createRenderer(stream, {
			capabilities: { level: 1, tty: true, hyperlinks: false },
			durations: false,
		})
			.start("x")
			.succeed({
				title: [{ text: "Scanned" }],
				commitRows: [
					{
						sha: { text: "abc1234" },
						author: "Ada",
						summary: "Add widgets",
						lead: { text: "#101", emphasis: "lead" },
						references: [
							{ text: "#102", emphasis: "candidate" },
							{ text: "#103", emphasis: "credit" },
							{ text: "#104", emphasis: "demoted" },
							{ text: "#105", emphasis: "related" },
						],
					},
				],
			});
		const visible = stripAnsi(get());
		for (const ref of ["#101", "#102", "#103", "#104", "#105"]) {
			expect(visible).toContain(ref);
		}
	});

	it("wraps a comma-separated reference list to the budget, keeping every item complete", () => {
		const { stream, get } = live(24);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Looked up" }],
				flow: [
					{ text: "#1001", style: "accent" },
					{ text: "#1002", style: "accent" },
					{ text: "#1003", style: "warning" },
					{ text: "#1004", style: "accent" },
				],
			});
		const visible = stripAnsi(get())
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""))
			.filter((line) => line.includes("#100"));

		for (const ref of ["#1001", "#1002", "#1003", "#1004"]) {
			expect(visible.join(" ")).toContain(ref);
		}
		expect(visible.length).toBeGreaterThan(1);
		expect(visible.join("\n")).toContain(", ");
	});

	it("truncates the last column of aligned rows to keep a row within the budget", () => {
		const { stream, get } = live(28);
		createRenderer(stream, { capabilities: noColorTty, durations: false })
			.start("x")
			.succeed({
				title: [{ text: "Looked up" }],
				rows: [
					{
						cells: [
							{ text: "abc1234" },
							{ text: "#1299" },
							{ text: "A long not-found commit subject" },
						],
					},
				],
			});
		const row = visibleLines(get()).find((line) => line.includes("abc1234"))!;
		expect(row).toContain("abc1234");
		expect(row).toContain("#1299");
		expect(row).toContain("…");
		expect(row).not.toContain("A long not-found commit subject");
	});
});

describe("live reporter", () => {
	it("animates a spinner and prints a duration on success", () => {
		let clock = 0;
		const { stream, get } = capture({ isTTY: true, columns: 120 });
		const renderer = createRenderer(stream, {
			capabilities: { level: 3, tty: true, hyperlinks: false },
			now: () => clock,
			durations: true,
		});
		const step = renderer.start("Scanning commits");
		clock = 1500;
		step.succeed({ title: [{ text: "Scanned 3 commits" }] });
		const out = stripAnsi(get());
		expect(out).toContain("✔ Scanned 3 commits");
		expect(out).toContain("✔ Scanned 3 commits (⚡️ 1.5 s)");
		expect(get()).toContain(`${ESC}[2m (⚡️ 1.5 s)`);
	});

	it("hides sub-2ms stage timings", () => {
		let clock = 0;
		const { stream, get } = capture({ isTTY: true, columns: 120 });
		const renderer = createRenderer(stream, {
			capabilities: { level: 3, tty: true, hyperlinks: false },
			now: () => clock,
			durations: true,
		});
		const step = renderer.start("Scanning commits");
		clock = 1;
		step.succeed({ title: [{ text: "Scanned 3 commits" }] });
		const out = stripAnsi(get());
		expect(out).toContain("✔ Scanned 3 commits");
		expect(out).not.toContain("(⚡");
	});

	it("clips by terminal width without splitting wide graphemes", () => {
		const { stream, get } = capture({ isTTY: true, columns: 8 });
		const step = createRenderer(stream, {
			capabilities: { level: 0, tty: true, hyperlinks: false },
			durations: false,
		}).start("Scanning commits");

		step.succeed({ title: [{ text: "👍界abc" }] });

		const out = stripAnsi(get());
		expect(out).toContain("✔ 👍界a");
		expect(out).not.toContain("✔ 👍界ab");
	});

	it("restores the cursor when a live step fails", () => {
		const { stream, get } = capture({ isTTY: true, columns: 80 });
		createRenderer(stream, {
			capabilities: { level: 0, tty: true, hyperlinks: false },
		})
			.start("Scanning commits")
			.fail("Scanning commits failed");

		expect(get()).toContain(`${ESC}[?25h`);
	});

	it("restores the cursor when an active renderer is disposed", () => {
		const { stream, get } = capture({ isTTY: true, columns: 80 });
		const renderer = createRenderer(stream, {
			capabilities: { level: 0, tty: true, hyperlinks: false },
		});
		renderer.start("Scanning commits");

		renderer.dispose();

		expect(get()).toContain(`${ESC}[?25h`);
	});
});
