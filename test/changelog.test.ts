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

import { generateChangelog } from "../src/changelog.js";
import type { ChangelogConfig } from "../src/config.js";
import type { ChangelogEntry } from "../src/resolved-references.js";

function entry(
	id: string,
	title: string,
	labels: readonly string[],
	htmlUrl = `https://example.test/${id.replace("#", "")}`,
): ChangelogEntry {
	return {
		target: { id },
		title,
		htmlUrl,
		labels,
	};
}

const defaultConfig: ChangelogConfig = {
	sections: [
		{ title: ":star: New Features", labels: ["enhancement"], summary: "features" },
		{
			title: ":lady_beetle: Bug Fixes",
			labels: ["bug", "regression"],
			summary: "bugs",
		},
		{
			title: ":notebook_with_decorative_cover: Documentation",
			labels: ["documentation"],
		},
		{ title: ":hammer: Dependency Upgrades", labels: ["dependency-upgrade"] },
	],
	excludeLabels: ["type: task"],
	team: ["octocat"],
};

describe("generateChangelog entries", () => {
	it("renders sections in configured order with their matching issues under each heading", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Add widgets", ["enhancement"]),
				entry("#2", "Fix gadget", ["bug"]),
				entry("#3", "Document widgets", ["documentation"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :star: New Features\n" +
				"- Add widgets. [#1](https://example.test/1)\n" +
				"\n" +
				"## :lady_beetle: Bug Fixes\n" +
				"- Fix gadget. [#2](https://example.test/2)\n" +
				"\n" +
				"## :notebook_with_decorative_cover: Documentation\n" +
				"- Document widgets. [#3](https://example.test/3)\n",
		);
	});

	it("places an issue in the first matching section only", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Both", ["enhancement", "bug"])],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :star: New Features\n- Both. [#1](https://example.test/1)\n",
		);
		expect(markdown).not.toContain(":lady_beetle: Bug Fixes");
	});

	it("matches labels case-insensitively by substring (deviation from the case-sensitive Java reference)", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Lowercase qualified", ["type: bug"]),
				entry("#2", "Title-cased qualified", ["Type: Bug"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :lady_beetle: Bug Fixes\n" +
				"- Lowercase qualified. [#1](https://example.test/1)\n" +
				"- Title-cased qualified. [#2](https://example.test/2)\n",
		);
	});

	it("does not match a configured token inside a longer word", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Real fix", ["bug"]),
				entry("#2", "Improve debugging output", ["debugging"]),
				entry("#3", "Not actually a bug", ["non-bug"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :lady_beetle: Bug Fixes\n" + "- Real fix. [#1](https://example.test/1)\n",
		);
		expect(markdown).not.toContain("debugging");
		expect(markdown).not.toContain("Not actually a bug");
	});

	it("drops issues carrying an excluded label, case-insensitively", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Real work", ["enhancement"]),
				entry("#2", "Housekeeping", ["enhancement", "Type: Task"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :star: New Features\n- Real work. [#1](https://example.test/1)\n",
		);
		expect(markdown).not.toContain("Housekeeping");
	});

	it("drops issues matching no section by default", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Add widgets", ["enhancement"]),
				entry("#2", "Mystery", ["unmatched"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :star: New Features\n- Add widgets. [#1](https://example.test/1)\n",
		);
		expect(markdown).not.toContain("Mystery");
		expect(markdown).not.toContain("Other Changes");
	});

	it("collects unclassified issues into a trailing :gear: Other Changes section with --all", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Add widgets", ["enhancement"]),
				entry("#2", "Mystery", ["unmatched"]),
			],
			[],
			defaultConfig,
			{ all: true },
		);

		expect(markdown).toBe(
			"## :star: New Features\n" +
				"- Add widgets. [#1](https://example.test/1)\n" +
				"\n" +
				"## :gear: Other Changes\n" +
				"- Mystery. [#2](https://example.test/2)\n",
		);
	});

	it("still drops excluded issues under --all", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Housekeeping", ["type: task"])],
			[],
			defaultConfig,
			{ all: true },
		);

		expect(markdown).toBe("");
	});

	it("ends each entry with a single period, adding one only when the title lacks it", () => {
		const { markdown } = generateChangelog(
			[
				entry("#1", "Add support for foo", ["enhancement"]),
				entry("#2", "Already a sentence.", ["enhancement"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain(
			"- Add support for foo. [#1](https://example.test/1)\n",
		);
		expect(markdown).toContain(
			"- Already a sentence. [#2](https://example.test/2)\n",
		);
	});

	it("wraps @mentions in backticks so contributors are not notified", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Thanks @octocat for the report", ["enhancement"])],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain("Thanks `@octocat` for the report");
	});

	it("does not backslash-escape markdown metacharacters (spec over Java reference)", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Fix <script> and [link]", ["enhancement"])],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain(
			"- Fix <script> and [link]. [#1](https://example.test/1)\n",
		);
	});

	it("counts placed items per summary bucket under the default config (features, bugs)", () => {
		const { sectionCounts } = generateChangelog(
			[
				entry("#1", "Feature A", ["enhancement"]),
				entry("#2", "Feature B", ["enhancement"]),
				entry("#3", "Bug A", ["bug"]),
				entry("#4", "Doc A", ["documentation"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(sectionCounts.get("features")).toBe(2);
		expect(sectionCounts.get("bugs")).toBe(1);
		expect(sectionCounts.has("documentation")).toBe(false);
	});

	it("counts only rendered entries, excluding dropped and unclassified-without-all items", () => {
		const { documentedEntries } = generateChangelog(
			[
				entry("#1", "Feature A", ["enhancement"]),
				entry("#2", "Bug A", ["bug"]),
				entry("#3", "Housekeeping", ["type: task"]),
				entry("#4", "Mystery", ["unmatched"]),
			],
			[],
			defaultConfig,
			{ all: false },
		);

		expect(documentedEntries).toBe(2);
	});

	it("counts an included unclassified entry as documented under --all", () => {
		const { documentedEntries } = generateChangelog(
			[
				entry("#1", "Feature A", ["enhancement"]),
				entry("#2", "Mystery", ["unmatched"]),
				entry("#3", "Housekeeping", ["type: task"]),
			],
			[],
			defaultConfig,
			{ all: true },
		);

		expect(documentedEntries).toBe(2);
	});

	it("derives bucket identity from the summary key, not the title (config-driven counts)", () => {
		const renamedConfig: ChangelogConfig = {
			sections: [
				{
					title: ":sparkles: Shiny Things",
					labels: ["enhancement"],
					summary: "improvements",
				},
			],
			excludeLabels: [],
			team: [],
		};

		const { sectionCounts } = generateChangelog(
			[
				entry("#1", "Feature A", ["enhancement"]),
				entry("#2", "Feature B", ["enhancement"]),
			],
			[],
			renamedConfig,
			{ all: false },
		);

		expect([...sectionCounts.entries()]).toEqual([["improvements", 2]]);
		expect(sectionCounts.has("features")).toBe(false);
	});
});

describe("generateChangelog contributor credit", () => {
	it("renders ordered author facts under :heart: Contributors", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Add widgets", ["enhancement"])],
			["contrib"],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain("## :heart: Contributors\n- @contrib\n");
	});

	it("never renders a Contributor Credit without a Changelog Entry from the same target", () => {
		const { markdown, documentedEntries } = generateChangelog(
			[],
			["contrib"],
			defaultConfig,
			{ all: false },
		);

		expect(documentedEntries).toBe(0);
		expect(markdown).toBe("## :heart: Contributors\n- @contrib\n");
	});

	it("deduplicates authors case-insensitively while preserving GitHub's displayed spelling", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Add widgets", ["enhancement"])],
			["Contrib", "contrib", "CONTRIB"],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain("## :heart: Contributors\n- @Contrib\n");
		expect(markdown.match(/@Contrib/gi)).toHaveLength(1);
	});

	it("excludes team members case-insensitively", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Work", ["enhancement"])],
			["OctoCat", "contrib"],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain("## :heart: Contributors\n- @contrib\n");
		expect(markdown).not.toMatch(/@OctoCat/i);
	});

	it("sorts contributors alphabetically without regard to case", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Work", ["enhancement"])],
			["zoe", "Bob", "alice"],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toContain("## :heart: Contributors\n- @alice\n- @Bob\n- @zoe\n");
	});

	it("counts unique contributors after team exclusion", () => {
		const { contributorCount } = generateChangelog(
			[entry("#1", "Work", ["enhancement"])],
			["octocat", "alice", "Alice"],
			defaultConfig,
			{ all: false },
		);

		expect(contributorCount).toBe(1);
	});

	it("omits the Contributors section when no eligible contributors remain", () => {
		const { markdown, contributorCount } = generateChangelog(
			[entry("#1", "Work", ["enhancement"])],
			["octocat"],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).not.toContain(":heart: Contributors");
		expect(contributorCount).toBe(0);
	});

	it("appends the Contributors block after the categorized sections", () => {
		const { markdown } = generateChangelog(
			[entry("#1", "Add widgets", ["enhancement"])],
			["contrib"],
			defaultConfig,
			{ all: false },
		);

		expect(markdown).toBe(
			"## :star: New Features\n" +
				"- Add widgets. [#1](https://example.test/1)\n" +
				"\n" +
				"## :heart: Contributors\n" +
				"- @contrib\n",
		);
	});
});
