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

import { stderr } from "node:process";

import { Chalk, supportsColor, supportsColorStderr } from "chalk";
import stringWidth from "string-width";

/**
 * Semantic styles. "accent" is the primary highlight and "warning" the attention accent; both are
 * fixed hexes that chalk downsamples to the terminal's level (truecolor -> ansi256 -> 16 -> none).
 * "faint" is the theme-adaptive dark gray (SGR 2).
 */
export type Style =
	| "plain"
	| "faint"
	| "bold"
	| "green"
	| "red"
	| "accent"
	| "warning"
	| "mauve"
	| "gray"
	| "grayMedium"
	| "grayDark";

export interface Affix {
	readonly text: string;
	readonly style?: Style;
}

export interface Cell {
	readonly text: string;
	readonly style?: Style;
	readonly bold?: boolean;
	readonly link?: string;
	readonly align?: "left" | "right";

	// Ornaments rendered tight against the (padded) text with their own style.
	readonly prefix?: Affix;
	readonly suffix?: Affix;
}

export interface Row {
	readonly cells: readonly Cell[];

	readonly gap?: number;
}

export interface OutputStream {
	write(chunk: string): unknown;

	readonly isTTY?: boolean;
	readonly columns?: number;
}

export interface Capabilities {
	readonly level: number;
	readonly tty: boolean;
	readonly hyperlinks: boolean;
}

export const ESC = String.fromCharCode(27);
export const BEL = String.fromCharCode(7);
export const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const SUCCESS: Cell = { text: "✔", style: "green" };
const ELLIPSIS = "…";
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const HEX = {
	accent: "#89b4fa",
	warning: "#eda757",
	mauve: "#CBA6F7",
	// A light green for the success glyph.
	green: "#a6e3a1",
	// Three descending gray levels (light, medium, dark) for the reference emphasis ladder; faint
	// (SGR dim) is fainter still. Limited-color terminals downsample adjacent levels to one ANSI
	// gray without losing any text.
	gray: "#9399b2",
	grayMedium: "#7f849c",
	grayDark: "#6c7086",
} as const;

export interface Palette {
	style(text: string, style?: Style): string;

	/**
	 * Add a bold weight on top of an already-styled string (composes with any color).
	 */
	bold(text: string): string;

	link(text: string, url?: string): string;

	/**
	 * Visible width of raw text (ignores styling, which is applied afterwards).
	 */
	width(text: string): number;
}

/**
 * Remove terminal control characters from external text before it reaches ANSI styling or layout.
 */
export function sanitizeTerminalText(text: string): string {
	return text.replace(TERMINAL_CONTROL, "");
}

/**
 * Build a palette for a given color level and hyperlink capability. A level of 0 yields plain
 * text; hyperlinks are emitted as OSC 8 escapes only when enabled.
 */
export function createPalette(level: number, hyperlinks: boolean): Palette {
	const chalk = new Chalk({ level: clampLevel(level) });

	const apply = (text: string, style?: Style): string => {
		const safe = sanitizeTerminalText(text);
		switch (style) {
			case "faint":
				return chalk.dim(safe);
			case "bold":
				return chalk.bold(safe);
			case "green":
				return chalk.hex(HEX.green)(safe);
			case "red":
				return chalk.red(safe);
			case "accent":
				return chalk.hex(HEX.accent)(safe);
			case "warning":
				return chalk.hex(HEX.warning)(safe);
			case "mauve":
				return chalk.hex(HEX.mauve)(safe);
			case "gray":
				return chalk.hex(HEX.gray)(safe);
			case "grayMedium":
				return chalk.hex(HEX.grayMedium)(safe);
			case "grayDark":
				return chalk.hex(HEX.grayDark)(safe);
			default:
				return safe;
		}
	};

	return {
		style: apply,
		bold: (text) => chalk.bold(text),
		link(text, url) {
			if (!hyperlinks || !url || sanitizeTerminalText(url) !== url) {
				return text;
			}
			return `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`;
		},
		width: (text) => stringWidth(sanitizeTerminalText(text)),
	};
}

function clampLevel(level: number): 0 | 1 | 2 | 3 {
	if (level <= 0) {
		return 0;
	}
	if (level >= 3) {
		return 3;
	}
	return level === 1 ? 1 : 2;
}

export function detectCapabilities(stream: OutputStream): Capabilities {
	const tty = stream.isTTY === true;
	const support = stream === stderr ? supportsColorStderr : supportsColor;
	const level = support ? support.level : 0;
	return { level, tty, hyperlinks: tty && level > 0 };
}

export function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function realize(palette: Palette, text: string, cell: Cell): string {
	const colored = palette.style(text, cell.style);
	const styled = cell.bold ? palette.bold(colored) : colored;
	const prefix = cell.prefix ? palette.style(cell.prefix.text, cell.prefix.style) : "";
	const suffix = cell.suffix ? palette.style(cell.suffix.text, cell.suffix.style) : "";
	return palette.link(`${prefix}${styled}${suffix}`, cell.link);
}

export function renderInline(palette: Palette, cells: readonly Cell[]): string {
	return cells.map((cell) => realize(palette, cell.text, cell)).join("");
}

/**
 * Truncate free text to {@link max} visible columns with a trailing ellipsis, never splitting a
 * grapheme. Text already within budget is returned unchanged.
 */
export function truncateText(palette: Palette, text: string, max: number): string {
	if (palette.width(text) <= max) {
		return text;
	}
	const available = Math.max(0, max - palette.width(ELLIPSIS));
	let width = 0;
	let truncated = "";
	for (const { segment } of GRAPHEMES.segment(text)) {
		const segmentWidth = palette.width(segment);
		if (width + segmentWidth > available) {
			break;
		}
		truncated += segment;
		width += segmentWidth;
	}
	return `${truncated}${ELLIPSIS}`;
}

export function pad(
	text: string,
	width: number,
	textWidth: number,
	align: "left" | "right",
	last: boolean,
): string {
	const fill = " ".repeat(Math.max(0, width - textWidth));
	if (align === "right") {
		return fill + text;
	}
	return last ? text : text + fill;
}
