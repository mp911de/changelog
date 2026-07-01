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
	renderInline,
	type Row,
	sanitizeTerminalText,
	truncateText,
} from "./palette.js";
import { type CommitRow, layoutCommitRows, layoutFlow } from "./reference-flow.js";

export interface ExcludedSection {
	readonly label: readonly Cell[];
	readonly flow?: readonly Cell[];
}

export interface StepSummary {
	readonly title: readonly Cell[];

	readonly notes?: readonly (readonly Cell[])[];
	readonly rows?: readonly Row[];

	readonly commitRows?: readonly CommitRow[];

	readonly flow?: readonly Cell[];

	readonly excluded?: ExcludedSection;
}

export interface BlockHandle {
	debug(line: string): void;

	succeed(summary: StepSummary): void;

	fail(title: string): void;

	discard(): void;
}

export interface BlockReporter {
	start(label: string): BlockHandle;

	dispose(): void;
}

export interface HeaderRepository {
	readonly owner: string;
	readonly repo: string;
	readonly url: string;
}

export interface BuildProvenance {
	readonly sha: string;
	readonly url?: string;
}

export interface HeaderFields {
	readonly repository: HeaderRepository;
	readonly version: string;
	readonly build: BuildProvenance;
	readonly repositoryLine: readonly Cell[];
	readonly range: readonly Cell[];
	readonly output: readonly Cell[];
}

export interface BlockContent extends StepSummary {
	readonly debugLines?: readonly string[];

	readonly budget?: number;
	readonly duration?: string;
}

/**
 * A laid-out block: the rendered lines plus the index at which commit-reference-flow lines begin.
 * Those trailing lines may overflow the terminal intentionally (a single reference wider than the
 * budget) and must not be clipped, while earlier chrome lines are safe to clip in the live region.
 */
export interface BlockLayout {
	readonly lines: readonly string[];
	readonly commitLineFrom: number;
}

function layoutRows(palette: Palette, rows: readonly Row[], budget: number): string[] {
	if (rows.length === 0) {
		return [];
	}
	const columns = Math.max(...rows.map((row) => row.cells.length));
	const widths: number[] = [];
	for (let column = 0; column < columns; column++) {
		widths[column] = Math.max(
			0,
			...rows.map((row) =>
				row.cells[column] ? palette.width(row.cells[column]!.text) : 0,
			),
		);
	}
	return rows.map((row) => {
		const gap = row.gap ?? 2;
		// The last column is free text; truncate it so the whole row stays within the budget.
		const before = row.cells
			.slice(0, -1)
			.reduce((sum, _, column) => sum + widths[column]! + gap, 0);
		return row.cells
			.map((cell, column) => {
				const last = column === row.cells.length - 1;
				const text =
					last && budget !== Infinity
						? truncateText(palette, cell.text, Math.max(0, budget - before))
						: cell.text;
				const padded = pad(
					text,
					widths[column]!,
					palette.width(text),
					cell.align ?? "left",
					last,
				);
				return realize(palette, padded, cell);
			})
			.join(" ".repeat(gap));
	});
}

export function blockLines(
	palette: Palette,
	glyph: Cell,
	content: BlockContent,
): BlockLayout {
	const timing: Cell[] = content.duration
		? [{ text: ` (⚡️ ${content.duration})`, style: "faint" }]
		: [];
	const lines = [
		renderInline(palette, [glyph, { text: " " }, ...content.title, ...timing]),
	];
	const children: string[] = [];
	for (const entry of content.debugLines ?? []) {
		children.push(palette.style(entry, "faint"));
	}
	for (const note of content.notes ?? []) {
		children.push(renderInline(palette, note));
	}
	const budget = content.budget ?? Infinity;
	children.push(...layoutRows(palette, content.rows ?? [], budget));
	const commitLineFrom = lines.length + children.length;
	children.push(...layoutCommitRows(palette, content.commitRows ?? [], budget));
	children.push(...layoutFlow(palette, content.flow ?? [], budget));
	if (content.excluded) {
		children.push(renderInline(palette, content.excluded.label));
		children.push(...layoutFlow(palette, content.excluded.flow ?? [], budget));
	}
	children.forEach((child, index) => {
		lines.push(
			index === 0 ? `  ${palette.style("└ ", "faint")}${child}` : `    ${child}`,
		);
	});
	return { lines, commitLineFrom };
}

export function headerBoxLines(
	palette: Palette,
	fields: HeaderFields,
	color: boolean,
): string[] {
	const labels: ReadonlyArray<readonly [string, readonly Cell[]]> = [
		["repository:", fields.repositoryLine],
		["range:", fields.range],
		["output:", fields.output],
	];
	const raw = (cells: readonly Cell[]): string =>
		cells.map((cell) => sanitizeTerminalText(cell.text)).join("");
	const repoName = sanitizeTerminalText(fields.repository.repo);
	const version = sanitizeTerminalText(fields.version);
	const commitSha = sanitizeTerminalText(fields.build.sha);

	if (!color) {
		return [
			`>_ ${repoName} › changelog (v${version}/${commitSha})`,
			...labels.map(([label, value]) => `${label} ${raw(value)}`),
		];
	}

	const labelWidth = Math.max(...labels.map(([label]) => label.length));
	const titleCells: Cell[] = [
		{ text: ">_ ", style: "faint" },
		{ text: repoName, style: "bold", link: fields.repository.url },
		{ text: " › ", style: "mauve", bold: true },
		{ text: "changelog", style: "bold" },
		{ text: ` (v${version}/`, style: "faint" },
		{ text: commitSha, style: "faint", link: fields.build.url },
		{ text: ")", style: "faint" },
	];
	const titleRaw = `>_ ${repoName} › changelog (v${version}/${commitSha})`;

	const rows: Array<{ rendered: string; width: number }> = [
		{ rendered: renderInline(palette, titleCells), width: palette.width(titleRaw) },
		{ rendered: "", width: 0 },
	];
	for (const [label, valueCells] of labels) {
		const gap = " ".repeat(labelWidth - label.length);
		const rendered = `${palette.style(label, "faint")}${gap}  ${renderInline(palette, valueCells)}`;
		rows.push({ rendered, width: labelWidth + 2 + palette.width(raw(valueCells)) });
	}

	const width = Math.max(...rows.map((row) => row.width));
	const bar = "─".repeat(width + 2);
	const framed = rows.map(
		(row) =>
			`${palette.style("│", "faint")} ${row.rendered}${" ".repeat(width - row.width)} ${palette.style("│", "faint")}`,
	);
	return [
		palette.style(`╭${bar}╮`, "faint"),
		...framed,
		palette.style(`╰${bar}╯`, "faint"),
	];
}
