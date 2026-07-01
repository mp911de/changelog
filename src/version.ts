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

import { InvalidArgumentError } from "commander";

import {
	type ArtifactVersion,
	compareVersions,
	isInferablePreRelease,
	isLineOpener,
	isMajorOpener,
	isNonReleaseVersion,
	parseArtifactVersion,
	preReleasePredecessorCandidates,
	predecessor,
	releaseVersion,
	requiresExactPreReleasePredecessor,
	sameNumericComponents,
	samePreReleaseFamily,
	sameVersion,
	serviceBranch,
} from "./artifact-version.js";
import type { RefKind } from "./git.js";

/**
 * A lone version is the release target (auto mode); the lower bound is resolved from tags and the
 * upper bound is the matching tag or HEAD. Two arguments or a `<from>..<to>` range supply both
 * bounds explicitly.
 */
export type CliRange =
	| { readonly mode: "auto"; readonly target: string }
	| { readonly mode: "explicit"; readonly from: string; readonly to: string };

/**
 * Interpret the positional arguments. A lone version is the release target (auto mode); two
 * arguments or a `<from>..<to>` range supply explicit bounds. Git refnames cannot contain "..", so
 * splitting on it is unambiguous; the range and a separate `to` are mutually exclusive.
 */
export function parseRange(from: string, to: string | undefined): CliRange {
	if (!from.includes("..")) {
		if (to !== undefined) {
			return { mode: "explicit", from, to };
		}
		if (parseArtifactVersion(from) === null) {
			throw new InvalidArgumentError(
				`"${from}" is not a recognized version; pass <from> <to> or a <from>..<to> range`,
			);
		}
		return { mode: "auto", target: from };
	}
	if (to !== undefined) {
		throw new InvalidArgumentError(
			"specify the range once: either <from>..<to> or <from> <to>, not both",
		);
	}
	if (from.includes("...")) {
		throw new InvalidArgumentError(
			`invalid range "${from}": use two dots, e.g. 4.0.0..4.0.4`,
		);
	}
	if (from.indexOf("..") !== from.lastIndexOf("..")) {
		throw new InvalidArgumentError(
			`invalid range "${from}": use a single <from>..<to>`,
		);
	}
	const separator = from.indexOf("..");
	const lower = from.slice(0, separator);
	const upper = from.slice(separator + 2);
	if (lower === "") {
		throw new InvalidArgumentError(
			`invalid range "${from}": missing <from> before ".."`,
		);
	}
	return { mode: "explicit", from: lower, to: upper === "" ? "HEAD" : upper };
}

/**
 * A Service Branch resolved against the repository: an unambiguous {@link ref} to feed `git log`
 * and `git rev-parse`, plus the human {@link label} to show in the header. The two differ for a
 * local branch (`refs/heads/4.0.x` vs `4.0.x`) so a same-named tag cannot shadow the branch in a
 * bare `git log 4.0.4..4.0.x`.
 */
export interface ResolvedBranch {
	readonly ref: string;
	readonly label: string;
}

/**
 * Supplies the repository's refs to {@link resolveAutoRange}, isolating it from Git.
 */
export interface RepoRefs {
	/**
	 * Every tag in the repository (`git tag`).
	 */
	tags(): Promise<readonly string[]>;

	/**
	 * Resolve a Service Branch name to a usable revision (local or remote-tracking), or undefined.
	 */
	resolveBranch(name: string): Promise<ResolvedBranch | undefined>;
}

/**
 * One end of a resolved commit range. {@link ref} is the unambiguous revision passed to Git;
 * {@link label} is its display spelling; {@link kind} is its git-resolved {@link RefKind} when the
 * resolver already knows it (always in auto mode), and {@code undefined} for an explicit bound whose
 * kind the caller classifies only when a header will render it.
 */
export interface ResolvedBound {
	readonly ref: string;
	readonly label: string;
	readonly kind?: RefKind;
}

export interface ResolvedRange {
	readonly from: ResolvedBound;
	readonly to: ResolvedBound;
}

function tagBound(raw: string): ResolvedBound {
	return { ref: raw, label: raw, kind: "tag" };
}

/**
 * Resolve the commit range for releasing {@code input}. {@code input} must be a recognized version
 * (callers validate this up front). The upper bound is the matching tag, the Service Branch tip
 * for a patch, or HEAD for a line-opener; the lower bound is the Predecessor, which must exist.
 */
export async function resolveAutoRange(
	input: string,
	repo: RepoRefs,
): Promise<ResolvedRange> {
	const target = parseArtifactVersion(input);
	if (target === null) {
		throw new Error(`"${input}" is not a recognized version`);
	}

	const tags = (await repo.tags())
		.map((raw) => parseArtifactVersion(raw))
		.filter((version): version is ArtifactVersion => version !== null);

	const to = await resolveUpperBound(target, tags, repo);
	const from = resolveLowerBound(target, tags);
	return { from, to };
}

