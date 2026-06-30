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

import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedTicket } from "../src/lookup.js";
import {
	type GitHubAdapterFactory,
	isMainModule,
	main,
	type Runtime,
} from "../src/cli.js";
import { targetKey } from "../src/ticket-references.js";
import { FixtureRepo } from "./fixture-repo.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// The run view styles each cell independently, so a colored terminal splits otherwise-adjacent text
// (a count and its label, the success glyph and its line) across SGR escapes. Strip them before
// substring assertions so the checks hold whether or not color leaks in from the host environment.
function stripAnsi(text: string): string {
	return text
		.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "")
		.replace(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, "g"), "");
}

function captureRuntime(
	cwd?: string,
	githubAdapter?: GitHubAdapterFactory,
): {
	out: string[];
	err: string[];
	runtime: Runtime;
} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		runtime: {
			stdout: {
				write: (s) => {
					out.push(String(s));
					return true;
				},
			},
			stderr: {
				write: (s) => {
					err.push(String(s));
					return true;
				},
			},
			cwd,
			githubAdapter,
		},
	};
}

function mockGitHubAdapter(
	tickets: Record<string, ResolvedTicket>,
	repo = { owner: "testowner", repo: "testrepo" },
): GitHubAdapterFactory {
	return async () => ({
		repo,
		login: "tester",
		createLookup: () => async (targets) => {
			const facts = new Map<string, ResolvedTicket>();
			const notFoundTargets = [];
			for (const target of targets) {
				const key = targetKey(target);
				const ticket = tickets[key] ?? tickets[target.id];
				if (ticket) {
					facts.set(key, ticket);
				} else {
					notFoundTargets.push(target);
				}
			}
			return { facts, notFoundTargets, cached: 0, fetched: facts.size };
		},
	});
}

function resolvedTicket(
	title: string,
	labels: string[] = [],
	pullRequest = false,
	author?: string,
): ResolvedTicket {
	return {
		title,
		htmlUrl: "https://github.com/testowner/testrepo/issues/1",
		labels,
		pullRequest,
		author,
	};
}

describe("main argument parsing", () => {
	it("returns 2 and writes the usage synopsis to stderr when called with no arguments", async () => {
		const { out, err, runtime } = captureRuntime();
		const code = await main(["node", "changelog"], runtime);
		expect(code).toBe(2);
		const usage = err.join("");
		expect(usage).toContain("usage: changelog");
		expect(usage).toContain("<version> | <from> <to> | <from>..<to>");
		expect(usage).toContain("--resolve-previous");
		expect(usage).toContain("-O file");
		expect(usage).toContain("--debug");
		expect(out.join("")).toBe("");
	});

	it("returns 2 for a malformed three-dot range", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "4.0.0...4.0.4"], runtime);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/use two dots/);
	});

	it("returns 2 for a range with more than one separator", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "4.0.0..4.0.4..5.0.0"], runtime);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/use a single <from>\.\.<to>/);
	});

	it("returns 2 for a range with a missing lower bound", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "..HEAD"], runtime);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/missing <from>/);
	});

	it("returns 2 when both a range and a separate to are supplied", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "4.0.0..4.0.4", "5.0.0"], runtime);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/specify the range once/);
	});

	it("returns 2 for a lone target that is not a recognized Artifact Version", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "main"], runtime);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/not a recognized version/);
	});

	it("returns 2 when --quiet and --debug are combined", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(
			["node", "changelog", "--quiet", "--debug", "1.0.0"],
			runtime,
		);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/--debug.+cannot be used with option.+quiet/);
	});

	it("returns 2 for --resolve-previous with an explicit range", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(
			["node", "changelog", "--resolve-previous", "1.0.0", "2.0.0"],
			runtime,
		);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/expects a single <version>/);
	});

	it("returns 2 for a -C directory that does not exist", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(
			["node", "changelog", "-C", "no-such-dir-xyz", "1.0.0"],
			runtime,
		);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/directory does not exist/);
	});

	it("returns 2 when -C is specified more than once", async () => {
		const { err, runtime } = captureRuntime();
		const code = await main(
			["node", "changelog", "-C", ".", "-C", ".", "1.0.0"],
			runtime,
		);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/may only be specified once/);
	});

	it("returns 0 and writes the version for --version", async () => {
		const { out, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "--version"], runtime);
		expect(code).toBe(0);
		expect(out.join("")).toMatch(/\d+\.\d+\.\d+/);
	});

	it("returns 0 and writes help for --help", async () => {
		const { out, runtime } = captureRuntime();
		const code = await main(["node", "changelog", "--help"], runtime);
		expect(code).toBe(0);
		expect(out.join("")).toContain("changelog");
		expect(out.join("")).toContain("-C <directory>");
		expect(out.join("")).toContain("--output");
	});
});

