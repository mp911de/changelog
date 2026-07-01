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

import { buildCommitUrl, commitSha } from "../src/build-info.js";

describe("commitSha", () => {
	it("falls back to dev in a source run", () => {
		expect(commitSha).toBe("dev");
	});
});

describe("buildCommitUrl", () => {
	const url = "https://github.com/mp911de/changelog/commit/abc1234";

	it("links the tool's own commit from https and ssh repository URLs", () => {
		expect(
			buildCommitUrl("git+https://github.com/mp911de/changelog.git", "abc1234"),
		).toBe(url);
		expect(buildCommitUrl("git@github.com:mp911de/changelog.git", "abc1234")).toBe(
			url,
		);
	});

	it("yields no link for a fallback SHA that points at no commit", () => {
		expect(
			buildCommitUrl("https://github.com/mp911de/changelog", "dev"),
		).toBeUndefined();
		expect(
			buildCommitUrl("https://github.com/mp911de/changelog", "unknown"),
		).toBeUndefined();
	});

	it("yields no link for a missing or non-GitHub repository URL", () => {
		expect(buildCommitUrl(undefined, "abc1234")).toBeUndefined();
		expect(
			buildCommitUrl("https://gitlab.com/mp911de/changelog", "abc1234"),
		).toBeUndefined();
	});
});
