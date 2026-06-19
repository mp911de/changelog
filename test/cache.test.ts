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
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCache, type ResolvedTicket } from "../src/cache.js";

function ticket(id: string): ResolvedTicket {
	return {
		title: `Title ${id}`,
		htmlUrl: `https://example.test/${id.replace("#", "")}`,
		labels: ["enhancement"],
		pullRequest: false,
		author: "octocat",
	};
}

describe("loadCache", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "changelog-cache-"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function cachePath(slug: string): string {
		return join(baseDir, ".changelog", `${slug}.cache.json`);
	}

	it("returns an empty cache and no file when none exists yet", async () => {
		const cache = await loadCache({ baseDir, slug: "widgets" });

		expect(cache.get("octo/widgets#1")).toBeUndefined();
		expect(() => readFileSync(cachePath("widgets"), "utf8")).toThrow();
	});

	it("writes .changelog/<slug>.cache.json keyed by owner/repo#number with ResolvedTicket entries", async () => {
		const cache = await loadCache({ baseDir, slug: "widgets" });
		await cache.update(new Map([["octo/widgets#1", ticket("#1")]]));

		const written = JSON.parse(readFileSync(cachePath("widgets"), "utf8")) as Record<
			string,
			ResolvedTicket
		>;
		expect(written).toEqual({ "octo/widgets#1": ticket("#1") });
	});

	it("pretty-prints the cache file for readable diffs", async () => {
		const cache = await loadCache({ baseDir, slug: "widgets" });
		await cache.update(new Map([["octo/widgets#1", ticket("#1")]]));

		const raw = readFileSync(cachePath("widgets"), "utf8");
		expect(raw).toContain('\n  "octo/widgets#1"');
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("loads existing entries so they can be reused as cache hits", async () => {
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			cachePath("widgets"),
			JSON.stringify({ "acme/gizmos#9": ticket("#9") }),
			"utf8",
		);

		const cache = await loadCache({ baseDir, slug: "widgets" });

		expect(cache.get("acme/gizmos#9")).toEqual(ticket("#9"));
	});

	it("treats __proto__ as a cache key without changing lookup behavior", async () => {
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			cachePath("widgets"),
			`{"__proto__":${JSON.stringify(ticket("#9"))}}`,
			"utf8",
		);

		const cache = await loadCache({ baseDir, slug: "widgets" });

		expect(cache.get("__proto__")).toEqual(ticket("#9"));
		expect(cache.get("title")).toBeUndefined();
	});

	it("keeps compatible entries and ignores malformed entries with an injected diagnostic", async () => {
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(
			cachePath("widgets"),
			JSON.stringify({
				"acme/gizmos#9": ticket("#9"),
				"acme/gizmos#10": { title: "Incomplete" },
			}),
			"utf8",
		);
		const diagnostics: string[] = [];

		const cache = await loadCache({
			baseDir,
			slug: "widgets",
			diagnostic: (message) => diagnostics.push(message),
		});

		expect(cache.get("acme/gizmos#9")).toEqual(ticket("#9"));
		expect(cache.get("acme/gizmos#10")).toBeUndefined();
		expect(diagnostics).toEqual([expect.stringContaining("acme/gizmos#10")]);
	});

	it("ignores a corrupt cache file instead of failing, so it can be rebuilt", async () => {
		mkdirSync(join(baseDir, ".changelog"), { recursive: true });
		writeFileSync(cachePath("widgets"), "{ this is not valid json", "utf8");
		const diagnostics: string[] = [];

		const cache = await loadCache({
			baseDir,
			slug: "widgets",
			diagnostic: (message) => diagnostics.push(message),
		});

		expect(cache.get("acme/gizmos#9")).toBeUndefined();
		expect(diagnostics).toEqual([
			expect.stringContaining("Ignoring unreadable JSON"),
		]);

		await cache.update(new Map([["octo/widgets#1", ticket("#1")]]));
		const written = JSON.parse(readFileSync(cachePath("widgets"), "utf8")) as Record<
			string,
			ResolvedTicket
		>;
		expect(written).toEqual({ "octo/widgets#1": ticket("#1") });
	});

	it("leaves no temp file behind after an atomic write", async () => {
		const cache = await loadCache({ baseDir, slug: "widgets" });
		await cache.update(new Map([["octo/widgets#1", ticket("#1")]]));

		expect(readdirSync(join(baseDir, ".changelog"))).toEqual(["widgets.cache.json"]);
	});
});
