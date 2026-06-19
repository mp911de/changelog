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
	type Cell,
	pad,
	type Palette,
	realize,
	type Style,
	truncateText,
} from "./palette.js";

/**
 * The five generic emphasis levels for a Ticket Reference in a scanned-commit flow, mapped to
 * progressively fainter color by the renderer. The Lead Ticket Reference is the brightest; the
 * omission marker shares the faintest `related` level. Limited-color terminals collapse adjacent
 * levels without dropping any text.
 */
export type Emphasis = "lead" | "candidate" | "credit" | "demoted" | "related";

/**
 * One Ticket Reference in a scanned-commit reference flow. Its text is a complete display label and
 * is always rendered in full or not at all; the renderer never truncates it to a substring.
 */
export interface ReferenceItem {
	readonly text: string;
	readonly emphasis: Emphasis;
	readonly link?: string;
}

/**
 * One scanned commit as layout intent: the abbreviated sha and two free-text fields the renderer may
 * truncate (summary before author), the Lead Ticket Reference that is never omitted or truncated, and
 * the additional references offered in display-priority then textual order. The renderer fits the
 * trailing reference flow to the terminal width, reserves room for an omission marker, and wraps the
 * lead to a continuation line when it cannot otherwise fit.
 */
export interface CommitRow {
	readonly sha: Cell;
	readonly author: string;
	readonly summary: string;
	readonly lead?: ReferenceItem;
	readonly references: readonly ReferenceItem[];
}

// Summary free-text minimum: additional references are dropped, and the lead wraps to a
// continuation line, before the summary shrinks below this width.
const SUMMARY_MIN = 10;
// A single space separates references in the trailing flow.
const FLOW_SEP = " ";
// Two spaces separate the fixed sha and author columns from each other and from the summary, so
// authors line up across rows.
const CORE_GAP = "  ";
const CORE_GAP_W = 2;
// A wrapped Lead Ticket Reference continues on the next child line, indented under the row.
const CONTINUATION_INDENT = "  ";

/**
 * Map a reference emphasis level to its descending-color {@link Style}.
 */
function emphasisStyle(emphasis: Emphasis): Style {
	switch (emphasis) {
		case "lead":
			return "accent";
		case "candidate":
			return "gray";
		case "credit":
			return "grayMedium";
		case "demoted":
			return "grayDark";
		case "related":
			return "faint";
	}
}

/**
 * The faint-gray omission marker shown when additional references do not all fit.
 */
function omissionMarker(count: number): string {
	return `and ${count} more`;
}

/**
 * Realize one atomic reference item with its emphasis color and link.
 */
function realizeReference(palette: Palette, item: ReferenceItem): string {
	return realize(palette, item.text, {
		text: item.text,
		style: emphasisStyle(item.emphasis),
		link: item.link,
	});
}

/**
 * Fit a trailing flow of atomic references into the remaining budget after a starting prefix. Each
 * reference is shown in full or not at all, in order. Space for `and N more` is reserved whenever
 * references remain, even if that displaces one complete reference; when the marker itself cannot fit
 * after what is already placed, it is omitted rather than truncated. Returns the realized suffix.
 */
export function fitReferenceFlow(
	palette: Palette,
	items: readonly ReferenceItem[],
	budget: number,
	used: number,
	// Separator before the first emitted token, so a flow that opens after the summary uses the
	// two-space column gap while items within the flow stay one space apart.
	firstSep: string = FLOW_SEP,
): string {
	let consumed = used;
	let suffix = "";
	let placed = 0;
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const sep = placed === 0 ? firstSep : FLOW_SEP;
		const cost = palette.width(sep) + palette.width(item.text);
		const remainingAfter = items.length - (index + 1);
		const marker =
			remainingAfter > 0
				? palette.width(FLOW_SEP) + palette.width(omissionMarker(remainingAfter))
				: 0;
		if (consumed + cost + marker > budget) {
			break;
		}
		suffix += `${sep}${realizeReference(palette, item)}`;
		consumed += cost;
		placed += 1;
	}
	const omitted = items.length - placed;
	if (omitted > 0) {
		const sep = placed === 0 ? firstSep : FLOW_SEP;
		const markerCost = palette.width(sep) + palette.width(omissionMarker(omitted));
		if (consumed + markerCost <= budget) {
			suffix += `${sep}${palette.style(omissionMarker(omitted), "faint")}`;
		}
	}
	return suffix;
}

