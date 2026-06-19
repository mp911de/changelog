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

import { generateChangelog } from "./changelog.js";
import { type ChangelogConfig, followReferenceMatcher } from "./config.js";
import { parseReferenceOccurrences } from "./commit-parser.js";
import { scanCommits } from "./git.js";
import type { Repository } from "./github-context.js";
import { noRunProgress, type RunProgress, runStage } from "./progress.js";
import { type LookupFacts, resolveTicketReferences } from "./resolved-references.js";
import {
	collectTicketReferences,
	type CommitReferences,
	type LookupTarget,
	type TicketTarget,
} from "./ticket-references.js";

/**
 * Resolve a batch of deduplicated, flagged Ticket Targets to role-free GitHub facts. The optional
 * {@code debug} traces GitHub requests into the Looking up stage.
 */
export type Lookup = (
	targets: readonly LookupTarget[],
	debug?: (line: string) => void,
) => Promise<LookupFacts>;

export interface PipelineOptions {
	readonly from: string;
	readonly to: string;
	readonly cwd: string;
	readonly repository: Repository;
	readonly config: ChangelogConfig;
	readonly all: boolean;
	readonly lookup: Lookup;
	readonly progress?: RunProgress;
}

/**
 * Run the three visible stages and return only the Changelog Document. Scanning reads Git history,
 * parses commit messages, and builds Aggregated Ticket References; Looking up resolves the requested
 * Ticket Targets into Resolved Ticket References; Generating renders the document. Each stage reports
 * its facts as Run Progress; nothing else is returned.
 */
export async function runPipeline(options: PipelineOptions): Promise<string> {
	const progress = options.progress ?? noRunProgress;

	// Parsing happens during scanning, so the Scanned facts are ready when the scan completes; there is no separate Parsing stage.
	const aggregate = await runStage(
		progress,
		"Scanning",
		async (debug) => {
			const commits = await scanCommits(
				options.from,
				options.to,
				options.cwd,
				debug,
			);
			const collected: CommitReferences[] = commits.map((commit) => ({
				commit: {
					sha: commit.sha,
					author: commit.author,
					summary: commit.shortMessage,
				},
				occurrences: parseReferenceOccurrences(commit.fullMessage),
			}));
			return {
				commitCount: commits.length,
				aggregate: collectTicketReferences(
					collected,
					options.repository,
				).aggregate(),
			};
		},
		(result) => ({
			type: "scanning-complete",
			stage: "Scanning",
			commits: result.commitCount,
			aggregate: result.aggregate,
		}),
	).then((result) => result.aggregate);

	const resolved = await runStage(
		progress,
		"Looking up",
		async (debug) => {
			const { followed, excluded } = partitionByFollow(
				aggregate.targets(),
				options.config.followReferences,
			);
			const facts = await options.lookup(followed, debug);
			return resolveTicketReferences(aggregate, facts, excluded);
		},
		(result) => ({
			type: "looking-up-complete",
			stage: "Looking up",
			resolved: result,
		}),
	);

	return runStage(
		progress,
		"Generating",
		() =>
			generateChangelog(resolved.entries, resolved.authors, options.config, {
				all: options.all,
			}),
		(result) => ({
			type: "generating-complete",
			stage: "Generating",
			summary: {
				documentedEntries: result.documentedEntries,
				sectionCounts: result.sectionCounts,
				contributorCount: result.contributorCount,
			},
		}),
	).then((result) => result.markdown);
}

/**
 * Split flagged targets into those to look up and those held back by followReferences. A reference
 * to the current repository (no explicit repository) is always followed; a cross-repository reference
 * is followed only when its `owner/repo` matches the allow-list. Absent or empty patterns follow
 * everything.
 */
function partitionByFollow(
	targets: readonly LookupTarget[],
	patterns: readonly string[] | undefined,
): { followed: LookupTarget[]; excluded: TicketTarget[] } {
	const matches = followReferenceMatcher(patterns ?? []);
	const followed: LookupTarget[] = [];
	const excluded: TicketTarget[] = [];
	for (const flagged of targets) {
		const repository = flagged.target.repository;
		if (repository && !matches(`${repository.owner}/${repository.repo}`)) {
			excluded.push(flagged.target);
		} else {
			followed.push(flagged);
		}
	}
	return { followed, excluded };
}
