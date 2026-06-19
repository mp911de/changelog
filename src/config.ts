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

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { hasCode } from "./errors.js";
import { readOptionalJson, writeJsonFile } from "./json-file.js";
import { escapeRegExp } from "./text.js";

export interface Section {
	readonly title: string;
	readonly labels: readonly string[];
	readonly summary?: string;
}

export interface ChangelogConfig {
	readonly sections: readonly Section[];
	readonly excludeLabels: readonly string[];
	readonly team: readonly string[];

	readonly followReferences?: readonly string[];
}

/**
 * Default configuration for a new changelog.json file.
 * @param login GitHub login of the current user.
 * @param owner the current repository owner, seeded into a new config's followReferences.
 */
function defaultConfig(login: string, owner?: string): ChangelogConfig {
	const base: ChangelogConfig = {
		sections: [
			{
				title: ":star: New Features",
				labels: ["enhancement"],
				summary: "features",
			},
			{
				title: ":lady_beetle: Bug Fixes",
				labels: ["bug", "regression"],
				summary: "bugs",
			},
			{
				title: ":notebook_with_decorative_cover: Documentation",
				labels: ["documentation"],
			},
			{
				title: ":hammer: Dependency Upgrades",
				labels: ["dependency-upgrade", "dependencies"],
			},
		],
		excludeLabels: ["type: task"],
		team: [login],
	};
	// Seed a new config to follow references within the same GitHub organization. Without a known
	// owner, omit followReferences entirely (unrestricted) rather than writing a meaningless `/*`.
	return owner ? { ...base, followReferences: [`${owner}/*`] } : base;
}

export interface LoadOrCreateConfigOptions {
	readonly baseDir: string;
	readonly login: string;
	// The current repository owner, seeded into a new config's followReferences as `<owner>/*`. When
	// absent, a new config omits followReferences and is therefore unrestricted.
	readonly owner?: string;
}

/**
 * Never copy existing configuration between locations so a project cannot end up with two
 * competing files. A new file uses {@code .github} when available and otherwise uses
 * {@code .changelog}.
 */
export async function loadOrCreateConfig(
	options: LoadOrCreateConfigOptions,
): Promise<ChangelogConfig> {
	const candidates = await configLocations(options.baseDir);

	for (const path of candidates) {
		const existing = await readOptionalJson<unknown>(path);
		if (existing !== undefined) {
			return parseConfig(existing, path);
		}
	}

	const created = defaultConfig(options.login, options.owner);
	await writeJsonFile(candidates[0]!, created, { compact: true });
	return created;
}

async function configLocations(baseDir: string): Promise<string[]> {
	const locations: string[] = [];
	if (await isDirectory(join(baseDir, ".github"))) {
		locations.push(join(baseDir, ".github", "changelog.json"));
	}
	locations.push(join(baseDir, ".changelog", "changelog.json"));
	return locations;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
			return false;
		}
		throw error;
	}
}

function parseConfig(value: unknown, path: string): ChangelogConfig {
	const config = record(value, path, "configuration");
	if (!Array.isArray(config.sections)) {
		throw invalidConfig(path, '"sections" must be an array');
	}

	const sections = config.sections.map((value, index): Section => {
		const section = record(value, path, `section ${index + 1}`);
		if (typeof section.title !== "string" || section.title.trim().length === 0) {
			throw invalidConfig(
				path,
				`section ${index + 1} must have a non-empty "title"`,
			);
		}
		const title = section.title.trim();
		const labels = stringArray(section.labels, path, `section ${index + 1} "labels"`);
		if (section.summary !== undefined && typeof section.summary !== "string") {
			throw invalidConfig(path, `section ${index + 1} "summary" must be a string`);
		}
		// Tri-state: an absent summary stays undefined (the section has no prose), a non-blank one is
		// trimmed and kept, and a blank string is rejected rather than silently treated as absent.
		const summary = section.summary?.trim();
		if (summary === "") {
			throw invalidConfig(path, `section ${index + 1} "summary" must not be blank`);
		}
		return { title, labels, summary };
	});

	const followReferences =
		config.followReferences === undefined
			? undefined
			: stringArray(config.followReferences, path, '"followReferences"');

	return {
		sections,
		excludeLabels: stringArray(config.excludeLabels, path, '"excludeLabels"'),
		team: stringArray(config.team, path, '"team"'),
		...(followReferences ? { followReferences } : {}),
	};
}

/**
 * Build a predicate over a `owner/repo` name from followReferences glob patterns. `*` matches one or
 * more characters and every other character is literal. An empty pattern list is unrestricted
 * (always true), matching the rule that an absent or empty followReferences imposes no limit.
 */
export function followReferenceMatcher(
	patterns: readonly string[],
): (repositoryName: string) => boolean {
	if (patterns.length === 0) {
		return () => true;
	}
	const expressions = patterns.map(globToRegExp);
	return (repositoryName) =>
		expressions.some((expression) => expression.test(repositoryName));
}

function globToRegExp(pattern: string): RegExp {
	const body = pattern.split("*").map(escapeRegExp).join(".+");
	return new RegExp(`^${body}$`, "i");
}

function record(
	value: unknown,
	path: string,
	description: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidConfig(path, `${description} must be an object`);
	}
	return value as Record<string, unknown>;
}

function stringArray(value: unknown, path: string, description: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw invalidConfig(path, `${description} must be an array of strings`);
	}
	const strings = value.map((entry) => entry.trim());
	if (strings.some((entry) => entry.length === 0)) {
		throw invalidConfig(path, `${description} must not contain blank strings`);
	}
	return strings;
}

function invalidConfig(path: string, detail: string): Error {
	return new Error(`Invalid changelog configuration at "${path}": ${detail}.`);
}
