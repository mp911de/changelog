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

import type { ResolvedTicketReferences } from "./resolved-references.js";
import type { Aggregate } from "./ticket-references.js";

/**
 * The visible lifecycle stages of one run, in order. Preparing resolves the range, repository, and
 * configuration; Scanning reads Git history, parses commit messages, and aggregates Ticket
 * References; Looking up resolves the requested Ticket Targets; Generating renders the document.
 * There is no separate Parsing stage: parsing and aggregation belong to Scanning.
 */
export type RunStage = "Preparing" | "Scanning" | "Looking up" | "Generating";

/**
 * The transient document summary produced by generation: the count of entries actually rendered
 * (after exclusion and `--all`), the per-section counts in configured order, and the number of
 * Contributor Credits. It is reported as Run Progress and is not part of the Changelog Document.
 */
export interface GenerationSummary {
	readonly documentedEntries: number;
	// Map order preserves the configured section order in the rendered summary.
	readonly sectionCounts: ReadonlyMap<string, number>;
	readonly contributorCount: number;
}

/**
 * One ordered, semantic Run Progress event. Events carry only run facts: no terminal cells, styles,
 * widths, or escape sequences. The Scanning completion carries Aggregated Ticket References, the
 * Looking up completion carries Resolved Ticket References, and the Generating completion carries the
 * transient generation summary, all directly. Stage-bound debug events stay attached to the stage
 * that produced them.
 */
export type RunProgressEvent =
	| { readonly type: "stage-start"; readonly stage: RunStage }
	| { readonly type: "stage-debug"; readonly stage: RunStage; readonly line: string }
	| { readonly type: "stage-failed"; readonly stage: RunStage }
	| { readonly type: "preparing-complete"; readonly stage: "Preparing" }
	| {
			readonly type: "scanning-complete";
			readonly stage: "Scanning";
			readonly commits: number;
			readonly aggregate: Aggregate;
	  }
	| {
			readonly type: "looking-up-complete";
			readonly stage: "Looking up";
			readonly resolved: ResolvedTicketReferences;
	  }
	| {
			readonly type: "generating-complete";
			readonly stage: "Generating";
			readonly summary: GenerationSummary;
	  };

/**
 * A sink for ordered Run Progress events. Implementations decide what, if anything, to display.
 */
export interface RunProgress {
	emit(event: RunProgressEvent): void;
}

/**
 * A Run Progress sink that discards every event, for quiet and stdout-only runs.
 */
export const noRunProgress: RunProgress = {
	emit: () => {},
};

/**
 * Run one stage with enforced event ordering and stage-bound debug. Emits a start event, runs the
 * action with a debug emitter scoped to this stage, emits the completion event the caller builds on
 * success, or emits a stage failure and rethrows on error. There is no mutable tracer binding: each
 * stage owns its own debug emitter, so traces cannot attach to the wrong stage.
 */
export async function runStage<T>(
	progress: RunProgress,
	stage: RunStage,
	action: (debug: (line: string) => void) => T | Promise<T>,
	complete: (result: T) => RunProgressEvent,
): Promise<T> {
	progress.emit({ type: "stage-start", stage });
	const debug = (line: string): void =>
		progress.emit({ type: "stage-debug", stage, line });
	try {
		const result = await action(debug);
		progress.emit(complete(result));
		return result;
	} catch (error) {
		progress.emit({ type: "stage-failed", stage });
		throw error;
	}
}
