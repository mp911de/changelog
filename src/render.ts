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
	blockLines,
	type BlockReporter,
	headerBoxLines,
	type HeaderFields,
} from "./block.js";
import { liveReporter } from "./live-reporter.js";
import {
	type Capabilities,
	type Cell,
	createPalette,
	detectCapabilities,
	type OutputStream,
	type Palette,
	renderInline,
	SUCCESS,
} from "./palette.js";

export type { Affix, Capabilities, Cell, OutputStream, Row, Style } from "./palette.js";
export { formatDuration } from "./palette.js";
export type { CommitRow, Emphasis, ReferenceItem } from "./reference-flow.js";
export type { BlockHandle, ExcludedSection, HeaderFields, StepSummary } from "./block.js";

export interface Renderer extends BlockReporter {
	headerBox(fields: HeaderFields): void;

	line(cells: readonly Cell[]): void;

	success(cells: readonly Cell[]): void;

	blank(): void;
}

export interface RendererOptions {
	readonly capabilities?: Capabilities;
	readonly durations?: boolean;
	readonly now?: () => number;
}

export function createRenderer(
	stream: OutputStream,
	options: RendererOptions = {},
): Renderer {
	const caps = options.capabilities ?? detectCapabilities(stream);
	const palette = createPalette(caps.level, caps.hyperlinks);
	const now = options.now ?? Date.now;
	const durations = options.durations ?? caps.tty;

	const reporter = caps.tty
		? liveReporter(stream, palette, now, durations)
		: staticReporter(stream, palette);

	return {
		start: reporter.start,
		dispose: reporter.dispose,
		headerBox(fields) {
			for (const heading of headerBoxLines(palette, fields, caps.level > 0)) {
				stream.write(`${heading}\n`);
			}
		},
		line(cells) {
			stream.write(`${renderInline(palette, cells)}\n`);
		},
		success(cells) {
			stream.write(
				`${renderInline(palette, [SUCCESS, { text: " " }, ...cells])}\n`,
			);
		},
		blank() {
			stream.write("\n");
		},
	};
}

/**
 * A trace-line writer for debug-only output and queries: it renders each line as a faint child
 * line on {@link stream}, with no hyperlinks. The renderer owns the styling so callers stay free of
 * terminal mechanics.
 */
export function createTraceWriter(stream: OutputStream): (line: string) => void {
	const palette = createPalette(detectCapabilities(stream).level, false);
	return (line) => stream.write(`${palette.style(line, "faint")}\n`);
}

function staticReporter(stream: OutputStream, palette: Palette): BlockReporter {
	return {
		start() {
			const debug: string[] = [];
			const commit = (layout: { lines: readonly string[] }) =>
				stream.write(`${layout.lines.join("\n")}\n\n`);
			return {
				debug(line) {
					debug.push(line);
				},
				succeed(summary) {
					// Non-TTY output is unbounded: every complete reference, no omission marker.
					commit(
						blockLines(palette, SUCCESS, {
							...summary,
							debugLines: debug,
						}),
					);
				},
				fail(title) {
					commit(
						blockLines(
							palette,
							{ text: "✖", style: "red" },
							{
								title: [{ text: title, style: "red" }],
								debugLines: debug,
							},
						),
					);
				},
				discard() {},
			};
		},
		dispose() {},
	};
}
