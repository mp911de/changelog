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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { hasCode } from "./errors.js";
import type { RepoRefs, ResolvedBranch } from "./version.js";

const execFileAsync = promisify(execFile);

const GIT_NOT_FOUND =
	"Git was not found. Install it from https://git-scm.com/ and try again.";
// A wide range with large commit bodies can produce a lot of output; buffer generously and
// translate an overflow into actionable guidance rather than a raw Node error.
const LOG_MAX_BUFFER = 256 * 1024 * 1024;

export interface CommitRecord {
	readonly sha: string;
	readonly author: string;
	readonly fullMessage: string;
	readonly shortMessage: string;
}

export type Trace = (command: string) => void;

/**
 * What a from/to revision is, so its header link can point at the right GitHub page: a tag's
 * release page, a branch's tree, a commit, or HEAD (resolved to its commit).
 */
export type RefKind = "commit" | "tag" | "branch" | "head";

// Git commit objects cannot contain NUL, so it is the only unambiguous field separator for
// arbitrary author names and commit messages.
const NUL = "\0";
const NUL_FORMAT = "%x00";

export async function scanCommits(
	from: string,
	to: string,
	cwd: string,
	trace?: Trace,
): Promise<CommitRecord[]> {
	const format = ["%H", "%an", "%B", "%s"].join(NUL_FORMAT) + NUL_FORMAT;
	const stdout = await runGit(
		[
			"log",
			"--no-merges",
			"--reverse",
			`--pretty=format:${format}`,
			"--end-of-options",
			`${from}..${to}`,
		],
		cwd,
		{ maxBuffer: LOG_MAX_BUFFER, trace },
	);

	const fields = stdout.split(NUL);
	if (fields.at(-1) === "") {
		fields.pop();
	}
	const commits: CommitRecord[] = [];
	for (let index = 0; index < fields.length; index += 4) {
		commits.push({
			sha: (fields[index] ?? "").replace(/^\n/, ""),
			author: fields[index + 1] ?? "",
			fullMessage: fields[index + 2] ?? "",
			shortMessage: fields[index + 3] ?? "",
		});
	}
	return commits;
}

/**
 * Resolve a revision to its full commit sha (for example to show the resolved sha of HEAD in
 * the header). Translates the same failure modes as scanning into actionable errors.
 */
export async function resolveCommit(
	ref: string,
	cwd: string,
	trace?: Trace,
): Promise<string> {
	try {
		const stdout = await runGit(revParseCommit(ref), cwd, { trace });
		return stdout.trim();
	} catch (error) {
		if (hasCode(error, 1)) {
			throw new Error(`Git revision "${ref}" was not found in "${cwd}".`);
		}
		throw error;
	}
}

export async function listTags(cwd: string, trace?: Trace): Promise<string[]> {
	const stdout = await runGit(["tag", "--list"], cwd, { trace });
	return nonEmptyLines(stdout);
}

/**
 * Resolve a Service Branch name to a usable revision: a local branch takes precedence,
 * otherwise a remote-tracking branch (`origin` first, then any other remote). Returns the
 * fully-qualified {@code ref} to use as the upper bound paired with its display {@code label}, or
 * undefined when no such branch exists. The ref is fully qualified (`refs/heads/...`,
 * `refs/remotes/...`) so a same-named tag cannot shadow the branch when Git resolves the range.
 */
export async function resolveBranch(
	name: string,
	cwd: string,
	trace?: Trace,
): Promise<ResolvedBranch | undefined> {
	if (await refExists(`refs/heads/${name}`, cwd, trace)) {
		return { ref: `refs/heads/${name}`, label: name };
	}
	if (await refExists(`refs/remotes/origin/${name}`, cwd, trace)) {
		return { ref: `refs/remotes/origin/${name}`, label: `origin/${name}` };
	}
	for (const remote of await listRemotes(cwd, trace)) {
		if (
			remote !== "origin" &&
			(await refExists(`refs/remotes/${remote}/${name}`, cwd, trace))
		) {
			return { ref: `refs/remotes/${remote}/${name}`, label: `${remote}/${name}` };
		}
	}
	return undefined;
}

