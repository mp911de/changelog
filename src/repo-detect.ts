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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { load } from "js-yaml";

import type { Repository } from "./github-context.js";

const execFileAsync = promisify(execFile);

export interface RemoteRepository {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
}

const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Whether {@code name} is a usable GitHub owner or repository path segment: the GitHub character
 * set, and not a {@code .}/{@code ..} traversal segment. The single validator shared by remote-URL
 * parsing and {@code gh}-reported names so both reject the same malformed inputs.
 */
export function isRepositoryName(name: string): boolean {
	return REPOSITORY_NAME.test(name) && name !== "." && name !== "..";
}

/**
 * Parse an ssh ({@code git@host:owner/repo.git}, {@code ssh://git@host/owner/repo}) or
 * http(s) git remote URL into host/owner/repo. Returns undefined for anything unrecognized.
 */
export function parseRemoteUrl(url: string): RemoteRepository | undefined {
	const trimmed = url.trim();
	if (trimmed === "") {
		return undefined;
	}

	let host: string;
	let path: string;
	if (trimmed.includes("://")) {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return undefined;
		}
		host = parsed.hostname;
		path = parsed.pathname;
	} else {
		// scp-like syntax: [user@]host:owner/repo(.git)
		const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
		if (!scp) {
			return undefined;
		}
		host = scp[1]!;
		// A Windows drive-letter path (C:/Users/...) also matches the scp shape, with a dotless
		// "host". Real GitHub hosts always contain a dot, so reject the dotless case rather than
		// misparse the drive letter as a host.
		if (!host.includes(".")) {
			return undefined;
		}
		path = scp[2]!;
	}

	const segments = path
		.replace(/^\/+/, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	const [owner, repo] = segments;
	if (
		host === "" ||
		segments.length !== 2 ||
		!isRepositoryName(owner!) ||
		!isRepositoryName(repo!)
	) {
		return undefined;
	}
	return { host: host.toLowerCase(), owner: owner!, repo: repo! };
}

/**
 * Read gh's hosts.yml, mapping each configured host to its authenticated username. Parsed with a
 * real YAML parser; malformed content yields an empty map so the caller falls back to gh.
 */
export function parseGhHosts(content: string): Map<string, { user?: string }> {
	const hosts = new Map<string, { user?: string }>();
	let parsed: unknown;
	try {
		parsed = load(content);
	} catch {
		return hosts;
	}
	if (!parsed || typeof parsed !== "object") {
		return hosts;
	}
	for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
		const user = hostUser(value);
		hosts.set(host.toLowerCase(), user === undefined ? {} : { user });
	}
	return hosts;
}

function hostUser(value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const user = (value as { user?: unknown }).user;
	return typeof user === "string" ? user : undefined;
}

export function ghHostsPath(env: Record<string, string | undefined>): string {
	const configDir =
		env.GH_CONFIG_DIR ??
		(env.XDG_CONFIG_HOME
			? join(env.XDG_CONFIG_HOME, "gh")
			: join(homedir(), ".config", "gh"));
	return join(configDir, "hosts.yml");
}

export interface LocalDetection {
	readonly repo: Repository;
	readonly login?: string;
}

/**
 * Detect the repository without `gh repo view`: parse the git remote URL and, when its host is
 * one gh is authenticated to (present in hosts.yml), use it directly and read the username from
 * there. Returns undefined (so the caller falls back to gh) whenever anything is missing or the
 * host is unknown.
 */
export async function detectLocalRepository(
	cwd: string | undefined,
	env: Record<string, string | undefined>,
	trace?: (line: string) => void,
): Promise<LocalDetection | undefined> {
	const remoteUrl = await gitRemoteUrl(cwd, trace);
	if (!remoteUrl) {
		return undefined;
	}
	const parsed = parseRemoteUrl(remoteUrl);
	if (!parsed) {
		return undefined;
	}

	const path = ghHostsPath(env);
	trace?.(`read ${path}`);
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return undefined;
	}

	const entry = parseGhHosts(content).get(parsed.host);
	if (!entry) {
		return undefined;
	}
	return { repo: { owner: parsed.owner, repo: parsed.repo }, login: entry.user };
}

async function gitRemoteUrl(
	cwd: string | undefined,
	trace?: (line: string) => void,
): Promise<string | undefined> {
	const run = async (args: string[]): Promise<string | undefined> => {
		trace?.(`git ${args.join(" ")}`);
		try {
			const { stdout } = await execFileAsync("git", args, cwd ? { cwd } : {});
			return stdout.trim();
		} catch {
			return undefined;
		}
	};

	const origin = await run(["remote", "get-url", "origin"]);
	if (origin) {
		return origin;
	}
	const first = (await run(["remote"]))
		?.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line !== "");
	return first ? run(["remote", "get-url", first]) : undefined;
}
