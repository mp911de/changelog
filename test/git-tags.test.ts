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

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { gitRepoRefs, listTags, resolveBranch, resolveRevision } from "../src/git.js";
import {
	resolveAutoRange,
	resolveExplicitBound,
	type RepoRefs,
	type ResolvedBranch,
} from "../src/version.js";

async function captureStdout(run: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		chunks.push(String(chunk));
		return true;
	}) as never;
	try {
		await run();
	} finally {
		process.stdout.write = original as never;
	}
	return chunks.join("");
}

describe("version resolution against a real repository", () => {
	let repo: string;

	const git = (...args: string[]): void => {
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	};

	const commit = (message: string): void => {
		writeFileSync(join(repo, "file.txt"), `${message}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", message);
	};

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "changelog-versions-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		git("config", "commit.gpgsign", "false");

		commit("4.0.0");
		git("tag", "4.0.0");

		git("checkout", "-q", "-b", "4.0.x", "4.0.0");
		for (const patch of ["4.0.1", "4.0.2", "4.0.3", "4.0.4", "4.0.5", "4.0.6"]) {
			commit(patch);
			git("tag", patch);
		}
		git("update-ref", "refs/remotes/origin/4.0.x", "refs/heads/4.0.x");

		git("checkout", "-q", "main");
		git("branch", "5.0.x", "main");
		git("branch", "-D", "4.0.x");
	});

	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("lists every tag", async () => {
		expect((await listTags(repo)).sort()).toEqual([
			"4.0.0",
			"4.0.1",
			"4.0.2",
			"4.0.3",
			"4.0.4",
			"4.0.5",
			"4.0.6",
		]);
	});

	it("resolves a service branch from a remote-tracking ref when no local branch exists", async () => {
		expect(await resolveBranch("4.0.x", repo)).toEqual({
			ref: "refs/remotes/origin/4.0.x",
			label: "origin/4.0.x",
		});
	});

	it("prefers a local service branch and returns its fully-qualified ref", async () => {
		expect(await resolveBranch("5.0.x", repo)).toEqual({
			ref: "refs/heads/5.0.x",
			label: "5.0.x",
		});
	});

	it("returns undefined for an unknown service branch", async () => {
		expect(await resolveBranch("9.9.x", repo)).toBeUndefined();
	});

	it("classifies revisions through Git's own resolution", async () => {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim();

		expect(await resolveRevision("4.0.3", repo)).toBe("tag");
		expect(await resolveRevision("main", repo)).toBe("branch");
		expect(await resolveRevision("HEAD", repo)).toBe("head");
		expect(await resolveRevision(sha, repo)).toBe("commit");
		// A remote-tracking branch does not resolve by its bare name; resolveBranch covers it.
		expect(await resolveRevision("4.0.x", repo)).toBeUndefined();
		expect(await resolveRevision("no-such-thing", repo)).toBeUndefined();
	});

	it("resolves a service branch input to the line's latest release and the branch tip", async () => {
		expect(await resolveAutoRange("4.0.x", gitRepoRefs(repo))).toEqual({
			from: { ref: "4.0.6", label: "4.0.6", kind: "tag" },
			to: {
				ref: "refs/remotes/origin/4.0.x",
				label: "origin/4.0.x",
				kind: "branch",
			},
		});
	});

	it("fails a local line branch that has no release yet", async () => {
		await expect(resolveAutoRange("5.0.x", gitRepoRefs(repo))).rejects.toThrow(
			/no release tag found on the 5\.0\.x line/,
		);
	});

	it("resolves explicit bounds through the revision, branch, and version fallbacks", async () => {
		const refs = gitRepoRefs(repo);

		expect(await resolveExplicitBound("4.0.3", "from", refs)).toEqual({
			ref: "4.0.3",
			label: "4.0.3",
			kind: "tag",
		});
		expect(await resolveExplicitBound("4.0.x", "to", refs)).toEqual({
			ref: "refs/remotes/origin/4.0.x",
			label: "origin/4.0.x",
			kind: "branch",
		});
		// An untagged patch version resolves to its service branch tip, like auto mode.
		expect(await resolveExplicitBound("4.0.7", "to", refs)).toEqual({
			ref: "refs/remotes/origin/4.0.x",
			label: "origin/4.0.x",
			kind: "branch",
		});
		await expect(resolveExplicitBound("4.0.7", "from", refs)).rejects.toThrow(
			/no tag matches version "4\.0\.7"/,
		);
	});

	it("prints just the resolved previous tag for --resolve-previous", async () => {
		const out = await captureStdout(async () => {
			await main(["node", "changelog", "--resolve-previous", "4.0.7", "-C", repo]);
		});
		expect(out).toBe("4.0.6\n");
	});

	it("prints the resolved previous release for a branch input", async () => {
		const out = await captureStdout(async () => {
			await main(["node", "changelog", "--resolve-previous", "4.0.x", "-C", repo]);
		});
		expect(out).toBe("4.0.6\n");
	});
});

describe("resolveAutoRange from fake repository refs", () => {
	const TAGS = ["4.0.0", "4.0.1", "4.0.2", "4.0.3", "4.0.4", "4.0.5", "4.0.6"];

	const repoRefs = (config: {
		tags: readonly string[];
		branches?: Record<string, ResolvedBranch>;
	}): RepoRefs => ({
		tags: async () => config.tags,
		resolveBranch: async (name) => config.branches?.[name],
		resolveRevision: async () => undefined,
	});

	it("resolves an upcoming patch to its predecessor and the fully-qualified branch ref", async () => {
		const refs = repoRefs({
			tags: TAGS,
			branches: {
				"4.0.x": { ref: "refs/remotes/origin/4.0.x", label: "origin/4.0.x" },
			},
		});

		expect(await resolveAutoRange("4.0.7", refs)).toEqual({
			from: { ref: "4.0.6", label: "4.0.6", kind: "tag" },
			to: {
				ref: "refs/remotes/origin/4.0.x",
				label: "origin/4.0.x",
				kind: "branch",
			},
		});
	});

	it("resolves a line-opener to the previous line opener and HEAD", async () => {
		expect(await resolveAutoRange("4.1.0", repoRefs({ tags: TAGS }))).toEqual({
			from: { ref: "4.0.0", label: "4.0.0", kind: "tag" },
			to: { ref: "HEAD", label: "HEAD", kind: "head" },
		});
	});

	it("fails with a gap when an intermediate patch was never tagged", async () => {
		const refs = repoRefs({
			tags: TAGS,
			branches: {
				"4.0.x": { ref: "refs/remotes/origin/4.0.x", label: "origin/4.0.x" },
			},
		});

		await expect(resolveAutoRange("4.0.8", refs)).rejects.toThrow(
			/Cannot find tag 4\.0\.7/,
		);
	});
});
