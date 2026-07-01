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

import { Command, InvalidArgumentError, Option } from "commander";

import { writeFileAtomically } from "./atomic-file.js";
import { buildCommitUrl, commitSha } from "./build-info.js";
import { hasCode, hasStringProp } from "./errors.js";
import { gitRepoRefs } from "./git.js";
import { defaultGitHubAdapter, type GitHubAdapterFactory } from "./github-adapter.js";
import type { Repository } from "./github-context.js";
import { runPipeline, type ScanCommits } from "./pipeline.js";
import { prepareRun, resolveHeaderFields } from "./prepare.js";
import { noRunProgress, type RunProgress, runStage } from "./progress.js";
import { createRenderer, createTraceWriter, type OutputStream } from "./render.js";
import { type CliRange, parseRange, resolveAutoRange } from "./version.js";
import {
	type CommitDetail,
	createDebugView,
	createPreparingView,
	createRunView,
	finalLine,
	type RunViewOptions,
} from "./view.js";

export type { GitHubAdapterFactory } from "./github-adapter.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as {
	version: string;
	repository?: { url?: string };
};

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

// Commander exposes parsed "-C" as "C" and leaves the option object structurally loose.
type CommanderOptions = Omit<CliInvocation, "range" | "cwd"> & {
	readonly C?: string;
};

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
	/**
	 * Scans the commit range. When not provided, the real Git scanner is used.
	 */
	readonly scan?: ScanCommits;
}

function toInvocation(
	target: string,
	to: string | undefined,
	opts: CommanderOptions,
	invocationDirectory: string,
): CliInvocation {
	const { C: directory, ...invocation } = opts;
	const cwd = directory ?? invocationDirectory;
	const range = parseRange(target, to);
	if (invocation.resolvePrevious && range.mode !== "auto") {
		throw new InvalidArgumentError(
			"--resolve-previous expects a single <version>, not a <from> <to> or <from>..<to> range",
		);
	}
	return { range, cwd, ...invocation };
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
		.version(`${pkg.version} (${commitSha})`)
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
		.addOption(
			new Option("--debug", "trace the git and GitHub calls being made")
				.default(false)
				.conflicts("quiet"),
		)
		.option("-q, --quiet", "suppress all output except errors", false)
		.action(
			async (target: string, to: string | undefined, opts: CommanderOptions) => {
				await action(toInvocation(target, to, opts, invocationDirectory));
			},
		);
	return program;
}

interface InternalRuntime {
	readonly out: OutputStream;
	readonly err: OutputStream;
	readonly githubAdapter: GitHubAdapterFactory;
	readonly scan?: ScanCommits;
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

interface Presentation {
	readonly renderer: ReturnType<typeof createRenderer> | undefined;
	readonly preparing: RunProgress;
	readonly outputUrl: string;
	runProgress(repo: Repository): RunProgress;
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
	const renderer = invocation.quiet || toStdout ? undefined : createRenderer(out);
	const viewOptions: RunViewOptions = {
		commitDetail: commitDetailOf(invocation),
		showLookupOutcomes: invocation.showAll,
		debug: invocation.debug,
	};
	const fallback: RunProgress =
		!renderer && invocation.debug
			? createDebugView(createTraceWriter(err))
			: noRunProgress;
	const preparing = renderer
		? createPreparingView(renderer, invocation.debug)
		: fallback;
	const runProgress = (repo: Repository): RunProgress =>
		renderer ? createRunView(renderer, repo, viewOptions) : fallback;

	const absoluteOutput = toStdout
		? undefined
		: isAbsolute(invocation.output)
			? invocation.output
			: resolve(invocation.cwd, invocation.output);
	const outputUrl = absoluteOutput ? pathToFileURL(absoluteOutput).href : "";

	return {
		renderer,
		preparing,
		outputUrl,
		runProgress,
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
		out.write(`${from.ref}\n`);
		return;
	}

	const { renderer, preparing, outputUrl, runProgress, write } = resolvePresentation(
		invocation,
		runtime,
	);
	try {
		const prepared = await runStage(
			preparing,
			"Preparing",
			async (debug) => {
				const trace = invocation.debug ? debug : undefined;
				const run = await prepareRun({
					range: invocation.range,
					cwd,
					repoOverride: invocation.repo,
					refresh: invocation.refresh,
					githubAdapter: runtime.githubAdapter,
					trace,
					diagnostic: debug,
				});
				const header = renderer
					? await resolveHeaderFields(run, {
							version: pkg.version,
							build: {
								sha: commitSha,
								url: buildCommitUrl(pkg.repository?.url, commitSha),
							},
							output: invocation.output,
							outputUrl,
							cwd,
							trace,
						})
					: undefined;
				return { run, header };
			},
			() => ({ type: "preparing-complete", stage: "Preparing" }),
		);
		const { run, header } = prepared;
		const { repo, range, config, lookup } = run;

		const progress = runProgress(repo);

		if (renderer && header) {
			renderer.headerBox(header);
			renderer.blank();
		}

		const markdown = await runPipeline({
			from: range.from.ref,
			to: range.to.ref,
			cwd,
			repository: repo,
			config,
			all: invocation.all,
			lookup,
			scan: runtime.scan,
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
		hasStringProp(error, "code") &&
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

	if (args.length <= 2) {
		err.write(`${usageText()}\n`);
		return 2;
	}

	let debugMode = false;
	const internalRuntime: InternalRuntime = {
		out,
		err,
		githubAdapter: runtime?.githubAdapter ?? defaultGitHubAdapter,
		scan: runtime?.scan,
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
				return 0;
			}
			// InvalidArgumentError thrown from our action is not printed by commander; print it here.
			// Commander's own parsing errors are already written via writeErr before being thrown.
			if (code === "commander.invalidArgument") {
				err.write(`error: ${error.message}\n`);
			}
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
