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

import { createTraceRouter } from "../src/github-adapter.js";

describe("createTraceRouter", () => {
	it("forwards to the initial sink until a route overrides it, then restores it", async () => {
		const lines: string[] = [];
		const router = createTraceRouter((line) => lines.push(`init:${line}`));

		router.sink("a");
		await router.route(
			(line) => lines.push(`call:${line}`),
			async () => {
				router.sink("b");
			},
		);
		router.sink("c");

		expect(lines).toEqual(["init:a", "call:b", "init:c"]);
	});

	it("restores the initial sink even when the routed function throws", async () => {
		const lines: string[] = [];
		const router = createTraceRouter((line) => lines.push(`init:${line}`));

		await expect(
			router.route(
				(line) => lines.push(`call:${line}`),
				async () => {
					router.sink("b");
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");
		router.sink("c");

		expect(lines).toEqual(["call:b", "init:c"]);
	});

	it("swallows trace when neither an initial nor a routed sink is set", async () => {
		const router = createTraceRouter();

		expect(() => router.sink("a")).not.toThrow();
		await router.route(undefined, async () => {
			expect(() => router.sink("b")).not.toThrow();
		});
	});

	it("returns the routed function's result", async () => {
		const router = createTraceRouter();

		expect(await router.route(undefined, async () => 42)).toBe(42);
	});
});
