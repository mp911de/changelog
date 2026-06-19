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
import { gitRepoRefs, listTags, resolveBranch } from "../src/git.js";
import { resolveAutoRange } from "../src/version.js";

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
		commit("4.1 development");
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

	it("resolves a maintenance branch from a remote-tracking ref when no local branch exists", async () => {
		expect(await resolveBranch("4.0.x", repo)).toBe("origin/4.0.x");
	});

	it("prefers a local maintenance branch", async () => {
		expect(await resolveBranch("5.0.x", repo)).toBe("5.0.x");
	});

	it("returns undefined for an unknown maintenance branch", async () => {
		expect(await resolveBranch("9.9.x", repo)).toBeUndefined();
	});

	it("resolves an upcoming patch to its predecessor and the remote-tracking branch tip", async () => {
		expect(await resolveAutoRange("4.0.7", gitRepoRefs(repo))).toEqual({
			from: "4.0.6",
			to: "origin/4.0.x",
		});
	});

	it("resolves a line-opener to the previous line opener and HEAD", async () => {
		expect(await resolveAutoRange("4.1.0", gitRepoRefs(repo))).toEqual({
			from: "4.0.0",
			to: "HEAD",
		});
	});

	it("fails with a gap when an intermediate patch was never tagged", async () => {
		await expect(resolveAutoRange("4.0.8", gitRepoRefs(repo))).rejects.toThrow(
			/Cannot find tag 4\.0\.7/,
		);
	});

	it("prints just the resolved previous tag for --resolve-previous", async () => {
		const out = await captureStdout(async () => {
			await main(["node", "changelog", "--resolve-previous", "4.0.7", "-C", repo]);
		});
		expect(out).toBe("4.0.6\n");
	});
});