async function resolveUpperBound(
	target: ArtifactVersion,
	tags: ArtifactVersion[],
	repo: RepoRefs,
): Promise<ResolvedBound> {
	// A tag for this exact version means it is already released: regenerate against that tag.
	const tagged =
		tags.find((version) => version.raw === target.raw) ??
		tags.find((version) => sameVersion(version, target));
	if (tagged !== undefined) {
		return tagBound(tagged.raw);
	}
	// A line-opener is developed on the current checkout; a patch comes off its Service Branch.
	if (isLineOpener(target)) {
		return { ref: "HEAD", label: "HEAD", kind: "head" };
	}
	const branch = serviceBranch(target);
	const resolved = await repo.resolveBranch(branch);
	if (resolved === undefined) {
		throw new Error(
			`no ${branch} service branch found for ${target.raw}; check out the service branch or pass <from> <to>`,
		);
	}
	return { ref: resolved.ref, label: resolved.label, kind: "branch" };
}

interface LowerBound {
	// The resolved Predecessor tag, or undefined when no matching release tag exists.
	readonly tag?: string;
	// The version that was expected, for the Gap diagnostic.
	readonly expected?: string;
}

function resolveLowerBound(
	target: ArtifactVersion,
	tags: ArtifactVersion[],
): ResolvedBound {
	const releases = tags.filter((version) => version.isRelease);

	const lower =
		nonReleaseLowerBound(target, tags, releases) ??
		releaseLowerBound(target, releases);
	if (lower.tag !== undefined) {
		return tagBound(lower.tag);
	}

	// No matching tag: distinguish a Gap (releases order below) from a first release (none do).
	if (releases.some((version) => compareVersions(version, target) < 0)) {
		throw new Error(
			`Cannot find tag ${lower.expected ?? "for the previous version"}. Pass <from> <to> explicitly.`,
		);
	}
	throw new Error(
		`could not determine a previous version for ${target.raw}; pass <from> <to> or <from>..<to> explicitly.`,
	);
}

function releaseLowerBound(
	target: ArtifactVersion,
	releases: readonly ArtifactVersion[],
): LowerBound {
	// Patches and minors resolve to their exact arithmetic Predecessor, which must be tagged: 4.0.4
	// against 4.0.3, 4.1.0 against 4.0.0, 4.3.0 against 4.2.0 (a Gap when 4.2.0 is missing). Only a
	// major opener cannot be derived arithmetically, so it discovers the previous major's latest line
	// from the tags (4.0.0 against 3.5.0).
	return isMajorOpener(target)
		? previousLineOpener(target, releases)
		: exactPredecessor(target, releases);
}

function nonReleaseLowerBound(
	target: ArtifactVersion,
	tags: readonly ArtifactVersion[],
	releases: readonly ArtifactVersion[],
): LowerBound | undefined {
	if (!isNonReleaseVersion(target)) {
		return undefined;
	}
	if (!isInferablePreRelease(target)) {
		return {};
	}
	const exact = exactPreReleasePredecessor(target, tags);
	if (exact.tag !== undefined) {
		return exact;
	}
	if (requiresExactPreReleasePredecessor(target)) {
		return exact;
	}
	const lower = highestLowerPreRelease(target, tags);
	return lower.tag !== undefined ? lower : releaseLowerBound(target, releases);
}

function exactPreReleasePredecessor(
	target: ArtifactVersion,
	tags: readonly ArtifactVersion[],
): LowerBound {
	const candidates = preReleasePredecessorCandidates(target);
	for (const candidate of candidates) {
		const match = tags.find((version) => sameVersion(version, candidate));
		if (match !== undefined) {
			return { tag: match.raw, expected: candidates[0]?.raw };
		}
	}
	return { expected: candidates[0]?.raw };
}

function highestLowerPreRelease(
	target: ArtifactVersion,
	tags: readonly ArtifactVersion[],
): LowerBound {
	let highest: ArtifactVersion | undefined;
	for (const version of tags) {
		if (
			!isInferablePreRelease(version) ||
			!sameNumericComponents(version, target) ||
			samePreReleaseFamily(version, target) ||
			compareVersions(version, target) >= 0
		) {
			continue;
		}
		if (highest === undefined || compareVersions(version, highest) > 0) {
			highest = version;
		}
	}
	return { tag: highest?.raw };
}

function exactPredecessor(
	target: ArtifactVersion,
	releases: readonly ArtifactVersion[],
): LowerBound {
	const previous = predecessor(target);
	if (previous === null) {
		return {};
	}
	const match = releases.find((version) => sameVersion(version, previous));
	return { tag: match?.raw, expected: previous.raw };
}

/**
 * The opener of the Release Line preceding a major opener: the latest release below the target
 * reduced to its line opener (last component zeroed). The previous major's latest line is discovered
 * from the tags rather than assumed, so 4.0.0 resolves against 3.5.0 (the latest 3.x line) rather
 * than the arithmetic 3.0.0. Patches and minors never reach here; they resolve arithmetically.
 */
function previousLineOpener(
	target: ArtifactVersion,
	releases: readonly ArtifactVersion[],
): LowerBound {
	let highest: ArtifactVersion | undefined;
	for (const version of releases) {
		if (compareVersions(version, target) >= 0) {
			continue;
		}
		if (highest === undefined || compareVersions(version, highest) > 0) {
			highest = version;
		}
	}
	if (highest === undefined) {
		return {};
	}
	const components = [...highest.components];
	components[components.length - 1] = 0;
	const opener = releaseVersion(components);
	const match = releases.find((version) => sameVersion(version, opener));
	return { tag: match?.raw, expected: opener.raw };
}
