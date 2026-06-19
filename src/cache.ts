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

import { join } from "node:path";

import { readOptionalJson, writeJsonFile } from "./json-file.js";

/**
 * Role-free GitHub facts for one Ticket Target, stored verbatim as the on-disk cache value.
 * Changelog-purpose targets use the title, URL, labels, and pull-request status; credit-purpose
 * targets use the author. These fields are long-term cache data (ADR 0004).
 */
export interface ResolvedTicket {
	readonly title: string;
	readonly htmlUrl: string;
	readonly labels: readonly string[];
	readonly pullRequest: boolean;
	readonly author?: string;
}

// Include the repository in the key so cross-repository references cannot collide. A Map keeps
// attacker-controlled cache keys such as __proto__ out of JavaScript's object prototype semantics.
type CacheEntries = Map<string, ResolvedTicket>;

export interface LoadCacheOptions {
	readonly baseDir: string;
	readonly slug: string;
	readonly diagnostic?: (message: string) => void;
}

export interface TicketCache {
	get(key: string): ResolvedTicket | undefined;

	update(tickets: ReadonlyMap<string, ResolvedTicket>): Promise<void>;
}

export async function loadCache(options: LoadCacheOptions): Promise<TicketCache> {
	const path = join(options.baseDir, ".changelog", `${options.slug}.cache.json`);
	// The cache is a disposable, regenerable artifact: a corrupt file (for example from an
	// interrupted write) is rebuilt from scratch rather than failing every subsequent run.
	const loaded = await readOptionalJson<unknown>(path, {
		onInvalid: "ignore",
		onIgnored: options.diagnostic,
	});
	const entries = compatibleEntries(loaded, path, options.diagnostic);

	return {
		get(key) {
			return entries.get(key);
		},
		async update(tickets) {
			for (const [key, ticket] of tickets) {
				entries.set(key, ticket);
			}
			await writeJsonFile(path, Object.fromEntries(entries));
		},
	};
}

function compatibleEntries(
	value: unknown,
	path: string,
	diagnostic: ((message: string) => void) | undefined,
): CacheEntries {
	if (value === undefined) {
		return new Map();
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		diagnostic?.(
			`Ignoring incompatible cache data at ${path}; continuing without it.`,
		);
		return new Map();
	}

	const entries: CacheEntries = new Map();
	for (const [key, entry] of Object.entries(value)) {
		if (isResolvedTicket(entry)) {
			entries.set(key, entry);
		} else {
			diagnostic?.(`Ignoring incompatible cache entry ${key} at ${path}.`);
		}
	}
	return entries;
}

function isResolvedTicket(value: unknown): value is ResolvedTicket {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const ticket = value as Record<string, unknown>;
	return (
		typeof ticket.title === "string" &&
		typeof ticket.htmlUrl === "string" &&
		Array.isArray(ticket.labels) &&
		ticket.labels.every((label) => typeof label === "string") &&
		typeof ticket.pullRequest === "boolean" &&
		(ticket.author === undefined || typeof ticket.author === "string")
	);
}
