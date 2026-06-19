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

import {
	compareVersions,
	isLineOpener,
	maintenanceBranch,
	parseArtifactVersion,
	predecessor,
	sameVersion,
} from "../src/artifact-version.js";

function parse(raw: string) {
	return parseArtifactVersion(raw)!;
}

describe("parseArtifactVersion", () => {
	it("treats v-prefix, trailing-zero and .RELEASE/.Final spellings as the same release", () => {
		const forms = [
			"4.0.0",
			"4.0",
			"4",
			"v4.0.0",
			"V4.0",
			"4.0.0.RELEASE",
			"4.0.0.Final",
		];
		const parsed = forms.map(parseArtifactVersion);

		expect(parsed.every((version) => version !== null && version.isRelease)).toBe(
			true,
		);
		const base = parsed[0]!;
		expect(parsed.every((version) => sameVersion(version!, base))).toBe(true);
	});

	it("classifies milestones, RCs, and snapshots as pre-releases", () => {
		for (const pre of [
			"4.0.0.M1",
			"4.0.0.RC1",
			"4.0.0.BUILD-SNAPSHOT",
			"4.0.0-RC1",
			"4.0.0-M2",
			"4.0.0-SNAPSHOT",
		]) {
			expect(parseArtifactVersion(pre)?.isRelease).toBe(false);
		}
	});

	it("rejects spellings that are not recognized versions, including .SR service releases", () => {
		const junkForms = [
			"nightly",
			"release-4",
			"4.0.0.RELEASED",
			"4.0.0.FOO",
			"04.0.0",
			"4.0.0.SR1",
			"v4.0.0.SR3",
			"",
			// A SemVer `+build` suffix is not a recognized Artifact Version spelling; it is not stripped.
			"4.0.0+build",
			"v4.0.0+exp.sha.5114f85",
		];
		for (const junk of junkForms) {
			expect(parseArtifactVersion(junk)).toBeNull();
		}
	});
});

describe("predecessor", () => {
	it("decrements the last significant component, zero-filling the rest", () => {
		const cases: [string, string][] = [
			["4.0.7", "4.0.6"],
			["4.1.0", "4.0.0"],
			["4.0.0", "3.0.0"],
			["1.2.3.4", "1.2.3.3"],
			["4.1", "4.0"],
			["1.0", "0.0"],
		];
		for (const [input, expected] of cases) {
			expect(sameVersion(predecessor(parse(input))!, parse(expected))).toBe(true);
		}
	});

	it("has no predecessor when every component is zero", () => {
		expect(predecessor(parse("0.0.0"))).toBeNull();
		expect(predecessor(parse("0"))).toBeNull();
	});
});

describe("upper-bound shape", () => {
	it("treats a trailing-zero or single-component version as a line-opener", () => {
		for (const opener of ["4.1.0", "4.0.0", "1.0", "4.0", "4"]) {
			expect(isLineOpener(parse(opener))).toBe(true);
		}
		for (const patch of ["4.0.7", "1.2.3.4", "4.0.1", "4.1"]) {
			expect(isLineOpener(parse(patch))).toBe(false);
		}
	});

	it("derives the maintenance branch by replacing the last component with x", () => {
		expect(maintenanceBranch(parse("4.0.7"))).toBe("4.0.x");
		expect(maintenanceBranch(parse("1.2.3.4"))).toBe("1.2.3.x");
		expect(maintenanceBranch(parse("4.1"))).toBe("4.x");
	});
});

describe("compareVersions", () => {
	it("orders by numeric components, padding the shorter with zeros", () => {
		expect(compareVersions(parse("4.0.6"), parse("4.0.7"))).toBeLessThan(0);
		expect(compareVersions(parse("4.0"), parse("4.0.0"))).toBe(0);
		expect(compareVersions(parse("4.1.0"), parse("4.0.9"))).toBeGreaterThan(0);
	});
});
