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

import { type RunProgress, type RunProgressEvent, runStage } from "../src/progress.js";

function recorder(): { events: RunProgressEvent[] } & RunProgress {
	const events: RunProgressEvent[] = [];
	return {
		events,
		emit(event) {
			events.push(event);
		},
	};
}

describe("runStage", () => {
	it("emits start, then stage-bound debug, then completion in order", async () => {
		const progress = recorder();

		const result = await runStage(
			progress,
			"Scanning",
			(debug) => {
				debug("git log a..b");
				return 7;
			},
			(commits) => ({
				type: "scanning-complete",
				stage: "Scanning",
				commits,
				aggregate: undefined as never,
			}),
		);

		expect(result).toBe(7);
		expect(progress.events.map((event) => event.type)).toEqual([
			"stage-start",
			"stage-debug",
			"scanning-complete",
		]);
		expect(progress.events[0]).toMatchObject({ stage: "Scanning" });
		expect(progress.events[1]).toMatchObject({
			stage: "Scanning",
			line: "git log a..b",
		});
	});

	it("emits a stage failure and rethrows when the action throws", async () => {
		const progress = recorder();

		await expect(
			runStage(
				progress,
				"Looking up",
				() => {
					throw new Error("boom");
				},
				() => ({
					type: "looking-up-complete",
					stage: "Looking up",
					resolved: undefined as never,
				}),
			),
		).rejects.toThrow("boom");

		expect(progress.events).toEqual([
			{ type: "stage-start", stage: "Looking up" },
			{ type: "stage-failed", stage: "Looking up" },
		]);
	});
});
