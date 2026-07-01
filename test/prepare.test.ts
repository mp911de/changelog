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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TicketCache } from "../src/cache.js";
import type { GitHubAdapterFactory } from "../src/github-adapter.js";
import { prepareRun, resolveHeaderFields } from "../src/prepare.js";
import { FixtureRepo } from "./fixture-repo.js";

describe("prepareRun", () => {
	let fixture: FixtureRepo;

	beforeEach(() => {
		fixture = FixtureRepo.create();
	});

	afterEach(() => {
		fixture.cleanup();
	});

	it("resolves an explicit range, repository, config and lookup without header work", async () => {
		let createLookupArgs: { cache: TicketCache; refresh: boolean } | undefined;
		const adapter: GitHubAdapterFactory = async () => ({
			repo: { owner: "octo", repo: "tools" },
			login: "octo",
			createLookup: (args) => {
				createLookupArgs = args;
				return async () => ({
					facts: new Map(),
					notFoundTargets: [],
					cached: 0,
					fetched: 0,
				});
			},
		});

		const run = await prepareRun({
			range: { mode: "explicit", from: "1.0.0", to: "HEAD" },
			cwd: fixture.dir,
			refresh: true,
			githubAdapter: adapter,
			diagnostic: () => {},
		});

		expect(run.repo).toEqual({ owner: "octo", repo: "tools" });
		// An explicit bound carries no kind; only the ref and label.
		expect(run.range).toEqual({
			from: { ref: "1.0.0", label: "1.0.0" },
			to: { ref: "HEAD", label: "HEAD" },
		});
		expect(createLookupArgs?.refresh).toBe(true);
		expect(typeof run.lookup).toBe("function");
		expect(run.config).toBeDefined();
	});

	it("passes the adapter the repo override and trace", async () => {
		let seen: { cwd: string; repoOverride?: string; traced: boolean } | undefined;
		const lines: string[] = [];
		const adapter: GitHubAdapterFactory = async ({ cwd, repoOverride, trace }) => {
			trace?.("hello");
			seen = { cwd, repoOverride, traced: trace !== undefined };
			return {
				repo: { owner: "o", repo: "r" },
				login: "o",
				createLookup: () => async () => ({
					facts: new Map(),
					notFoundTargets: [],
					cached: 0,
					fetched: 0,
				}),
			};
		};

		await prepareRun({
			range: { mode: "explicit", from: "a", to: "b" },
			cwd: fixture.dir,
			repoOverride: "owner/name",
			refresh: false,
			githubAdapter: adapter,
			trace: (line) => lines.push(line),
			diagnostic: () => {},
		});

		expect(seen).toEqual({
			cwd: fixture.dir,
			repoOverride: "owner/name",
			traced: true,
		});
		expect(lines).toEqual(["hello"]);
	});
});

describe("resolveHeaderFields", () => {
	let fixture: FixtureRepo;

	beforeEach(() => {
		fixture = FixtureRepo.create();
	});

	afterEach(() => {
		fixture.cleanup();
	});

	it("links each bound from its carried kind and resolves the range head sha", async () => {
		fixture.commit("first");
		fixture.git("tag", "1.0.0");
		const head = fixture.commit("second");

		const header = await resolveHeaderFields(
			{
				repo: { owner: "octo", repo: "tools" },
				range: {
					from: { ref: "1.0.0", label: "1.0.0", kind: "tag" },
					to: { ref: "HEAD", label: "HEAD", kind: "head" },
				},
			},
			{
				version: "9.9.9",
				build: { sha: "abc1234" },
				output: "notes.md",
				outputUrl: "file:///notes.md",
				cwd: fixture.dir,
			},
		);

		expect(header.version).toBe("9.9.9");
		expect(header.range[0]).toEqual({
			text: "1.0.0",
			link: "https://github.com/octo/tools/releases/tag/1.0.0",
		});
		expect(header.range[2]).toEqual({
			text: "HEAD",
			link: `https://github.com/octo/tools/commit/${head}`,
		});
		expect(header.range[4]?.text).toBe(head.slice(0, 7));
	});

	it("classifies an explicit bound that carries no kind as a commit", async () => {
		const first = fixture.commit("first");
		const second = fixture.commit("second");

		const header = await resolveHeaderFields(
			{
				repo: { owner: "o", repo: "r" },
				range: {
					from: { ref: first, label: first },
					to: { ref: second, label: second },
				},
			},
			{
				version: "1",
				build: { sha: "abc1234" },
				output: "n.md",
				outputUrl: "",
				cwd: fixture.dir,
			},
		);

		expect(header.range[0]).toEqual({
			text: first,
			link: `https://github.com/o/r/commit/${first}`,
		});
		expect(header.range[2]?.link).toBe(`https://github.com/o/r/commit/${second}`);
	});
});
