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

import type { CommitRecord } from "../src/git.js";
import type { ScanCommits } from "../src/pipeline.js";

let commitCounter = 0;

export function commit(message: string): CommitRecord {
	commitCounter += 1;
	const [shortMessage = message] = message.split("\n", 1);
	return {
		sha: commitCounter.toString(16).padStart(40, "0"),
		author: "Test User",
		fullMessage: message,
		shortMessage,
	};
}

/**
 * Builds a {@link ScanCommits} that yields commits parsed from `messages`,
 * ignoring the `from`/`to` refs it is called with.
 *
 * Because the injected scan never looks at the range, a test may pass any
 * placeholder range (e.g. `"base..HEAD"`). This is safe only for `--quiet` or
 * stdout runs, where no header renders and the refs are never resolved by Git.
 */
export function scanning(...messages: string[]): ScanCommits {
	const commits = messages.map(commit);
	return async () => commits;
}

export function failingScan(message: string): ScanCommits {
	return async () => {
		throw new Error(message);
	};
}
