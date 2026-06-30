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

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { writeFileAtomically } from "./atomic-file.js";
import { hasCode } from "./errors.js";

export interface ReadJsonOptions {
	// How to treat a file that exists but does not contain valid JSON. "throw" (the default) surfaces
	// the parse error so authoritative files such as configuration are never silently discarded;
	// "ignore" treats the content as absent, which suits caches a truncated write must not break.
	readonly onInvalid?: "throw" | "ignore";
	readonly onIgnored?: (message: string) => void;
}

/**
 * A missing file is always optional. By default a present-but-invalid file still throws so
 * invalid configuration is not silently replaced; pass {@code onInvalid: "ignore"} to recover
 * from a corrupt cache instead.
 */
export async function readOptionalJson<T>(
	path: string,
	options: ReadJsonOptions = {},
): Promise<T | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) {
			return undefined;
		}
		throw error;
	}

	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		if (options.onInvalid === "ignore") {
			options.onIgnored?.(
				`Ignoring unreadable JSON at ${path}; continuing without it.`,
			);
			return undefined;
		}
		throw new Error(`Could not parse JSON at "${path}".`, { cause: error });
	}
}

/**
 * Write atomically via a sibling temp file and rename so an interrupted write cannot truncate
 * the target into invalid JSON. Pretty printing and a trailing newline keep diffs readable.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const text = JSON.stringify(value, null, 2);
	await writeFileAtomically(path, `${text}\n`);
}
