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
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { followReferenceMatcher, loadOrCreateConfig } from "../src/config.js";

describe("loadOrCreateConfig", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "changelog-config-"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("creates .changelog/changelog.json with the default schema, team seeded with the login, when absent", async () => {
		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		expect(config).toEqual({
			sections: [
				{
					title: ":star: New Features",
					labels: ["enhancement"],
					summary: "features",
				},
				{
					title: ":lady_beetle: Bug Fixes",
					labels: ["bug", "regression"],
					summary: "bugs",
				},
				{
					title: ":notebook_with_decorative_cover: Documentation",
					labels: ["documentation"],
				},
				{
					title: ":hammer: Dependency Upgrades",
					labels: ["dependency-upgrade", "dependencies"],
				},
			],
			excludeLabels: ["type: task"],
			team: ["octocat"],
			followReferences: ["octo-org/*"],
		});

		const written = readFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			"utf8",
		);
		expect(JSON.parse(written)).toEqual(config);
	});

	it("pretty-prints the created file for readable diffs", async () => {
		await loadOrCreateConfig({ baseDir, login: "octocat", owner: "octo-org" });

		const written = readFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			"utf8",
		);
		expect(written).toContain('\n  "sections"');
		expect(written.endsWith("\n")).toBe(true);
	});

	it("loads an existing config without overwriting it", async () => {
		const existing = {
			sections: [
				{ title: ":rocket: Stuff", labels: ["feature"], summary: "things" },
			],
			excludeLabels: ["wontfix"],
			team: ["someone-else"],
		};
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			JSON.stringify(existing),
			"utf8",
		);

		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		expect(config).toEqual(existing);
		expect(config.team).toEqual(["someone-else"]);
	});

	it("rejects a configuration with the wrong shape at the loading seam", async () => {
		const path = join(baseDir, ".changelog", "changelog.json");
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				sections: [],
				excludeLabels: [],
				team: "octocat",
			}),
			"utf8",
		);

		await expect(
			loadOrCreateConfig({
				baseDir,
				login: "octocat",
				owner: "octo-org",
			}),
		).rejects.toThrow(
			`Invalid changelog configuration at "${path}": "team" must be an array of strings.`,
		);
	});

	it("rejects blank configuration strings at the loading seam", async () => {
		const path = join(baseDir, ".changelog", "changelog.json");
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				sections: [{ title: "Changes", labels: ["enhancement"] }],
				excludeLabels: ["  "],
				team: ["octocat"],
			}),
			"utf8",
		);

		await expect(
			loadOrCreateConfig({
				baseDir,
				login: "octocat",
				owner: "octo-org",
			}),
		).rejects.toThrow(
			`Invalid changelog configuration at "${path}": "excludeLabels" must not contain blank strings.`,
		);
	});

	it("identifies the source path when configuration JSON is malformed", async () => {
		const path = join(baseDir, ".changelog", "changelog.json");
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(path, "{not-json", "utf8");

		await expect(
			loadOrCreateConfig({
				baseDir,
				login: "octocat",
				owner: "octo-org",
			}),
		).rejects.toThrow(`Could not parse JSON at "${path}".`);
	});

	it("creates the config in .github/changelog.json when a .github directory exists", async () => {
		mkdirSync(join(baseDir, ".github"), { recursive: true });

		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		const written = readFileSync(join(baseDir, ".github", "changelog.json"), "utf8");
		expect(JSON.parse(written)).toEqual(config);
		expect(existsSync(join(baseDir, ".changelog", "changelog.json"))).toBe(false);
	});

	it("loads .github/changelog.json in preference to the .changelog fallback", async () => {
		const preferred = {
			sections: [
				{ title: ":rocket: Stuff", labels: ["feature"], summary: "things" },
			],
			excludeLabels: ["wontfix"],
			team: ["gh-team"],
		};
		mkdirSync(join(baseDir, ".github"), { recursive: true });
		writeFileSync(
			join(baseDir, ".github", "changelog.json"),
			JSON.stringify(preferred),
			"utf8",
		);
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			JSON.stringify({ sections: [], excludeLabels: [], team: ["ignored"] }),
			"utf8",
		);

		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		expect(config).toEqual(preferred);
	});

	it("honors an existing .changelog config even when a .github directory exists, without duplicating it", async () => {
		const existing = {
			sections: [
				{ title: ":rocket: Stuff", labels: ["feature"], summary: "things" },
			],
			excludeLabels: ["wontfix"],
			team: ["someone-else"],
		};
		mkdirSync(join(baseDir, ".github"), { recursive: true });
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			JSON.stringify(existing),
			"utf8",
		);

		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		expect(config).toEqual(existing);
		expect(existsSync(join(baseDir, ".github", "changelog.json"))).toBe(false);
	});

	it("omits followReferences from a new config when the owner is not known", async () => {
		const config = await loadOrCreateConfig({ baseDir, login: "octocat" });

		expect(config.followReferences).toBeUndefined();
		const written = JSON.parse(
			readFileSync(join(baseDir, ".changelog", "changelog.json"), "utf8"),
		);
		expect(Object.prototype.hasOwnProperty.call(written, "followReferences")).toBe(
			false,
		);
	});

	it("preserves a followReferences allow-list from an existing config", async () => {
		const existing = {
			sections: [{ title: ":rocket: Stuff", labels: ["feature"] }],
			excludeLabels: [],
			team: [],
			followReferences: ["spring-projects/*", "spring-projects/spring-data*"],
		};
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			JSON.stringify(existing),
			"utf8",
		);

		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		expect(config.followReferences).toEqual([
			"spring-projects/*",
			"spring-projects/spring-data*",
		]);
	});

	it("treats a config without a followReferences property as unrestricted", async () => {
		const existing = {
			sections: [{ title: "X", labels: ["a"] }],
			excludeLabels: [],
			team: [],
		};
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			join(baseDir, ".changelog", "changelog.json"),
			JSON.stringify(existing),
			"utf8",
		);

		const config = await loadOrCreateConfig({
			baseDir,
			login: "octocat",
			owner: "octo-org",
		});

		expect(config.followReferences).toBeUndefined();
	});

	it("rejects a non-string followReferences entry", async () => {
		const path = join(baseDir, ".changelog", "changelog.json");
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				sections: [{ title: "X", labels: ["a"] }],
				excludeLabels: [],
				team: [],
				followReferences: [42],
			}),
			"utf8",
		);

		await expect(
			loadOrCreateConfig({
				baseDir,
				login: "octocat",
				owner: "octo-org",
			}),
		).rejects.toThrow(
			`Invalid changelog configuration at "${path}": "followReferences" must be an array of strings.`,
		);
	});
});

