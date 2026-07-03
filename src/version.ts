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
 * A lone argument is the release target (auto mode): a version, tag, or Service Branch resolved
 * against the repository by {@link resolveAutoRange}. Two arguments or a `<from>..<to>` range
 * supply both bounds explicitly.
 */
export type CliRange =
	| { readonly mode: "auto"; readonly target: string }
	| { readonly mode: "explicit"; readonly from: string; readonly to: string };

/**
 * Interpret the positional arguments. A lone argument is the release target (auto mode); two
 * arguments or a `<from>..<to>` range supply explicit bounds. Git refnames cannot contain "..", so
 * splitting on it is unambiguous; the range and a separate `to` are mutually exclusive. What a
 * target or bound means is decided later against the repository, not here.
 */
export function parseRange(from: string, to: string | undefined): CliRange {
	if (!from.includes("..")) {
		if (to !== undefined) {
			return { mode: "explicit", from, to };
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
 * Supplies the repository's refs to {@link resolveAutoRange} and {@link resolveExplicitBound},
 * isolating them from Git.
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

	/**
	 * Resolve {@code input} as a Git revision using Git's own resolution rules: its
	 * {@link RefKind} when it names a commit, or undefined when it does not.
	 */
	resolveRevision(input: string): Promise<RefKind | undefined>;
}

/**
 * One end of a resolved commit range. {@link ref} is the unambiguous revision passed to Git;
 * {@link label} is its display spelling — the normalized form when the bound was resolved through
 * a fallback (the matched tag for a version, `origin/4.0.x` for a bare branch name); {@link kind}
 * is its git-resolved {@link RefKind}.
 */
export interface ResolvedBound {
	readonly ref: string;
	readonly label: string;
	readonly kind: RefKind;
}

export interface ResolvedRange {
	readonly from: ResolvedBound;
	readonly to: ResolvedBound;
}

function tagBound(raw: string): ResolvedBound {
	return { ref: raw, label: raw, kind: "tag" };
}

function branchBound(branch: ResolvedBranch): ResolvedBound {
	return { ref: branch.ref, label: branch.label, kind: "branch" };
}

// A Service Branch name (4.0.x, or deeper lines like 4.0.1.x) always denotes a branch, never a
// version: "4.0.x" would otherwise parse as version 4.0 with an unknown "x" qualifier.
const SERVICE_BRANCH_NAME = /^\d+(?:\.\d+)*\.x$/;

/**
 * Resolve the commit range for releasing {@code input}, interpreting it in order: a Service
 * Branch name releases what accumulated on that line since its latest release, and anything else
 * is read as a version — a tag spelling its own version, or a version resolved against the tags.
 * The upper bound is the matching tag, the Service Branch tip for a patch, or HEAD for a
 * line-opener; the lower bound is the Predecessor, which must exist. A revision that matches but
 * cannot infer a lower bound (a plain branch, a commit, a tag that spells no version) falls
 * through to the next interpretation and only fails when none completes.
 */
export async function resolveAutoRange(
	input: string,
	repo: RepoRefs,
): Promise<ResolvedRange> {
	if (SERVICE_BRANCH_NAME.test(input)) {
		const branch = await repo.resolveBranch(input);
		if (branch === undefined) {
			throw new Error(
				`no ${input} branch found; check out the branch or pass <from> <to>`,
			);
		}
		return resolveLineRange(input, branch, repo);
	}

	const target = parseArtifactVersion(input);
	if (target !== null) {
		return resolveVersionRange(target, repo);
	}
	throw new Error(await describeAutoFailure(input, repo));
}

async function resolveVersionRange(
	target: ArtifactVersion,
	repo: RepoRefs,
): Promise<ResolvedRange> {
	const tags = parseTags(await repo.tags());
	const to = await resolveUpperBound(target, tags, repo);
	const from = resolveLowerBound(target, tags);
	return { from, to };
}

/**
 * Resolve a Service Branch input: the branch tip is the upper bound and the line's latest release
 * tag the lower bound. A line without a release tag is a first release, which needs explicit
 * bounds; silently widening to another line would hide that.
 */
async function resolveLineRange(
	name: string,
	branch: ResolvedBranch,
	repo: RepoRefs,
): Promise<ResolvedRange> {
	let highest: ArtifactVersion | undefined;
	for (const version of parseTags(await repo.tags())) {
		if (!version.isRelease || serviceBranch(version) !== name) {
			continue;
		}
		if (highest === undefined || compareVersions(version, highest) > 0) {
			highest = version;
		}
	}
	if (highest === undefined) {
		throw new Error(
			`no release tag found on the ${name} line; pass <from> <to> or a <from>..<to> range`,
		);
	}
	return { from: tagBound(highest.raw), to: branchBound(branch) };
}

/**
 * The most specific failure for an auto-mode input no interpretation completed: what the input
 * resolved to and why that cannot infer a lower bound, or that it resolved to nothing at all.
 */
async function describeAutoFailure(input: string, repo: RepoRefs): Promise<string> {
	const guidance = "pass <from> <to> or a <from>..<to> range";
	const revision = await repo.resolveRevision(input);
	if (revision === "tag") {
		return `tag "${input}" is not a recognized version; ${guidance}`;
	}
	if (revision === "branch") {
		// A remote-tracking spelling of a Service Branch carries its line name after the remote.
		const line = input.slice(input.indexOf("/") + 1);
		if (SERVICE_BRANCH_NAME.test(line)) {
			return `cannot infer a lower bound for branch "${input}"; pass its line name ${line} or an explicit <from> <to> range`;
		}
		return `cannot infer a lower bound for branch "${input}"; ${guidance}`;
	}
	if (revision !== undefined) {
		const subject = revision === "head" ? "HEAD" : `commit "${input}"`;
		return `cannot infer a lower bound for ${subject}; ${guidance}`;
	}
	const branch = await repo.resolveBranch(input);
	if (branch !== undefined) {
		return `cannot infer a lower bound for branch "${branch.label}"; ${guidance}`;
	}
	return `"${input}" is not a Git revision, branch, or version; ${guidance}`;
}

/**
 * Resolve one explicit bound, interpreting it in order: a Git revision as spelled (commit, tag,
 * branch, HEAD, or a revision expression like {@code v1.0.0~2}), a bare branch name resolved
 * against local and remote-tracking refs, and finally a version resolved through the tags. As a
 * version, the {@code to} side reuses the full auto-mode upper-bound chain (matching tag, Service
 * Branch tip, HEAD for a line-opener) while the {@code from} side must name an existing tag,
 * because an untagged version denotes no commit to scan from.
 */
export async function resolveExplicitBound(
	input: string,
	side: "from" | "to",
	repo: RepoRefs,
): Promise<ResolvedBound> {
	const revision = await repo.resolveRevision(input);
	if (revision !== undefined) {
		return { ref: input, label: input, kind: revision };
	}
	const branch = await repo.resolveBranch(input);
	if (branch !== undefined) {
		return branchBound(branch);
	}
	const version = parseArtifactVersion(input);
	if (version === null || SERVICE_BRANCH_NAME.test(input)) {
		throw new Error(`"${input}" is not a Git revision, branch, or version`);
	}
	const tags = parseTags(await repo.tags());
	if (side === "to") {
		return resolveUpperBound(version, tags, repo);
	}
	const tagged = taggedVersion(version, tags);
	if (tagged === undefined) {
		throw new Error(`no tag matches version "${input}"`);
	}
	return tagBound(tagged.raw);
}

function parseTags(raw: readonly string[]): ArtifactVersion[] {
	return raw
		.map((tag) => parseArtifactVersion(tag))
		.filter((version): version is ArtifactVersion => version !== null);
}

/**
 * The tag releasing {@code target}, preferring the exact spelling over an equivalent one
 * ({@code v4.0.5.RELEASE} for {@code 4.0.5}).
 */
function taggedVersion(
	target: ArtifactVersion,
	tags: readonly ArtifactVersion[],
): ArtifactVersion | undefined {
	return (
		tags.find((version) => version.raw === target.raw) ??
		tags.find((version) => sameVersion(version, target))
	);
}

async function resolveUpperBound(
	target: ArtifactVersion,
	tags: ArtifactVersion[],
	repo: RepoRefs,
): Promise<ResolvedBound> {
	// A tag for this exact version means it is already released: regenerate against that tag.
	const tagged = taggedVersion(target, tags);
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
	return branchBound(resolved);
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
