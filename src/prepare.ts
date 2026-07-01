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

import { loadCache } from "./cache.js";
import { type ChangelogConfig, loadOrCreateConfig } from "./config.js";
import { classifyRef, gitRepoRefs, resolveCommit } from "./git.js";
import type { GitHubAdapterFactory } from "./github-adapter.js";
import type { Repository } from "./github-context.js";
import { headerFields } from "./links.js";
import type { Lookup } from "./pipeline.js";
import type { BuildProvenance, HeaderFields } from "./render.js";
import { type CliRange, resolveAutoRange, type ResolvedRange } from "./version.js";

/**
 * The dependencies a single preparation needs. {@code trace} is the {@code --debug}-gated Git/GitHub
 * call trace (undefined when not tracing); {@code diagnostic} always receives cache diagnostics for
 * the Preparing stage regardless of {@code --debug}.
 */
export interface PrepareRunOptions {
	readonly range: CliRange;
	readonly cwd: string;
	readonly repoOverride?: string;
	readonly refresh: boolean;
	readonly githubAdapter: GitHubAdapterFactory;
	readonly trace?: (line: string) => void;
	readonly diagnostic: (line: string) => void;
}

export interface PreparedRun {
	readonly repo: Repository;
	readonly range: ResolvedRange;
	readonly config: ChangelogConfig;
	readonly lookup: Lookup;
}

/**
 * Resolve everything a run needs before scanning: the commit range (from the tags in auto mode, or
 * verbatim for an explicit range), the GitHub repository and login, the configuration, and the
 * {@link Lookup} bound to the loaded cache. Performs no header or terminal work; see
 * {@link resolveHeaderFields} for the presentation values.
 */
export async function prepareRun(options: PrepareRunOptions): Promise<PreparedRun> {
	const { cwd, trace } = options;
	const range: ResolvedRange =
		options.range.mode === "auto"
			? await resolveAutoRange(options.range.target, gitRepoRefs(cwd, trace))
			: {
					from: { ref: options.range.from, label: options.range.from },
					to: { ref: options.range.to, label: options.range.to },
				};

	const adapter = await options.githubAdapter({
		cwd,
		repoOverride: options.repoOverride,
		trace,
	});
	const config = await loadOrCreateConfig({
		baseDir: cwd,
		login: adapter.login,
		owner: adapter.repo.owner,
	});
	const cache = await loadCache({
		baseDir: cwd,
		slug: adapter.repo.repo,
		diagnostic: options.diagnostic,
	});
	const lookup = adapter.createLookup({ cache, refresh: options.refresh });

	return { repo: adapter.repo, range, config, lookup };
}

export interface HeaderContext {
	readonly version: string;
	readonly build: BuildProvenance;
	readonly output: string;
	readonly outputUrl: string;
	readonly cwd: string;
	readonly trace?: (line: string) => void;
}

/**
 * Build the header box fields for a resolved range. Resolves the range head sha (and the {@code from}
 * sha only when {@code from} is HEAD), and each bound's {@link RefKind} from the bound itself when
 * the range resolver already knew it (auto mode) or by classifying the ref against Git otherwise
 * (explicit mode). Called only when a header will render, so the Git work is skipped for quiet runs.
 */
export async function resolveHeaderFields(
	run: Pick<PreparedRun, "repo" | "range">,
	context: HeaderContext,
): Promise<HeaderFields> {
	const { repo, range } = run;
	const { cwd, trace } = context;
	const { from, to } = range;

	const toSha = await resolveCommit(to.ref, cwd, trace);
	const fromSha =
		from.ref === "HEAD"
			? from.ref === to.ref
				? toSha
				: await resolveCommit(from.ref, cwd, trace)
			: "";
	const fromKind = from.kind ?? (await classifyRef(from.ref, cwd, trace));
	const toKind = to.kind ?? (await classifyRef(to.ref, cwd, trace));

	return headerFields({
		repository: repo,
		version: context.version,
		build: context.build,
		range,
		fromKind,
		toKind,
		fromSha,
		toSha,
		output: context.output,
		outputUrl: context.outputUrl,
	});
}
