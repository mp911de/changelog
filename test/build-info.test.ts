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

import { buildVersionUrl, commitSha } from "../src/build-info.js";

describe("commitSha", () => {
	it("falls back to dev in a source run", () => {
		expect(commitSha).toBe("dev");
	});
});

describe("buildVersionUrl", () => {
	const repoHttps = "git+https://github.com/mp911de/changelog.git";
	const repoSsh = "git@github.com:mp911de/changelog.git";

	it("links to the commit from https and ssh repository URLs when SHA is valid", () => {
		const commitUrl = "https://github.com/mp911de/changelog/commit/abc1234";
		expect(buildVersionUrl(repoHttps, "abc1234", "0.1.2")).toBe(commitUrl);
		expect(buildVersionUrl(repoSsh, "abc1234", "0.1.2")).toBe(commitUrl);
	});

	it("links to the release tag when SHA is a fallback value", () => {
		const tagUrl = "https://github.com/mp911de/changelog/releases/tag/0.1.2";
		expect(buildVersionUrl(repoHttps, "dev", "0.1.2")).toBe(tagUrl);
		expect(buildVersionUrl(repoHttps, "unknown", "0.1.2")).toBe(tagUrl);
	});

	it("yields no link for a missing or non-GitHub repository URL", () => {
		expect(buildVersionUrl(undefined, "abc1234", "0.1.2")).toBeUndefined();
		expect(
			buildVersionUrl("https://gitlab.com/mp911de/changelog", "abc1234", "0.1.2"),
		).toBeUndefined();
	});
});