describe("main run-level", () => {
	let repo: FixtureRepo;

	beforeEach(() => {
		repo = FixtureRepo.create();
	});

	afterEach(() => {
		repo.cleanup();
	});

	it("accepts a Spring-style release version as an automatic range target", async () => {
		repo.commit("base");
		repo.git("tag", "3.0.0.RELEASE");
		repo.commit("Fixes #1 Add feature");

		const adapter = mockGitHubAdapter({
			"#1": resolvedTicket("Add feature", ["enhancement"]),
		});
		const { out, err, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--quiet", "4.0.0.RELEASE"],
			runtime,
		);

		expect(code).toBe(0);
		expect(out.join("")).toContain("Add feature");
		expect(err.join("")).toBe("");
	});

	it("resolves --resolve-previous from tags and returns 0", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("first");
		repo.git("tag", "1.1.0");

		const { out, err, runtime } = captureRuntime(repo.dir);
		const code = await main(
			["node", "changelog", "--resolve-previous", "1.1.0"],
			runtime,
		);

		expect(code).toBe(0);
		expect(out.join("").trim()).toBe("1.0.0");
		expect(err.join("")).toBe("");
	});

	it("generates a changelog to stdout and returns 0", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("Fixes #1 Add feature");
		repo.git("tag", "1.1.0");

		const adapter = mockGitHubAdapter({
			"#1": resolvedTicket("Add feature", ["enhancement"]),
		});
		const { out, err, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--quiet", "1.1.0"],
			runtime,
		);

		expect(code).toBe(0);
		expect(out.join("")).toContain("Add feature");
		expect(err.join("")).toBe("");
	});

	it("uses a valid -C directory as the run cwd", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("Fixes #1 Add feature");
		repo.git("tag", "1.1.0");
		const outside = mkdtempSync(join(tmpdir(), "changelog-cwd-"));

		try {
			const adapter = mockGitHubAdapter({
				"#1": resolvedTicket("Add feature", ["enhancement"]),
			});
			const { out, err, runtime } = captureRuntime(outside, adapter);
			const code = await main(
				[
					"node",
					"changelog",
					"-C",
					repo.dir,
					"--output",
					"-",
					"--quiet",
					"1.1.0",
				],
				runtime,
			);

			expect(code).toBe(0);
			expect(out.join("")).toContain("Add feature");
			expect(err.join("")).toBe("");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("writes the changelog to a file and returns 0", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("Fixes #2 Fix bug");
		repo.git("tag", "1.1.0");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({ "#2": resolvedTicket("Fix bug", ["bug"]) });
		const { runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", outputFile, "--quiet", "1.1.0"],
			runtime,
		);

		expect(code).toBe(0);
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(outputFile, "utf8")).toContain("Fix bug");
	});

	it("replaces an output symlink without overwriting its target", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("Fixes #2 Fix bug");
		repo.git("tag", "1.1.0");
		const target = join(repo.dir, "protected.txt");
		const outputFile = join(repo.dir, "release-notes.md");
		writeFileSync(target, "keep me\n", "utf8");
		symlinkSync(target, outputFile);

		const adapter = mockGitHubAdapter({ "#2": resolvedTicket("Fix bug", ["bug"]) });
		const { runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(["node", "changelog", "--quiet", "1.1.0"], runtime);

		expect(code).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("keep me\n");
		expect(lstatSync(outputFile).isSymbolicLink()).toBe(false);
		expect(readFileSync(outputFile, "utf8")).toContain("Fix bug");
	});

	it("renders the full run view to stdout for normal file output and keeps the document off stdout", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("Fixes #3 Tidy up");
		repo.git("tag", "1.1.0");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({
			"#3": resolvedTicket("Tidy up", ["enhancement"]),
		});
		const { out, err, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", outputFile, "1.1.0"],
			runtime,
		);

		expect(code).toBe(0);

		expect(stripAnsi(out.join(""))).toContain("✔ Created");
		expect(out.join("")).not.toContain("Tidy up");
		expect(err.join("")).toBe("");
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(outputFile, "utf8")).toContain("Tidy up");
	});

	it("keeps stdout clean and routes debug traces to stderr for stdout output with --debug", async () => {
		repo.commit("base");
		repo.git("tag", "1.0.0");
		repo.commit("Fixes #5 Improve docs");
		repo.git("tag", "1.1.0");

		const adapter = mockGitHubAdapter({
			"#5": resolvedTicket("Improve docs", ["documentation"]),
		});
		const { out, err, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--debug", "1.1.0"],
			runtime,
		);

		expect(code).toBe(0);

		expect(out.join("")).toContain("Improve docs");
		expect(out.join("")).not.toContain("✔ Created");

		expect(err.join("").length).toBeGreaterThan(0);
		expect(err.join("")).not.toContain("Improve docs");

		const errText = err.join("");
		for (const chrome of [
			"✔",
			"└",
			"╭",
			"Scanned",
			"Looked up",
			"Documented",
			"Created",
		]) {
			expect(errText).not.toContain(chrome);
		}
		expect(errText).not.toMatch(/\d+ ms|\d+\.\d+ s/);
	});

	it("returns 1 and writes a concise error on runtime failure without --debug", async () => {
		const { err, runtime } = captureRuntime(repo.dir, mockGitHubAdapter({}));
		const code = await main(
			["node", "changelog", "--quiet", "bad-from", "bad-to"],
			runtime,
		);

		expect(code).toBe(1);
		expect(err.join("").length).toBeGreaterThan(0);

		expect(err.join("")).not.toMatch(/^\s+at .+:\d+:\d+/m);
	});

	it("lets git log validate an explicit Git range during scanning", async () => {
		let adapterCalls = 0;
		const adapter: GitHubAdapterFactory = async () => {
			adapterCalls += 1;
			return mockGitHubAdapter({})({ cwd: repo.dir });
		};
		const { err, runtime } = captureRuntime(repo.dir, adapter);

		const code = await main(
			["node", "changelog", "--quiet", "bad-from", "bad-to"],
			runtime,
		);

		expect(code).toBe(1);
		expect(adapterCalls).toBe(1);
		expect(err.join("")).toContain("git log failed");
	});

	it("includes a stack trace on runtime failure when --debug is active", async () => {
		const { err, runtime } = captureRuntime(repo.dir, mockGitHubAdapter({}));
		const code = await main(
			["node", "changelog", "--debug", "--output", "-", "bad-from", "bad-to"],
			runtime,
		);

		expect(code).toBe(1);
		expect(err.join("")).toMatch(/^\s+at .+:\d+:\d+/m);
	});

	it("accepts an explicit from..to range and returns 0", async () => {
		const from = repo.commit("base");
		repo.commit("Fixes #4 Feature");

		const adapter = mockGitHubAdapter({
			"#4": resolvedTicket("Feature", ["enhancement"]),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--quiet", `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		expect(out.join("")).toContain("Feature");
	});

	it("produces one entry and one GitHub request for one target referenced by Simple syntax in two commits", async () => {
		const from = repo.commit("base");
		repo.commit("#1234 Add the feature");
		repo.commit("#1234 Polish the feature");

		const requested: string[] = [];
		const adapter: GitHubAdapterFactory = async () => ({
			repo: { owner: "testowner", repo: "testrepo" },
			login: "tester",
			createLookup: () => async (targets) => {
				const facts = new Map<string, ResolvedTicket>();
				for (const target of targets) {
					requested.push(target.id);
					if (target.id === "#1234") {
						facts.set(
							targetKey(target),
							resolvedTicket("Add the feature", ["enhancement"]),
						);
					}
				}
				return { facts, notFoundTargets: [], cached: 0, fetched: facts.size };
			},
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--quiet", `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);

		expect(requested).toEqual(["#1234"]);

		const document = out.join("");
		expect(document.match(/Add the feature/g)).toHaveLength(1);
	});

	it("looks up a local and explicitly current-repository reference only once", async () => {
		const from = repo.commit("base");
		repo.commit("Closes #12");
		repo.commit("Closes testowner/testrepo#12");

		const requested: string[] = [];
		const adapter: GitHubAdapterFactory = async () => ({
			repo: { owner: "testowner", repo: "testrepo" },
			login: "tester",
			createLookup: () => async (targets) => {
				requested.push(...targets.map(targetKey));
				return {
					facts: new Map([
						["#12", resolvedTicket("One target", ["enhancement"])],
					]),
					notFoundTargets: [],
					cached: 0,
					fetched: 1,
				};
			},
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const outputFile = join(repo.dir, "notes.md");
		const code = await main(
			["node", "changelog", "--output", outputFile, `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		expect(requested).toEqual(["#12"]);
		expect(stripAnsi(out.join(""))).toContain("1 unique ticket reference");
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(outputFile, "utf8").match(/One target/g)).toHaveLength(1);
	});

	it("documents a backport's issue and credits its Original pull request author separately", async () => {
		const from = repo.commit("base");
		repo.commit("Backport fix\n\nCloses #10\n\nOriginal pull request: #20");

		const adapter = mockGitHubAdapter({
			"#10": resolvedTicket("Backport fix", ["bug"]),
			"#20": resolvedTicket("The pull request", [], false, "contrib"),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--quiet", `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		const document = out.join("");

		expect(document).toContain("- Backport fix. [#10]");
		expect(document).not.toContain("The pull request");
		expect(document).toContain("## :heart: Contributors\n- @contrib\n");
	});

	it("by default lists no commit rows and reports the Scanned summary facts", async () => {
		const from = repo.commit("base");
		repo.commit("#7 Add feature");
		repo.commit("Bump dependency version");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({
			"#7": resolvedTicket("Add feature", ["enhancement"]),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", outputFile, `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		const view = out.join("");

		expect(view).not.toContain("Bump dependency version");
		expect(view).toContain("without ticket reference");
		expect(view).toContain("unique ticket reference");
	});

	it("--show-missing lists only commits with zero ticket references using an orange sha", async () => {
		const from = repo.commit("base");
		repo.commit("#7 Add feature");
		repo.commit("Bump dependency version");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({
			"#7": resolvedTicket("Add feature", ["enhancement"]),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			[
				"node",
				"changelog",
				"--output",
				outputFile,
				"--show-missing",
				`${from}..HEAD`,
			],
			runtime,
		);

		expect(code).toBe(0);
		const view = out.join("");

		expect(view).toContain("Bump dependency version");
		expect(view).not.toContain("Add feature");
	});

	it("--show-commits lists every scanned commit including referenced ones", async () => {
		const from = repo.commit("base");
		repo.commit("#7 Add feature");
		repo.commit("Bump dependency version");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({
			"#7": resolvedTicket("Add feature", ["enhancement"]),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			[
				"node",
				"changelog",
				"--output",
				outputFile,
				"--show-commits",
				`${from}..HEAD`,
			],
			runtime,
		);

		expect(code).toBe(0);
		const view = out.join("");
		expect(view).toContain("Add feature");
		expect(view).toContain("Bump dependency version");
	});

	it("renders every reference for a multi-reference commit with no omission marker off a TTY", async () => {
		const from = repo.commit("base");
		repo.commit(
			"Closes #11, closes #12\n\nOriginal pull request: #20\n\nSee also #30",
		);
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({
			"#11": resolvedTicket("First", ["bug"]),
			"#12": resolvedTicket("Second", ["bug"]),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			[
				"node",
				"changelog",
				"--output",
				outputFile,
				"--show-commits",
				`${from}..HEAD`,
			],
			runtime,
		);

		expect(code).toBe(0);
		const view = out.join("");

		for (const ref of ["#11", "#12", "#20", "#30"]) {
			expect(view).toContain(ref);
		}
		expect(view).not.toContain("more");
	});

	it("--show-all lists every commit and every lookup outcome", async () => {
		const from = repo.commit("base");
		repo.commit("#7 Add feature");
		repo.commit("Closes #404 Vanished");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({
			"#7": resolvedTicket("Add feature", ["enhancement"]),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", outputFile, "--show-all", `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		const view = out.join("");

		expect(view).toContain("Vanished");
		expect(view).toContain("#404");
		expect(view).toContain("#7");
	});

	it("counts only zero-occurrence commits as missing and never a Related-only commit", async () => {
		const from = repo.commit("base");

		repo.commit("Tidy up\n\nRelated tickets: #50");
		repo.commit("Bump dependency version");
		const outputFile = join(repo.dir, "notes.md");

		const adapter = mockGitHubAdapter({});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", outputFile, `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		const view = out.join("");

		expect(stripAnsi(view)).toContain("1 without ticket reference");
	});

	it("credits a candidate author when GitHub reports the closed target as a pull request", async () => {
		const from = repo.commit("base");
		repo.commit("Closes #30 Merge the change");

		const adapter = mockGitHubAdapter({
			"#30": resolvedTicket("Merge the change", ["enhancement"], true, "contrib"),
		});
		const { out, runtime } = captureRuntime(repo.dir, adapter);
		const code = await main(
			["node", "changelog", "--output", "-", "--quiet", `${from}..HEAD`],
			runtime,
		);

		expect(code).toBe(0);
		const document = out.join("");
		expect(document).toContain("- Merge the change. [#30]");
		expect(document).toContain("## :heart: Contributors\n- @contrib\n");
	});
});

describe("isMainModule", () => {
	it("matches the entry through symlinks so a linked/installed bin runs main()", () => {
		const dir = mkdtempSync(join(tmpdir(), "changelog-entry-"));
		try {
			const real = join(dir, "cli.js");
			writeFileSync(real, "entry\n");
			const link = join(dir, "linked-bin");
			symlinkSync(real, link);
			const moduleUrl = pathToFileURL(real).href;

			expect(isMainModule(moduleUrl, real)).toBe(true);
			expect(isMainModule(moduleUrl, link)).toBe(true);

			const other = join(dir, "other.js");
			writeFileSync(other, "other\n");
			expect(isMainModule(moduleUrl, other)).toBe(false);
			expect(isMainModule(moduleUrl, join(dir, "missing.js"))).toBe(false);
			expect(isMainModule(moduleUrl, undefined)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
