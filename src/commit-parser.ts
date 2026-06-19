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

import {
	qualifierRank,
	type ReferenceOccurrence,
	referenceOccurrence,
	type ReferenceQualifier,
} from "./ticket-references.js";

// GITHUB_QUALIFIED_TICKET: (owner)(repo)(#|gh- n)(#|gh-) -> groups 1,2,3,4
const GITHUB_QUALIFIED_TICKET = "([\\w-]{1,100})/([\\w-]{1,100})((#|gh-)\\d+)";
// GITHUB_URL_QUALIFIED_TICKET: (owner)(repo)(n) -> groups 1,2,3
const GITHUB_URL_QUALIFIED_TICKET =
	"http[s:/]+[\\w.]{1,253}/([\\w-]{1,100})/([\\w-]{1,100})/issues/(\\d+)";
// GITHUB_TICKET: (#|gh- n) -> group 1
const GITHUB_TICKET = "((?:#|gh-)\\d+)";

// Within close/see/related-to the matched ticket is captured as group 1; extraction re-parses it.
const CLOSE_KEYWORDS =
	"(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)";
const SEE_KEYWORDS = "(?:see)";
const RELATED_TO_KEYWORDS = "(?:related to)";
const TICKET_ALTERNATION = `(${GITHUB_QUALIFIED_TICKET}|${GITHUB_URL_QUALIFIED_TICKET}|${GITHUB_TICKET})`;

const GITHUB_CLOSE_SYNTAX = `${CLOSE_KEYWORDS}[\\s:]*${TICKET_ALTERNATION}`;
const GITHUB_SEE_SYNTAX = `${SEE_KEYWORDS}[\\s:]*${TICKET_ALTERNATION}`;
const GITHUB_RELATED_TO_SYNTAX = `${RELATED_TO_KEYWORDS}[\\s:]*${TICKET_ALTERNATION}`;

// RELATED_TICKET captures the whole comma/whitespace-separated list as group 1; downstream
// splits it and re-parses each. PULL_REQUEST captures its single trailing ticket.
const RELATED_TICKET = `(?:(?:Related (?:tickets|ticket))|(?:Ticket)|(?:Related))[:]*(?:\\s+)?((?:${TICKET_ALTERNATION}(?:[\\s,]*))+)`;
// "pull request:" is the canonical form; an "Original " prefix is just another variant that
// matches. Case-insensitivity comes from the `i` flag applied where this pattern runs.
const PULL_REQUEST = `(?:Original\\s+)?(?:pull request|PR|pullrequest)[:]*(?:\\s+)?${TICKET_ALTERNATION}`;

const QUALIFIED_MATCH = new RegExp(`^${GITHUB_QUALIFIED_TICKET}$`, "i");
const URL_QUALIFIED_MATCH = new RegExp(`^${GITHUB_URL_QUALIFIED_TICKET}$`, "i");
const TICKET_MATCH = new RegExp(`^${GITHUB_TICKET}$`, "i");

const ANY_TICKET_SCAN = new RegExp(TICKET_ALTERNATION, "gi");

// Relationship syntaxes whose enclosed ticket tokens carry a stronger qualifier than a bare
// reference. Each entry runs over the whole message; any ticket token inside a match inherits the
// listed qualifier. A RELATED_TICKET match groups several tokens, so one match qualifies every
// ticket in the list.
const QUALIFIER_SYNTAX: ReadonlyArray<{
	pattern: string;
	qualifier: ReferenceQualifier;
}> = [
	{ pattern: GITHUB_CLOSE_SYNTAX, qualifier: "Qualified" },
	{ pattern: PULL_REQUEST, qualifier: "PullRequest" },
	{ pattern: GITHUB_SEE_SYNTAX, qualifier: "See" },
	{ pattern: RELATED_TICKET, qualifier: "Related" },
	{ pattern: GITHUB_RELATED_TO_SYNTAX, qualifier: "Related" },
];

/**
 * Emit every textual Ticket Reference occurrence in the commit message, in textual order, once per
 * textual reference, each carrying its strongest recognized {@link ReferenceQualifier}. Closing
 * keywords yield `Qualified`, pull-request syntax yields `PullRequest`, `see` syntax yields
 * `See`, `related`/`related to`/`Related:`/`Ticket:` syntax yields `Related`, and a bare reference
 * stays `Simple`. A misspelled relationship keyword leaves its reference `Simple`. The parser
 * recognizes syntax only; it does not rank references, assign roles, deduplicate targets, or expose
 * offsets.
 */
export function parseReferenceOccurrences(message: string): ReferenceOccurrence[] {
	const qualifiers = qualifierByPosition(message);
	const occurrences: ReferenceOccurrence[] = [];
	ANY_TICKET_SCAN.lastIndex = 0;
	for (
		let match = ANY_TICKET_SCAN.exec(message);
		match;
		match = ANY_TICKET_SCAN.exec(message)
	) {
		const occurrence = extractOccurrence(
			match[1]!,
			qualifiers.get(match.index) ?? "Simple",
		);
		if (occurrence) {
			occurrences.push(occurrence);
		}
	}
	return occurrences;
}

/**
 * Map each ticket token's start position to its strongest recognized qualifier. Each relationship
 * syntax runs over the whole message; ticket tokens enclosed by a match inherit its qualifier, and
 * the strongest qualifier wins when syntaxes overlap. Unclaimed positions stay `Simple` by default.
 */
function qualifierByPosition(message: string): Map<number, ReferenceQualifier> {
	const byPosition = new Map<number, ReferenceQualifier>();
	for (const { pattern, qualifier } of QUALIFIER_SYNTAX) {
		const syntax = new RegExp(pattern, "gim");
		for (let match = syntax.exec(message); match; match = syntax.exec(message)) {
			const enclosed = new RegExp(TICKET_ALTERNATION, "gi");
			for (
				let token = enclosed.exec(match[0]);
				token;
				token = enclosed.exec(match[0])
			) {
				const position = match.index + token.index;
				const current = byPosition.get(position);
				if (
					current === undefined ||
					qualifierRank[qualifier] > qualifierRank[current]
				) {
					byPosition.set(position, qualifier);
				}
			}
		}
	}
	return byPosition;
}

function extractOccurrence(
	token: string,
	qualifier: ReferenceQualifier,
): ReferenceOccurrence | undefined {
	const trimmed = token.trim();

	const url = URL_QUALIFIED_MATCH.exec(trimmed);
	if (url) {
		return referenceOccurrence(`#${url[3]}`, qualifier, {
			owner: url[1]!,
			repo: url[2]!,
		});
	}

	const qualified = QUALIFIED_MATCH.exec(trimmed);
	if (qualified) {
		return referenceOccurrence(qualified[3]!, qualifier, {
			owner: qualified[1]!,
			repo: qualified[2]!,
		});
	}

	if (TICKET_MATCH.test(trimmed)) {
		return referenceOccurrence(trimmed, qualifier);
	}

	return undefined;
}
