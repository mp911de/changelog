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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCache } from "../src/cache.js";
import type { Repository } from "../src/github-context.js";
import { createTargetLookup, type ResolvedTicket } from "../src/lookup.js";
import { targetKey, type TicketTarget } from "../src/ticket-references.js";

function target(id: string, repository?: Repository): TicketTarget {
	return repository ? { id, repository } : { id };
}

function mockOctokit(issues: Record<number, unknown>) {
	const calls: Array<{ owner: string; repo: string; issue_number: number }> = [];
	const octokit = {
		rest: {
			issues: {
				get: async (params: {
					owner: string;
					repo: string;
					issue_number: number;
				}) => {
					calls.push(params);
					const data = issues[params.issue_number];
					if (!data) {
						const error = new Error("Not Found") as Error & {
							status: number;
						};
						error.status = 404;
						throw error;
					}
					return { data };
				},
			},
		},
	};
	return { octokit, calls };
}

const repo = { owner: "octo", repo: "widgets" };

describe("createTargetLookup", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "changelog-target-lookup-cache-"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function cacheFile(): Record<string, ResolvedTicket> {
		return JSON.parse(
			readFileSync(join(baseDir, ".changelog", "widgets.cache.json"), "utf8"),
		) as Record<string, ResolvedTicket>;
	}

	it("resolves a Ticket Target to role-free GitHub facts keyed by target", async () => {
		const { octokit } = mockOctokit({
			101: {
				title: "Add widgets",
				html_url: "https://github.com/octo/widgets/issues/101",
				labels: [{ name: "enhancement" }, "bug"],
				user: { login: "contributor" },
			},
		});
		const lookup = createTargetLookup({ octokit: octokit as never, repo });

		const { facts, notFoundTargets } = await lookup([target("#101")]);

		expect(facts.get("#101")).toEqual({
			title: "Add widgets",
			htmlUrl: "https://github.com/octo/widgets/issues/101",
			labels: ["enhancement", "bug"],
			pullRequest: false,
			author: "contributor",
		});
		expect(notFoundTargets).toEqual([]);
	});

	it("issues one request per Ticket Target and resolves cross-repository targets from their own repo", async () => {
		const { octokit, calls } = mockOctokit({
			5: { title: "Implicit", html_url: "u", labels: [], user: { login: "a" } },
			9: { title: "Cross repo", html_url: "u", labels: [], user: { login: "b" } },
		});
		const lookup = createTargetLookup({ octokit: octokit as never, repo });

		const { facts } = await lookup([
			target("#5"),
			target("#9", { owner: "acme", repo: "gizmos" }),
		]);

		expect(calls).toContainEqual({ owner: "octo", repo: "widgets", issue_number: 5 });
		expect(calls).toContainEqual({ owner: "acme", repo: "gizmos", issue_number: 9 });
		expect(calls).toHaveLength(2);
		expect(facts.get("acme/gizmos#9")?.title).toBe("Cross repo");
	});

	it("classifies a 404 Ticket Target as not found rather than failing the run", async () => {
		const { octokit } = mockOctokit({
			1: { title: "Exists", html_url: "u", labels: [], user: { login: "a" } },
		});
		const lookup = createTargetLookup({ octokit: octokit as never, repo });

		const { facts, notFoundTargets } = await lookup([target("#1"), target("#999")]);

		expect([...facts.keys()]).toEqual(["#1"]);
		expect(notFoundTargets.map((found) => targetKey(found))).toEqual(["#999"]);
	});

	it("serves cached targets locally and writes fetched targets back with the existing key spelling", async () => {
		const seed = await loadCache({ baseDir, slug: "widgets" });
		await seed.update(
			new Map([
				[
					"octo/widgets#5",
					{
						title: "Cached",
						htmlUrl: "cached-url",
						labels: ["enhancement"],
						pullRequest: false,
						author: "cached-author",
					},
				],
			]),
		);

		const { octokit, calls } = mockOctokit({
			9: { title: "Fetched", html_url: "u9", labels: [], user: { login: "b" } },
		});
		const cache = await loadCache({ baseDir, slug: "widgets" });
		const lookup = createTargetLookup({ octokit: octokit as never, repo, cache });

		const { facts, cached, fetched } = await lookup([target("#5"), target("#9")]);

		expect(calls.map((call) => call.issue_number)).toEqual([9]);
		expect(facts.get("#5")?.title).toBe("Cached");
		expect(facts.get("#9")?.title).toBe("Fetched");
		expect(cached).toBe(1);
		expect(fetched).toBe(1);
		expect(cacheFile()["octo/widgets#9"]?.title).toBe("Fetched");
	});

	it("persists targets fetched before a failing lookup so the next run can reuse them", async () => {
		const octokit = {
			rest: {
				issues: {
					get: async ({ issue_number }: { issue_number: number }) => {
						if (issue_number === 500) {
							throw Object.assign(new Error("Server Error"), {
								status: 500,
							});
						}
						return {
							data: {
								title: "Cached me",
								html_url: "u5",
								labels: [],
								user: { login: "a" },
							},
						};
					},
				},
			},
		};
		const cache = await loadCache({ baseDir, slug: "widgets" });
		const lookup = createTargetLookup({ octokit: octokit as never, repo, cache });

		await expect(lookup([target("#5"), target("#500")])).rejects.toThrow(
			/Failed to look up/,
		);

		expect(cacheFile()).toEqual({
			"octo/widgets#5": {
				title: "Cached me",
				htmlUrl: "u5",
				labels: [],
				pullRequest: false,
				author: "a",
			},
		});
	});
});