/**
 * Classify a revision so the renderer can link it to the right GitHub page. Checks git rather than
 * the spelling of the name: a tag named like a branch (for example {@code 7.0.x}) is still a tag,
 * and a Service Branch that does not end in {@code .x} is still a branch. Covers the resolved
 * remote-tracking form ({@code origin/4.0.x}) via {@code refs/remotes}. Anything that is neither a
 * tag nor a branch (a sha) is treated as a commit.
 */
export async function classifyRef(
	ref: string,
	cwd: string,
	trace?: Trace,
): Promise<RefKind> {
	if (ref === "HEAD") {
		return "head";
	}
	if (await refExists(`refs/tags/${ref}`, cwd, trace)) {
		return "tag";
	}
	if (
		(await refExists(`refs/heads/${ref}`, cwd, trace)) ||
		(await refExists(`refs/remotes/${ref}`, cwd, trace))
	) {
		return "branch";
	}
	return "commit";
}

export function gitRepoRefs(cwd: string, trace?: Trace): RepoRefs {
	return {
		tags: () => listTags(cwd, trace),
		resolveBranch: (name) => resolveBranch(name, cwd, trace),
	};
}

async function refExists(ref: string, cwd: string, trace?: Trace): Promise<boolean> {
	try {
		await runGit(revParseCommit(ref), cwd, { trace });
		return true;
	} catch (error) {
		// Exit code 1 from rev-parse --verify --quiet means the ref is absent; anything else is a real error.
		if (hasCode(error, 1)) {
			return false;
		}
		throw error;
	}
}

async function listRemotes(cwd: string, trace?: Trace): Promise<string[]> {
	const stdout = await runGit(["remote"], cwd, { trace });
	return nonEmptyLines(stdout);
}

function nonEmptyLines(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

// The canonical "resolve this ref to a commit"
function revParseCommit(ref: string): string[] {
	return ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
}

/**
 * Run git, translating the cryptic failure modes (git not installed, directory is not a
 * repository, output too large to buffer) into actionable errors. Other failures, including
 * rev-parse's exit code 1, pass through unchanged for callers to interpret.
 */
export async function runGit(
	args: string[],
	cwd: string | undefined,
	options: { maxBuffer?: number; trace?: Trace } = {},
): Promise<string> {
	options.trace?.(`git ${args.join(" ")}`);
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: options.maxBuffer,
		});
		return stdout;
	} catch (error) {
		throw translateGitError(error, args, cwd);
	}
}

function translateGitError(
	error: unknown,
	args: string[],
	cwd: string | undefined,
): unknown {
	if (hasCode(error, "ENOENT")) {
		return new Error(GIT_NOT_FOUND, { cause: error });
	}
	if (hasCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
		return new Error(
			"Git produced more output than changelog can buffer at once. " +
				"Narrow the commit range and try again.",
			{ cause: error },
		);
	}
	if (isNotARepository(error)) {
		return new Error(
			`"${cwd}" is not a Git repository. Run changelog inside a repository or pass -C <directory>.`,
			{ cause: error },
		);
	}
	// refExists and resolveCommit rely on catching rev-parse --verify --quiet exit 1 to detect
	// an absent ref, so leave that benign case as the raw error for hasCode(error, 1) to match. Any other
	// non-zero exit carrying stderr is a real failure worth surfacing instead of an opaque "Command failed".
	if (!hasCode(error, 1)) {
		const stderr = gitStderr(error);
		if (stderr.length > 0) {
			return new Error(`git ${args[0]} failed: ${stderr.trim()}`, { cause: error });
		}
	}
	return error;
}

function gitStderr(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === "string") {
			return stderr;
		}
	}
	return "";
}

function isNotARepository(error: unknown): boolean {
	return gitStderr(error).includes("not a git repository");
}
