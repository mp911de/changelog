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
	type RepoRefs,
	resolveAutoRange,
	resolveExplicitBound,
	type ResolvedRange,
} from "../src/version.js";

function repo(overrides: Partial<RepoRefs>): RepoRefs {
	return {
		tags: async () => [],
		resolveBranch: async () => undefined,
		resolveRevision: async () => undefined,
		...overrides,
	};
}

// A service-branch stub for "4.0.x" that returns the same spelling as ref and label; the
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
	it("resolves a patch to its predecessor and the service branch tip", async () => {
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

	it("resolves inferable pre-releases from same-version pre-release predecessors", async () => {
		const refs = repo({
			tags: async () => ["4.0.0", "4.1.0-M0", "4.1.0-M1", "4.1.0-M2", "4.1.0-RC1"],
		});
		const cases: readonly [string, string, string][] = [
			["4.1.0-M1", "4.1.0-M0", "4.1.0-M1"],
			["4.1.0-M2", "4.1.0-M1", "4.1.0-M2"],
			["4.1.0-RC1", "4.1.0-M2", "4.1.0-RC1"],
			["4.1.0-RC2", "4.1.0-RC1", "HEAD"],
		];

		for (const [target, from, to] of cases) {
			expect(range(await resolveAutoRange(target, refs))).toEqual({ from, to });
		}
	});

	it("enters inferable pre-release families from lower families or the release predecessor", async () => {
		const refs = repo({
			tags: async () => ["4.0.0", "4.1.0-alpha", "4.1.0-alpha1"],
		});

		expect(
			range(
				await resolveAutoRange("4.1.0-M1", repo({ tags: async () => ["4.0.0"] })),
			),
		).toEqual({
			from: "4.0.0",
			to: "HEAD",
		});
		expect(range(await resolveAutoRange("4.1.0-alpha", refs))).toEqual({
			from: "4.0.0",
			to: "4.1.0-alpha",
		});
		expect(range(await resolveAutoRange("4.1.0-beta", refs))).toEqual({
			from: "4.1.0-alpha1",
			to: "HEAD",
		});
		expect(range(await resolveAutoRange("4.1.0-beta1", refs))).toEqual({
			from: "4.1.0-alpha1",
			to: "HEAD",
		});
	});

	it("prefers same qualifier spelling before aliases for pre-release predecessors", async () => {
		const refs = repo({
			tags: async () => [
				"4.0.0",
				"4.1.0-alpha1",
				"4.1.0-a1",
				"4.1.0-RC1",
				"4.1.0-CR1",
			],
		});

		expect(range(await resolveAutoRange("4.1.0-alpha2", refs))).toEqual({
			from: "4.1.0-alpha1",
			to: "HEAD",
		});
		expect(range(await resolveAutoRange("4.1.0-a2", refs))).toEqual({
			from: "4.1.0-a1",
			to: "HEAD",
		});
		expect(range(await resolveAutoRange("4.1.0-RC2", refs))).toEqual({
			from: "4.1.0-RC1",
			to: "HEAD",
		});
		expect(range(await resolveAutoRange("4.1.0-CR2", refs))).toEqual({
			from: "4.1.0-CR1",
			to: "HEAD",
		});
	});

	it("fails with a gap when a numbered pre-release predecessor is missing", async () => {
		await expect(
			resolveAutoRange(
				"4.1.0-M3",
				repo({ tags: async () => ["4.0.0", "4.1.0-M1"] }),
			),
		).rejects.toThrow(/Cannot find tag 4\.1\.0-M2/);
		await expect(
			resolveAutoRange(
				"4.1.0-RC2",
				repo({ tags: async () => ["4.0.0", "4.1.0-M2"] }),
			),
		).rejects.toThrow(/Cannot find tag 4\.1\.0-RC1/);
	});

	it("requires explicit bounds for non-inferable pre-release targets", async () => {
		const refs = repo({ tags: async () => ["4.0.0"] });

		for (const target of [
			"4.1.0-dev",
			"4.1.0-nightly",
			"4.1.0-SNAPSHOT",
			"4.1.0-1",
			"4.1.0-foo",
		]) {
			await expect(resolveAutoRange(target, refs)).rejects.toThrow(
				/Cannot find tag for the previous version/,
			);
		}
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

	it("fails when a patch has no resolvable service branch", async () => {
		const refs = repo({
			tags: async () => ["4.0.6"],
			resolveBranch: async () => undefined,
		});

		await expect(resolveAutoRange("4.0.7", refs)).rejects.toThrow(
			/no 4\.0\.x service branch found/,
		);
	});

	it("matches a bare version against v-prefixed tags and returns the tag spelling", async () => {
		const refs = repo({ tags: async () => ["v4.0.0", "v4.0.1"] });

		expect(range(await resolveAutoRange("4.1.0", refs))).toEqual({
			from: "v4.0.0",
			to: "HEAD",
		});
	});

	it("returns the v-prefixed tag and the bare service branch for a patch", async () => {
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

	it("resolves a first service release from GA to the service branch tip", async () => {
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

describe("resolveAutoRange ordered input resolution", () => {
	it("resolves a service branch input from the line's latest release to the branch tip", async () => {
		const refs = repo({
			tags: async () => ["v4.0.5.RELEASE", "v4.0.6.RELEASE", "4.1.0", "4.0.7-M1"],
			resolveBranch: branch("origin/4.0.x"),
		});

		const { from, to } = await resolveAutoRange("4.0.x", refs);
		expect(from).toEqual({
			ref: "v4.0.6.RELEASE",
			label: "v4.0.6.RELEASE",
			kind: "tag",
		});
		expect(to).toEqual({
			ref: "origin/4.0.x",
			label: "origin/4.0.x",
			kind: "branch",
		});
	});

	it("resolves a deeper line branch by its full line name", async () => {
		const refs = repo({
			tags: async () => ["4.0.1.1", "4.0.1.2", "4.0.2.1"],
			resolveBranch: async (name) =>
				name === "4.0.1.x" ? { ref: "4.0.1.x", label: "4.0.1.x" } : undefined,
		});

		expect(range(await resolveAutoRange("4.0.1.x", refs))).toEqual({
			from: "4.0.1.2",
			to: "4.0.1.x",
		});
	});

	it("fails when a line branch has no release tag yet", async () => {
		const refs = repo({
			tags: async () => ["4.0.7-M1", "3.9.0"],
			resolveBranch: branch("origin/4.0.x"),
		});

		await expect(resolveAutoRange("4.0.x", refs)).rejects.toThrow(
			/no release tag found on the 4\.0\.x line/,
		);
	});

	it("fails when a line branch does not exist anywhere", async () => {
		await expect(resolveAutoRange("9.9.x", repo({}))).rejects.toThrow(
			/no 9\.9\.x branch found/,
		);
	});

	it("falls through to the version when a branch shadows a version spelling", async () => {
		const refs = repo({
			tags: async () => ["v4.0.5.RELEASE", "v4.0.6.RELEASE"],
			resolveBranch: branch("origin/4.0.x"),
			resolveRevision: async (input) => (input === "4.0.7" ? "branch" : undefined),
		});

		expect(range(await resolveAutoRange("4.0.7", refs))).toEqual({
			from: "v4.0.6.RELEASE",
			to: "origin/4.0.x",
		});
	});

	it("fails for a tag whose name is not a version", async () => {
		const refs = repo({ resolveRevision: async () => "tag" });

		await expect(resolveAutoRange("release-2024", refs)).rejects.toThrow(
			/tag "release-2024" is not a recognized version/,
		);
	});

	it("fails for a branch that cannot infer a lower bound", async () => {
		const refs = repo({ resolveRevision: async () => "branch" });

		await expect(resolveAutoRange("main", refs)).rejects.toThrow(
			/cannot infer a lower bound for branch "main"/,
		);
	});

	it("points a remote-tracking line spelling at its line name", async () => {
		const refs = repo({ resolveRevision: async () => "branch" });

		await expect(resolveAutoRange("origin/4.0.x", refs)).rejects.toThrow(
			/pass its line name 4\.0\.x/,
		);
	});

	it("fails for commit and HEAD inputs", async () => {
		const commits = repo({ resolveRevision: async () => "commit" });
		await expect(resolveAutoRange("282f9c3", commits)).rejects.toThrow(
			/cannot infer a lower bound for commit "282f9c3"/,
		);

		const head = repo({ resolveRevision: async () => "head" });
		await expect(resolveAutoRange("HEAD", head)).rejects.toThrow(
			/cannot infer a lower bound for HEAD/,
		);
	});

	it("names the remote-tracking branch when only a bare branch name matches", async () => {
		const refs = repo({
			resolveBranch: async () => ({
				ref: "refs/remotes/origin/develop",
				label: "origin/develop",
			}),
		});

		await expect(resolveAutoRange("develop", refs)).rejects.toThrow(
			/cannot infer a lower bound for branch "origin\/develop"/,
		);
	});

	it("fails an input that is neither a revision, branch, nor version", async () => {
		await expect(resolveAutoRange("no-such-thing", repo({}))).rejects.toThrow(
			/"no-such-thing" is not a Git revision, branch, or version/,
		);
	});
});

describe("resolveExplicitBound", () => {
	const TAGS = ["v4.0.4.RELEASE", "v4.0.5.RELEASE"];

	it("passes a resolvable revision through with its kind", async () => {
		const refs = repo({
			resolveRevision: async (input) => (input === "HEAD~2" ? "commit" : undefined),
		});

		expect(await resolveExplicitBound("HEAD~2", "from", refs)).toEqual({
			ref: "HEAD~2",
			label: "HEAD~2",
			kind: "commit",
		});
	});

	it("resolves a bare branch name to its remote-tracking ref", async () => {
		const refs = repo({
			resolveBranch: async (name) =>
				name === "4.0.x"
					? { ref: "refs/remotes/origin/4.0.x", label: "origin/4.0.x" }
					: undefined,
		});

		expect(await resolveExplicitBound("4.0.x", "to", refs)).toEqual({
			ref: "refs/remotes/origin/4.0.x",
			label: "origin/4.0.x",
			kind: "branch",
		});
	});

	it("resolves a version bound to its tag spelling on both sides", async () => {
		const refs = repo({ tags: async () => TAGS });

		expect(await resolveExplicitBound("4.0.5", "from", refs)).toEqual({
			ref: "v4.0.5.RELEASE",
			label: "v4.0.5.RELEASE",
			kind: "tag",
		});
		expect(await resolveExplicitBound("4.0.5", "to", refs)).toEqual({
			ref: "v4.0.5.RELEASE",
			label: "v4.0.5.RELEASE",
			kind: "tag",
		});
	});

	it("resolves an untagged patch to-bound to the service branch tip", async () => {
		const refs = repo({
			tags: async () => TAGS,
			resolveBranch: branch("origin/4.0.x"),
		});

		expect(await resolveExplicitBound("4.0.6", "to", refs)).toEqual({
			ref: "origin/4.0.x",
			label: "origin/4.0.x",
			kind: "branch",
		});
	});

	it("resolves an untagged line-opener to-bound to HEAD", async () => {
		const refs = repo({ tags: async () => TAGS });

		expect(await resolveExplicitBound("4.1.0", "to", refs)).toEqual({
			ref: "HEAD",
			label: "HEAD",
			kind: "head",
		});
	});

	it("fails an untagged patch to-bound without its service branch", async () => {
		const refs = repo({ tags: async () => TAGS });

		await expect(resolveExplicitBound("4.0.6", "to", refs)).rejects.toThrow(
			/no 4\.0\.x service branch found for 4\.0\.6/,
		);
	});

	it("fails an untagged from-bound version", async () => {
		const refs = repo({
			tags: async () => TAGS,
			resolveBranch: branch("origin/4.0.x"),
		});

		await expect(resolveExplicitBound("4.0.6", "from", refs)).rejects.toThrow(
			/no tag matches version "4\.0\.6"/,
		);
	});

	it("fails a bound that is neither a revision, branch, nor version", async () => {
		await expect(
			resolveExplicitBound("no-such-thing", "to", repo({})),
		).rejects.toThrow(/"no-such-thing" is not a Git revision, branch, or version/);
	});

	it("treats an unresolvable line name as a branch, not a version", async () => {
		await expect(resolveExplicitBound("9.9.x", "to", repo({}))).rejects.toThrow(
			/"9\.9\.x" is not a Git revision, branch, or version/,
		);
	});
});
