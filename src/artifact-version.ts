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
 * pads with zeros so `4`, `4.0` and `4.0.0` are equal before applying the stable Qualifier order.
 */
export interface ArtifactVersion {
	readonly raw: string;
	readonly components: readonly number[];
	readonly isRelease: boolean;
	readonly qualifier: VersionQualifier;
}

const SHAPE = /^(\d+(?:\.\d+)*)(?:([.-])(.+))?$/;
const NUMERIC_QUALIFIER = /^\d+(?:\.\d+)*$/;
const SINGLE_SEGMENT_QUALIFIER = /^([a-zA-Z]+)([.-])?(\d*)$/;
const SNAPSHOT_ORDER = 0;
const KNOWN_PRE_RELEASE_OFFSET = 1;
const GENERIC_ORDER = 16;
const RELEASE_ORDER = 17;
const SERVICE_RELEASE_ORDER = 18;
const TYPE_ORDER = new Map<string, number>([
	["", 0],
	["dev", 1],
	["nightly", 2],
	["canary", 3],
	["experimental", 4],
	["alpha", 5],
	["a", 6],
	["beta", 7],
	["b", 8],
	["pre", 9],
	["preview", 10],
	["m", 11],
	["next", 12],
	["rc", 13],
	["cr", 14],
]);

type VersionQualifier =
	| {
			readonly kind: "snapshot" | "pre-release" | "release";
			readonly order: number;
			readonly identifiers: readonly Identifier[];
	  }
	| {
			readonly kind: "generic";
			readonly order: typeof GENERIC_ORDER;
			readonly genericText: string;
	  }
	| {
			readonly kind: "service-release";
			readonly order: typeof SERVICE_RELEASE_ORDER;
			readonly identifiers: readonly Identifier[];
	  };

interface Identifier {
	readonly raw: string;
	readonly numeric?: bigint;
}

const RELEASE_QUALIFIER: VersionQualifier = {
	kind: "release",
	order: RELEASE_ORDER,
	identifiers: [],
};

const SNAPSHOT_QUALIFIER: VersionQualifier = {
	kind: "snapshot",
	order: SNAPSHOT_ORDER,
	identifiers: [],
};

/**
 * Parse {@code raw}; returns {@code null} when it is not a recognized version spelling.
 */