/**
 * Lay out one scanned commit. The abbreviated sha and the author are fixed left-aligned columns,
 * separated from each other and from the summary by two spaces so authors line up across rows. The
 * summary is the only truncatable free text; the Lead Ticket Reference and any additional references
 * trail it as one atomic flow (a commit with no lead still shows its references). The summary
 * truncates to make room for the lead; when the lead still does not fit, it wraps to an indented
 * continuation line, overflowing intact when it alone is wider than the budget. Additional references
 * are dropped (with an `and N more` marker) before the summary shrinks below its minimum. With an
 * unbounded budget every reference is shown and nothing is truncated.
 */
function layoutCommitRow(
	palette: Palette,
	row: CommitRow,
	budget: number,
	authorWidth: number,
): string[] {
	const sha = realize(palette, row.sha.text, row.sha);
	const shaW = palette.width(row.sha.text);
	const summaryW = palette.width(row.summary);
	// The fixed left columns: sha, gap, author (padded to the shared column width), gap.
	const coreFixed = shaW + CORE_GAP_W + authorWidth + CORE_GAP_W;

	const core = (summary: string): string => {
		const author = pad(
			row.author,
			authorWidth,
			palette.width(row.author),
			"left",
			false,
		);
		return (
			`${sha}${CORE_GAP}${realize(palette, author, { text: author, style: "mauve" })}` +
			`${CORE_GAP}${realize(palette, summary, { text: summary, style: "faint" })}`
		);
	};

	// No lead: the summary fills the remaining core-line room and the references trail it directly,
	// opening with the two-space column gap.
	if (!row.lead) {
		const room = Math.max(SUMMARY_MIN, budget - coreFixed);
		const summary = truncateText(palette, row.summary, Math.min(summaryW, room));
		const flow = fitReferenceFlow(
			palette,
			row.references,
			budget,
			coreFixed + palette.width(summary),
			CORE_GAP,
		);
		return [`${core(summary)}${flow}`];
	}

	const leadW = palette.width(row.lead.text);
	// The reference region opens with the two-space column gap before the lead.
	const leadCost = CORE_GAP_W + leadW;
	const lead = realizeReference(palette, row.lead);
	const roomWithLead = budget - coreFixed - leadCost;

	// Keep the lead on the core line, truncating the summary toward its minimum to make room.
	if (roomWithLead >= Math.min(summaryW, SUMMARY_MIN)) {
		const summary = truncateText(
			palette,
			row.summary,
			Math.max(SUMMARY_MIN, Math.min(summaryW, roomWithLead)),
		);
		const used = coreFixed + palette.width(summary) + leadCost;
		const flow = fitReferenceFlow(palette, row.references, budget, used);
		return [`${core(summary)}${CORE_GAP}${lead}${flow}`];
	}

	// The lead does not fit even at the minimum summary: wrap it (and the flow) to a continuation
	// line. The lead overflows intact when it alone is wider than the budget.
	const room = Math.max(SUMMARY_MIN, budget - coreFixed);
	const summary = truncateText(palette, row.summary, Math.min(summaryW, room));
	const continuationUsed = palette.width(CONTINUATION_INDENT) + leadW;
	const flow = fitReferenceFlow(palette, row.references, budget, continuationUsed);
	return [core(summary), `${CONTINUATION_INDENT}${lead}${flow}`];
}

export function layoutCommitRows(
	palette: Palette,
	rows: readonly CommitRow[],
	budget: number,
): string[] {
	if (rows.length === 0) {
		return [];
	}
	// The author is a fixed left-aligned column sized to the widest author so names line up.
	const authorWidth = Math.max(0, ...rows.map((row) => palette.width(row.author)));
	return rows.flatMap((row) => layoutCommitRow(palette, row, budget, authorWidth));
}

/**
 * Wrap a flat, comma-separated flow of atomic items to the budget across continuation lines. Every
 * item is shown in full; an item wider than the budget overflows intact on its own line. With an
 * unbounded budget the whole flow is one line.
 */
export function layoutFlow(
	palette: Palette,
	items: readonly Cell[],
	budget: number,
): string[] {
	if (items.length === 0) {
		return [];
	}
	const sepW = palette.width(", ");
	const lines: string[] = [];
	let current = "";
	let width = 0;
	for (const item of items) {
		const itemW = palette.width(item.text);
		const lead = current.length > 0 ? sepW : 0;
		if (current.length > 0 && width + lead + itemW > budget) {
			lines.push(current);
			current = "";
			width = 0;
		}
		if (current.length > 0) {
			current += palette.style(", ", "faint");
			width += sepW;
		}
		current += realize(palette, item.text, item);
		width += itemW;
	}
	if (current.length > 0) {
		lines.push(current);
	}
	return lines;
}
