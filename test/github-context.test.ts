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

import { installRequestTrace, resolveGitHubContext } from "../src/github-context.js";

const stubLogin = async () => "octocat";

const noLocal = async () => undefined;

const missingGh = () => Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });

describe("resolveGitHubContext", () => {
	it("authenticates from GH_TOKEN and detects the repository via gh repo view", async () => {
		const calls: string[][] = [];
		const context = await resolveGitHubContext({
			env: { GH_TOKEN: "secret-token" },
			getLogin: stubLogin,
			detectLocal: noLocal,
			gh: async (args) => {
				calls.push(args);
				return JSON.stringify({
					nameWithOwner: "octo/widgets",
					url: "https://github.com/octo/widgets",
				});
			},
		});

		expect(context.repo).toEqual({ owner: "octo", repo: "widgets" });
		expect(calls).toContainEqual(["repo", "view", "--json", "nameWithOwner,url"]);
		expect(context.octokit).toBeDefined();
	});

	it("prefers GH_TOKEN over gh auth token", async () => {
		const calls: string[][] = [];
		await resolveGitHubContext({
			env: { GH_TOKEN: "from-env" },
			getLogin: stubLogin,
			gh: async (args) => {
				calls.push(args);
				if (args[0] === "auth") {
					return "from-gh-cli\n";
				}
				return JSON.stringify({ nameWithOwner: "octo/widgets", url: "" });
			},
		});

		expect(calls).not.toContainEqual(["auth", "token"]);
	});

	it("falls back to gh auth token when GH_TOKEN is unset", async () => {
		const calls: string[][] = [];
		await resolveGitHubContext({
			env: {},
			getLogin: stubLogin,
			gh: async (args) => {
				calls.push(args);
				if (args[0] === "auth") {
					return "from-gh-cli\n";
				}
				return JSON.stringify({ nameWithOwner: "octo/widgets", url: "" });
			},
		});

		expect(calls).toContainEqual(["auth", "token"]);
	});

	it("runs gh commands in the selected working directory", async () => {
		const calls: Array<{ args: string[]; cwd: string | undefined }> = [];
		const context = await resolveGitHubContext({
			env: {},
			cwd: "/work/repository",
			getLogin: stubLogin,
			detectLocal: noLocal,
			gh: async (args, cwd) => {
				calls.push({ args, cwd });
				if (args[0] === "auth") {
					return "from-gh-cli\n";
				}
				return JSON.stringify({ nameWithOwner: "octo/widgets", url: "" });
			},
		});

		expect(context.repo).toEqual({ owner: "octo", repo: "widgets" });
		expect(calls).toEqual([
			{ args: ["auth", "token"], cwd: "/work/repository" },
			{
				args: ["repo", "view", "--json", "nameWithOwner,url"],
				cwd: "/work/repository",
			},
		]);
	});

	it("lets the repo option override gh repo view detection", async () => {
		const calls: string[][] = [];
		const context = await resolveGitHubContext({
			env: { GH_TOKEN: "secret-token" },
			repo: "acme/gizmos",
			getLogin: stubLogin,
			gh: async (args) => {
				calls.push(args);
				return JSON.stringify({ nameWithOwner: "octo/widgets", url: "" });
			},
		});

		expect(context.repo).toEqual({ owner: "acme", repo: "gizmos" });
		expect(calls).not.toContainEqual(["repo", "view", "--json", "nameWithOwner,url"]);
	});

	it("rejects repository names with more than owner and repo", async () => {
		await expect(
			resolveGitHubContext({
				env: { GH_TOKEN: "secret-token" },
				repo: "acme/widgets/extra",
				getLogin: stubLogin,
			}),
		).rejects.toThrow("expected owner/repo");
	});

	it("rejects a repo segment that is a path-traversal token", async () => {
		await expect(
			resolveGitHubContext({
				env: { GH_TOKEN: "secret-token" },
				repo: "acme/..",
				getLogin: stubLogin,
			}),
		).rejects.toThrow("expected owner/repo");
	});

	it("rejects a repository name with characters outside the GitHub set", async () => {
		await expect(
			resolveGitHubContext({
				env: { GH_TOKEN: "secret-token" },
				repo: "ac me/widgets",
				getLogin: stubLogin,
			}),
		).rejects.toThrow("expected owner/repo");
	});

	it("throws a helpful error when no token can be resolved", async () => {
		await expect(
			resolveGitHubContext({
				env: {},
				gh: async (args) =>
					args[0] === "auth"
						? ""
						: JSON.stringify({
								nameWithOwner: "octo/widgets",
								url: "",
							}),
			}),
		).rejects.toThrow(/GH_TOKEN/);
	});

	it("prompts to install gh when the authentication fallback cannot find it", async () => {
		await expect(
			resolveGitHubContext({
				env: {},
				gh: async () => {
					throw missingGh();
				},
			}),
		).rejects.toThrow(
			"GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and try again.",
		);
	});

	it("prompts to install gh when repository detection cannot find it", async () => {
		await expect(
			resolveGitHubContext({
				env: { GH_TOKEN: "secret-token" },
				detectLocal: noLocal,
				gh: async () => {
					throw missingGh();
				},
			}),
		).rejects.toThrow(
			"GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and try again.",
		);
	});

	it("falls back to the token guidance when gh is present but not authenticated", async () => {
		await expect(
			resolveGitHubContext({
				env: {},
				gh: async (args) => {
					if (args[0] === "auth") {
						throw Object.assign(
							new Error("gh: To get started, run gh auth login"),
							{ code: 1 },
						);
					}
					return JSON.stringify({ nameWithOwner: "octo/widgets", url: "" });
				},
			}),
		).rejects.toThrow(/No GitHub token found/);
	});

	it("reports a clear error when gh repo view returns no parseable repository", async () => {
		await expect(
			resolveGitHubContext({
				env: { GH_TOKEN: "secret-token" },
				getLogin: stubLogin,
				detectLocal: noLocal,
				gh: async (args) => (args[0] === "repo" ? "not json at all" : ""),
			}),
		).rejects.toThrow(/Could not read repository information from `gh repo view`/);
	});

	it("resolves the current login via the injected login resolver", async () => {
		const context = await resolveGitHubContext({
			env: { GH_TOKEN: "secret-token" },
			repo: "octo/widgets",
			detectLocal: noLocal,
			gh: async () => "",
			getLogin: async () => "current-user",
		});

		expect(context.login).toBe("current-user");
	});

	it("detects the repository and login locally, skipping gh repo view and the user API call", async () => {
		const ghCalls: string[][] = [];
		let loginCalled = false;
		const context = await resolveGitHubContext({
			env: { GH_TOKEN: "secret-token" },
			detectLocal: async () => ({
				repo: {
					owner: "spring-projects",
					repo: "spring-data-commons",
				},
				login: "mp911de",
			}),
			getLogin: async () => {
				loginCalled = true;
				return "from-api";
			},
			gh: async (args) => {
				ghCalls.push(args);
				return "";
			},
		});

		expect(context.repo).toEqual({
			owner: "spring-projects",
			repo: "spring-data-commons",
		});
		expect(context.login).toBe("mp911de");
		expect(ghCalls).not.toContainEqual([
			"repo",
			"view",
			"--json",
			"nameWithOwner,url",
		]);
		expect(loginCalled).toBe(false);
	});

	it("falls back to the login API when local detection finds a repo but no username", async () => {
		const context = await resolveGitHubContext({
			env: { GH_TOKEN: "secret-token" },
			detectLocal: async () => ({ repo: { owner: "octo", repo: "widgets" } }),
			getLogin: async () => "from-api",
			gh: async () => "",
		});

		expect(context.repo).toEqual({ owner: "octo", repo: "widgets" });
		expect(context.login).toBe("from-api");
	});
});

