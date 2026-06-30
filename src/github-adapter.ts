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

import type { TicketCache } from "./cache.js";
import { resolveGitHubContext } from "./github-context.js";
import { createTargetLookup } from "./lookup.js";
import type { Lookup } from "./pipeline.js";

/**
 * Resolves the GitHub repository context and produces the run's {@link Lookup}. Injecting a factory
 * lets tests replace the real {@code gh}-backed context resolution and lookup; production uses
 * {@link defaultGitHubAdapter}.
 */
export type GitHubAdapterFactory = (options: {
	readonly cwd: string;
	readonly repoOverride?: string;
	readonly trace?: (line: string) => void;
}) => Promise<{
	readonly repo: { readonly owner: string; readonly repo: string };
	readonly login: string;
	readonly createLookup: (options: {
		readonly cache: TicketCache;
		readonly refresh: boolean;
	}) => Lookup;
}>;

/**
 * Routes one GitHub client's request trace to whichever stage's debug sink is active. A single
 * shared client serves preparation and every lookup, so {@link route} swaps the active sink for the
 * duration of a lookup and restores it afterwards while {@link sink} stays installed in the client's
 * request hook. This is a deliberate, contained exception to the no-mutable-tracer rule that
 * {@code progress.ts} enforces for stages: the client outlives the stage that created it.
 */
export interface TraceRouter {
	readonly sink: (line: string) => void;

	route<T>(
		active: ((line: string) => void) | undefined,
		fn: () => Promise<T>,
	): Promise<T>;
}

export function createTraceRouter(initial?: (line: string) => void): TraceRouter {
	let active = initial;
	return {
		sink: (line) => active?.(line),
		async route(next, fn) {
			active = next;
			try {
				return await fn();
			} finally {
				active = initial;
			}
		},
	};
}

/**
 * The production GitHub adapter: resolves the repository context once and reuses its client for
 * every lookup. The shared client's request trace is routed through a {@link TraceRouter} so it
 * attaches to the preparation trace during preparation and to each lookup call's own debug for the
 * duration of that call.
 */
export const defaultGitHubAdapter: GitHubAdapterFactory = async ({
	cwd,
	repoOverride,
	trace,
}) => {
	const router = createTraceRouter(trace);
	const context = await resolveGitHubContext({
		repo: repoOverride,
		cwd,
		trace: trace ? router.sink : undefined,
	});
	return {
		repo: context.repo,
		login: context.login,
		createLookup: ({ cache, refresh }) => {
			const lookup = createTargetLookup({
				octokit: context.octokit,
				repo: context.repo,
				cache,
				refresh,
			});
			return (targets, debug) =>
				router.route(debug ?? trace, () => lookup(targets));
		},
	};
};
