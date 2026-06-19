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

import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import type { Cell, Palette } from "../src/palette.js";
import {
	type CommitRow,
	type Emphasis,
	fitReferenceFlow,
	layoutCommitRows,
	layoutFlow,
	type ReferenceItem,
} from "../src/reference-flow.js";

// A plain identity palette so assertions read the fitting result, not the styling.
const palette: Palette = {
	style: (text) => text,
	bold: (text) => text,
	link: (text) => text,
	width: (text) => stringWidth(text),
};

function ref(text: string, emphasis: Emphasis = "candidate"): ReferenceItem {
	return { text, emphasis };
}

function commit(
	summary: string,
	lead: ReferenceItem | undefined,
	references: readonly ReferenceItem[],
): CommitRow {
	return { sha: { text: "abc1234" }, author: "alice", summary, lead, references };
}

describe("layoutCommitRows", () => {
	it("shows every reference on one line with an unbounded budget", () => {
		const [line] = layoutCommitRows(
			palette,
			[commit("Fix the thing", ref("#10", "lead"), [ref("#11"), ref("#12")])],
			Infinity,
		);

		expect(line).toBe("abc1234  alice  Fix the thing  #10 #11 #12");
	});

	it("keeps references atomic and marks the remainder when the budget is tight", () => {
		const refs = [ref("#1111"), ref("#2222"), ref("#3333")];

		const [line] = layoutCommitRows(
			palette,
			[commit("S", ref("#10", "lead"), refs)],
			40,
		);

		// Whatever fits is shown in full; the rest collapse into an omission marker, never a
		// partial token.
		expect(line).toMatch(/ and \d+ more$/);
		expect(line).not.toContain("#222");
		expect(line!.startsWith("abc1234  alice  S  #10")).toBe(true);
	});

	it("wraps the lead to a continuation line when it cannot share the core line", () => {
		const lines = layoutCommitRows(
			palette,
			[commit("A long-enough summary here", ref("#123456789", "lead"), [])],
			30,
		);

		expect(lines).toHaveLength(2);
		expect(lines[1]?.trimStart()).toBe("#123456789");
	});
});

describe("layoutFlow", () => {
	it("is one line when unbounded and wraps without splitting items", () => {
		const items: Cell[] = [{ text: "#1" }, { text: "#2" }, { text: "#3" }];

		expect(layoutFlow(palette, items, Infinity)).toEqual(["#1, #2, #3"]);

		const wrapped = layoutFlow(palette, items, 5);
		expect(wrapped.every((line) => !line.endsWith(","))).toBe(true);
		expect(wrapped.join(" ")).toContain("#3");
	});
});

describe("fitReferenceFlow", () => {
	it("reserves room for the omission marker rather than overflowing the budget", () => {
		const suffix = fitReferenceFlow(
			palette,
			[ref("#1"), ref("#2"), ref("#3")],
			12,
			0,
			"",
		);

		expect(stringWidth(suffix)).toBeLessThanOrEqual(12);
		expect(suffix).toMatch(/and \d+ more$/);
	});
});
