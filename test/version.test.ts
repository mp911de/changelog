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

import { type RepoRefs, resolveAutoRange, type ResolvedRange } from "../src/version.js";

function repo(overrides: Partial<RepoRefs>): RepoRefs {
	return {
		tags: async () => [],
		resolveBranch: async () => undefined,
		...overrides,
	};
}

// A maintenance-branch stub for "4.0.x" that returns the same spelling as ref and label; the
// fully-qualified ref the real Git adapter produces is exercised in git-tags.test.ts.
function branch(label: string): RepoRefs["resolveBranch"] {
	return async (name) => (name === "4.0.x" ? { ref: label, label } : undefined);
}

// Flatten a resolved range to its bound refs for the value assertions; bound kind and label are
// asserted separately where they matter.
function range(resolved: ResolvedRange): { from: string; to: string } {
	return { from: resolved.from.ref, to: resolved.to.ref };
}

describe("resolveAutoRange", () => {
	it("resolves a patch to its predecessor and the maintenance branch tip", async () => {
		const refs = repo({
			tags: async () => ["4.0.5", "4.0.6"],
			resolveBranch: branch("origin/4.0.x"),
		});

		expect(range(await resolveAutoRange("4.0.7", refs))).toEqual({
			from: "4.0.6",
			to: "origin/4.0.x",
		});
	});

	it("carries each bound's kind and display label", async () => {
		const refs = repo({
			tags: async () => ["4.0.5", "4.0.6"],
			resolveBranch: async (name) =>
				name === "4.0.x"
					? { ref: "refs/remotes/origin/4.0.x", label: "origin/4.0.x" }
					: undefined,
		});

		const { from, to } = await resolveAutoRange("4.0.7", refs);
		expect(from).toEqual({ ref: "4.0.6", label: "4.0.6", kind: "tag" });
		expect(to).toEqual({
			ref: "refs/remotes/origin/4.0.x",
			label: "origin/4.0.x",
			kind: "branch",
		});
	});

	it("resolves a minor line-opener to the previous line's opener and HEAD", async () => {
		const refs = repo({ tags: async () => ["4.0.0", "4.0.5", "4.0.6"] });

		const resolved = await resolveAutoRange("4.1.0", refs);
		expect(range(resolved)).toEqual({ from: "4.0.0", to: "HEAD" });
		expect(resolved.to).toEqual({ ref: "HEAD", label: "HEAD", kind: "head" });
	});

	it("fails with a gap when a minor's predecessor opener is missing", async () => {
		const refs = repo({ tags: async () => ["4.0.0", "4.1.0"] });

		await expect(resolveAutoRange("4.3.0", refs)).rejects.toThrow(
			/Cannot find tag 4\.2\.0/,
		);
	});

	it("resolves a major bump to the previous major's latest line opener and HEAD", async () => {
		const refs = repo({ tags: async () => ["3.4.0", "3.5.0", "3.5.1"] });

		expect(range(await resolveAutoRange("4.0.0", refs))).toEqual({
			from: "3.5.0",
			to: "HEAD",
		});
	});

	it("treats a bare two-component tag as a within-line counter, not a minor line", async () => {
		// 3.5 is release 5 on the 3.x line (not the minor 3.5.x line), so its line opener is 3.0 and the
		// major changelog spans the whole 3.x line. See CONTEXT.md (Release Line).
		const refs = repo({ tags: async () => ["3.0", "3.1", "3.5"] });

		expect(range(await resolveAutoRange("4.0.0", refs))).toEqual({
			from: "3.0",
			to: "HEAD",
		});
	});

	it("fails with a gap when the previous line opener is missing for a major bump", async () => {
		const refs = repo({ tags: async () => ["3.5.1"] });

		await expect(resolveAutoRange("4.0.0", refs)).rejects.toThrow(
			/Cannot find tag 3\.5\.0/,
		);
	});

	it("regenerates an already-tagged release against its tag", async () => {
		const refs = repo({ tags: async () => ["4.0.4", "4.0.5"] });

		expect(range(await resolveAutoRange("4.0.5", refs))).toEqual({
			from: "4.0.4",
			to: "4.0.5",
		});
	});

	it("ignores pre-releases and matches the predecessor across spellings", async () => {
		const refs = repo({
			tags: async () => ["1.0.0.RELEASE", "1.1.0.RELEASE", "1.2.0-M1"],
		});

		expect(range(await resolveAutoRange("1.2.0", refs))).toEqual({
			from: "1.1.0.RELEASE",
			to: "HEAD",
		});
	});

	it("fails with a gap when the predecessor is missing but releases order below", async () => {
		const refs = repo({
			tags: async () => ["4.0.4", "4.0.5"],
			resolveBranch: async () => ({ ref: "origin/4.0.x", label: "origin/4.0.x" }),
		});

		await expect(resolveAutoRange("4.0.7", refs)).rejects.toThrow(
			/Cannot find tag 4\.0\.6/,
		);
	});

	it("fails as a first release when no release orders below the target", async () => {
		const refs = repo({ tags: async () => [] });

		await expect(resolveAutoRange("4.0.0", refs)).rejects.toThrow(
			/could not determine a previous version/,
		);
	});

	it("fails when a patch has no resolvable maintenance branch", async () => {
		const refs = repo({
			tags: async () => ["4.0.6"],
			resolveBranch: async () => undefined,
		});

		await expect(resolveAutoRange("4.0.7", refs)).rejects.toThrow(
			/no 4\.0\.x branch found/,
		);
	});

	it("matches a bare version against v-prefixed tags and returns the tag spelling", async () => {
		const refs = repo({ tags: async () => ["v4.0.0", "v4.0.1"] });

		expect(range(await resolveAutoRange("4.1.0", refs))).toEqual({
			from: "v4.0.0",
			to: "HEAD",
		});
	});

	it("returns the v-prefixed tag and the bare maintenance branch for a patch", async () => {
		const refs = repo({
			tags: async () => ["v4.0.5", "v4.0.6"],
			resolveBranch: branch("origin/4.0.x"),
		});

		expect(range(await resolveAutoRange("4.0.7", refs))).toEqual({
			from: "v4.0.6",
			to: "origin/4.0.x",
		});
	});

	it("regenerates an already-tagged release across v-prefix spellings", async () => {
		const refs = repo({ tags: async () => ["v4.0.4", "v4.0.5"] });

		expect(range(await resolveAutoRange("4.0.5", refs))).toEqual({
			from: "v4.0.4",
			to: "v4.0.5",
		});
	});

	it("treats a v-prefixed version input the same as the bare version", async () => {
		const refs = repo({ tags: async () => ["4.0.0", "4.0.1"] });

		const bare = await resolveAutoRange("4.1.0", refs);
		expect(await resolveAutoRange("v4.1.0", refs)).toEqual(bare);
		expect(range(bare)).toEqual({ from: "4.0.0", to: "HEAD" });
	});

	it("resolves a first service release from GA to the maintenance branch tip", async () => {
		const refs = repo({
			tags: async () => ["4.0.0"],
			resolveBranch: branch("origin/4.0.x"),
		});

		expect(range(await resolveAutoRange("4.0.0.SR1", refs))).toEqual({
			from: "4.0.0",
			to: "origin/4.0.x",
		});
	});

	it("resolves a later service release from the previous service-release tag", async () => {
		const refs = repo({
			tags: async () => ["4.0.0", "4.0.0.SR1"],
			resolveBranch: branch("origin/4.0.x"),
		});

		expect(range(await resolveAutoRange("4.0.0.SR2", refs))).toEqual({
			from: "4.0.0.SR1",
			to: "origin/4.0.x",
		});
	});

	it("regenerates an already-tagged service release against its tag", async () => {
		const refs = repo({ tags: async () => ["4.0.0", "4.0.0.SR1"] });

		expect(range(await resolveAutoRange("4.0.0.SR1", refs))).toEqual({
			from: "4.0.0",
			to: "4.0.0.SR1",
		});
	});
});