export function parseArtifactVersion(raw: string): ArtifactVersion | null {
	let text = raw.trim();
	if (text.startsWith("v") || text.startsWith("V")) {
		text = text.slice(1);
	}
	const metadataIndex = text.indexOf("+");
	if (metadataIndex !== -1) {
		text = text.slice(0, metadataIndex);
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
	const qualifier = parseQualifier(shape[3]);
	if (qualifier === null) {
		return null;
	}
	return releaseVersion(parts.map(Number), raw, qualifier);
}

/**
 * Classify the qualifier into the stable Artifact Version order.
 */
function parseQualifier(qualifier: string | undefined): VersionQualifier | null {
	if (qualifier === undefined) {
		return RELEASE_QUALIFIER;
	}
	const candidate = qualifier.trim();
	if (candidate === "") {
		return RELEASE_QUALIFIER;
	}
	if (/\s/.test(candidate)) {
		return null;
	}
	const lower = candidate.toLowerCase();
	if (lower === "release" || lower === "final") {
		return RELEASE_QUALIFIER;
	}
	if (lower === "snapshot" || lower === "build-snapshot") {
		return SNAPSHOT_QUALIFIER;
	}
	if (NUMERIC_QUALIFIER.test(candidate)) {
		return knownQualifier("", candidate.split("."));
	}

	const single = SINGLE_SEGMENT_QUALIFIER.exec(candidate);
	if (single !== null) {
		return knownQualifier(
			single[1]!.toLowerCase(),
			single[3] === "" ? [] : [single[3]!],
			candidate,
		);
	}

	const segments = candidate.replaceAll("-", ".").split(".");
	if (segments.length >= 2 && !isNumeric(segments[0]!)) {
		const [type, ...identifiers] = segments;
		return knownQualifier(type!.toLowerCase(), identifiers, candidate);
	}

	return { kind: "generic", order: GENERIC_ORDER, genericText: candidate };
}

function knownQualifier(
	type: string,
	identifiers: readonly string[],
	fallbackText?: string,
): VersionQualifier {
	if (type === "sr") {
		return {
			kind: "service-release",
			order: SERVICE_RELEASE_ORDER,
			identifiers: identifiers.map(identifier),
		};
	}
	const typeOrder = TYPE_ORDER.get(type);
	if (typeOrder === undefined) {
		return {
			kind: "generic",
			order: GENERIC_ORDER,
			genericText: fallbackText ?? [type, ...identifiers].join("."),
		};
	}
	return {
		kind: "pre-release",
		order: KNOWN_PRE_RELEASE_OFFSET + typeOrder,
		identifiers: identifiers.map(identifier),
	};
}

function identifier(raw: string): Identifier {
	return isNumeric(raw) ? { raw, numeric: BigInt(raw) } : { raw };
}

function isNumeric(value: string): boolean {
	return /^\d+$/.test(value);
}

/**
 * The version that must immediately precede {@code version}: decrement its last significant (non-zero)
 * component and zero the rest. Returns {@code null} when every component is zero (no predecessor).
 */
export function predecessor(version: ArtifactVersion): ArtifactVersion | null {
	const qualifier = version.qualifier;
	if (qualifier.kind === "service-release") {
		return previousServiceRelease(version, qualifier);
	}

	const components = [...version.components];
	let last = components.length - 1;
	while (last >= 0 && components[last] === 0) {
		last--;
	}
	if (last < 0) {
		return null;
	}
	components[last] = components[last]! - 1;
	return releaseVersion(components);
}

function previousServiceRelease(
	version: ArtifactVersion,
	qualifier: Extract<VersionQualifier, { kind: "service-release" }>,
): ArtifactVersion {
	const counter = qualifier.identifiers[0];
	if (counter?.numeric !== undefined && counter.numeric > 1n) {
		const previous = (counter.numeric - 1n).toString();
		return releaseVersion(
			version.components,
			`${version.components.join(".")}.SR${previous}`,
			{
				kind: "service-release",
				order: SERVICE_RELEASE_ORDER,
				identifiers: [identifier(previous)],
			},
		);
	}
	return releaseVersion(version.components);
}

/**
 * Whether {@code version} opens a Release Line rather than advancing one: a trailing-zero last
 * component (`4.1.0`, `4.0`) or a single component (`4`). Line-openers take HEAD as their upper
 * bound; everything else is a patch resolved against a {@link maintenanceBranch}.
 */
export function isLineOpener(version: ArtifactVersion): boolean {
	if (version.qualifier.kind === "service-release") {
		return false;
	}
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
	if (version.qualifier.kind === "service-release") {
		return false;
	}
	return version.components.slice(1).every((component) => component === 0);
}

/**
 * The maintenance branch name for a patch {@code version}: its last component replaced by `x`.
 */
export function maintenanceBranch(version: ArtifactVersion): string {
	return [...version.components.slice(0, -1), "x"].join(".");
}

/**
 * Order two versions by their numeric components and stable Qualifier order.
 */
export function compareVersions(left: ArtifactVersion, right: ArtifactVersion): number {
	const componentComparison = compareComponents(left.components, right.components);
	return componentComparison !== 0
		? componentComparison
		: compareQualifiers(left.qualifier, right.qualifier);
}

/**
 * Whether two versions denote the same Artifact Version, allowing equivalent GA spellings.
 */
export function sameVersion(left: ArtifactVersion, right: ArtifactVersion): boolean {
	return compareVersions(left, right) === 0;
}

export function releaseVersion(
	components: readonly number[],
	raw = components.join("."),
	qualifier: VersionQualifier = RELEASE_QUALIFIER,
): ArtifactVersion {
	return {
		raw,
		components: [...components],
		isRelease: qualifier.kind === "release" || qualifier.kind === "service-release",
		qualifier,
	};
}

function compareComponents(left: readonly number[], right: readonly number[]): number {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const comparison = compare(left[index] ?? 0, right[index] ?? 0);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

function compareQualifiers(left: VersionQualifier, right: VersionQualifier): number {
	const orderComparison = compare(left.order, right.order);
	if (orderComparison !== 0) {
		return orderComparison;
	}
	if (left.kind === "generic" && right.kind === "generic") {
		return compareGenericText(left.genericText, right.genericText);
	}
	if ("identifiers" in left && "identifiers" in right) {
		return compareIdentifiers(left.identifiers, right.identifiers);
	}
	return 0;
}

function compareIdentifiers(
	left: readonly Identifier[],
	right: readonly Identifier[],
): number {
	const count = Math.min(left.length, right.length);
	for (let index = 0; index < count; index++) {
		const comparison = compareIdentifier(left[index]!, right[index]!);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return compare(left.length, right.length);
}

function compareIdentifier(left: Identifier, right: Identifier): number {
	if (left.numeric !== undefined && right.numeric !== undefined) {
		return compare(left.numeric, right.numeric);
	}
	if (left.numeric !== undefined || right.numeric !== undefined) {
		return left.numeric !== undefined ? -1 : 1;
	}
	return compare(left.raw, right.raw);
}

function compareGenericText(left: string, right: string): number {
	const lowerComparison = compare(left.toLowerCase(), right.toLowerCase());
	return lowerComparison !== 0 ? lowerComparison : compare(left, right);
}

/**
 * Three-way comparison for any relationally-ordered primitive, yielding -1, 0, or 1.
 */
function compare<T extends string | number | bigint>(left: T, right: T): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}
