#!/usr/bin/env node
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

import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { argv, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import { parseArtifactVersion } from "./artifact-version.js";
import { writeFileAtomically } from "./atomic-file.js";
import { loadCache, type TicketCache } from "./cache.js";
import { loadOrCreateConfig } from "./config.js";
import { hasCode } from "./errors.js";
import { classifyRef, gitRepoRefs, resolveCommit } from "./git.js";
import { resolveGitHubContext } from "./github-context.js";
import { createTargetLookup } from "./lookup.js";
import { type Lookup, runPipeline } from "./pipeline.js";
import { noRunProgress, type RunProgress, runStage } from "./progress.js";
import { createRenderer, createTraceWriter, type OutputStream } from "./render.js";
import { resolveAutoRange } from "./version.js";
import {
	type CommitDetail,
	createDebugView,
	createRunView,
	finalLine,
	headerFields,
	type RunViewOptions,
} from "./view.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/**
 * A lone version is the release target (auto mode); the lower bound is resolved from tags and the
 * upper bound is the matching tag or HEAD. Two arguments or a `<from>..<to>` range supply both
 * bounds explicitly.
 */
type CliRange =
	| { readonly mode: "auto"; readonly target: string }
	| { readonly mode: "explicit"; readonly from: string; readonly to: string };

interface CliInvocation {
	readonly range: CliRange;
	readonly cwd: string;
	readonly output: string;
	readonly all: boolean;
	readonly refresh: boolean;
	readonly showMissing: boolean;
	readonly showCommits: boolean;
	readonly showAll: boolean;
	readonly quiet: boolean;
	readonly debug: boolean;
	readonly resolvePrevious: boolean;
	readonly repo?: string;
}

/**
 * The GitHub adapter replaces the real {@code gh}-backed context resolution and lookup creation
 * for testing. When not provided, the real implementation is used.
 */
export type GitHubAdapterFactory = (options: {
	readonly cwd: string;
	readonly repoOverride?: string;
	readonly trace?: (line: string) => void;
}) => Promise<{
	readonly repo: { readonly owner: string; readonly repo: string };
	readonly login: string;
	readonly createLookup: (options: {
		readonly cache: TicketCache;
		readonly refresh: boolean;
	}) => Lookup;
}>;

/**
 * Injectable runtime dependencies for a CLI invocation. When not provided, production defaults
 * (process.stdout, process.stderr, process.cwd, real GitHub) are used.
 */
export interface Runtime {
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	/**
	 * Base directory for resolving relative -C paths and for default cwd.
	 */
	readonly cwd?: string;
	readonly githubAdapter?: GitHubAdapterFactory;
}

const defaultGitHubAdapter: GitHubAdapterFactory = async ({
	cwd,
	repoOverride,
	trace,
}) => {
	// One shared GitHub client serves preparation and lookup, so its request trace is routed to
	// whichever stage's debug is active: the prepare trace during preparation, each lookup call's
	// own debug for the duration of that call.
	let activeTrace = trace;
	const forward = trace ? (line: string) => activeTrace?.(line) : undefined;
	const context = await resolveGitHubContext({
		repo: repoOverride,
		cwd,
		trace: forward,
	});
	return {
		repo: context.repo,
		login: context.login,
		createLookup: ({ cache, refresh }) => {
			const lookup = createTargetLookup({
				octokit: context.octokit,
				repo: context.repo,
				cache,
				refresh,
			});
			// The aggregate carries lookup flags to the seam; GitHub resolution needs only the target.
			return async (targets, debug) => {
				activeTrace = debug ?? trace;
				try {
					return await lookup(targets.map((flagged) => flagged.target));
				} finally {
					activeTrace = trace;
				}
			};
		},
	};
};

/**
 * Interpret the positional arguments. A lone version is the release target (auto mode); two
 * arguments or a `<from>..<to>` range supply explicit bounds. Git refnames cannot contain "..", so
 * splitting on it is unambiguous; the range and a separate `to` are mutually exclusive.
 */
function parseRange(from: string, to: string | undefined): CliRange {
	if (!from.includes("..")) {
		if (to !== undefined) {
			return { mode: "explicit", from, to };
		}
		if (parseArtifactVersion(from) === null) {
			throw new InvalidArgumentError(
				`"${from}" is not a recognized version; pass <from> <to> or a <from>..<to> range`,
			);
		}
		return { mode: "auto", target: from };
	}
	if (to !== undefined) {
		throw new InvalidArgumentError(
			"specify the range once: either <from>..<to> or <from> <to>, not both",
		);
	}
	if (from.includes("...")) {
		throw new InvalidArgumentError(
			`invalid range "${from}": use two dots, e.g. 4.0.0..4.0.4`,
		);
	}
	if (from.indexOf("..") !== from.lastIndexOf("..")) {
		throw new InvalidArgumentError(
			`invalid range "${from}": use a single <from>..<to>`,
		);
	}
	const separator = from.indexOf("..");
	const lower = from.slice(0, separator);
	const upper = from.slice(separator + 2);
	if (lower === "") {
		throw new InvalidArgumentError(
			`invalid range "${from}": missing <from> before ".."`,
		);
	}
	return { mode: "explicit", from: lower, to: upper === "" ? "HEAD" : upper };
}

function buildProgram(
	action: (invocation: CliInvocation) => Promise<void>,
	options?: { readonly baseCwd?: string },
): Command {
	const invocationDirectory = options?.baseCwd ?? process.cwd();
	let directorySpecified = false;

	const parseDirectory = (directory: string): string => {
		if (directorySpecified) {
			throw new InvalidArgumentError("-C may only be specified once");
		}
		directorySpecified = true;

		const target = resolve(invocationDirectory, directory);
		try {
			if (!statSync(target).isDirectory()) {
				throw new InvalidArgumentError(
					`cannot change to "${directory}": not a directory`,
				);
			}
		} catch (error) {
			if (error instanceof InvalidArgumentError) {
				throw error;
			}
			if (hasCode(error, "ENOENT")) {
				throw new InvalidArgumentError(
					`cannot change to "${directory}": directory does not exist`,
				);
			}
			throw new InvalidArgumentError(
				`cannot change to "${directory}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return target;
	};

	const program = new Command();
	program
		.name("changelog")
		.description("Generate GitHub release notes for a commit range.")
		.version(pkg.version)
		.argument(
			"<target>",
			"release version to generate notes for, or the <from> of an explicit range",
		)
		.argument(
			"[to]",
			"explicit upper bound; supplying it treats <target> as the <from> lower bound",
		)
		.option(
			"-C <directory>",
			"run as if started in the given directory",
			parseDirectory,
		)
		.option("-O, --output <file>", "output file, or - for stdout", "release-notes.md")
		.option(
			"--all",
			"collect unclassified issues under an Other Changes section",
			false,
		)
		.option("--refresh", "force re-fetch and overwrite cached tickets", false)
		.option("--show-missing", "list only commits without ticket reference", false)
		.option("--show-commits", "list every scanned commit", false)
		.option(
			"--show-all",
			"list every commit and every looked-up ticket outcome",
			false,
		)
		.option("--repo <owner/repo>", "override the auto-detected repository")
		.option(
			"--resolve-previous",
			"print the resolved previous version tag and exit",
			false,
		)
		.option("--debug", "trace the git and GitHub calls being made", false)
		.option("-q, --quiet", "suppress all output except errors", false)
		.action(
			async (
				target: string,
				to: string | undefined,
				opts: Omit<CliInvocation, "range" | "cwd"> & { C?: string },
			) => {
				const { C: directory, ...invocation } = opts;
				const cwd = directory ?? invocationDirectory;
				if (invocation.quiet && invocation.debug) {
					throw new InvalidArgumentError(
						"--quiet and --debug cannot be combined",
					);
				}
				const range = parseRange(target, to);
				if (invocation.resolvePrevious && range.mode !== "auto") {
					throw new InvalidArgumentError(
						"--resolve-previous expects a single <version>, not a <from> <to> or <from>..<to> range",
					);
				}
				await action({ range, cwd, ...invocation });
			},
		);
	return program;
}

interface InternalRuntime {
	readonly out: OutputStream;
	readonly err: OutputStream;
	readonly githubAdapter: GitHubAdapterFactory;
}

/**
 * Normalize the overlapping commit-display flags into one of `none`, `missing`, or `all` before the
 * run lifecycle, so the run view never sees overlapping booleans. `--show-all` and `--show-commits`
 * both select `all`; `--show-missing` selects `missing`; otherwise `none`.
 */
function commitDetailOf(invocation: CliInvocation): CommitDetail {
	if (invocation.showAll || invocation.showCommits) {
		return "all";
	}
	if (invocation.showMissing) {
		return "missing";
	}
	return "none";
}

// The run view's options are filled in during Preparing (the resolved repository), so they stay
// mutable here even though the view reads them as readonly.
type MutableRunViewOptions = {
	-readonly [K in keyof RunViewOptions]: RunViewOptions[K];
};

/**
 * Everything the run needs to present itself, resolved once from the invocation: where progress is
 * reported (full view, debug-only, or silent), the renderer the header and final line use, the run
 * view options to fill in after Preparing, and where the finished changelog is written.
 */
interface Presentation {
	readonly renderer: ReturnType<typeof createRenderer> | undefined;
	readonly runViewOptions: MutableRunViewOptions;
	readonly progress: RunProgress;
	readonly outputUrl: string;
	write(markdown: string): Promise<void>;
}

/**
 * Resolve the run's presentation in one place so {@link execute} consumes ready sinks instead of
 * deciding them inline. The rules: {@code -O -} and {@code -q} keep the run view off stdout (no
 * renderer); without a renderer, {@code --debug} still traces to stderr, otherwise the run is silent;
 * the changelog goes to stdout for {@code -O -} and to the resolved file otherwise.
 */
function resolvePresentation(
	invocation: CliInvocation,
	runtime: InternalRuntime,
): Presentation {
	const { out, err } = runtime;
	const toStdout = invocation.output === "-";
	// -O - writes the changelog to stdout, so the run view stays off it; -q silences it outright.
	const renderer = invocation.quiet || toStdout ? undefined : createRenderer(out);
	const runViewOptions: MutableRunViewOptions = {
		repo: { owner: "", repo: "" },
		commitDetail: commitDetailOf(invocation),
		showLookupOutcomes: invocation.showAll,
		debug: invocation.debug,
	};
	const progress: RunProgress = renderer
		? createRunView(renderer, runViewOptions)
		: invocation.debug
			? createDebugView(createTraceWriter(err))
			: noRunProgress;

	const absoluteOutput = toStdout
		? undefined
		: isAbsolute(invocation.output)
			? invocation.output
			: resolve(invocation.cwd, invocation.output);
	const outputUrl = absoluteOutput ? pathToFileURL(absoluteOutput).href : "";

	return {
		renderer,
		runViewOptions,
		progress,
		outputUrl,
		async write(markdown) {
			if (absoluteOutput === undefined) {
				out.write(markdown);
			} else {
				await writeFileAtomically(absoluteOutput, markdown);
			}
		},
	};
}

async function execute(
	invocation: CliInvocation,
	runtime: InternalRuntime,
): Promise<void> {
	const { out, err } = runtime;
	const cwd = invocation.cwd;

	// --resolve-previous is a query: print the resolved lower bound and exit, like --version. It
	// needs only Git, keeps stdout clean for scripting, and routes any --debug trace to stderr.
	if (invocation.resolvePrevious && invocation.range.mode === "auto") {
		const trace = invocation.debug ? createTraceWriter(err) : undefined;
		const { from } = await resolveAutoRange(
			invocation.range.target,
			gitRepoRefs(cwd, trace),
		);
		out.write(`${from}\n`);
		return;
	}

	// The full view reads its options at emit time, so the repository resolved during Preparing can
	// be filled into runViewOptions before any row that needs its links is rendered.
	const { renderer, runViewOptions, progress, outputUrl, write } = resolvePresentation(
		invocation,
		runtime,
	);
	try {
		const prepared = await runStage(
			progress,
			"Preparing",
			async (debug) => {
				const trace = invocation.debug ? debug : undefined;
				// In auto mode the bounds come from the tags; in explicit mode they are given verbatim.
				const { from, to } =
					invocation.range.mode === "auto"
						? await resolveAutoRange(
								invocation.range.target,
								gitRepoRefs(cwd, trace),
							)
						: { from: invocation.range.from, to: invocation.range.to };
				// Resolve only the header values that will be rendered; scanning validates the range later.
				const resolvedTo = renderer ? await resolveCommit(to, cwd, trace) : "";
				const resolvedFrom =
					renderer && from === "HEAD"
						? from === to
							? resolvedTo
							: await resolveCommit(from, cwd, trace)
						: "";
				const adapterResult = await runtime.githubAdapter({
					cwd,
					repoOverride: invocation.repo,
					trace,
				});
				const { repo, login } = adapterResult;

				// Classify the bounds for their header links only when a renderer will show them.
				const fromKind = renderer
					? await classifyRef(from, cwd, trace)
					: "commit";
				const toKind = renderer ? await classifyRef(to, cwd, trace) : "commit";
				const config = await loadOrCreateConfig({
					baseDir: cwd,
					login,
					owner: repo.owner,
				});
				const cache = await loadCache({
					baseDir: cwd,
					slug: repo.repo,
					diagnostic: debug,
				});
				const lookup = adapterResult.createLookup({
					cache,
					refresh: invocation.refresh,
				});
				return {
					repo,
					from,
					to,
					fromKind,
					toKind,
					fromSha: resolvedFrom,
					toSha: resolvedTo,
					config,
					lookup,
				};
			},
			() => ({ type: "preparing-complete", stage: "Preparing" }),
		);
		const { repo, from, to, fromKind, toKind, fromSha, toSha, config, lookup } =
			prepared;

		if (renderer) {
			// The full view needs the resolved repository for its commit and ticket links.
			runViewOptions.repo = repo;
			renderer.headerBox(
				headerFields({
					repo,
					version: pkg.version,
					from,
					to,
					fromKind,
					toKind,
					fromSha,
					toSha,
					output: invocation.output,
					outputUrl,
				}),
			);
			renderer.blank();
		}

		const markdown = await runPipeline({
			from,
			to,
			cwd,
			repository: repo,
			config,
			all: invocation.all,
			lookup,
			progress,
		});

		await write(markdown);

		renderer?.success(finalLine(invocation.output, outputUrl));
	} finally {
		renderer?.dispose();
	}
}

function isCommanderError(error: unknown): error is {
	code?: string;
	exitCode?: number;
} & Error {
	return (
		typeof error === "object" &&
		error !== null &&
		typeof (error as { code?: unknown }).code === "string" &&
		(error as { code: string }).code.startsWith("commander.")
	);
}

/**
 * A grep-style synopsis shown when changelog is run with no arguments. Full option help stays
 * available via --help.
 */
function usageText(): string {
	return [
		"usage: changelog [-C dir] [-O file] [--all] [--refresh]",
		"                 [--show-missing] [--show-commits] [--show-all]",
		"                 [--repo owner/repo] [--resolve-previous] [--debug] [-q]",
		"                 <version> | <from> <to> | <from>..<to>",
	].join("\n");
}

/**
 * Execute a complete invocation and return the process exit code. Returns 0 on success, 1 on
 * runtime failure, and 2 on usage or argument error. Does not mutate process.exitCode.
 */
export async function main(args: string[] = argv, runtime?: Runtime): Promise<number> {
	const out = runtime?.stdout ?? stdout;
	const err = runtime?.stderr ?? stderr;
	const baseCwd = runtime?.cwd ?? process.cwd();

	// No arguments at all: print the slim synopsis to stderr and return a usage error code.
	if (args.length <= 2) {
		err.write(`${usageText()}\n`);
		return 2;
	}

	let debugMode = false;
	const internalRuntime: InternalRuntime = {
		out,
		err,
		githubAdapter: runtime?.githubAdapter ?? defaultGitHubAdapter,
	};

	const program = buildProgram(
		async (invocation) => {
			debugMode = invocation.debug;
			await execute(invocation, internalRuntime);
		},
		{ baseCwd },
	);

	program.exitOverride();
	program.configureOutput({
		writeOut: (text) => out.write(text),
		writeErr: (text) => err.write(text),
	});

	try {
		await program.parseAsync(args);
		return 0;
	} catch (error) {
		if (isCommanderError(error)) {
			const code = error.code ?? "";
			const exitCode = error.exitCode ?? 2;
			if (exitCode === 0) {
				// Version and help are success paths; nothing to print.
				return 0;
			}
			// InvalidArgumentError thrown from our action is not printed by commander; print it here.
			// Commander's own parsing errors are already written via writeErr before being thrown.
			if (code === "commander.invalidArgument") {
				err.write(`error: ${error.message}\n`);
			}
			// Treat all non-zero commander errors as usage errors (exit code 2).
			return 2;
		}
		const message =
			debugMode && error instanceof Error
				? (error.stack ?? error.message)
				: error instanceof Error
					? error.message
					: String(error);
		err.write(`${message}\n`);
		return 1;
	}
}

/**
 * Whether the module at {@code moduleUrl} is the process entry point {@code entry} (typically
 * `process.argv[1]`). Both sides are resolved through symlinks before comparing: when launched via
 * a linked or globally installed bin, the entry is the symlink in the global bin directory while
 * the module URL is already realpath-resolved to the real file, so a literal comparison would miss.
 */
export function isMainModule(moduleUrl: string, entry: string | undefined): boolean {
	if (entry === undefined) {
		return false;
	}
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isMainModule(import.meta.url, argv[1])) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
