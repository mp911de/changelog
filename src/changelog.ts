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

import type { ChangelogConfig, Section } from "./config.js";
import type { ChangelogEntry } from "./resolved-references.js";
import { escapeRegExp } from "./text.js";
import { targetKey } from "./ticket-references.js";

const OTHER_CHANGES_TITLE = ":gear: Other Changes";

export interface GenerateOptions {
	readonly all: boolean;
}

export interface ChangelogResult {
	readonly markdown: string;
	// Summary keys keep counts stable when a section title changes.
	readonly sectionCounts: ReadonlyMap<string, number>;
	readonly contributorCount: number;
	// Entries actually rendered in the document, after exclusion and `--all` handling.
	readonly documentedEntries: number;
}

/**
 * Generate the Changelog Document from separate document-generation inputs: resolved Changelog
 * Entries and ordered author facts. Entries are excluded, placed into their first matching section,
 * and rendered in input (commit-discovery) order. Author facts become Contributor Credits
 * after case-insensitive team exclusion and deduplication, displayed with GitHub's spelling and
 * sorted alphabetically without regard to case. A credit-only author never becomes a Changelog
 * Entry. Label matching is case-insensitive and anchored on word boundaries so a qualified label
 * such as {@code Type: Bug} matches the configured {@code bug} token, while {@code debugging} does
 * not.
 */
export function generateChangelog(
	entries: readonly ChangelogEntry[],
	authors: readonly string[],
	config: ChangelogConfig,
	options: GenerateOptions,
): ChangelogResult {
	const placed = new Map<Section, ChangelogEntry[]>();
	const sectionCounts = new Map<string, number>();
	const other: ChangelogEntry[] = [];

	const matchers = compileLabelMatchers(config);

	for (const entry of entries) {
		const labels = entry.labels;
		if (containsAny(labels, config.excludeLabels, matchers)) {
			continue;
		}

		const section = config.sections.find((candidate) =>
			containsAny(labels, candidate.labels, matchers),
		);
		if (!section) {
			other.push(entry);
			continue;
		}

		const bucket = placed.get(section);
		if (bucket) {
			bucket.push(entry);
		} else {
			placed.set(section, [entry]);
		}
		if (section.summary) {
			sectionCounts.set(
				section.summary,
				(sectionCounts.get(section.summary) ?? 0) + 1,
			);
		}
	}

	const blocks: string[] = [];
	let documentedEntries = 0;
	for (const section of config.sections) {
		const sectionItems = placed.get(section);
		if (sectionItems) {
			blocks.push(renderSection(section.title, sectionItems));
			documentedEntries += sectionItems.length;
		}
	}
	if (options.all && other.length > 0) {
		blocks.push(renderSection(OTHER_CHANGES_TITLE, other));
		documentedEntries += other.length;
	}

	const contributors = collectContributors(authors, config.team);
	if (contributors.length > 0) {
		blocks.push(renderContributors(contributors));
	}

	return {
		markdown: blocks.join("\n"),
		sectionCounts,
		contributorCount: contributors.length,
		documentedEntries,
	};
}

const CONTRIBUTORS_TITLE = ":heart: Contributors";

/**
 * Reduce ordered author facts to Contributor Credits: drop empty logins and team members
 * (case-insensitively), keep one entry per login (case-insensitively, retaining GitHub's first-seen
 * spelling), then sort alphabetically without regard to case.
 */
function collectContributors(
	authors: readonly string[],
	team: readonly string[],
): string[] {
	const excluded = new Set(team.map((member) => member.toLowerCase()));
	const seen = new Map<string, string>();
	for (const author of authors) {
		if (!author) {
			continue;
		}
		const key = author.toLowerCase();
		if (excluded.has(key) || seen.has(key)) {
			continue;
		}
		seen.set(key, author);
	}
	return [...seen.values()].sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);
}

function renderContributors(contributors: readonly string[]): string {
	const lines = contributors.map((author) => `- @${author}\n`).join("");
	return `## ${CONTRIBUTORS_TITLE}\n${lines}`;
}

/**
 * Precompile every section and exclude token into its word-boundary matcher once per run, keyed by
 * the original token. The entry loop then reuses these instead of recompiling a RegExp per label.
 */
function compileLabelMatchers(config: ChangelogConfig): Map<string, RegExp> {
	const matchers = new Map<string, RegExp>();
	const addToken = (token: string): void => {
		if (!matchers.has(token)) {
			matchers.set(token, labelMatcher(token));
		}
	};
	config.excludeLabels.forEach(addToken);
	for (const section of config.sections) {
		section.labels.forEach(addToken);
	}
	return matchers;
}

function containsAny(
	labels: readonly string[],
	candidates: readonly string[],
	matchers: Map<string, RegExp>,
): boolean {
	return candidates.some((candidate) => {
		const needle = matchers.get(candidate) ?? labelMatcher(candidate);
		return labels.some((label) => needle.test(label));
	});
}

// Match the token only at word boundaries, so `bug` matches "Type: Bug" but not "debugging".
function labelMatcher(candidate: string): RegExp {
	return new RegExp(`(?<![\\w-])${escapeRegExp(candidate.trim())}(?![\\w-])`, "i");
}

function renderSection(title: string, entries: readonly ChangelogEntry[]): string {
	return `## ${title}\n${entries.map(renderEntry).join("")}`;
}

function renderEntry(entry: ChangelogEntry): string {
	return `- ${formatTitle(entry.title)} [${targetKey(entry.target)}](${entry.htmlUrl})\n`;
}

const MENTION = /(^|[^\w`])(@[\w-]+)/g;

function formatTitle(title: string): string {
	// Code formatting prevents issue titles from notifying mentioned users.
	const quoted = title.replace(MENTION, "$1`$2`");
	const trimmed = quoted.replace(/\s+$/, "");
	return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}
