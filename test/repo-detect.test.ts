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

import { ghHostsPath, parseGhHosts, parseRemoteUrl } from "../src/repo-detect.js";

describe("parseRemoteUrl", () => {
	it("parses scp-style ssh remotes", () => {
		expect(
			parseRemoteUrl("git@github.com:spring-projects/spring-data-commons.git"),
		).toEqual({
			host: "github.com",
			owner: "spring-projects",
			repo: "spring-data-commons",
		});
	});

	it("parses ssh and https remotes, with or without .git or a userinfo prefix", () => {
		expect(parseRemoteUrl("ssh://git@github.com/octo/widgets.git")).toEqual({
			host: "github.com",
			owner: "octo",
			repo: "widgets",
		});
		expect(parseRemoteUrl("https://github.com/octo/widgets")).toEqual({
			host: "github.com",
			owner: "octo",
			repo: "widgets",
		});
		expect(parseRemoteUrl("https://user@ghe.example.com/Org/Repo.git")).toEqual({
			host: "ghe.example.com",
			owner: "Org",
			repo: "Repo",
		});
	});

	it("lowercases the host but preserves owner/repo case", () => {
		expect(parseRemoteUrl("git@GitHub.com:Octo/Widgets.git")).toEqual({
			host: "github.com",
			owner: "Octo",
			repo: "Widgets",
		});
	});

	it("returns undefined for unrecognized or incomplete remotes", () => {
		expect(parseRemoteUrl("")).toBeUndefined();
		expect(parseRemoteUrl("not a url")).toBeUndefined();
		expect(parseRemoteUrl("https://github.com/onlyowner")).toBeUndefined();
	});

	it("rejects invalid owner/repo names rather than guessing a repository", () => {
		expect(parseRemoteUrl("git@github.com:own er/repo.git")).toBeUndefined();
		expect(parseRemoteUrl("https://github.com/owner/re!po")).toBeUndefined();
	});

	it("rejects a path with more than two segments", () => {
		expect(parseRemoteUrl("git@github.com:owner/repo/extra")).toBeUndefined();
		expect(parseRemoteUrl("https://github.com/owner/repo/extra")).toBeUndefined();
	});

	it("rejects a Windows drive-letter path that mimics scp syntax", () => {
		expect(parseRemoteUrl("C:/Users/mark/project")).toBeUndefined();
		expect(parseRemoteUrl("C:\\Users\\mark\\project")).toBeUndefined();
	});
});

describe("parseGhHosts", () => {
	it("maps each host to its username", () => {
		const hosts = parseGhHosts(
			[
				"github.com:",
				"    user: mp911de",
				"    oauth_token: gho_xxx",
				"    git_protocol: https",
				"ghe.example.com:",
				"    user: someone",
			].join("\n"),
		);
		expect(hosts.get("github.com")?.user).toBe("mp911de");
		expect(hosts.get("ghe.example.com")?.user).toBe("someone");
		expect(hosts.has("missing.com")).toBe(false);
	});

	it("takes the host-level user and is not confused by a nested users: block", () => {
		const hosts = parseGhHosts(
			[
				"github.com:",
				"    users:",
				"        mp911de:",
				"            oauth_token: gho_a",
				"    user: mp911de",
			].join("\n"),
		);
		expect(hosts.get("github.com")?.user).toBe("mp911de");
	});
});

describe("ghHostsPath", () => {
	it("honors GH_CONFIG_DIR, then XDG_CONFIG_HOME", () => {
		expect(ghHostsPath({ GH_CONFIG_DIR: "/cfg/gh" })).toBe("/cfg/gh/hosts.yml");
		expect(ghHostsPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gh/hosts.yml");
	});
});
