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

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyRef, listTags, resolveCommit, scanCommits } from "../src/git.js";
import { FixtureRepo } from "./fixture-repo.js";

describe("scanCommits", () => {
	let repo: FixtureRepo;

	beforeEach(() => {
		repo = FixtureRepo.create();
	});

	afterEach(() => {
		repo.cleanup();
	});

	it("returns only commits in from..to, oldest first", async () => {
		const base = repo.commit("base");
		repo.commit("first");
		repo.commit("second");

		const commits = await scanCommits(base, "HEAD", repo.dir);

		expect(commits.map((commit) => commit.shortMessage)).toEqual(["first", "second"]);
	});

	it("traces the git log issued while scanning", async () => {
		const base = repo.commit("base");
		repo.commit("next");
		const traced: string[] = [];

		await scanCommits(base, "HEAD", repo.dir, (command) => traced.push(command));

		expect(traced).toHaveLength(1);
		expect(traced[0]).toMatch(/^git log /);
	});

	it("excludes merge commits", async () => {
		const base = repo.commit("base");
		repo.git("checkout", "-q", "-b", "feature");
		repo.commit("feature work");
		repo.git("checkout", "-q", "main");
		repo.commit("main work");
		repo.git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");

		const commits = await scanCommits(base, "HEAD", repo.dir);

		expect(commits.map((commit) => commit.shortMessage)).not.toContain(
			"Merge feature",
		);
		expect(commits.map((commit) => commit.shortMessage).sort()).toEqual([
			"feature work",
			"main work",
		]);
	});

	it("captures full and short messages and the sha", async () => {
		const base = repo.commit("base");
		const sha = repo.commit("Subject line\n\nBody paragraph.");

		const [commit] = await scanCommits(base, "HEAD", repo.dir);

		expect(commit?.sha).toBe(sha);
		expect(commit?.author).toBe("Test User");
		expect(commit?.shortMessage).toBe("Subject line");
		expect(commit?.fullMessage.trim()).toBe("Subject line\n\nBody paragraph.");
	});

	it("preserves record and field separator bytes inside commit messages", async () => {
		const field = String.fromCharCode(31);
		const record = String.fromCharCode(30);
		const base = repo.commit("base");
		repo.commit(`Subject ${field} one\n\nBody ${record} intact`);
		repo.commit("second");

		const commits = await scanCommits(base, "HEAD", repo.dir);

		expect(commits).toHaveLength(2);
		expect(commits[0]?.shortMessage).toBe(`Subject ${field} one`);
		expect(commits[0]?.fullMessage).toContain(`Body ${record} intact`);
		expect(commits[1]?.shortMessage).toBe("second");
	});

	it("reports unavailable scan revisions from git log", async () => {
		repo.commit("base");

		await expect(scanCommits("missing-from", "missing-to", repo.dir)).rejects.toThrow(
			/git log failed: fatal: ambiguous argument 'missing-from\.\.missing-to'/,
		);
	});

	it("reports an unavailable revision consistently when resolving a commit", async () => {
		repo.commit("base");

		await expect(resolveCommit("missing", repo.dir)).rejects.toThrow(
			`Git revision "missing" was not found in "${repo.dir}".`,
		);
	});

	it("reports a clear error when the directory is not a Git repository", async () => {
		const notARepo = mkdtempSync(join(tmpdir(), "changelog-not-a-repo-"));
		try {
			await expect(scanCommits("HEAD~1", "HEAD", notARepo)).rejects.toThrow(
				`"${notARepo}" is not a Git repository.`,
			);
		} finally {
			rmSync(notARepo, { recursive: true, force: true });
		}
	});

	it("surfaces git stderr when git fails for a reason other than an absent ref", async () => {
		repo.commit("base");
		repo.git("tag", "v1");
		// A corrupt packed-refs makes git tag --list exit non-zero with a clear fatal: message; this
		// exercises the generic failure path rather than the benign rev-parse --verify exit code 1.
		appendFileSync(
			join(repo.dir, ".git", "packed-refs"),
			"not a valid sha refs/tags/v1\n",
		);

		await expect(listTags(repo.dir)).rejects.toThrow(
			/^git tag failed: .*unexpected line in .*packed-refs/,
		);
	});
});

describe("classifyRef", () => {
	let repo: FixtureRepo;

	beforeEach(() => {
		repo = FixtureRepo.create();
	});

	afterEach(() => {
		repo.cleanup();
	});

	it("classifies by git, not by the spelling of the name", async () => {
		const sha = repo.commit("base");
		// A tag named like a maintenance branch, and a branch that does not end in .x: the spelling
		// is misleading, so classification must come from git.
		repo.git("tag", "7.0.x");
		repo.git("branch", "release/7.0");

		expect(await classifyRef("7.0.x", repo.dir)).toBe("tag");
		expect(await classifyRef("release/7.0", repo.dir)).toBe("branch");
		expect(await classifyRef("main", repo.dir)).toBe("branch");
		expect(await classifyRef(sha, repo.dir)).toBe("commit");
		expect(await classifyRef("HEAD", repo.dir)).toBe("head");
	});

	it("classifies a remote-tracking branch as a branch", async () => {
		repo.commit("base");
		// Simulate the resolved upper-bound form (origin/<branch>) by creating the remote ref.
		repo.git("update-ref", "refs/remotes/origin/4.0.x", "HEAD");

		expect(await classifyRef("origin/4.0.x", repo.dir)).toBe("branch");
	});
});
