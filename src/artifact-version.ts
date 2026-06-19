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

/**
 * A tag or release target parsed from any supported spelling. {@link components} are the numeric
 * parts as written (unpadded) so a Maintenance Branch and Predecessor can be derived; comparison
 * pads with zeros so `4`, `4.0` and `4.0.0` are equal. Parsing is a preparatory stage — the
 * selection rules work on the numeric form and the Release/Pre-release flag.
 */
export interface ArtifactVersion {
	readonly raw: string;
	readonly components: readonly number[];
	readonly isRelease: boolean;
}

const SHAPE = /^(\d+(?:\.\d+)*)(?:([.-])(.+))?$/;

/**
 * Parse {@code raw}; returns {@code null} when it is not a recognized version spelling.
 */
export function parseArtifactVersion(raw: string): ArtifactVersion | null {
	let text = raw.trim();
	if (text.startsWith("v") || text.startsWith("V")) {
		text = text.slice(1);
	}

	const shape = SHAPE.exec(text);
	if (shape === null) {
		return null;
	}
	const parts = shape[1]!.split(".");
	// Reject leading zeros (e.g. "04") to match conventional version syntax.
	if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
		return null;
	}
	const release = classify(shape[2], shape[3]);
	if (release === null) {
		return null;
	}
	return { raw, components: parts.map(Number), isRelease: release };
}

/**
 * Classify the qualifier: `true` Release, `false` Pre-release, `null` unrecognized.
 */
function classify(
	separator: string | undefined,
	qualifier: string | undefined,
): boolean | null {
	if (qualifier === undefined) {
		return true;
	}
	// A hyphen qualifier follows SemVer: always a pre-release.
	if (separator === "-") {
		return false;
	}
	const upper = qualifier.toUpperCase();
	if (upper === "RELEASE" || upper === "FINAL") {
		return true;
	}
	if (
		/^M\d+$/.test(upper) ||
		/^RC\d+$/.test(upper) ||
		upper === "SNAPSHOT" ||
		upper === "BUILD-SNAPSHOT"
	) {
		return false;
	}
	return null;
}

/**
 * The version that must immediately precede {@code version}: decrement its last significant (non-zero)
 * component and zero the rest. Returns {@code null} when every component is zero (no predecessor).
 */
export function predecessor(version: ArtifactVersion): ArtifactVersion | null {
	const components = [...version.components];
	let last = components.length - 1;
	while (last >= 0 && components[last] === 0) {
		last--;
	}
	if (last < 0) {
		return null;
	}
	components[last] = components[last]! - 1;
	return { raw: components.join("."), components, isRelease: true };
}

/**
 * Whether {@code version} opens a Release Line rather than advancing one: a trailing-zero last
 * component (`4.1.0`, `4.0`) or a single component (`4`). Line-openers take HEAD as their upper
 * bound; everything else is a patch resolved against a {@link maintenanceBranch}.
 */
export function isLineOpener(version: ArtifactVersion): boolean {
	return (
		version.components.length < 2 ||
		version.components[version.components.length - 1] === 0
	);
}

/**
 * Whether {@code version} opens a new major line (`4`, `4.0`, `4.0.0`): every component after the
 * major is zero. A major opener is the one case whose Predecessor cannot be derived by arithmetic,
 * since the previous major's latest line (for example `3.5`) is unknown from the version alone and
 * must be discovered from the tags. Every other version (patch or minor) resolves arithmetically.
 */
export function isMajorOpener(version: ArtifactVersion): boolean {
	return version.components.slice(1).every((component) => component === 0);
}

/**
 * The maintenance branch name for a patch {@code version}: its last component replaced by `x`.
 */
export function maintenanceBranch(version: ArtifactVersion): string {
	return [...version.components.slice(0, -1), "x"].join(".");
}

/**
 * Order two versions by their numeric components, padding the shorter with zeros.
 */
export function compareVersions(left: ArtifactVersion, right: ArtifactVersion): number {
	return compareComponents(left.components, right.components);
}

/**
 * Whether two versions denote the same numeric release, padding the shorter with zeros.
 */
export function sameVersion(left: ArtifactVersion, right: ArtifactVersion): boolean {
	return compareComponents(left.components, right.components) === 0;
}

function compareComponents(left: readonly number[], right: readonly number[]): number {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference < 0 ? -1 : 1;
		}
	}
	return 0;
}