describe("installRequestTrace", () => {
	it("traces method, url and resulting status for octokit requests", () => {
		const lines: string[] = [];
		const hooks: Record<string, (...args: never[]) => unknown> = {};
		const octokit = {
			hook: {
				after: (_name: string, fn: never) => (hooks.after = fn as never),
				error: (_name: string, fn: never) => (hooks.error = fn as never),
			},
		};
		installRequestTrace(octokit as never, (line) => lines.push(line));

		(hooks.after as (r: unknown, o: unknown) => void)(
			{ status: 200 },
			{
				method: "GET",
				url: "/repos/o/r/issues/1",
			},
		);
		expect(() =>
			(hooks.error as (e: unknown, o: unknown) => void)(
				{ status: 404 },
				{
					method: "GET",
					url: "/repos/o/r/issues/9",
				},
			),
		).toThrow();

		expect(lines).toEqual([
			"GET /repos/o/r/issues/1 → 200",
			"GET /repos/o/r/issues/9 → 404",
		]);
	});
});

describe("gh command tracing", () => {
	it("traces the gh subcommands resolveGitHubContext issues", async () => {
		const traced: string[] = [];
		await resolveGitHubContext({
			env: {},
			trace: (line) => traced.push(line),
			getLogin: async () => "octocat",
			detectLocal: async () => undefined,
			gh: async (args) =>
				args[0] === "auth"
					? "token\n"
					: JSON.stringify({
							nameWithOwner: "octo/widgets",
							url: "",
						}),
		});

		expect(traced).toContain("gh auth token");
		expect(traced).toContain("gh repo view --json nameWithOwner,url");
	});
});
