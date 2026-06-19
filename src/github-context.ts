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

import type { ThrottlingOptions } from "@octokit/plugin-throttling";
import { Octokit } from "octokit";

import { hasCode } from "./errors.js";
import {
	detectLocalRepository,
	isRepositoryName,
	type LocalDetection,
} from "./repo-detect.js";

const execFileAsync = promisify(execFile);
const GH_NOT_FOUND =
	"GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and try again.";

/**
 * Retry once after primary and secondary rate limits so a temporary limit does not abort a
 * large changelog run. Built per Octokit instance so the warnings can close over the run's injected
 * trace sink, keeping quiet mode quiet instead of going to the default console via octokit.log.warn.
 */
function throttleOptions(trace?: (line: string) => void): ThrottlingOptions {
	const warn = trace ?? (() => {});
	return {
		onRateLimit: (retryAfter, options, _octokit, retryCount) => {
			warn(`Request quota exhausted for ${options.method} ${options.url}`);
			return retryCount < 1;
		},
		onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
			warn(`Secondary rate limit hit for ${options.method} ${options.url}`);
			return retryCount < 1;
		},
	};
}

export interface Repository {
	readonly owner: string;
	readonly repo: string;
}

export interface GitHubContext {
	readonly repo: Repository;
	readonly octokit: Octokit;
	readonly login: string;
}

export type GhRunner = (args: string[], cwd?: string) => Promise<string>;

export type LoginResolver = (octokit: Octokit) => Promise<string>;

export type LocalDetector = (
	cwd: string | undefined,
	env: Record<string, string | undefined>,
	trace?: (line: string) => void,
) => Promise<LocalDetection | undefined>;

export interface GitHubContextOptions {
	readonly env?: Record<string, string | undefined>;
	readonly gh?: GhRunner;
	readonly repo?: string;
	readonly getLogin?: LoginResolver;
	readonly detectLocal?: LocalDetector;
	readonly cwd?: string;
	readonly trace?: (line: string) => void;
}

const defaultGhRunner: GhRunner = async (args, cwd) => {
	const { stdout } = await execFileAsync("gh", args, { cwd });
	return stdout;
};

const defaultLoginResolver: LoginResolver = async (octokit) => {
	const { data } = await octokit.rest.users.getAuthenticated();
	return data.login;
};

export async function resolveGitHubContext(
	options: GitHubContextOptions = {},
): Promise<GitHubContext> {
	const env = options.env ?? process.env;
	const trace = options.trace;
	const base = options.gh ?? defaultGhRunner;
	const gh: GhRunner = trace
		? (args, cwd) => {
				trace(`gh ${args.join(" ")}`);
				return base(args, cwd);
			}
		: base;
	const getLogin = options.getLogin ?? defaultLoginResolver;
	const detectLocal = options.detectLocal ?? detectLocalRepository;

	const token = await resolveToken(env, gh, options.cwd);

	// Prefer detecting the repository (and username) from the git remote + gh hosts.yml, which avoids
	// the `gh repo view` subprocess and the authenticated-user API call. Fall back to gh when the
	// remote is unrecognized or its host is not one gh is signed in to.
	let repo: Repository;
	let login: string | undefined;
	if (options.repo) {
		repo = parseRepository(options.repo);
	} else {
		const local = await detectLocal(options.cwd, env, trace);
		if (local) {
			repo = local.repo;
			login = local.login;
		} else {
			repo = await detectRepository(gh, options.cwd);
		}
	}

	const octokit = new Octokit({ auth: token, throttle: throttleOptions(trace) });
	if (trace) {
		installRequestTrace(octokit, trace);
	}
	if (login === undefined) {
		login = await getLogin(octokit);
	}

	return { repo, octokit, login };
}

export function installRequestTrace(
	octokit: Octokit,
	trace: (line: string) => void,
): void {
	octokit.hook.after("request", (response, requestOptions) => {
		trace(`${requestOptions.method} ${requestOptions.url} → ${response.status}`);
	});
	octokit.hook.error("request", (error, requestOptions) => {
		const status = (error as { status?: number }).status;
		trace(`${requestOptions.method} ${requestOptions.url} → ${status ?? "error"}`);
		throw error;
	});
}

async function resolveToken(
	env: Record<string, string | undefined>,
	gh: GhRunner,
	cwd?: string,
): Promise<string> {
	const fromEnv = env.GH_TOKEN?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	const fromCli = (await tokenFromCli(gh, cwd)).trim();
	if (fromCli) {
		return fromCli;
	}

	throw new Error(
		"No GitHub token found. Set the GH_TOKEN environment variable or run `gh auth login`.",
	);
}

/**
 * A present-but-unauthenticated gh exits non-zero from `gh auth token`; treat that as "no token
 * available" and fall back to the guidance above instead of surfacing gh's raw error. Only a
 * missing gh executable is re-raised, with the install prompt.
 */
async function tokenFromCli(gh: GhRunner, cwd?: string): Promise<string> {
	try {
		return await gh(["auth", "token"], cwd);
	} catch (error) {
		const missing = ghNotFound(error);
		if (missing) {
			throw missing;
		}
		return "";
	}
}

async function detectRepository(gh: GhRunner, cwd?: string): Promise<Repository> {
	const stdout = await runGh(gh, ["repo", "view", "--json", "nameWithOwner,url"], cwd);
	return parseRepository(repoViewName(stdout));
}

function repoViewName(stdout: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(
			"Could not read repository information from `gh repo view`. " +
				"Run changelog inside a GitHub repository or pass --repo owner/repo.",
			{ cause: error },
		);
	}
	const nameWithOwner = (parsed as { nameWithOwner?: unknown }).nameWithOwner;
	if (typeof nameWithOwner !== "string" || nameWithOwner.length === 0) {
		throw new Error(
			"`gh repo view` did not report a repository name. Pass --repo owner/repo to set it explicitly.",
		);
	}
	return nameWithOwner;
}

async function runGh(gh: GhRunner, args: string[], cwd?: string): Promise<string> {
	try {
		return await gh(args, cwd);
	} catch (error) {
		throw ghNotFound(error) ?? error;
	}
}

function ghNotFound(error: unknown): Error | undefined {
	return hasCode(error, "ENOENT")
		? new Error(GH_NOT_FOUND, { cause: error })
		: undefined;
}

function parseRepository(nameWithOwner: string): Repository {
	const parts = nameWithOwner.split("/");
	const [owner, repo] = parts;
	if (
		parts.length !== 2 ||
		!isRepositoryName(owner ?? "") ||
		!isRepositoryName(repo ?? "")
	) {
		throw new Error(
			`Could not parse repository from "${nameWithOwner}"; expected owner/repo.`,
		);
	}
	return { owner: owner!, repo: repo! };
}
