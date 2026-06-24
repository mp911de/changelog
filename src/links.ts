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
import type { HeaderFields } from "./render.js";
import { targetKey, type TicketTarget } from "./ticket-references.js";

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

function treeUrl(repo: Repository, ref: string): string {
	return repoUrl(repo, `/tree/${ref}`);
}

function tagUrl(repo: Repository, ref: string): string {
	return repoUrl(repo, `/releases/tag/${ref}`);
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
			return treeUrl(repo, ref);
		case "tag":
			return tagUrl(repo, ref);
	}
}

export interface HeaderParams {
	readonly repo: Repository;
	readonly version: string;
	readonly from: string;
	readonly to: string;
	// Git-resolved kinds of `from`/`to`, used to point each link at the right GitHub page.
	readonly fromKind: RefKind;
	readonly toKind: RefKind;
	// Full sha of `from`, resolved only when `from` is HEAD; `toSha` is always the head of the range.
	readonly fromSha: string;
	readonly toSha: string;
	readonly output: string;
	readonly outputUrl: string;
}

/**
 * Build the header box fields, linking the from/to revisions and the resolved range sha.
 */
export function headerFields(params: HeaderParams): HeaderFields {
	const { repo } = params;
	return {
		repoName: repo.repo,
		repoUrl: repoUrl(repo),
		version: params.version,
		repository: [{ text: `${repo.owner}/${repo.repo}`, link: repoUrl(repo) }],
		range: [
			{
				text: params.from,
				link: refUrl(repo, params.from, params.fromKind, params.fromSha),
			},
			{ text: ".." },
			{
				text: params.to,
				link: refUrl(repo, params.to, params.toKind, params.toSha),
			},
			{ text: " (", style: "faint" },
			{
				text: params.toSha.slice(0, 7),
				style: "faint",
				link: commitUrl(repo, params.toSha),
			},
			{ text: ")", style: "faint" },
		],
		output: [{ text: params.output, link: params.outputUrl }],
	};
}
