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

import { commitUrl } from "./links.js";
import { parseRemoteUrl } from "./repo-detect.js";

// Replaced with a string literal by tsdown's `define` at build time (see tsdown.config.ts). The
// `typeof` guard is the one safe read of the still-undeclared global in source runs (vite-node,
// vitest), where esbuild never substitutes it.
declare const __COMMIT_SHA__: string;

/**
 * Abbreviated commit SHA this build was produced from, captured at build time. Reports
 * {@code "dev"} when running from source (tests, {@code npm run run} via vite-node, where no build
 * step substitutes the value) and {@code "unknown"} when the build ran without git access (a
 * tarball checkout, or git missing from PATH).
 */
export const commitSha = typeof __COMMIT_SHA__ !== "undefined" ? __COMMIT_SHA__ : "dev";

/**
 * Resolve the GitHub commit URL for {@code sha} within the changelog tool's own repository, parsed
 * from the {@code repository.url} field of package.json (e.g.
 * {@code git+https://github.com/mp911de/changelog.git}). This is the provenance of the running
 * build and is distinct from the repository a run generates notes for. Returns {@code undefined}
 * when {@code sha} is not a real commit (the {@code "dev"}/{@code "unknown"} fallbacks), when
 * {@code repositoryUrl} is absent, or when it does not parse to a {@code github.com} repository, in
 * which case the SHA renders as plain text. See {@link parseRemoteUrl} for the accepted URL forms.
 */
export function buildCommitUrl(
	repositoryUrl: string | undefined,
	sha: string,
): string | undefined {
	if (repositoryUrl === undefined || !/^[0-9a-f]+$/i.test(sha)) {
		return undefined;
	}

	const remote = parseRemoteUrl(repositoryUrl);
	if (remote === undefined || remote.host !== "github.com") {
		return undefined;
	}

	return commitUrl(remote, sha);
}
