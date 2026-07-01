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

import type { RefKind } from "./git.js";
import type { Repository } from "./github-context.js";
import type { BuildProvenance, HeaderFields } from "./render.js";
import { targetKey, type TicketTarget } from "./ticket-references.js";
import type { ResolvedRange } from "./version.js";

const GITHUB = "https://github.com";

export function repoUrl(repo: Repository, path = ""): string {
	return `${GITHUB}/${repo.owner}/${repo.repo}${path}`;
}

export function commitUrl(repo: Repository, sha: string): string {
	return repoUrl(repo, `/commit/${sha}`);
}

// GitHub redirects /issues/<n> to /pull/<n> for pull requests, so one form links both.
export function ticketUrl(repo: Repository, target: TicketTarget): string {
	const number = target.id.replace(/^#/, "");
	return repoUrl(target.repository ?? repo, `/issues/${number}`);
}

/**
 * Link a from/to revision to its GitHub page from its git-resolved {@link RefKind}: a tag's release
 * page, a branch's tree, a plain commit, or HEAD (resolved to its head commit).
 */
function refUrl(
	repo: Repository,
	ref: string,
	kind: RefKind,
	resolvedSha: string,
): string {
	switch (kind) {
		case "head":
			return commitUrl(repo, resolvedSha);
		case "commit":
			return commitUrl(repo, ref);
		case "branch":
			return repoUrl(repo, `/tree/${ref}`);
		case "tag":
			return repoUrl(repo, `/releases/tag/${ref}`);
	}
}

export function headerFields(params: {
	readonly repository: Repository;
	readonly version: string;
	readonly build: BuildProvenance;
	readonly range: ResolvedRange;
	readonly fromKind: RefKind;
	readonly toKind: RefKind;
	readonly fromSha: string;
	readonly toSha: string;
	readonly output: string;
	readonly outputUrl: string;
}): HeaderFields {
	const { repository, range } = params;
	const repositoryUrl = repoUrl(repository);
	return {
		repository: { ...repository, url: repositoryUrl },
		version: params.version,
		build: params.build,
		repositoryLine: [
			{
				text: `${repository.owner}/${repository.repo}`,
				link: repositoryUrl,
			},
		],
		range: [
			{
				text: range.from.label,
				link: refUrl(
					repository,
					range.from.label,
					params.fromKind,
					params.fromSha,
				),
			},
			{ text: ".." },
			{
				text: range.to.label,
				link: refUrl(repository, range.to.label, params.toKind, params.toSha),
			},
			{ text: " (", style: "faint" },
			{
				text: params.toSha.slice(0, 7),
				style: "faint",
				link: commitUrl(repository, params.toSha),
			},
			{ text: ")", style: "faint" },
		],
		output: [{ text: params.output, link: params.outputUrl }],
	};
}
