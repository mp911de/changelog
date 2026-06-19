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

import { parseReferenceOccurrences } from "../src/commit-parser.js";

const FOO_BAZ = { owner: "foo-baz1", repo: "b_ar" };

describe("parseReferenceOccurrences", () => {
	it("emits a leading #n as a single Simple reference for the current repository", () => {
		const occurrences = parseReferenceOccurrences("#1234 Add feature");

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#1234");
		expect(occurrences[0]?.qualifier).toBe("Simple");
		expect(occurrences[0]?.repository).toBeUndefined();
	});

	it("normalizes gh-n to #n and keeps the Simple qualifier", () => {
		const occurrences = parseReferenceOccurrences("gh-586 Polishing");

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#586");
		expect(occurrences[0]?.qualifier).toBe("Simple");
	});

	it("emits several references in textual order, once per textual reference", () => {
		const occurrences = parseReferenceOccurrences("#1 then #2 and #3");

		expect(occurrences.map((occurrence) => occurrence.id)).toEqual([
			"#1",
			"#2",
			"#3",
		]);
		expect(occurrences.every((occurrence) => occurrence.qualifier === "Simple")).toBe(
			true,
		);
	});

	it("binds a repository-qualified reference to its own repository", () => {
		const occurrences = parseReferenceOccurrences("Touch foo-baz1/b_ar#415 here");

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#415");
		expect(occurrences[0]?.repository).toEqual(FOO_BAZ);
	});

	it("binds a URL-qualified reference to its own repository", () => {
		const occurrences = parseReferenceOccurrences(
			"See https://github.com/foo-baz1/b_ar/issues/415 for details",
		);

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#415");
		expect(occurrences[0]?.repository).toEqual(FOO_BAZ);
	});

	it("returns no occurrences for a commit with no ticket token", () => {
		expect(parseReferenceOccurrences("Bump the build script")).toEqual([]);
	});

	it("qualifies a reference following a closing keyword", () => {
		const occurrences = parseReferenceOccurrences("Polishing\n\nCloses gh-586.");

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#586");
		expect(occurrences[0]?.qualifier).toBe("Qualified");
	});

	it("marks a pull-request reference PullRequest", () => {
		const occurrences = parseReferenceOccurrences(
			"#456 Hello.\n pull request: #415.",
		);

		expect(
			occurrences.map((occurrence) => [occurrence.id, occurrence.qualifier]),
		).toEqual([
			["#456", "Simple"],
			["#415", "PullRequest"],
		]);
	});

	it("treats an Original prefix as another pull-request variant", () => {
		const occurrences = parseReferenceOccurrences(
			"#456 Hello.\n Original pull request: #415.",
		);

		expect(
			occurrences.map((occurrence) => [occurrence.id, occurrence.qualifier]),
		).toEqual([
			["#456", "Simple"],
			["#415", "PullRequest"],
		]);
	});

	it("matches the pull-request syntax case-insensitively", () => {
		const occurrences = parseReferenceOccurrences(
			"Tidy up\n\nORIGINAL PULL REQUEST: #777",
		);

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#777");
		expect(occurrences[0]?.qualifier).toBe("PullRequest");
	});

	it("marks a see reference See", () => {
		const occurrences = parseReferenceOccurrences("Tidy up\n\nSee gh-574.");

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#574");
		expect(occurrences[0]?.qualifier).toBe("See");
	});

	it("marks a related-to reference Related, not See", () => {
		const occurrences = parseReferenceOccurrences("Tidy up\n\nRelated to gh-99.");

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#99");
		expect(occurrences[0]?.qualifier).toBe("Related");
	});

	it("marks every reference in a Related list Related, in textual order", () => {
		const occurrences = parseReferenceOccurrences(
			"Hello.\n Related tickets: gh-1438, gh-1461, gh-1609.",
		);

		expect(
			occurrences.map((occurrence) => [occurrence.id, occurrence.qualifier]),
		).toEqual([
			["#1438", "Related"],
			["#1461", "Related"],
			["#1609", "Related"],
		]);
	});

	it("leaves a misspelled relationship keyword Simple", () => {
		const occurrences = parseReferenceOccurrences(
			"Fix bug\n\nOriginal pull requesst: #3426",
		);

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.id).toBe("#3426");
		expect(occurrences[0]?.qualifier).toBe("Simple");
	});

	it("emits each occurrence once with its strongest qualifier in textual order", () => {
		const occurrences = parseReferenceOccurrences(
			"Closes #5 then #6.\n\nSee #7. Original pull request: #8.",
		);

		expect(
			occurrences.map((occurrence) => [occurrence.id, occurrence.qualifier]),
		).toEqual([
			["#5", "Qualified"],
			["#6", "Simple"],
			["#7", "See"],
			["#8", "PullRequest"],
		]);
	});

	it("scans adversarial input without catastrophic backtracking", () => {
		// No slash and no #n is the worst case for the owner token: the unbounded pattern
		// backtracked O(n^2) here (>1000ms at this size). The bounded token must stay linear.
		const hostile = "a-".repeat(50000);

		const start = performance.now();
		parseReferenceOccurrences(hostile);

		expect(performance.now() - start).toBeLessThan(200);
	});
});
