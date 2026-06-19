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
 * the target into invalid JSON. Pretty printing and a trailing newline keep diffs readable. Pass
 * {@code compact: true} for the {@link compactJson} layout (used for hand-edited config files).
 */
export async function writeJsonFile(
	path: string,
	value: unknown,
	options: { compact?: boolean } = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const text = options.compact ? compactJson(value) : JSON.stringify(value, null, 2);
	await writeFileAtomically(path, `${text}\n`);
}

/**
 * Serialize JSON in a compact, review-friendly layout: a value stays on one line when it is a
 * primitive, an array whose elements are all primitives, or an object whose every value is itself
 * inline-able; otherwise it breaks across lines with 2-space indentation, each element or entry
 * formatted recursively. Empty arrays and objects stay inline. The result is standard JSON.
 */
export function compactJson(value: unknown): string {
	return formatJson(value, 0);
}

function formatJson(value: unknown, depth: number): string {
	const inlined = inlineJson(value);
	if (inlined !== undefined) {
		return inlined;
	}
	const inner = "  ".repeat(depth + 1);
	const outer = "  ".repeat(depth);
	if (Array.isArray(value)) {
		const items = value.map((item) => `${inner}${formatJson(item, depth + 1)}`);
		return `[\n${items.join(",\n")}\n${outer}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).map(
		([key, item]) => `${inner}${JSON.stringify(key)}: ${formatJson(item, depth + 1)}`,
	);
	return `{\n${entries.join(",\n")}\n${outer}}`;
}

/**
 * The single-line form of a value when it is flat enough to inline, otherwise undefined.
 */
function inlineJson(value: unknown): string | undefined {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		if (value.every((item) => item === null || typeof item !== "object")) {
			return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
		}
		return undefined;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) {
		return "{}";
	}
	const parts: string[] = [];
	for (const [key, item] of entries) {
		const piece = inlineJson(item);
		if (piece === undefined) {
			return undefined;
		}
		parts.push(`${JSON.stringify(key)}: ${piece}`);
	}
	return `{ ${parts.join(", ")} }`;
}
