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

import stringWidth from "string-width";

import {
	type BlockLayout,
	blockLines,
	type BlockReporter,
	type StepSummary,
} from "./block.js";
import {
	ESC,
	formatDuration,
	GRAPHEMES,
	type OutputStream,
	type Palette,
	SUCCESS,
} from "./palette.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function liveReporter(
	stream: OutputStream,
	palette: Palette,
	now: () => number,
	durations: boolean,
): BlockReporter {
	let cursorHidden = false;
	let disposeActive: (() => void) | undefined;
	const columns = () => (stream.columns && stream.columns > 0 ? stream.columns : 80);

	return {
		start(label) {
			disposeActive?.();
			const start = now();
			const debug: string[] = [];
			let frame = 0;
			let drawn = 0;
			let closed = false;
			let timer: ReturnType<typeof setInterval> | undefined;

			// Tear down the live region exactly once: stop the spinner, detach the signal handlers,
			// and restore the cursor so an interrupted run never leaves it hidden in the terminal.
			const cleanup = () => {
				if (closed) {
					return;
				}
				closed = true;
				if (timer !== undefined) {
					clearInterval(timer);
				}
				process.off("SIGINT", onSigint);
				process.off("SIGTERM", onSigterm);
				if (cursorHidden) {
					stream.write(`${ESC}[?25h`);
					cursorHidden = false;
				}
				if (disposeActive === cleanup) {
					disposeActive = undefined;
				}
			};
			// On Ctrl-C / kill, restore the terminal first, then re-raise the signal so the process
			// exits with the conventional signal disposition rather than swallowing it.
			const terminate = (signal: NodeJS.Signals) => {
				cleanup();
				process.kill(process.pid, signal);
			};
			const onSigint = () => terminate("SIGINT");
			const onSigterm = () => terminate("SIGTERM");
			disposeActive = cleanup;
			process.once("SIGINT", onSigint);
			process.once("SIGTERM", onSigterm);

			// The reference-flow budget is the terminal width less the child indent (4 columns) and
			// a one-column safety margin, so a fitted row never soft-wraps in the live region.
			const budget = () => columns() - 5;

			// Redraw the live spinner region. Chrome lines are clipped so a long line cannot
			// soft-wrap and break the cursor-up math; commit-flow lines (commitLineFrom onward) are
			// left intact so a single reference wider than the terminal overflows rather than being
			// substring-truncated.
			const render = (layout: BlockLayout) => {
				const out = layout.lines.map((line, index) =>
					index < layout.commitLineFrom ? clip(line, columns() - 1) : line,
				);
				const prefix = drawn > 0 ? `${ESC}[${drawn}A${ESC}[0J` : "";
				stream.write(`${prefix}${out.join("\n")}\n`);
				drawn = out.length;
			};
			const running = () =>
				blockLines(
					palette,
					{
						text: FRAMES[frame % FRAMES.length]!,
						style: "accent",
					},
					{ title: [{ text: label }], debugLines: debug },
				);

			// Hide the cursor while the spinner animates; cleanup restores it on finish or signal.
			if (!cursorHidden) {
				stream.write(`${ESC}[?25l`);
				cursorHidden = true;
			}
			render(running());
			timer = setInterval(() => {
				frame += 1;
				render(running());
			}, 80);
			if (typeof timer.unref === "function") {
				timer.unref();
			}

			const finish = (layout: BlockLayout) => {
				if (closed) {
					return;
				}
				render(layout);
				stream.write("\n");
				drawn = 0;
				cleanup();
			};

			return {
				debug(line) {
					debug.push(line);
					render(running());
				},
				succeed(summary: StepSummary) {
					// Sub-2ms stages add noise, not insight, so 0ms and 1ms timings are hidden.
					const elapsed = now() - start;
					const duration =
						durations && Math.round(elapsed) >= 2
							? formatDuration(elapsed)
							: undefined;
					finish(
						blockLines(palette, SUCCESS, {
							title: summary.title,
							debugLines: debug,
							notes: summary.notes,
							rows: summary.rows,
							commitRows: summary.commitRows,
							flow: summary.flow,
							excluded: summary.excluded,
							budget: budget(),
							duration,
						}),
					);
				},
				fail(title) {
					finish(
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
				discard() {
					if (closed) {
						return;
					}

					if (drawn > 0) {
						stream.write(`${ESC}[${drawn}A${ESC}[0J`);
					}
					drawn = 0;
					cleanup();
				},
			};
		},
		dispose() {
			disposeActive?.();
		},
	};
}

/**
 * Clip a styled line to a visible column budget without splitting escape sequences, closing any
 * open hyperlink and resetting color at the cut so the live region stays aligned.
 */
function clip(line: string, columns: number): string {
	let visible = 0;
	let index = 0;
	let out = "";
	while (index < line.length) {
		// Escape sequences carry zero visible width: copy each one through whole so a cut never
		// lands inside one and corrupts the styling.
		if (line[index] === ESC) {
			const escape = consumeEscape(line, index);
			out += line.slice(index, escape);
			index = escape;
			continue;
		}

		const escape = line.indexOf(ESC, index);
		const end = escape === -1 ? line.length : escape;
		for (const { segment } of GRAPHEMES.segment(line.slice(index, end))) {
			const width = stringWidth(segment);
			if (visible + width > columns) {
				return `${out}${ESC}]8;;${String.fromCharCode(7)}${ESC}[0m`;
			}
			out += segment;
			visible += width;
		}
		index = end;
	}
	return out;
}

function consumeEscape(line: string, start: number): number {
	// SGR sequences end with 'm'; OSC 8 hyperlinks end with BEL.
	if (line[start + 1] === "]") {
		const bel = line.indexOf(String.fromCharCode(7), start);
		return bel === -1 ? line.length : bel + 1;
	}
	let index = start + 2;
	while (index < line.length && line[index] !== "m") {
		index += 1;
	}
	return index + 1;
}