describe("followReferenceMatcher", () => {
	it("treats an empty pattern list as unrestricted", () => {
		const matches = followReferenceMatcher([]);
		expect(matches("anyone/anything")).toBe(true);
	});

	it("expands * to one or more characters and matches the literal parts exactly", () => {
		const matches = followReferenceMatcher([
			"spring-projects/*",
			"spring-projects/spring-data*",
			"octo/widgets",
		]);
		// `spring-projects/*` follows any repository in the org (at least one character after the slash).
		expect(matches("spring-projects/spring-data-redis")).toBe(true);
		// `*` requires one or more characters, so a bare org-and-slash does not match.
		expect(matches("spring-projects/")).toBe(false);
		// `spring-data*` requires a suffix after spring-data.
		expect(matches("spring-projects/spring-data-jpa")).toBe(true);
		// An exact pattern matches only itself.
		expect(matches("octo/widgets")).toBe(true);
		expect(matches("octo/widgets-extra")).toBe(false);
		// A repository in another organization is not followed.
		expect(matches("forbidden/repository")).toBe(false);
	});

	it("matches case-insensitively and treats dots and hyphens as literal, not wildcards", () => {
		const matches = followReferenceMatcher(["Octo/Spring.Data"]);
		expect(matches("octo/spring.data")).toBe(true);
		// The dot is escaped, so it does not stand in for an arbitrary character.
		expect(matches("octo/springXdata")).toBe(false);
	});
});
