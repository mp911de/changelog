#!/usr/bin/env node
import { createRequire } from "node:module";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { argv, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { load } from "js-yaml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "octokit";
import pLimit from "p-limit";
import { Chalk, supportsColor, supportsColorStderr } from "chalk";
import stringWidth from "string-width";
//#region src/atomic-file.ts
/**
* Replace a file atomically without following an existing destination symlink. The temporary file
* is created exclusively in the destination directory so another process cannot substitute it.
*/
async function writeFileAtomically(path, content) {
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let file;
	try {
		file = await open(temp, "wx");
		await file.writeFile(content, "utf8");
		await file.close();
		file = void 0;
		await rename(temp, path);
	} catch (error) {
		await file?.close().catch(() => {});
		await unlink(temp).catch(() => {});
		throw error;
	}
}
//#endregion
//#region src/ticket-references.ts
function normalizeOccurrenceId(id) {
	if (id.toLowerCase().startsWith("gh-")) return `#${id.substring(3)}`;
	return id;
}
function referenceOccurrence(id, qualifier, repository) {
	const normalized = normalizeOccurrenceId(id);
	return repository ? {
		id: normalized,
		qualifier,
		repository
	} : {
		id: normalized,
		qualifier
	};
}
/**
* The fully-qualified key for a ticket within a repository. Takes the {@link Repository} whole so
* owner and repo cannot be transposed at the call site.
*/
function repositoryKey(repository, id) {
	return `${repository.owner}/${repository.repo}${id}`;
}
/**
* Stable identity for a Ticket Target: repository plus ticket number, or the bare id for the
* current repository. Delegates to {@link repositoryKey} so it shares the cache key spelling and
* lookup and cache line up.
*/
function targetKey(target) {
	return target.repository ? repositoryKey(target.repository, target.id) : target.id;
}
/**
* A value collection for Ticket Targets keyed by their domain identity, preserving first-seen order.
*/
var TicketTargetSet = class TicketTargetSet {
	targets = /* @__PURE__ */ new Map();
	static from(targets) {
		return new TicketTargetSet(targets);
	}
	constructor(targets = []) {
		for (const target of targets) this.add(target);
	}
	get size() {
		return this.targets.size;
	}
	add(target) {
		const key = targetKey(target);
		if (this.targets.has(key)) return false;
		this.targets.set(key, target);
		return true;
	}
	has(target) {
		return this.targets.has(targetKey(target));
	}
	delete(target) {
		return this.targets.delete(targetKey(target));
	}
	values() {
		return [...this.targets.values()];
	}
};
/**
* Aggregate one commit's parser output at a time into the immutable {@link Aggregate}. Commits are
* supplied oldest-first so the first sighting of a target is its oldest provenance. When supplied,
* {@code currentRepository} canonicalizes explicitly qualified references to the current repository
* while their occurrence spelling remains available for display.
*/
function aggregateReferences(collected, currentRepository) {
	const provenance = /* @__PURE__ */ new Map();
	const changelog = /* @__PURE__ */ new Map();
	const credit = /* @__PURE__ */ new Map();
	const suppressionCandidateTargets = new TicketTargetSet();
	const noteTarget = (target, commit) => {
		const key = targetKey(target);
		if (!provenance.has(key)) provenance.set(key, commit);
	};
	return {
		commits: collected.map(({ commit, occurrences }) => {
			const tier = highestCandidateTier(occurrences);
			const pullRequestsAreCreditOnly = tier === "Qualified" || tier === "See";
			const candidates = new TicketTargetSet();
			const credits = new TicketTargetSet();
			const demoted = new TicketTargetSet();
			const related = new TicketTargetSet();
			for (const occurrence of occurrences) {
				const target = toTarget(occurrence, currentRepository);
				if (occurrence.qualifier === "PullRequest") {
					noteTarget(target, commit);
					credit.set(targetKey(target), target);
					credits.add(target);
					if (pullRequestsAreCreditOnly) suppressionCandidateTargets.add(target);
				}
				if (occurrence.qualifier === tier) {
					noteTarget(target, commit);
					changelog.set(targetKey(target), target);
					candidates.add(target);
					continue;
				}
				if (occurrence.qualifier === "Related") {
					related.add(target);
					continue;
				}
				if (occurrence.qualifier === "PullRequest") continue;
				demoted.add(target);
			}
			const candidateTargets = candidates.values();
			return {
				commit,
				lead: candidateTargets[0],
				candidates: candidateTargets,
				credits: credits.values(),
				demoted: demoted.values(),
				related: related.values()
			};
		}),
		targets: buildLookupTargets(changelog, credit),
		suppressionCandidateTargets: suppressionCandidateTargets.values(),
		provenance
	};
}
/**
* Merge the changelog and credit target maps into one list in commit-discovery order: changelog
* targets in first-appearance order, then any credit-only targets, each flagged by the maps it
* appears in. A target in both maps keeps its earliest position.
*/
function buildLookupTargets(changelog, credit) {
	return [...new Map([...changelog, ...credit])].map(([key, target]) => ({
		target,
		changelog: changelog.has(key),
		credit: credit.has(key)
	}));
}
const QUALIFIERS = {
	Qualified: {
		rank: 4,
		candidate: true
	},
	See: {
		rank: 3,
		candidate: true
	},
	PullRequest: {
		rank: 2,
		candidate: true
	},
	Related: {
		rank: 1,
		candidate: false
	},
	Simple: {
		rank: 0,
		candidate: true
	}
};
function qualifierRank(qualifier) {
	return QUALIFIERS[qualifier].rank;
}
const CANDIDATE_TIERS = Object.keys(QUALIFIERS).filter((qualifier) => QUALIFIERS[qualifier].candidate).sort((left, right) => QUALIFIERS[right].rank - QUALIFIERS[left].rank);
/**
* The highest non-empty candidate tier for one commit's occurrences, or {@code undefined} when the
* commit has no candidate-tier occurrence (including a commit whose only references are Related).
* Candidate-eligible references outside the returned tier are demoted; Related references are never
* candidates and always stay diagnostic.
*/
function highestCandidateTier(occurrences) {
	return CANDIDATE_TIERS.find((tier) => occurrences.some((occurrence) => occurrence.qualifier === tier));
}
function toTarget(occurrence, currentRepository) {
	const repository = occurrence.repository;
	return repository && !sameRepository(repository, currentRepository) ? {
		id: occurrence.id,
		repository: occurrence.repository
	} : { id: occurrence.id };
}
function sameRepository(left, right) {
	return right !== void 0 && left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}
//#endregion
//#region src/links.ts
const GITHUB = "https://github.com";
function repoUrl(repo, path = "") {
	return `${GITHUB}/${repo.owner}/${repo.repo}${path}`;
}
function commitUrl(repo, sha) {
	return repoUrl(repo, `/commit/${sha}`);
}
function ticketUrl(repo, target) {
	const number = target.id.replace(/^#/, "");
	return repoUrl(target.repository ?? repo, `/issues/${number}`);
}
/**
* Link a from/to revision to its GitHub page from its git-resolved {@link RefKind}: a tag's release
* page, a branch's tree, a plain commit, or HEAD (resolved to its head commit).
*/
function refUrl(repo, ref, kind, resolvedSha) {
	switch (kind) {
		case "head": return commitUrl(repo, resolvedSha);
		case "commit": return commitUrl(repo, ref);
		case "branch": return repoUrl(repo, `/tree/${ref}`);
		case "tag": return repoUrl(repo, `/releases/tag/${ref}`);
	}
}
function headerFields(params) {
	const { repository, range } = params;
	const repositoryUrl = repoUrl(repository);
	return {
		repository: {
			...repository,
			url: repositoryUrl
		},
		version: params.version,
		build: params.build,
		repositoryLine: [{
			text: `${repository.owner}/${repository.repo}`,
			link: repositoryUrl
		}],
		range: [
			{
				text: range.from.label,
				link: refUrl(repository, range.from.label, params.fromKind, params.fromSha)
			},
			{ text: ".." },
			{
				text: range.to.label,
				link: refUrl(repository, range.to.label, params.toKind, params.toSha)
			},
			{
				text: " (",
				style: "faint"
			},
			{
				text: params.toSha.slice(0, 7),
				style: "faint",
				link: commitUrl(repository, params.toSha)
			},
			{
				text: ")",
				style: "faint"
			}
		],
		output: [{
			text: params.output,
			link: params.outputUrl
		}]
	};
}
//#endregion
//#region src/errors.ts
function prop(error, key) {
	return typeof error === "object" && error !== null ? error[key] : void 0;
}
function hasCode(error, code) {
	return prop(error, "code") === code;
}
function hasStatus(error, status) {
	return prop(error, "status") === status;
}
function hasStringProp(error, key) {
	return typeof prop(error, key) === "string";
}
//#endregion
//#region src/git.ts
const execFileAsync$1 = promisify(execFile);
const GIT_NOT_FOUND = "Git was not found. Install it from https://git-scm.com/ and try again.";
const LOG_MAX_BUFFER = 256 * 1024 * 1024;
const NUL = "\0";
const NUL_FORMAT = "%x00";
async function scanCommits(from, to, cwd, trace) {
	const fields = (await runGit([
		"log",
		"--no-merges",
		"--reverse",
		`--pretty=format:${[
			"%H",
			"%an",
			"%B",
			"%s"
		].join(NUL_FORMAT) + NUL_FORMAT}`,
		"--end-of-options",
		`${from}..${to}`
	], cwd, {
		maxBuffer: LOG_MAX_BUFFER,
		trace
	})).split(NUL);
	if (fields.at(-1) === "") fields.pop();
	const commits = [];
	for (let index = 0; index < fields.length; index += 4) commits.push({
		sha: (fields[index] ?? "").replace(/^\n/, ""),
		author: fields[index + 1] ?? "",
		fullMessage: fields[index + 2] ?? "",
		shortMessage: fields[index + 3] ?? ""
	});
	return commits;
}
/**
* Resolve a revision to its full commit sha (for example to show the resolved sha of HEAD in
* the header). Translates the same failure modes as scanning into actionable errors.
*/
async function resolveCommit(ref, cwd, trace) {
	try {
		return (await runGit(revParseCommit(ref), cwd, { trace })).trim();
	} catch (error) {
		if (hasCode(error, 1)) throw new Error(`Git revision "${ref}" was not found in "${cwd}".`);
		throw error;
	}
}
async function listTags(cwd, trace) {
	return nonEmptyLines(await runGit(["tag", "--list"], cwd, { trace }));
}
/**
* Resolve a Service Branch name to a usable revision: a local branch takes precedence,
* otherwise a remote-tracking branch (`origin` first, then any other remote). Returns the
* fully-qualified {@code ref} to use as the upper bound paired with its display {@code label}, or
* undefined when no such branch exists. The ref is fully qualified (`refs/heads/...`,
* `refs/remotes/...`) so a same-named tag cannot shadow the branch when Git resolves the range.
*/
async function resolveBranch(name, cwd, trace) {
	if (await refExists(`refs/heads/${name}`, cwd, trace)) return {
		ref: `refs/heads/${name}`,
		label: name
	};
	if (await refExists(`refs/remotes/origin/${name}`, cwd, trace)) return {
		ref: `refs/remotes/origin/${name}`,
		label: `origin/${name}`
	};
	for (const remote of await listRemotes(cwd, trace)) if (remote !== "origin" && await refExists(`refs/remotes/${remote}/${name}`, cwd, trace)) return {
		ref: `refs/remotes/${remote}/${name}`,
		label: `${remote}/${name}`
	};
}
/**
* Classify a revision so the renderer can link it to the right GitHub page. Checks git rather than
* the spelling of the name: a tag named like a branch (for example {@code 7.0.x}) is still a tag,
* and a Service Branch that does not end in {@code .x} is still a branch. Covers the resolved
* remote-tracking form ({@code origin/4.0.x}) via {@code refs/remotes}. Anything that is neither a
* tag nor a branch (a sha) is treated as a commit.
*/
async function classifyRef(ref, cwd, trace) {
	if (ref === "HEAD") return "head";
	if (await refExists(`refs/tags/${ref}`, cwd, trace)) return "tag";
	if (await refExists(`refs/heads/${ref}`, cwd, trace) || await refExists(`refs/remotes/${ref}`, cwd, trace)) return "branch";
	return "commit";
}
function gitRepoRefs(cwd, trace) {
	return {
		tags: () => listTags(cwd, trace),
		resolveBranch: (name) => resolveBranch(name, cwd, trace)
	};
}
async function refExists(ref, cwd, trace) {
	try {
		await runGit(revParseCommit(ref), cwd, { trace });
		return true;
	} catch (error) {
		if (hasCode(error, 1)) return false;
		throw error;
	}
}
async function listRemotes(cwd, trace) {
	return nonEmptyLines(await runGit(["remote"], cwd, { trace }));
}
function nonEmptyLines(stdout) {
	return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
function revParseCommit(ref) {
	return [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${ref}^{commit}`
	];
}
/**
* Run git, translating the cryptic failure modes (git not installed, directory is not a
* repository, output too large to buffer) into actionable errors. Other failures, including
* rev-parse's exit code 1, pass through unchanged for callers to interpret.
*/
async function runGit(args, cwd, options = {}) {
	options.trace?.(`git ${args.join(" ")}`);
	try {
		const { stdout } = await execFileAsync$1("git", args, {
			cwd,
			maxBuffer: options.maxBuffer
		});
		return stdout;
	} catch (error) {
		throw translateGitError(error, args, cwd);
	}
}
function translateGitError(error, args, cwd) {
	if (hasCode(error, "ENOENT")) return new Error(GIT_NOT_FOUND, { cause: error });
	if (hasCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) return new Error("Git produced more output than changelog can buffer at once. Narrow the commit range and try again.", { cause: error });
	if (isNotARepository(error)) return new Error(`"${cwd}" is not a Git repository. Run changelog inside a repository or pass -C <directory>.`, { cause: error });
	if (!hasCode(error, 1)) {
		const stderr = gitStderr(error);
		if (stderr.length > 0) return new Error(`git ${args[0]} failed: ${stderr.trim()}`, { cause: error });
	}
	return error;
}
function gitStderr(error) {
	if (typeof error === "object" && error !== null) {
		const stderr = error.stderr;
		if (typeof stderr === "string") return stderr;
	}
	return "";
}
function isNotARepository(error) {
	return gitStderr(error).includes("not a git repository");
}
//#endregion
//#region src/repo-detect.ts
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
/**
* Whether {@code name} is a usable GitHub owner or repository path segment: the GitHub character
* set, and not a {@code .}/{@code ..} traversal segment. The single validator shared by remote-URL
* parsing and {@code gh}-reported names so both reject the same malformed inputs.
*/
function isRepositoryName(name) {
	return REPOSITORY_NAME.test(name) && name !== "." && name !== "..";
}
/**
* Parse an ssh ({@code git@host:owner/repo.git}, {@code ssh://git@host/owner/repo}) or
* http(s) git remote URL into host/owner/repo. Returns undefined for anything unrecognized.
*/
function parseRemoteUrl(url) {
	const trimmed = url.trim();
	if (trimmed === "") return;
	let host;
	let path;
	if (trimmed.includes("://")) {
		let parsed;
		try {
			parsed = new URL(trimmed);
		} catch {
			return;
		}
		host = parsed.hostname;
		path = parsed.pathname;
	} else {
		const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
		if (!scp) return;
		host = scp[1];
		if (!host.includes(".")) return;
		path = scp[2];
	}
	const segments = path.replace(/^\/+/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
	const [owner, repo] = segments;
	if (host === "" || segments.length !== 2 || !isRepositoryName(owner) || !isRepositoryName(repo)) return;
	return {
		host: host.toLowerCase(),
		owner,
		repo
	};
}
/**
* Read gh's hosts.yml, mapping each configured host to its authenticated username. Parsed with a
* real YAML parser; malformed content yields an empty map so the caller falls back to gh.
*/
function parseGhHosts(content) {
	const hosts = /* @__PURE__ */ new Map();
	let parsed;
	try {
		parsed = load(content);
	} catch {
		return hosts;
	}
	if (!parsed || typeof parsed !== "object") return hosts;
	for (const [host, value] of Object.entries(parsed)) {
		const user = hostUser(value);
		hosts.set(host.toLowerCase(), user === void 0 ? {} : { user });
	}
	return hosts;
}
function hostUser(value) {
	if (!value || typeof value !== "object") return;
	const user = value.user;
	return typeof user === "string" ? user : void 0;
}
function ghHostsPath(env) {
	return join(env.GH_CONFIG_DIR ?? (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "gh") : join(homedir(), ".config", "gh")), "hosts.yml");
}
/**
* Detect the repository without `gh repo view`: parse the git remote URL and, when its host is
* one gh is authenticated to (present in hosts.yml), use it directly and read the username from
* there. Returns undefined (so the caller falls back to gh) whenever anything is missing or the
* host is unknown.
*/
async function detectLocalRepository(cwd, env, trace) {
	const remoteUrl = await gitRemoteUrl(cwd, trace);
	if (!remoteUrl) return;
	const parsed = parseRemoteUrl(remoteUrl);
	if (!parsed) return;
	const path = ghHostsPath(env);
	trace?.(`read ${path}`);
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return;
	}
	const entry = parseGhHosts(content).get(parsed.host);
	if (!entry) return;
	return {
		repo: {
			owner: parsed.owner,
			repo: parsed.repo
		},
		login: entry.user
	};
}
async function gitRemoteUrl(cwd, trace) {
	const run = async (args) => {
		try {
			return (await runGit(args, cwd, { trace })).trim();
		} catch {
			return;
		}
	};
	const origin = await run([
		"remote",
		"get-url",
		"origin"
	]);
	if (origin) return origin;
	const first = (await run(["remote"]))?.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");
	return first ? run([
		"remote",
		"get-url",
		first
	]) : void 0;
}
//#endregion
//#region src/build-info.ts
/**
* Abbreviated commit SHA this build was produced from, captured at build time. Reports
* {@code "dev"} when running from source (tests, {@code npm run run} via vite-node, where no build
* step substitutes the value) and {@code "unknown"} when the build ran without git access (a
* tarball checkout, or git missing from PATH).
*/
const commitSha = "4ca94e6";
/**
* Resolve the GitHub commit URL for {@code sha} within the changelog tool's own repository, parsed
* from the {@code repository.url} field of package.json (e.g.
* {@code git+https://github.com/mp911de/changelog.git}). This is the provenance of the running
* build and is distinct from the repository a run generates notes for. Returns {@code undefined}
* when {@code sha} is not a real commit (the {@code "dev"}/{@code "unknown"} fallbacks), when
* {@code repositoryUrl} is absent, or when it does not parse to a {@code github.com} repository, in
* which case the SHA renders as plain text. See {@link parseRemoteUrl} for the accepted URL forms.
*/
function buildCommitUrl(repositoryUrl, sha) {
	if (repositoryUrl === void 0 || !/^[0-9a-f]+$/i.test(sha)) return;
	const remote = parseRemoteUrl(repositoryUrl);
	if (remote === void 0 || remote.host !== "github.com") return;
	return commitUrl(remote, sha);
}
//#endregion
//#region src/github-context.ts
const execFileAsync = promisify(execFile);
const GH_NOT_FOUND = "GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and try again.";
/**
* Retry once after primary and secondary rate limits so a temporary limit does not abort a
* large changelog run. Built per Octokit instance so the warnings can close over the run's injected
* trace sink, keeping quiet mode quiet instead of going to the default console via octokit.log.warn.
*/
function throttleOptions(trace) {
	const warn = trace ?? (() => {});
	return {
		onRateLimit: (retryAfter, options, _octokit, retryCount) => {
			warn(`Request quota exhausted for ${options.method} ${options.url}`);
			return retryCount < 1;
		},
		onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
			warn(`Secondary rate limit hit for ${options.method} ${options.url}`);
			return retryCount < 1;
		}
	};
}
const defaultGhRunner = async (args, cwd) => {
	const { stdout } = await execFileAsync("gh", args, { cwd });
	return stdout;
};
const defaultLoginResolver = async (octokit) => {
	const { data } = await octokit.rest.users.getAuthenticated();
	return data.login;
};
async function resolveGitHubContext(options = {}) {
	const env = options.env ?? process.env;
	const trace = options.trace;
	const base = options.gh ?? defaultGhRunner;
	const gh = trace ? (args, cwd) => {
		trace(`gh ${args.join(" ")}`);
		return base(args, cwd);
	} : base;
	const getLogin = options.getLogin ?? defaultLoginResolver;
	const detectLocal = options.detectLocal ?? detectLocalRepository;
	const token = await resolveToken(env, gh, options.cwd);
	let repo;
	let login;
	if (options.repo) repo = parseRepository(options.repo);
	else {
		const local = await detectLocal(options.cwd, env, trace);
		if (local) {
			repo = local.repo;
			login = local.login;
		} else repo = await detectRepository(gh, options.cwd);
	}
	const octokit = new Octokit({
		auth: token,
		throttle: throttleOptions(trace)
	});
	if (trace) installRequestTrace(octokit, trace);
	if (login === void 0) login = await getLogin(octokit);
	return {
		repo,
		octokit,
		login
	};
}
function installRequestTrace(octokit, trace) {
	octokit.hook.after("request", (response, requestOptions) => {
		trace(`${requestOptions.method} ${requestOptions.url} → ${response.status}`);
	});
	octokit.hook.error("request", (error, requestOptions) => {
		const status = error.status;
		trace(`${requestOptions.method} ${requestOptions.url} → ${status ?? "error"}`);
		throw error;
	});
}
async function resolveToken(env, gh, cwd) {
	const fromEnv = env.GH_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const fromCli = (await tokenFromCli(gh, cwd)).trim();
	if (fromCli) return fromCli;
	throw new Error("No GitHub token found. Set the GH_TOKEN environment variable or run `gh auth login`.");
}
/**
* A present-but-unauthenticated gh exits non-zero from `gh auth token`; treat that as "no token
* available" and fall back to the guidance above instead of surfacing gh's raw error. Only a
* missing gh executable is re-raised, with the install prompt.
*/
async function tokenFromCli(gh, cwd) {
	try {
		return await gh(["auth", "token"], cwd);
	} catch (error) {
		const missing = ghNotFound(error);
		if (missing) throw missing;
		return "";
	}
}
async function detectRepository(gh, cwd) {
	return parseRepository(repoViewName(await runGh(gh, [
		"repo",
		"view",
		"--json",
		"nameWithOwner,url"
	], cwd)));
}
function repoViewName(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error("Could not read repository information from `gh repo view`. Run changelog inside a GitHub repository or pass --repo owner/repo.", { cause: error });
	}
	const nameWithOwner = parsed.nameWithOwner;
	if (typeof nameWithOwner !== "string" || nameWithOwner.length === 0) throw new Error("`gh repo view` did not report a repository name. Pass --repo owner/repo to set it explicitly.");
	return nameWithOwner;
}
async function runGh(gh, args, cwd) {
	try {
		return await gh(args, cwd);
	} catch (error) {
		throw ghNotFound(error) ?? error;
	}
}
function ghNotFound(error) {
	return hasCode(error, "ENOENT") ? new Error(GH_NOT_FOUND, { cause: error }) : void 0;
}
function parseRepository(nameWithOwner) {
	const parts = nameWithOwner.split("/");
	const [owner, repo] = parts;
	if (parts.length !== 2 || !isRepositoryName(owner ?? "") || !isRepositoryName(repo ?? "")) throw new Error(`Could not parse repository from "${nameWithOwner}"; expected owner/repo.`);
	return {
		owner,
		repo
	};
}
//#endregion
//#region src/lookup.ts
const CONCURRENCY = 10;
function createTargetLookup(options) {
	const { octokit, repo, cache, refresh } = options;
	const limit = pLimit(CONCURRENCY);
	return async function lookup(targets) {
		const outcomes = await Promise.all(targets.map((target) => limit(async () => {
			const repository = target.repository ?? repo;
			const key = repositoryKey(repository, target.id);
			if (cache && !refresh) {
				const hit = cache.get(key);
				if (hit) return {
					kind: "resolved",
					key: targetKey(target),
					ticket: hit,
					source: "cache"
				};
			}
			try {
				const ticket = await fetchTicket(octokit, repository, target.id);
				if (!ticket) return {
					kind: "not-found",
					target
				};
				return {
					kind: "resolved",
					key: targetKey(target),
					ticket,
					source: "github",
					cacheEntry: cache ? [key, ticket] : void 0
				};
			} catch (error) {
				return {
					kind: "failed",
					target,
					error
				};
			}
		})));
		const updates = new Map(outcomes.flatMap((outcome) => outcome.kind === "resolved" && outcome.cacheEntry ? [outcome.cacheEntry] : []));
		if (cache && updates.size > 0) await cache.update(updates);
		const failures = outcomes.filter((outcome) => outcome.kind === "failed");
		if (failures.length > 0) throw targetLookupFailure(failures);
		const facts = new Map(outcomes.flatMap((outcome) => outcome.kind === "resolved" ? [[outcome.key, outcome.ticket]] : []));
		const notFoundTargets = outcomes.flatMap((outcome) => outcome.kind === "not-found" ? [outcome.target] : []);
		const cached = outcomes.filter((outcome) => outcome.kind === "resolved" && outcome.source === "cache").length;
		return {
			facts,
			notFoundTargets,
			cached,
			fetched: facts.size - cached
		};
	};
}
function targetLookupFailure(failures) {
	const ids = failures.map((failure) => targetKey(failure.target)).join(", ");
	const cause = failures[0].error;
	const detail = cause instanceof Error ? cause.message : String(cause);
	const noun = failures.length === 1 ? "ticket" : "tickets";
	return new Error(`Failed to look up ${failures.length} ${noun} (${ids}): ${detail}`, { cause });
}
async function fetchTicket(octokit, target, id) {
	const issueNumber = Number(id.replace(/^#/, ""));
	try {
		const { data } = await octokit.rest.issues.get({
			owner: target.owner,
			repo: target.repo,
			issue_number: issueNumber
		});
		return toResolvedTicket(data);
	} catch (error) {
		if (hasStatus(error, 404)) return;
		throw error;
	}
}
function toResolvedTicket(data) {
	return {
		title: data.title,
		htmlUrl: data.html_url,
		labels: data.labels.map((label) => typeof label === "string" ? label : label.name ?? "").filter((name) => name.length > 0),
		pullRequest: data.pull_request != null,
		author: data.user?.login
	};
}
//#endregion
//#region src/github-adapter.ts
function createTraceRouter(initial) {
	let active = initial;
	return {
		sink: (line) => active?.(line),
		async route(next, fn) {
			active = next;
			try {
				return await fn();
			} finally {
				active = initial;
			}
		}
	};
}
/**
* The production GitHub adapter: resolves the repository context once and reuses its client for
* every lookup. The shared client's request trace is routed through a {@link TraceRouter} so it
* attaches to the preparation trace during preparation and to each lookup call's own debug for the
* duration of that call.
*/
const defaultGitHubAdapter = async ({ cwd, repoOverride, trace }) => {
	const router = createTraceRouter(trace);
	const context = await resolveGitHubContext({
		repo: repoOverride,
		cwd,
		trace: trace ? router.sink : void 0
	});
	return {
		repo: context.repo,
		login: context.login,
		createLookup: ({ cache, refresh }) => {
			const lookup = createTargetLookup({
				octokit: context.octokit,
				repo: context.repo,
				cache,
				refresh
			});
			return (targets, debug) => router.route(debug ?? trace, () => lookup(targets));
		}
	};
};
//#endregion
//#region src/text.ts
/**
* Escape the regular-expression metacharacters in {@code text} so it can be embedded as a literal
* inside a larger pattern.
*/
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/changelog.ts
const OTHER_CHANGES_TITLE = ":gear: Other Changes";
/**
* Generate the Changelog Document from separate document-generation inputs: resolved Changelog
* Entries and ordered author facts. Entries are excluded, placed into their first matching section,
* and rendered in input (commit-discovery) order. Author facts become Contributor Credits
* after case-insensitive team exclusion and deduplication, displayed with GitHub's spelling and
* sorted alphabetically without regard to case. A credit-only author never becomes a Changelog
* Entry. Label matching is case-insensitive and anchored on word boundaries so a qualified label
* such as {@code Type: Bug} matches the configured {@code bug} token, while {@code debugging} does
* not.
*/
function generateChangelog(entries, authors, config, options) {
	const placed = /* @__PURE__ */ new Map();
	const sectionCounts = /* @__PURE__ */ new Map();
	const other = [];
	const matchers = compileLabelMatchers(config);
	for (const entry of entries) {
		const labels = entry.labels;
		if (containsAny(labels, config.excludeLabels, matchers)) continue;
		const section = config.sections.find((candidate) => containsAny(labels, candidate.labels, matchers));
		if (!section) {
			other.push(entry);
			continue;
		}
		const bucket = placed.get(section);
		if (bucket) bucket.push(entry);
		else placed.set(section, [entry]);
		if (section.summary) sectionCounts.set(section.summary, (sectionCounts.get(section.summary) ?? 0) + 1);
	}
	const blocks = [];
	let documentedEntries = 0;
	for (const section of config.sections) {
		const sectionItems = placed.get(section);
		if (sectionItems) {
			blocks.push(renderSection(section.title, sectionItems));
			documentedEntries += sectionItems.length;
		}
	}
	if (options.all && other.length > 0) {
		blocks.push(renderSection(OTHER_CHANGES_TITLE, other));
		documentedEntries += other.length;
	}
	const contributors = collectContributors(authors, config.team);
	if (contributors.length > 0) blocks.push(renderContributors(contributors));
	return {
		markdown: blocks.join("\n"),
		summary: {
			sectionCounts,
			contributorCount: contributors.length,
			documentedEntries
		}
	};
}
const CONTRIBUTORS_TITLE = ":heart: Contributors";
/**
* Reduce ordered author facts to Contributor Credits: drop empty logins and team members
* (case-insensitively), keep one entry per login (case-insensitively, retaining GitHub's first-seen
* spelling), then sort alphabetically without regard to case.
*/
function collectContributors(authors, team) {
	const excluded = new Set(team.map((member) => member.toLowerCase()));
	const seen = /* @__PURE__ */ new Map();
	for (const author of authors) {
		if (!author) continue;
		const key = author.toLowerCase();
		if (excluded.has(key) || seen.has(key)) continue;
		seen.set(key, author);
	}
	return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
function renderContributors(contributors) {
	return `## ${CONTRIBUTORS_TITLE}\n${contributors.map((author) => `- @${author}\n`).join("")}`;
}
/**
* Precompile every section and exclude token into its word-boundary matcher once per run, keyed by
* the original token. The entry loop then reuses these instead of recompiling a RegExp per label.
*/
function compileLabelMatchers(config) {
	const matchers = /* @__PURE__ */ new Map();
	const addToken = (token) => {
		if (!matchers.has(token)) matchers.set(token, labelMatcher(token));
	};
	config.excludeLabels.forEach(addToken);
	for (const section of config.sections) section.labels.forEach(addToken);
	return matchers;
}
function containsAny(labels, candidates, matchers) {
	return candidates.some((candidate) => {
		const needle = matchers.get(candidate) ?? labelMatcher(candidate);
		return labels.some((label) => needle.test(label));
	});
}
function labelMatcher(candidate) {
	return new RegExp(`(?<![\\w-])${escapeRegExp(candidate.trim())}(?![\\w-])`, "i");
}
function renderSection(title, entries) {
	return `## ${title}\n${entries.map(renderEntry).join("")}`;
}
function renderEntry(entry) {
	return `- ${formatTitle(entry.title)} [${targetKey(entry.target)}](${entry.htmlUrl})\n`;
}
const MENTION = /(^|[^\w`])(@[\w-]+)/g;
function formatTitle(title) {
	const trimmed = title.replace(MENTION, "$1`$2`").replace(/\s+$/, "");
	return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}
//#endregion
//#region src/json-file.ts
/**
* A missing file is always optional. By default a present-but-invalid file still throws so
* invalid configuration is not silently replaced; pass {@code onInvalid: "ignore"} to recover
* from a corrupt cache instead.
*/
async function readOptionalJson(path, options = {}) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		if (options.onInvalid === "ignore") {
			options.onIgnored?.(`Ignoring unreadable JSON at ${path}; continuing without it.`);
			return;
		}
		throw new Error(`Could not parse JSON at "${path}".`, { cause: error });
	}
}
/**
* Write atomically via a sibling temp file and rename so an interrupted write cannot truncate
* the target into invalid JSON. Pretty printing and a trailing newline keep diffs readable.
*/
async function writeJsonFile(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}
//#endregion
//#region src/config.ts
function defaultConfig(login, owner) {
	const base = {
		sections: [
			{
				title: ":star: New Features",
				labels: ["enhancement"],
				summary: "features"
			},
			{
				title: ":lady_beetle: Bug Fixes",
				labels: ["bug", "regression"],
				summary: "bugs"
			},
			{
				title: ":notebook_with_decorative_cover: Documentation",
				labels: ["documentation"]
			},
			{
				title: ":hammer: Dependency Upgrades",
				labels: ["dependency-upgrade", "dependencies"]
			}
		],
		excludeLabels: ["type: task"],
		team: [login]
	};
	return owner ? {
		...base,
		followReferences: [`${owner}/*`]
	} : base;
}
/**
* Never copy existing configuration between locations so a project cannot end up with two
* competing files. A new file uses {@code .github} when available and otherwise uses
* {@code .changelog}.
*/
async function loadOrCreateConfig(options) {
	const candidates = await configLocations(options.baseDir);
	for (const path of candidates) {
		const existing = await readOptionalJson(path);
		if (existing !== void 0) return parseConfig(existing, path);
	}
	const created = defaultConfig(options.login, options.owner);
	await writeJsonFile(candidates[0], created);
	return created;
}
async function configLocations(baseDir) {
	const locations = [];
	if (await isDirectory(join(baseDir, ".github"))) locations.push(join(baseDir, ".github", "changelog.json"));
	locations.push(join(baseDir, ".changelog", "changelog.json"));
	return locations;
}
async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
		throw error;
	}
}
function parseConfig(value, path) {
	const config = record(value, path, "configuration");
	if (!Array.isArray(config.sections)) throw invalidConfig(path, "\"sections\" must be an array");
	const sections = config.sections.map((value, index) => {
		const section = record(value, path, `section ${index + 1}`);
		if (typeof section.title !== "string" || section.title.trim().length === 0) throw invalidConfig(path, `section ${index + 1} must have a non-empty "title"`);
		const title = section.title.trim();
		const labels = stringArray(section.labels, path, `section ${index + 1} "labels"`);
		if (section.summary !== void 0 && typeof section.summary !== "string") throw invalidConfig(path, `section ${index + 1} "summary" must be a string`);
		const summary = section.summary?.trim();
		if (summary === "") throw invalidConfig(path, `section ${index + 1} "summary" must not be blank`);
		return {
			title,
			labels,
			summary
		};
	});
	const followReferences = config.followReferences === void 0 ? void 0 : stringArray(config.followReferences, path, "\"followReferences\"");
	return {
		sections,
		excludeLabels: stringArray(config.excludeLabels, path, "\"excludeLabels\""),
		team: stringArray(config.team, path, "\"team\""),
		...followReferences ? { followReferences } : {}
	};
}
/**
* Build a predicate over a `owner/repo` name from followReferences glob patterns. `*` matches one or
* more characters and every other character is literal. An empty pattern list is unrestricted
* (always true), matching the rule that an absent or empty followReferences imposes no limit.
*/
function followReferenceMatcher(patterns) {
	if (patterns.length === 0) return () => true;
	const expressions = patterns.map(globToRegExp);
	return (repositoryName) => expressions.some((expression) => expression.test(repositoryName));
}
function globToRegExp(pattern) {
	const body = pattern.split("*").map(escapeRegExp).join(".+");
	return new RegExp(`^${body}$`, "i");
}
function record(value, path, description) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidConfig(path, `${description} must be an object`);
	return value;
}
function stringArray(value, path, description) {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw invalidConfig(path, `${description} must be an array of strings`);
	const strings = value.map((entry) => entry.trim());
	if (strings.some((entry) => entry.length === 0)) throw invalidConfig(path, `${description} must not contain blank strings`);
	return strings;
}
function invalidConfig(path, detail) {
	return /* @__PURE__ */ new Error(`Invalid changelog configuration at "${path}": ${detail}.`);
}
//#endregion
//#region src/commit-parser.ts
const GITHUB_QUALIFIED_TICKET = "([\\w-]{1,100})/([\\w-]{1,100})((#|gh-)\\d+)";
const GITHUB_URL_QUALIFIED_TICKET = "http[s:/]+[\\w.]{1,253}/([\\w-]{1,100})/([\\w-]{1,100})/issues/(\\d+)";
const GITHUB_TICKET = "((?:#|gh-)\\d+)";
const CLOSE_KEYWORDS = "(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)";
const SEE_KEYWORDS = "(?:see)";
const RELATED_TO_KEYWORDS = "(?:related to)";
const TICKET_ALTERNATION = `(${GITHUB_QUALIFIED_TICKET}|${GITHUB_URL_QUALIFIED_TICKET}|${GITHUB_TICKET})`;
const GITHUB_CLOSE_SYNTAX = `${CLOSE_KEYWORDS}[\\s:]*${TICKET_ALTERNATION}`;
const GITHUB_SEE_SYNTAX = `${SEE_KEYWORDS}[\\s:]*${TICKET_ALTERNATION}`;
const GITHUB_RELATED_TO_SYNTAX = `${RELATED_TO_KEYWORDS}[\\s:]*${TICKET_ALTERNATION}`;
const RELATED_TICKET = `(?:(?:Related (?:tickets|ticket))|(?:Ticket)|(?:Related))[:]*(?:\\s+)?((?:${TICKET_ALTERNATION}(?:[\\s,]*))+)`;
const PULL_REQUEST = `(?:Original\\s+)?(?:pull request|PR|pullrequest)[:]*(?:\\s+)?${TICKET_ALTERNATION}`;
/**
* A required capture group: throw rather than silently miscapture when an alternation branch matched
* but the expected group did not, turning a regex/code mismatch into a diagnosable error.
*/
function group(match, index) {
	const value = match[index];
	if (value === void 0) throw new Error(`expected capture group ${index} in "${match[0]}"`);
	return value;
}
const QUALIFIED_MATCH = new RegExp(`^${GITHUB_QUALIFIED_TICKET}$`, "i");
const URL_QUALIFIED_MATCH = new RegExp(`^${GITHUB_URL_QUALIFIED_TICKET}$`, "i");
const TICKET_MATCH = new RegExp(`^${GITHUB_TICKET}$`, "i");
const ANY_TICKET_SCAN = new RegExp(TICKET_ALTERNATION, "gi");
const QUALIFIER_SYNTAX = [
	{
		pattern: GITHUB_CLOSE_SYNTAX,
		qualifier: "Qualified"
	},
	{
		pattern: PULL_REQUEST,
		qualifier: "PullRequest"
	},
	{
		pattern: GITHUB_SEE_SYNTAX,
		qualifier: "See"
	},
	{
		pattern: RELATED_TICKET,
		qualifier: "Related"
	},
	{
		pattern: GITHUB_RELATED_TO_SYNTAX,
		qualifier: "Related"
	}
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
function parseReferenceOccurrences(message) {
	const qualifiers = qualifierByPosition(message);
	const occurrences = [];
	ANY_TICKET_SCAN.lastIndex = 0;
	for (let match = ANY_TICKET_SCAN.exec(message); match; match = ANY_TICKET_SCAN.exec(message)) {
		const occurrence = extractOccurrence(group(match, 1), qualifiers.get(match.index) ?? "Simple");
		if (occurrence) occurrences.push(occurrence);
	}
	return occurrences;
}
/**
* Map each ticket token's start position to its strongest recognized qualifier. Each relationship
* syntax runs over the whole message; ticket tokens enclosed by a match inherit its qualifier, and
* the strongest qualifier wins when syntaxes overlap. Unclaimed positions stay `Simple` by default.
*/
function qualifierByPosition(message) {
	const byPosition = /* @__PURE__ */ new Map();
	for (const { pattern, qualifier } of QUALIFIER_SYNTAX) {
		const syntax = new RegExp(pattern, "gim");
		for (let match = syntax.exec(message); match; match = syntax.exec(message)) {
			const enclosed = new RegExp(TICKET_ALTERNATION, "gi");
			for (let token = enclosed.exec(match[0]); token; token = enclosed.exec(match[0])) {
				const position = match.index + token.index;
				const current = byPosition.get(position);
				if (current === void 0 || qualifierRank(qualifier) > qualifierRank(current)) byPosition.set(position, qualifier);
			}
		}
	}
	return byPosition;
}
function extractOccurrence(token, qualifier) {
	const trimmed = token.trim();
	const url = URL_QUALIFIED_MATCH.exec(trimmed);
	if (url) return referenceOccurrence(`#${group(url, 3)}`, qualifier, {
		owner: group(url, 1),
		repo: group(url, 2)
	});
	const qualified = QUALIFIED_MATCH.exec(trimmed);
	if (qualified) return referenceOccurrence(group(qualified, 3), qualifier, {
		owner: group(qualified, 1),
		repo: group(qualified, 2)
	});
	if (TICKET_MATCH.test(trimmed)) return referenceOccurrence(trimmed, qualifier);
}
//#endregion
//#region src/progress.ts
const noRunProgress = { emit: () => {} };
/**
* Run one stage with enforced event ordering and stage-bound debug. Emits a start event, runs the
* action with a debug emitter scoped to this stage, emits the completion event the caller builds on
* success, or emits a stage failure and rethrows on error. There is no mutable tracer binding: each
* stage owns its own debug emitter, so traces cannot attach to the wrong stage.
*/
async function runStage(progress, stage, action, complete) {
	progress.emit({
		type: "stage-start",
		stage
	});
	const debug = (line) => progress.emit({
		type: "stage-debug",
		stage,
		line
	});
	try {
		const result = await action(debug);
		progress.emit(complete(result));
		return result;
	} catch (error) {
		progress.emit({
			type: "stage-failed",
			stage
		});
		throw error;
	}
}
//#endregion
//#region src/resolved-references.ts
/**
* Join {@link aggregate} with {@link lookup} facts. Each unsuppressed candidate target with facts
* becomes a Changelog Entry. Author facts follow the credit rule: a credit-purpose target is always
* credited (the commit's PullRequest qualifier is authoritative), and a changelog-only candidate is
* credited only when GitHub reports it as a pull request. Not-found failures are split by whether the
* target carried an effective changelog purpose (candidate) or only a credit purpose. Targets in
* {@code excluded} were held back by followReferences: they are never looked up, never become entries
* or credits, and are reported separately from looked-up and not-found targets.
*/
function resolveTicketReferences(aggregate, lookup, excluded = []) {
	const entries = [];
	const authors = [];
	const lookedUp = [];
	const excludedMembership = TicketTargetSet.from(excluded);
	const excludedTargets = new TicketTargetSet();
	const flagsByKey = new Map(aggregate.targets.map((t) => [targetKey(t.target), t]));
	const suppressedChangelogTargets = TicketTargetSet.from(aggregate.suppressionCandidateTargets.filter((target) => !excludedMembership.has(target)));
	for (const { target, changelog, credit } of aggregate.targets) {
		if (excludedMembership.has(target)) {
			excludedTargets.add(target);
			continue;
		}
		const facts = lookup.facts.get(targetKey(target));
		lookedUp.push({
			target,
			found: facts !== void 0
		});
		if (!facts) continue;
		if (changelog && !suppressedChangelogTargets.has(target)) entries.push({
			target,
			title: facts.title,
			htmlUrl: facts.htmlUrl,
			labels: facts.labels
		});
		if (earnsCredit(credit, facts) && facts.author) authors.push(facts.author);
	}
	const candidateNotFound = [];
	const creditNotFound = [];
	for (const target of lookup.notFoundTargets) {
		const failure = toNotFound(aggregate, target);
		const key = targetKey(target);
		const flags = flagsByKey.get(key);
		const changelog = flags?.changelog && !suppressedChangelogTargets.has(target);
		if (flags?.credit && !changelog) creditNotFound.push(failure);
		else candidateNotFound.push(failure);
	}
	return {
		entries,
		authors,
		lookedUp,
		excluded: excludedTargets.values(),
		candidateNotFound,
		creditNotFound,
		cached: lookup.cached,
		fetched: lookup.fetched
	};
}
/**
* The Contributor Credit rule in one place: a credit-flagged target is always credited (the commit's
* PullRequest qualifier is authoritative), and a changelog-only candidate is credited only when
* GitHub reports it as a pull request.
*/
function earnsCredit(credit, facts) {
	return credit || facts.pullRequest;
}
function toNotFound(aggregate, target) {
	const commit = aggregate.provenance.get(targetKey(target));
	if (!commit) throw new Error(`No commit provenance recorded for ${targetKey(target)}.`);
	return {
		target,
		commit
	};
}
//#endregion
//#region src/pipeline.ts
async function runPipeline(options) {
	const progress = options.progress ?? noRunProgress;
	const scan = options.scan ?? scanCommits;
	const aggregate = await runStage(progress, "Scanning", async (debug) => {
		const commits = await scan(options.from, options.to, options.cwd, debug);
		const collected = commits.map((commit) => ({
			commit: {
				sha: commit.sha,
				author: commit.author,
				summary: commit.shortMessage
			},
			occurrences: parseReferenceOccurrences(commit.fullMessage)
		}));
		return {
			commitCount: commits.length,
			aggregate: aggregateReferences(collected, options.repository)
		};
	}, (result) => ({
		type: "scanning-complete",
		stage: "Scanning",
		commits: result.commitCount,
		aggregate: result.aggregate
	})).then((result) => result.aggregate);
	const resolved = await runStage(progress, "Looking up", async (debug) => {
		const { followed, excluded } = partitionByFollow(aggregate.targets, options.config.followReferences);
		return resolveTicketReferences(aggregate, await options.lookup(followed, debug), excluded);
	}, (result) => ({
		type: "looking-up-complete",
		stage: "Looking up",
		resolved: result
	}));
	return runStage(progress, "Generating", () => generateChangelog(resolved.entries, resolved.authors, options.config, { all: options.all }), (result) => ({
		type: "generating-complete",
		stage: "Generating",
		summary: result.summary
	})).then((result) => result.markdown);
}
/**
* Split flagged targets into plain lookup targets and those held back by followReferences. A reference
* to the current repository (no explicit repository) is always followed; a cross-repository reference
* is followed only when its `owner/repo` matches the allow-list. Absent or empty patterns follow
* everything.
*/
function partitionByFollow(targets, patterns) {
	const matches = followReferenceMatcher(patterns ?? []);
	const followed = [];
	const excluded = [];
	for (const flagged of targets) {
		const repository = flagged.target.repository;
		if (repository && !matches(`${repository.owner}/${repository.repo}`)) excluded.push(flagged.target);
		else followed.push(flagged.target);
	}
	return {
		followed,
		excluded
	};
}
//#endregion
//#region src/cache.ts
async function loadCache(options) {
	const path = join(options.baseDir, ".changelog", `${options.slug}.cache.json`);
	const entries = compatibleEntries(await readOptionalJson(path, {
		onInvalid: "ignore",
		onIgnored: options.diagnostic
	}), path, options.diagnostic);
	return {
		get(key) {
			return entries.get(key);
		},
		async update(tickets) {
			for (const [key, ticket] of tickets) entries.set(key, ticket);
			await writeJsonFile(path, Object.fromEntries(entries));
		}
	};
}
function compatibleEntries(value, path, diagnostic) {
	if (value === void 0) return /* @__PURE__ */ new Map();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		diagnostic?.(`Ignoring incompatible cache data at ${path}; continuing without it.`);
		return /* @__PURE__ */ new Map();
	}
	const entries = /* @__PURE__ */ new Map();
	for (const [key, entry] of Object.entries(value)) if (isResolvedTicket(entry)) entries.set(key, entry);
	else diagnostic?.(`Ignoring incompatible cache entry ${key} at ${path}.`);
	return entries;
}
function isResolvedTicket(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const ticket = value;
	return typeof ticket.title === "string" && typeof ticket.htmlUrl === "string" && Array.isArray(ticket.labels) && ticket.labels.every((label) => typeof label === "string") && typeof ticket.pullRequest === "boolean" && (ticket.author === void 0 || typeof ticket.author === "string");
}
//#endregion
//#region src/artifact-version.ts
const SHAPE = /^(\d+(?:\.\d+)*)(?:([.-])(.+))?$/;
const NUMERIC_QUALIFIER = /^\d+(?:\.\d+)*$/;
const SINGLE_SEGMENT_QUALIFIER = /^([a-zA-Z]+)([.-])?(\d*)$/;
const SNAPSHOT_ORDER = 0;
const KNOWN_PRE_RELEASE_OFFSET = 1;
const GENERIC_ORDER = 16;
const RELEASE_ORDER = 17;
const SERVICE_RELEASE_ORDER = 18;
const TYPE_ORDER = /* @__PURE__ */ new Map([
	["", 0],
	["dev", 1],
	["nightly", 2],
	["canary", 3],
	["experimental", 4],
	["alpha", 5],
	["a", 6],
	["beta", 7],
	["b", 8],
	["pre", 9],
	["preview", 10],
	["m", 11],
	["next", 12],
	["rc", 13],
	["cr", 14]
]);
const INFERABLE_PRE_RELEASE_TYPES = /* @__PURE__ */ new Set([
	"alpha",
	"a",
	"beta",
	"b",
	"pre",
	"preview",
	"m",
	"rc",
	"cr"
]);
const NON_NUMERIC_INFERABLE_PRE_RELEASE_TYPES = /* @__PURE__ */ new Set([
	"alpha",
	"a",
	"beta",
	"b"
]);
const PRE_RELEASE_FAMILY = /* @__PURE__ */ new Map([
	["alpha", "alpha"],
	["a", "alpha"],
	["beta", "beta"],
	["b", "beta"],
	["pre", "pre"],
	["preview", "preview"],
	["m", "m"],
	["rc", "rc"],
	["cr", "rc"]
]);
const PRE_RELEASE_ALIASES = /* @__PURE__ */ new Map([
	["alpha", ["a"]],
	["a", ["alpha"]],
	["beta", ["b"]],
	["b", ["beta"]],
	["rc", ["cr"]],
	["cr", ["rc"]]
]);
const PRE_RELEASE_DISPLAY = /* @__PURE__ */ new Map([
	["m", "M"],
	["rc", "RC"],
	["cr", "CR"]
]);
const RELEASE_QUALIFIER = {
	kind: "release",
	order: RELEASE_ORDER,
	identifiers: []
};
const SNAPSHOT_QUALIFIER = {
	kind: "snapshot",
	order: SNAPSHOT_ORDER,
	identifiers: []
};
/**
* Parse {@code raw}; returns {@code null} when it is not a recognized version spelling.
*/
function parseArtifactVersion(raw) {
	let text = raw.trim();
	if (text.startsWith("v") || text.startsWith("V")) text = text.slice(1);
	const metadataIndex = text.indexOf("+");
	if (metadataIndex !== -1) text = text.slice(0, metadataIndex);
	const shape = SHAPE.exec(text);
	if (shape === null) return null;
	const parts = shape[1].split(".");
	if (parts.some((part) => part.length > 1 && part.startsWith("0"))) return null;
	const qualifier = parseQualifier(shape[3]);
	if (qualifier === null) return null;
	return releaseVersion(parts.map(Number), raw, qualifier);
}
/**
* Classify the qualifier into the stable Artifact Version order.
*/
function parseQualifier(qualifier) {
	if (qualifier === void 0) return RELEASE_QUALIFIER;
	const candidate = qualifier.trim();
	if (candidate === "") return RELEASE_QUALIFIER;
	if (/\s/.test(candidate)) return null;
	const lower = candidate.toLowerCase();
	if (lower === "release" || lower === "final") return RELEASE_QUALIFIER;
	if (lower === "snapshot" || lower === "build-snapshot") return SNAPSHOT_QUALIFIER;
	if (NUMERIC_QUALIFIER.test(candidate)) return knownQualifier("", candidate.split("."));
	const single = SINGLE_SEGMENT_QUALIFIER.exec(candidate);
	if (single !== null) return knownQualifier(single[1].toLowerCase(), single[3] === "" ? [] : [single[3]], candidate);
	const segments = candidate.replaceAll("-", ".").split(".");
	if (segments.length >= 2 && !isNumeric(segments[0])) {
		const [type, ...identifiers] = segments;
		return knownQualifier(type.toLowerCase(), identifiers, candidate);
	}
	return {
		kind: "generic",
		order: GENERIC_ORDER,
		genericText: candidate
	};
}
function knownQualifier(type, identifiers, fallbackText) {
	if (type === "sr") return {
		kind: "service-release",
		order: SERVICE_RELEASE_ORDER,
		identifiers: identifiers.map(identifier)
	};
	const typeOrder = TYPE_ORDER.get(type);
	if (typeOrder === void 0) return {
		kind: "generic",
		order: GENERIC_ORDER,
		genericText: fallbackText ?? [type, ...identifiers].join(".")
	};
	return {
		kind: "pre-release",
		order: KNOWN_PRE_RELEASE_OFFSET + typeOrder,
		type,
		identifiers: identifiers.map(identifier)
	};
}
function identifier(raw) {
	return isNumeric(raw) ? {
		raw,
		numeric: BigInt(raw)
	} : { raw };
}
function isNumeric(value) {
	return /^\d+$/.test(value);
}
/**
* The version that must immediately precede {@code version}: decrement its last significant (non-zero)
* component and zero the rest. Returns {@code null} when every component is zero (no predecessor).
*/
function predecessor(version) {
	const qualifier = version.qualifier;
	if (qualifier.kind === "service-release") return previousServiceRelease(version, qualifier);
	const components = [...version.components];
	let last = components.length - 1;
	while (last >= 0 && components[last] === 0) last--;
	if (last < 0) return null;
	components[last] = components[last] - 1;
	return releaseVersion(components);
}
function previousServiceRelease(version, qualifier) {
	const counter = qualifier.identifiers[0];
	if (counter?.numeric !== void 0 && counter.numeric > 1n) {
		const previous = (counter.numeric - 1n).toString();
		return releaseVersion(version.components, `${version.components.join(".")}.SR${previous}`, {
			kind: "service-release",
			order: SERVICE_RELEASE_ORDER,
			identifiers: [identifier(previous)]
		});
	}
	return releaseVersion(version.components);
}
/**
* Whether {@code version} has a qualifier that orders before GA.
*/
function isNonReleaseVersion(version) {
	return !version.isRelease;
}
/**
* Whether {@code version} has a known qualifier whose predecessor can be inferred safely.
*/
function isInferablePreRelease(version) {
	return inferablePreRelease(version) !== void 0;
}
/**
* Candidate same-family predecessors for a numbered pre-release target, ordered by preference:
* same qualifier spelling first, then semantic aliases.
*/
function preReleasePredecessorCandidates(target) {
	const preRelease = inferablePreRelease(target);
	const previous = previousPreReleaseIdentifiers(preRelease?.identifiers);
	if (preRelease === void 0 || previous === void 0) return [];
	return [preRelease.type, ...PRE_RELEASE_ALIASES.get(preRelease.type) ?? []].map((type) => preReleaseVersion(target.components, type, previous));
}
/**
* Whether a numbered pre-release target must fail when its same-family predecessor is absent.
*/
function requiresExactPreReleasePredecessor(target) {
	const last = inferablePreRelease(target)?.identifiers.at(-1)?.numeric;
	return last !== void 0 && last > 1n;
}
/**
* Whether two versions have equivalent numeric components, ignoring qualifiers and spelling.
*/
function sameNumericComponents(left, right) {
	return compareComponents(left.components, right.components) === 0;
}
/**
* Whether two inferable pre-releases belong to the same semantic qualifier family.
*/
function samePreReleaseFamily(left, right) {
	const leftPreRelease = inferablePreRelease(left);
	const rightPreRelease = inferablePreRelease(right);
	return leftPreRelease !== void 0 && rightPreRelease !== void 0 && leftPreRelease.family === rightPreRelease.family;
}
/**
* Whether {@code version} opens a Release Line rather than advancing one: a trailing-zero last
* component (`4.1.0`, `4.0`) or a single component (`4`). Line-openers take HEAD as their upper
* bound; everything else is a patch resolved against a Service Branch.
*/
function isLineOpener(version) {
	if (version.qualifier.kind === "service-release") return false;
	return version.components.length < 2 || version.components[version.components.length - 1] === 0;
}
/**
* Whether {@code version} opens a new major line (`4`, `4.0`, `4.0.0`): every component after the
* major is zero. A major opener is the one case whose Predecessor cannot be derived by arithmetic,
* since the previous major's latest line (for example `3.5`) is unknown from the version alone and
* must be discovered from the tags. Every other version (patch or minor) resolves arithmetically.
*/
function isMajorOpener(version) {
	if (version.qualifier.kind === "service-release") return false;
	return version.components.slice(1).every((component) => component === 0);
}
/**
* The Service Branch name for a patch {@code version}: its last component replaced by `x`.
*/
function serviceBranch(version) {
	return [...version.components.slice(0, -1), "x"].join(".");
}
/**
* Order two versions by their numeric components and stable Qualifier order.
*/
function compareVersions(left, right) {
	const componentComparison = compareComponents(left.components, right.components);
	return componentComparison !== 0 ? componentComparison : compareQualifiers(left.qualifier, right.qualifier);
}
/**
* Whether two versions denote the same Artifact Version, allowing equivalent GA spellings.
*/
function sameVersion(left, right) {
	return compareVersions(left, right) === 0;
}
function releaseVersion(components, raw = components.join("."), qualifier = RELEASE_QUALIFIER) {
	return {
		raw,
		components: [...components],
		isRelease: qualifier.kind === "release" || qualifier.kind === "service-release",
		qualifier
	};
}
function inferablePreRelease(version) {
	const qualifier = version.qualifier;
	if (qualifier.kind !== "pre-release" || !INFERABLE_PRE_RELEASE_TYPES.has(qualifier.type)) return;
	if (qualifier.identifiers.length === 0 && !NON_NUMERIC_INFERABLE_PRE_RELEASE_TYPES.has(qualifier.type)) return;
	if (qualifier.identifiers.length > 0 && qualifier.identifiers.some((value) => value.numeric === void 0)) return;
	const family = PRE_RELEASE_FAMILY.get(qualifier.type);
	if (family === void 0) return;
	return {
		type: qualifier.type,
		family,
		identifiers: qualifier.identifiers
	};
}
function previousPreReleaseIdentifiers(identifiers) {
	const last = identifiers?.at(-1)?.numeric;
	if (identifiers === void 0 || last === void 0 || last < 1n) return;
	return [...identifiers.slice(0, -1).map((value) => value.raw), (last - 1n).toString()];
}
function preReleaseVersion(components, type, identifiers) {
	const display = PRE_RELEASE_DISPLAY.get(type) ?? type;
	const suffix = identifiers.length === 0 ? display : `${display}${identifiers.length === 1 ? identifiers[0] : `.${identifiers.join(".")}`}`;
	return releaseVersion(components, `${components.join(".")}-${suffix}`, knownQualifier(type, identifiers, suffix));
}
function compareComponents(left, right) {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const comparison = compare(left[index] ?? 0, right[index] ?? 0);
		if (comparison !== 0) return comparison;
	}
	return 0;
}
function compareQualifiers(left, right) {
	const orderComparison = compare(left.order, right.order);
	if (orderComparison !== 0) return orderComparison;
	if (left.kind === "generic" && right.kind === "generic") return compareGenericText(left.genericText, right.genericText);
	if ("identifiers" in left && "identifiers" in right) return compareIdentifiers(left.identifiers, right.identifiers);
	return 0;
}
function compareIdentifiers(left, right) {
	const count = Math.min(left.length, right.length);
	for (let index = 0; index < count; index++) {
		const comparison = compareIdentifier(left[index], right[index]);
		if (comparison !== 0) return comparison;
	}
	return compare(left.length, right.length);
}
function compareIdentifier(left, right) {
	if (left.numeric !== void 0 && right.numeric !== void 0) return compare(left.numeric, right.numeric);
	if (left.numeric !== void 0 || right.numeric !== void 0) return left.numeric !== void 0 ? -1 : 1;
	return compare(left.raw, right.raw);
}
function compareGenericText(left, right) {
	const lowerComparison = compare(left.toLowerCase(), right.toLowerCase());
	return lowerComparison !== 0 ? lowerComparison : compare(left, right);
}
/**
* Three-way comparison for any relationally-ordered primitive, yielding -1, 0, or 1.
*/
function compare(left, right) {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
//#endregion
//#region src/version.ts
/**
* Interpret the positional arguments. A lone version is the release target (auto mode); two
* arguments or a `<from>..<to>` range supply explicit bounds. Git refnames cannot contain "..", so
* splitting on it is unambiguous; the range and a separate `to` are mutually exclusive.
*/
function parseRange(from, to) {
	if (!from.includes("..")) {
		if (to !== void 0) return {
			mode: "explicit",
			from,
			to
		};
		if (parseArtifactVersion(from) === null) throw new InvalidArgumentError(`"${from}" is not a recognized version; pass <from> <to> or a <from>..<to> range`);
		return {
			mode: "auto",
			target: from
		};
	}
	if (to !== void 0) throw new InvalidArgumentError("specify the range once: either <from>..<to> or <from> <to>, not both");
	if (from.includes("...")) throw new InvalidArgumentError(`invalid range "${from}": use two dots, e.g. 4.0.0..4.0.4`);
	if (from.indexOf("..") !== from.lastIndexOf("..")) throw new InvalidArgumentError(`invalid range "${from}": use a single <from>..<to>`);
	const separator = from.indexOf("..");
	const lower = from.slice(0, separator);
	const upper = from.slice(separator + 2);
	if (lower === "") throw new InvalidArgumentError(`invalid range "${from}": missing <from> before ".."`);
	return {
		mode: "explicit",
		from: lower,
		to: upper === "" ? "HEAD" : upper
	};
}
function tagBound(raw) {
	return {
		ref: raw,
		label: raw,
		kind: "tag"
	};
}
/**
* Resolve the commit range for releasing {@code input}. {@code input} must be a recognized version
* (callers validate this up front). The upper bound is the matching tag, the Service Branch tip
* for a patch, or HEAD for a line-opener; the lower bound is the Predecessor, which must exist.
*/
async function resolveAutoRange(input, repo) {
	const target = parseArtifactVersion(input);
	if (target === null) throw new Error(`"${input}" is not a recognized version`);
	const tags = (await repo.tags()).map((raw) => parseArtifactVersion(raw)).filter((version) => version !== null);
	const to = await resolveUpperBound(target, tags, repo);
	return {
		from: resolveLowerBound(target, tags),
		to
	};
}
async function resolveUpperBound(target, tags, repo) {
	const tagged = tags.find((version) => version.raw === target.raw) ?? tags.find((version) => sameVersion(version, target));
	if (tagged !== void 0) return tagBound(tagged.raw);
	if (isLineOpener(target)) return {
		ref: "HEAD",
		label: "HEAD",
		kind: "head"
	};
	const branch = serviceBranch(target);
	const resolved = await repo.resolveBranch(branch);
	if (resolved === void 0) throw new Error(`no ${branch} service branch found for ${target.raw}; check out the service branch or pass <from> <to>`);
	return {
		ref: resolved.ref,
		label: resolved.label,
		kind: "branch"
	};
}
function resolveLowerBound(target, tags) {
	const releases = tags.filter((version) => version.isRelease);
	const lower = nonReleaseLowerBound(target, tags, releases) ?? releaseLowerBound(target, releases);
	if (lower.tag !== void 0) return tagBound(lower.tag);
	if (releases.some((version) => compareVersions(version, target) < 0)) throw new Error(`Cannot find tag ${lower.expected ?? "for the previous version"}. Pass <from> <to> explicitly.`);
	throw new Error(`could not determine a previous version for ${target.raw}; pass <from> <to> or <from>..<to> explicitly.`);
}
function releaseLowerBound(target, releases) {
	return isMajorOpener(target) ? previousLineOpener(target, releases) : exactPredecessor(target, releases);
}
function nonReleaseLowerBound(target, tags, releases) {
	if (!isNonReleaseVersion(target)) return;
	if (!isInferablePreRelease(target)) return {};
	const exact = exactPreReleasePredecessor(target, tags);
	if (exact.tag !== void 0) return exact;
	if (requiresExactPreReleasePredecessor(target)) return exact;
	const lower = highestLowerPreRelease(target, tags);
	return lower.tag !== void 0 ? lower : releaseLowerBound(target, releases);
}
function exactPreReleasePredecessor(target, tags) {
	const candidates = preReleasePredecessorCandidates(target);
	for (const candidate of candidates) {
		const match = tags.find((version) => sameVersion(version, candidate));
		if (match !== void 0) return {
			tag: match.raw,
			expected: candidates[0]?.raw
		};
	}
	return { expected: candidates[0]?.raw };
}
function highestLowerPreRelease(target, tags) {
	let highest;
	for (const version of tags) {
		if (!isInferablePreRelease(version) || !sameNumericComponents(version, target) || samePreReleaseFamily(version, target) || compareVersions(version, target) >= 0) continue;
		if (highest === void 0 || compareVersions(version, highest) > 0) highest = version;
	}
	return { tag: highest?.raw };
}
function exactPredecessor(target, releases) {
	const previous = predecessor(target);
	if (previous === null) return {};
	return {
		tag: releases.find((version) => sameVersion(version, previous))?.raw,
		expected: previous.raw
	};
}
/**
* The opener of the Release Line preceding a major opener: the latest release below the target
* reduced to its line opener (last component zeroed). The previous major's latest line is discovered
* from the tags rather than assumed, so 4.0.0 resolves against 3.5.0 (the latest 3.x line) rather
* than the arithmetic 3.0.0. Patches and minors never reach here; they resolve arithmetically.
*/
function previousLineOpener(target, releases) {
	let highest;
	for (const version of releases) {
		if (compareVersions(version, target) >= 0) continue;
		if (highest === void 0 || compareVersions(version, highest) > 0) highest = version;
	}
	if (highest === void 0) return {};
	const components = [...highest.components];
	components[components.length - 1] = 0;
	const opener = releaseVersion(components);
	return {
		tag: releases.find((version) => sameVersion(version, opener))?.raw,
		expected: opener.raw
	};
}
//#endregion
//#region src/prepare.ts
/**
* Resolve everything a run needs before scanning: the commit range (from the tags in auto mode, or
* verbatim for an explicit range), the GitHub repository and login, the configuration, and the
* {@link Lookup} bound to the loaded cache. Performs no header or terminal work; see
* {@link resolveHeaderFields} for the presentation values.
*/
async function prepareRun(options) {
	const { cwd, trace } = options;
	const range = options.range.mode === "auto" ? await resolveAutoRange(options.range.target, gitRepoRefs(cwd, trace)) : {
		from: {
			ref: options.range.from,
			label: options.range.from
		},
		to: {
			ref: options.range.to,
			label: options.range.to
		}
	};
	const adapter = await options.githubAdapter({
		cwd,
		repoOverride: options.repoOverride,
		trace
	});
	const config = await loadOrCreateConfig({
		baseDir: cwd,
		login: adapter.login,
		owner: adapter.repo.owner
	});
	const cache = await loadCache({
		baseDir: cwd,
		slug: adapter.repo.repo,
		diagnostic: options.diagnostic
	});
	const lookup = adapter.createLookup({
		cache,
		refresh: options.refresh
	});
	return {
		repo: adapter.repo,
		range,
		config,
		lookup
	};
}
/**
* Build the header box fields for a resolved range. Resolves the range head sha (and the {@code from}
* sha only when {@code from} is HEAD), and each bound's {@link RefKind} from the bound itself when
* the range resolver already knew it (auto mode) or by classifying the ref against Git otherwise
* (explicit mode). Called only when a header will render, so the Git work is skipped for quiet runs.
*/
async function resolveHeaderFields(run, context) {
	const { repo, range } = run;
	const { cwd, trace } = context;
	const { from, to } = range;
	const toSha = await resolveCommit(to.ref, cwd, trace);
	const fromSha = from.ref === "HEAD" ? from.ref === to.ref ? toSha : await resolveCommit(from.ref, cwd, trace) : "";
	const fromKind = from.kind ?? await classifyRef(from.ref, cwd, trace);
	const toKind = to.kind ?? await classifyRef(to.ref, cwd, trace);
	return headerFields({
		repository: repo,
		version: context.version,
		build: context.build,
		range,
		fromKind,
		toKind,
		fromSha,
		toSha,
		output: context.output,
		outputUrl: context.outputUrl
	});
}
const GRAPHEMES = new Intl.Segmenter(void 0, { granularity: "grapheme" });
const SUCCESS = {
	text: "✔",
	style: "green"
};
const ELLIPSIS = "…";
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const HEX = {
	accent: "#89b4fa",
	warning: "#eda757",
	mauve: "#CBA6F7",
	green: "#a6e3a1",
	gray: "#9399b2",
	grayMedium: "#7f849c",
	grayDark: "#6c7086"
};
/**
* Remove terminal control characters from external text before it reaches ANSI styling or layout.
*/
function sanitizeTerminalText(text) {
	return text.replace(TERMINAL_CONTROL, "");
}
/**
* Build a palette for a given color level and hyperlink capability. A level of 0 yields plain
* text; hyperlinks are emitted as OSC 8 escapes only when enabled.
*/
function createPalette(level, hyperlinks) {
	const chalk = new Chalk({ level: clampLevel(level) });
	const apply = (text, style) => {
		const safe = sanitizeTerminalText(text);
		switch (style) {
			case "faint": return chalk.dim(safe);
			case "bold": return chalk.bold(safe);
			case "green": return chalk.hex(HEX.green)(safe);
			case "red": return chalk.red(safe);
			case "accent": return chalk.hex(HEX.accent)(safe);
			case "warning": return chalk.hex(HEX.warning)(safe);
			case "mauve": return chalk.hex(HEX.mauve)(safe);
			case "gray": return chalk.hex(HEX.gray)(safe);
			case "grayMedium": return chalk.hex(HEX.grayMedium)(safe);
			case "grayDark": return chalk.hex(HEX.grayDark)(safe);
			default: return safe;
		}
	};
	return {
		style: apply,
		bold: (text) => chalk.bold(text),
		link(text, url) {
			if (!hyperlinks || !url || sanitizeTerminalText(url) !== url) return text;
			return `]8;;${url}${text}]8;;`;
		},
		width: (text) => stringWidth(sanitizeTerminalText(text))
	};
}
function clampLevel(level) {
	if (level <= 0) return 0;
	if (level >= 3) return 3;
	return level === 1 ? 1 : 2;
}
function detectCapabilities(stream) {
	const tty = stream.isTTY === true;
	const support = stream === stderr ? supportsColorStderr : supportsColor;
	const level = support ? support.level : 0;
	return {
		level,
		tty,
		hyperlinks: tty && level > 0
	};
}
function formatDuration(ms) {
	return ms < 1e3 ? `${Math.round(ms)} ms` : `${(ms / 1e3).toFixed(1)} s`;
}
function realize(palette, text, cell) {
	const colored = palette.style(text, cell.style);
	const styled = cell.bold ? palette.bold(colored) : colored;
	const prefix = cell.prefix ? palette.style(cell.prefix.text, cell.prefix.style) : "";
	const suffix = cell.suffix ? palette.style(cell.suffix.text, cell.suffix.style) : "";
	return palette.link(`${prefix}${styled}${suffix}`, cell.link);
}
function renderInline(palette, cells) {
	return cells.map((cell) => realize(palette, cell.text, cell)).join("");
}
/**
* Truncate free text to {@link max} visible columns with a trailing ellipsis, never splitting a
* grapheme. Text already within budget is returned unchanged.
*/
function truncateText(palette, text, max) {
	if (palette.width(text) <= max) return text;
	const available = Math.max(0, max - palette.width(ELLIPSIS));
	let width = 0;
	let truncated = "";
	for (const { segment } of GRAPHEMES.segment(text)) {
		const segmentWidth = palette.width(segment);
		if (width + segmentWidth > available) break;
		truncated += segment;
		width += segmentWidth;
	}
	return `${truncated}${ELLIPSIS}`;
}
function pad(text, width, textWidth, align, last) {
	const fill = " ".repeat(Math.max(0, width - textWidth));
	if (align === "right") return fill + text;
	return last ? text : text + fill;
}
//#endregion
//#region src/reference-flow.ts
const SUMMARY_MIN = 10;
const FLOW_SEP = " ";
const CORE_GAP = "  ";
const CORE_GAP_W = 2;
const CONTINUATION_INDENT = "  ";
function emphasisStyle(emphasis) {
	switch (emphasis) {
		case "lead": return "accent";
		case "candidate": return "gray";
		case "credit": return "grayMedium";
		case "demoted": return "grayDark";
		case "related": return "faint";
	}
}
function omissionMarker(count) {
	return `and ${count} more`;
}
function realizeReference(palette, item) {
	return realize(palette, item.text, {
		text: item.text,
		style: emphasisStyle(item.emphasis),
		link: item.link
	});
}
/**
* Fit a trailing flow of atomic references into the remaining budget after a starting prefix. Each
* reference is shown in full or not at all, in order. Space for `and N more` is reserved whenever
* references remain, even if that displaces one complete reference; when the marker itself cannot fit
* after what is already placed, it is omitted rather than truncated. Returns the realized suffix.
*/
function fitReferenceFlow(palette, items, budget, used, firstSep = FLOW_SEP) {
	let consumed = used;
	let suffix = "";
	let placed = 0;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const sep = placed === 0 ? firstSep : FLOW_SEP;
		const cost = palette.width(sep) + palette.width(item.text);
		const remainingAfter = items.length - (index + 1);
		const marker = remainingAfter > 0 ? palette.width(FLOW_SEP) + palette.width(omissionMarker(remainingAfter)) : 0;
		if (consumed + cost + marker > budget) break;
		suffix += `${sep}${realizeReference(palette, item)}`;
		consumed += cost;
		placed += 1;
	}
	const omitted = items.length - placed;
	if (omitted > 0) {
		const sep = placed === 0 ? firstSep : FLOW_SEP;
		const markerCost = palette.width(sep) + palette.width(omissionMarker(omitted));
		if (consumed + markerCost <= budget) suffix += `${sep}${palette.style(omissionMarker(omitted), "faint")}`;
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
function layoutCommitRow(palette, row, budget, authorWidth) {
	const sha = realize(palette, row.sha.text, row.sha);
	const shaW = palette.width(row.sha.text);
	const summaryW = palette.width(row.summary);
	const coreFixed = shaW + CORE_GAP_W + authorWidth + CORE_GAP_W;
	const core = (summary) => {
		const author = pad(row.author, authorWidth, palette.width(row.author), "left", false);
		return `${sha}${CORE_GAP}${realize(palette, author, {
			text: author,
			style: "mauve"
		})}${CORE_GAP}${realize(palette, summary, {
			text: summary,
			style: "faint"
		})}`;
	};
	if (!row.lead) {
		const room = Math.max(SUMMARY_MIN, budget - coreFixed);
		const summary = truncateText(palette, row.summary, Math.min(summaryW, room));
		const flow = fitReferenceFlow(palette, row.references, budget, coreFixed + palette.width(summary), CORE_GAP);
		return [`${core(summary)}${flow}`];
	}
	const leadW = palette.width(row.lead.text);
	const leadCost = CORE_GAP_W + leadW;
	const lead = realizeReference(palette, row.lead);
	const roomWithLead = budget - coreFixed - leadCost;
	if (roomWithLead >= Math.min(summaryW, SUMMARY_MIN)) {
		const summary = truncateText(palette, row.summary, Math.max(SUMMARY_MIN, Math.min(summaryW, roomWithLead)));
		const used = coreFixed + palette.width(summary) + leadCost;
		const flow = fitReferenceFlow(palette, row.references, budget, used);
		return [`${core(summary)}${CORE_GAP}${lead}${flow}`];
	}
	const room = Math.max(SUMMARY_MIN, budget - coreFixed);
	const summary = truncateText(palette, row.summary, Math.min(summaryW, room));
	const continuationUsed = palette.width(CONTINUATION_INDENT) + leadW;
	const flow = fitReferenceFlow(palette, row.references, budget, continuationUsed);
	return [core(summary), `${CONTINUATION_INDENT}${lead}${flow}`];
}
function layoutCommitRows(palette, rows, budget) {
	if (rows.length === 0) return [];
	const authorWidth = Math.max(0, ...rows.map((row) => palette.width(row.author)));
	return rows.flatMap((row) => layoutCommitRow(palette, row, budget, authorWidth));
}
/**
* Wrap a flat, comma-separated flow of atomic items to the budget across continuation lines. Every
* item is shown in full; an item wider than the budget overflows intact on its own line. With an
* unbounded budget the whole flow is one line.
*/
function layoutFlow(palette, items, budget) {
	if (items.length === 0) return [];
	const sepW = palette.width(", ");
	const lines = [];
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
	if (current.length > 0) lines.push(current);
	return lines;
}
//#endregion
//#region src/block.ts
function layoutRows(palette, rows, budget) {
	if (rows.length === 0) return [];
	const columns = Math.max(...rows.map((row) => row.cells.length));
	const widths = [];
	for (let column = 0; column < columns; column++) widths[column] = Math.max(0, ...rows.map((row) => row.cells[column] ? palette.width(row.cells[column].text) : 0));
	return rows.map((row) => {
		const gap = row.gap ?? 2;
		const before = row.cells.slice(0, -1).reduce((sum, _, column) => sum + widths[column] + gap, 0);
		return row.cells.map((cell, column) => {
			const last = column === row.cells.length - 1;
			const text = last && budget !== Infinity ? truncateText(palette, cell.text, Math.max(0, budget - before)) : cell.text;
			return realize(palette, pad(text, widths[column], palette.width(text), cell.align ?? "left", last), cell);
		}).join(" ".repeat(gap));
	});
}
function blockLines(palette, glyph, content) {
	const timing = content.duration ? [{
		text: ` (⚡️ ${content.duration})`,
		style: "faint"
	}] : [];
	const lines = [renderInline(palette, [
		glyph,
		{ text: " " },
		...content.title,
		...timing
	])];
	const children = [];
	for (const entry of content.debugLines ?? []) children.push(palette.style(entry, "faint"));
	for (const note of content.notes ?? []) children.push(renderInline(palette, note));
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
		lines.push(index === 0 ? `  ${palette.style("└ ", "faint")}${child}` : `    ${child}`);
	});
	return {
		lines,
		commitLineFrom
	};
}
function headerBoxLines(palette, fields, color) {
	const labels = [
		["repository:", fields.repositoryLine],
		["range:", fields.range],
		["output:", fields.output]
	];
	const raw = (cells) => cells.map((cell) => sanitizeTerminalText(cell.text)).join("");
	const repoName = sanitizeTerminalText(fields.repository.repo);
	const version = sanitizeTerminalText(fields.version);
	const commitSha = sanitizeTerminalText(fields.build.sha);
	if (!color) return [`>_ ${repoName} › changelog (v${version}/${commitSha})`, ...labels.map(([label, value]) => `${label} ${raw(value)}`)];
	const labelWidth = Math.max(...labels.map(([label]) => label.length));
	const titleCells = [
		{
			text: ">_ ",
			style: "faint"
		},
		{
			text: repoName,
			style: "bold",
			link: fields.repository.url
		},
		{
			text: " › ",
			style: "mauve",
			bold: true
		},
		{
			text: "changelog",
			style: "bold"
		},
		{
			text: ` (v${version}/`,
			style: "faint"
		},
		{
			text: commitSha,
			style: "faint",
			link: fields.build.url
		},
		{
			text: ")",
			style: "faint"
		}
	];
	const titleRaw = `>_ ${repoName} › changelog (v${version}/${commitSha})`;
	const rows = [{
		rendered: renderInline(palette, titleCells),
		width: palette.width(titleRaw)
	}, {
		rendered: "",
		width: 0
	}];
	for (const [label, valueCells] of labels) {
		const gap = " ".repeat(labelWidth - label.length);
		const rendered = `${palette.style(label, "faint")}${gap}  ${renderInline(palette, valueCells)}`;
		rows.push({
			rendered,
			width: labelWidth + 2 + palette.width(raw(valueCells))
		});
	}
	const width = Math.max(...rows.map((row) => row.width));
	const bar = "─".repeat(width + 2);
	const framed = rows.map((row) => `${palette.style("│", "faint")} ${row.rendered}${" ".repeat(width - row.width)} ${palette.style("│", "faint")}`);
	return [
		palette.style(`╭${bar}╮`, "faint"),
		...framed,
		palette.style(`╰${bar}╯`, "faint")
	];
}
//#endregion
//#region src/live-reporter.ts
const FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
function liveReporter(stream, palette, now, durations) {
	let cursorHidden = false;
	let disposeActive;
	const columns = () => stream.columns && stream.columns > 0 ? stream.columns : 80;
	return {
		start(label) {
			disposeActive?.();
			const start = now();
			const debug = [];
			let frame = 0;
			let drawn = 0;
			let closed = false;
			let timer;
			const cleanup = () => {
				if (closed) return;
				closed = true;
				if (timer !== void 0) clearInterval(timer);
				process.off("SIGINT", onSigint);
				process.off("SIGTERM", onSigterm);
				if (cursorHidden) {
					stream.write(`[?25h`);
					cursorHidden = false;
				}
				if (disposeActive === cleanup) disposeActive = void 0;
			};
			const terminate = (signal) => {
				cleanup();
				process.kill(process.pid, signal);
			};
			const onSigint = () => terminate("SIGINT");
			const onSigterm = () => terminate("SIGTERM");
			disposeActive = cleanup;
			process.once("SIGINT", onSigint);
			process.once("SIGTERM", onSigterm);
			const budget = () => columns() - 5;
			const render = (layout) => {
				const out = layout.lines.map((line, index) => index < layout.commitLineFrom ? clip(line, columns() - 1) : line);
				const prefix = drawn > 0 ? `[${drawn}A[0J` : "";
				stream.write(`${prefix}${out.join("\n")}\n`);
				drawn = out.length;
			};
			const running = () => blockLines(palette, {
				text: FRAMES[frame % FRAMES.length],
				style: "accent"
			}, {
				title: [{ text: label }],
				debugLines: debug
			});
			if (!cursorHidden) {
				stream.write(`[?25l`);
				cursorHidden = true;
			}
			render(running());
			timer = setInterval(() => {
				frame += 1;
				render(running());
			}, 80);
			if (typeof timer.unref === "function") timer.unref();
			const finish = (layout) => {
				if (closed) return;
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
				succeed(summary) {
					const elapsed = now() - start;
					const duration = durations && Math.round(elapsed) >= 2 ? formatDuration(elapsed) : void 0;
					finish(blockLines(palette, SUCCESS, {
						...summary,
						debugLines: debug,
						budget: budget(),
						duration
					}));
				},
				fail(title) {
					finish(blockLines(palette, {
						text: "✖",
						style: "red"
					}, {
						title: [{
							text: title,
							style: "red"
						}],
						debugLines: debug
					}));
				},
				discard() {
					if (closed) return;
					if (drawn > 0) stream.write(`[${drawn}A[0J`);
					drawn = 0;
					cleanup();
				}
			};
		},
		dispose() {
			disposeActive?.();
		}
	};
}
/**
* Clip a styled line to a visible column budget without splitting escape sequences, closing any
* open hyperlink and resetting color at the cut so the live region stays aligned.
*/
function clip(line, columns) {
	let visible = 0;
	let index = 0;
	let out = "";
	while (index < line.length) {
		if (line[index] === "\x1B") {
			const escape = consumeEscape(line, index);
			out += line.slice(index, escape);
			index = escape;
			continue;
		}
		const escape = line.indexOf("\x1B", index);
		const end = escape === -1 ? line.length : escape;
		for (const { segment } of GRAPHEMES.segment(line.slice(index, end))) {
			const width = stringWidth(segment);
			if (visible + width > columns) return `${out}]8;;${String.fromCharCode(7)}[0m`;
			out += segment;
			visible += width;
		}
		index = end;
	}
	return out;
}
function consumeEscape(line, start) {
	if (line[start + 1] === "]") {
		const bel = line.indexOf(String.fromCharCode(7), start);
		return bel === -1 ? line.length : bel + 1;
	}
	let index = start + 2;
	while (index < line.length && line[index] !== "m") index += 1;
	return index + 1;
}
//#endregion
//#region src/render.ts
function createRenderer(stream, options = {}) {
	const caps = options.capabilities ?? detectCapabilities(stream);
	const palette = createPalette(caps.level, caps.hyperlinks);
	const now = options.now ?? Date.now;
	const durations = options.durations ?? caps.tty;
	const reporter = caps.tty ? liveReporter(stream, palette, now, durations) : staticReporter(stream, palette);
	return {
		start: reporter.start,
		dispose: reporter.dispose,
		headerBox(fields) {
			for (const heading of headerBoxLines(palette, fields, caps.level > 0)) stream.write(`${heading}\n`);
		},
		line(cells) {
			stream.write(`${renderInline(palette, cells)}\n`);
		},
		success(cells) {
			stream.write(`${renderInline(palette, [
				SUCCESS,
				{ text: " " },
				...cells
			])}\n`);
		},
		blank() {
			stream.write("\n");
		}
	};
}
/**
* A trace-line writer for debug-only output and queries: it renders each line as a faint child
* line on {@link stream}, with no hyperlinks. The renderer owns the styling so callers stay free of
* terminal mechanics.
*/
function createTraceWriter(stream) {
	const palette = createPalette(detectCapabilities(stream).level, false);
	return (line) => stream.write(`${palette.style(line, "faint")}\n`);
}
function staticReporter(stream, palette) {
	return {
		start() {
			const debug = [];
			const commit = (layout) => stream.write(`${layout.lines.join("\n")}\n\n`);
			return {
				debug(line) {
					debug.push(line);
				},
				succeed(summary) {
					commit(blockLines(palette, SUCCESS, {
						...summary,
						debugLines: debug
					}));
				},
				fail(title) {
					commit(blockLines(palette, {
						text: "✖",
						style: "red"
					}, {
						title: [{
							text: title,
							style: "red"
						}],
						debugLines: debug
					}));
				},
				discard() {}
			};
		},
		dispose() {}
	};
}
//#endregion
//#region src/view.ts
function plural(count, singular, plural = `${singular}s`) {
	return count === 1 ? singular : plural;
}
function countCell(value, style) {
	return {
		text: String(value),
		style
	};
}
function titleLine(verb, count, noun, plurals) {
	return [
		{ text: `${verb} ` },
		countCell(count, "accent"),
		{ text: ` ${plural(count, noun, plurals)}` }
	];
}
function factLine(count, label, style = "accent") {
	return [countCell(count, style), {
		text: label,
		style: "faint"
	}];
}
/**
* The Scanned block's collapsed fact lines (shown without commit rows): unique Ticket Targets across
* every occurrence, unique PullRequest-qualified targets, then ticketless commits last. There is no
* raw occurrence count. Zero categories are omitted. Ticketless commits use the warning accent, the
* same highlighting rule the Documented entries ledger applies to its not-found counts.
*/
function scannedFacts(summary) {
	const notes = [];
	if (summary.uniqueTargets > 0) notes.push(factLine(summary.uniqueTargets, ` unique ${plural(summary.uniqueTargets, "ticket reference")}`));
	if (summary.pullRequestTargets > 0) notes.push(factLine(summary.pullRequestTargets, ` pull request ${plural(summary.pullRequestTargets, "reference")}`));
	if (summary.missing > 0) notes.push(factLine(summary.missing, ` without ${plural(summary.missing, "ticket reference")} (re-run with --show-missing)`, "warning"));
	return notes;
}
function targetDisplay(target, repo) {
	return {
		text: targetKey(target),
		link: ticketUrl(repo, target)
	};
}
function referenceItem(target, emphasis, repo) {
	return {
		...targetDisplay(target, repo),
		emphasis
	};
}
function commitRows(commits, repo) {
	return commits.map((commit) => {
		const seen = new TicketTargetSet();
		if (commit.lead) seen.add(commit.lead);
		const references = [];
		const addRole = (targets, emphasis) => {
			for (const target of targets) {
				if (seen.has(target)) continue;
				seen.add(target);
				references.push(referenceItem(target, emphasis, repo));
			}
		};
		addRole(commit.candidates, "candidate");
		addRole(commit.credits, "credit");
		addRole(commit.demoted, "demoted");
		addRole(commit.related, "related");
		return {
			sha: {
				text: commit.sha.slice(0, 7),
				style: commit.missing ? "warning" : "accent",
				link: commitUrl(repo, commit.sha)
			},
			author: commit.author,
			summary: commit.summary,
			lead: commit.lead ? referenceItem(commit.lead, "lead", repo) : void 0,
			references
		};
	});
}
function lookupNotes(cached, fetched) {
	const notes = [];
	if (cached > 0) notes.push(factLine(cached, " cached"));
	if (fetched > 0) notes.push(factLine(fetched, " fetched"));
	return notes;
}
/**
* A flat, comma-separated flow of every looked-up target for the verbose lookup-outcome listing.
* Each reference is a complete, clickable atomic item, accent when resolved and warning when not
* found; the renderer wraps the flow to the terminal width without truncating any reference.
*/
function lookedUpReferences(outcomes, repo) {
	return outcomes.map(({ target, found }) => ({
		...targetDisplay(target, repo),
		style: found ? "accent" : "warning"
	}));
}
function notFoundRows(references, repo) {
	return references.map((failure) => ({ cells: [
		{
			text: failure.commit.sha.slice(0, 7),
			style: "accent",
			link: commitUrl(repo, failure.commit.sha)
		},
		{
			...targetDisplay(failure.target, repo),
			style: "warning"
		},
		{
			text: failure.commit.summary,
			style: "faint"
		}
	] }));
}
/**
* The stats ledger: labels form the stable left edge and non-zero counts align on the right.
* Candidate not-found and credit-only not-found counts stay distinct, both using the warning accent
* with everything else in accent. Ticketless commits are reported once in the Scanned block, not here.
*/
function ledgerRows(facts) {
	return [
		[
			facts.commits,
			plural(facts.commits, "commit"),
			"accent"
		],
		...[...facts.sectionCounts].map(([bucket, value]) => [
			value,
			bucket,
			"accent"
		]),
		[
			facts.uniqueTargets,
			plural(facts.uniqueTargets, "ticket reference"),
			"accent"
		],
		[
			facts.candidateNotFound,
			"tickets not found",
			"warning"
		],
		[
			facts.creditNotFound,
			"credit-only tickets not found",
			"warning"
		],
		[
			facts.contributorCount,
			plural(facts.contributorCount, "contributor"),
			"accent"
		]
	].filter(([value]) => value > 0).map(([value, label, style]) => ({ cells: [{
		text: label,
		style: "faint"
	}, {
		text: String(value),
		style,
		align: "right",
		bold: true
	}] }));
}
function finalLine(output, outputUrl) {
	return [{ text: "Created " }, {
		text: output,
		link: outputUrl
	}];
}
/**
* Build a Run Progress sink that renders the full run view, linking commits and tickets against
* {@code repo} (resolved before the view is built). It translates ordered semantic events into
* renderer block lifecycle calls and accumulates run facts so the Generating block can render the
* stats ledger. It opens at Scanning; the repo-free Preparing stage is rendered by
* {@link createPreparingView} before this view is built. The CLI decides whether to use it at all.
*/
function createRunView(renderer, repo, options) {
	let block;
	let scanned;
	let resolved;
	return { emit(event) {
		switch (event.type) {
			case "stage-start":
				block = renderer.start(event.stage);
				return;
			case "stage-debug":
				if (options.debug) block?.debug(event.line);
				return;
			case "stage-failed":
				block?.fail(`${event.stage} failed`);
				block = void 0;
				return;
			case "scanning-complete":
				scanned = {
					commits: event.commits,
					aggregate: event.aggregate,
					...scannedSummary(event.aggregate)
				};
				block?.succeed(scannedSummaryView(scanned, repo, options));
				block = void 0;
				return;
			case "looking-up-complete":
				resolved = event.resolved;
				block?.succeed(lookedUpView(resolved, repo, options));
				block = void 0;
				return;
			case "generating-complete":
				block?.succeed(generatedView(event.summary, scanned, resolved));
				block = void 0;
				return;
		}
	} };
}
/**
* Build a Run Progress sink for debug-only mode: emit only stage-bound debug lines to {@code write},
* with no headers, progress blocks, durations, or completion output. It consumes the same event
* model as the full view.
*/
function createDebugView(write) {
	return { emit(event) {
		if (event.type === "stage-debug") write(event.line);
	} };
}
/**
* Build a Run Progress sink for the Preparing stage, which runs before the repository is resolved and
* so cannot use the repo-linked {@link createRunView}. It shows the stage spinner and, in debug mode,
* the stage's trace and a "Prepared context" line; outside debug mode the completed stage is
* discarded silently so the visible view opens at the header box.
*/
function createPreparingView(renderer, debug) {
	let block;
	return { emit(event) {
		switch (event.type) {
			case "stage-start":
				block = renderer.start(event.stage);
				return;
			case "stage-debug":
				if (debug) block?.debug(event.line);
				return;
			case "stage-failed":
				block?.fail(`${event.stage} failed`);
				block = void 0;
				return;
			case "preparing-complete":
				if (debug) block?.succeed({ title: [{ text: "Prepared context" }] });
				else block?.discard();
				block = void 0;
				return;
		}
	} };
}
function commitTargets(commit) {
	return [
		...commit.candidates,
		...commit.credits,
		...commit.demoted,
		...commit.related
	];
}
function isMissing(commit) {
	return commitTargets(commit).length === 0;
}
function scannedSummary(aggregate) {
	const unique = new TicketTargetSet();
	const pullRequest = new TicketTargetSet();
	let missing = 0;
	for (const commit of aggregate.commits) {
		if (isMissing(commit)) missing += 1;
		for (const candidate of commitTargets(commit)) unique.add(candidate);
		for (const credit of commit.credits) pullRequest.add(credit);
	}
	return {
		missing,
		uniqueTargets: unique.size,
		pullRequestTargets: pullRequest.size
	};
}
function scannedRows(aggregate) {
	return [...aggregate.commits].reverse().map((commit) => ({
		sha: commit.commit.sha,
		author: commit.commit.author,
		summary: commit.commit.summary,
		lead: commit.lead,
		candidates: commit.candidates.slice(1),
		credits: commit.credits,
		demoted: commit.demoted,
		related: commit.related,
		missing: isMissing(commit)
	}));
}
function scannedSummaryView(scanned, repo, options) {
	const title = titleLine("Scanned", scanned.commits, "commit");
	const rows = scannedRows(scanned.aggregate);
	if (options.commitDetail === "all") return {
		title,
		commitRows: commitRows(rows, repo)
	};
	if (options.commitDetail === "missing") return {
		title,
		commitRows: commitRows(rows.filter((row) => row.missing), repo)
	};
	return {
		title,
		notes: scannedFacts(scanned)
	};
}
function lookedUpView(resolved, repo, options) {
	const notFound = [...resolved.candidateNotFound, ...resolved.creditNotFound];
	return {
		title: titleLine("Looked up", resolved.lookedUp.length, "ticket"),
		notes: lookupNotes(resolved.cached, resolved.fetched),
		rows: notFoundRows(notFound, repo),
		flow: options.showLookupOutcomes ? lookedUpReferences(resolved.lookedUp, repo) : void 0,
		excluded: excludedSection(resolved.excluded, repo, options.showLookupOutcomes)
	};
}
/**
* The "N excluded" section for the Looked up block: a warning-accent count of the references held
* back by followReferences, plus the excluded references themselves (accent, like the looked-up ones)
* when the verbose outcome listing is requested. Absent when nothing was excluded.
*/
function excludedSection(excluded, repo, showLookupOutcomes) {
	if (excluded.length === 0) return;
	return {
		label: factLine(excluded.length, " excluded", "warning"),
		flow: showLookupOutcomes ? excludedReferences(excluded, repo) : void 0
	};
}
/**
* A flat flow of the followReferences-excluded targets, rendered accent and linked like the looked-up
* references: being excluded is a configuration choice, not a lookup failure.
*/
function excludedReferences(excluded, repo) {
	return excluded.map((target) => ({
		...targetDisplay(target, repo),
		style: "accent"
	}));
}
function generatedView(summary, scanned, resolved) {
	const facts = {
		commits: scanned?.commits ?? 0,
		uniqueTargets: scanned?.uniqueTargets ?? 0,
		candidateNotFound: resolved?.candidateNotFound.length ?? 0,
		creditNotFound: resolved?.creditNotFound.length ?? 0,
		...summary
	};
	return {
		title: titleLine("Documented", summary.documentedEntries, "entry", "entries"),
		rows: ledgerRows(facts)
	};
}
//#endregion
//#region src/cli.ts
const pkg = createRequire(import.meta.url)("../package.json");
function toInvocation(target, to, opts, invocationDirectory) {
	const { C: directory, ...invocation } = opts;
	const cwd = directory ?? invocationDirectory;
	const range = parseRange(target, to);
	if (invocation.resolvePrevious && range.mode !== "auto") throw new InvalidArgumentError("--resolve-previous expects a single <version>, not a <from> <to> or <from>..<to> range");
	return {
		range,
		cwd,
		...invocation
	};
}
function buildProgram(action, options) {
	const invocationDirectory = options?.baseCwd ?? process.cwd();
	let directorySpecified = false;
	const parseDirectory = (directory) => {
		if (directorySpecified) throw new InvalidArgumentError("-C may only be specified once");
		directorySpecified = true;
		const target = resolve(invocationDirectory, directory);
		try {
			if (!statSync(target).isDirectory()) throw new InvalidArgumentError(`cannot change to "${directory}": not a directory`);
		} catch (error) {
			if (error instanceof InvalidArgumentError) throw error;
			if (hasCode(error, "ENOENT")) throw new InvalidArgumentError(`cannot change to "${directory}": directory does not exist`);
			throw new InvalidArgumentError(`cannot change to "${directory}": ${error instanceof Error ? error.message : String(error)}`);
		}
		return target;
	};
	const program = new Command();
	program.name("changelog").description("Generate GitHub release notes for a commit range.").version(`${pkg.version} (${commitSha})`).argument("<target>", "release version to generate notes for, or the <from> of an explicit range").argument("[to]", "explicit upper bound; supplying it treats <target> as the <from> lower bound").option("-C <directory>", "run as if started in the given directory", parseDirectory).option("-O, --output <file>", "output file, or - for stdout", "release-notes.md").option("--all", "collect unclassified issues under an Other Changes section", false).option("--refresh", "force re-fetch and overwrite cached tickets", false).option("--show-missing", "list only commits without ticket reference", false).option("--show-commits", "list every scanned commit", false).option("--show-all", "list every commit and every looked-up ticket outcome", false).option("--repo <owner/repo>", "override the auto-detected repository").option("--resolve-previous", "print the resolved previous version tag and exit", false).addOption(new Option("--debug", "trace the git and GitHub calls being made").default(false).conflicts("quiet")).option("-q, --quiet", "suppress all output except errors", false).action(async (target, to, opts) => {
		await action(toInvocation(target, to, opts, invocationDirectory));
	});
	return program;
}
/**
* Normalize the overlapping commit-display flags into one of `none`, `missing`, or `all` before the
* run lifecycle, so the run view never sees overlapping booleans. `--show-all` and `--show-commits`
* both select `all`; `--show-missing` selects `missing`; otherwise `none`.
*/
function commitDetailOf(invocation) {
	if (invocation.showAll || invocation.showCommits) return "all";
	if (invocation.showMissing) return "missing";
	return "none";
}
/**
* Resolve the run's presentation in one place so {@link execute} consumes ready sinks instead of
* deciding them inline. The rules: {@code -O -} and {@code -q} keep the run view off stdout (no
* renderer); without a renderer, {@code --debug} still traces to stderr, otherwise the run is silent;
* the changelog goes to stdout for {@code -O -} and to the resolved file otherwise.
*/
function resolvePresentation(invocation, runtime) {
	const { out, err } = runtime;
	const toStdout = invocation.output === "-";
	const renderer = invocation.quiet || toStdout ? void 0 : createRenderer(out);
	const viewOptions = {
		commitDetail: commitDetailOf(invocation),
		showLookupOutcomes: invocation.showAll,
		debug: invocation.debug
	};
	const fallback = !renderer && invocation.debug ? createDebugView(createTraceWriter(err)) : noRunProgress;
	const preparing = renderer ? createPreparingView(renderer, invocation.debug) : fallback;
	const runProgress = (repo) => renderer ? createRunView(renderer, repo, viewOptions) : fallback;
	const absoluteOutput = toStdout ? void 0 : isAbsolute(invocation.output) ? invocation.output : resolve(invocation.cwd, invocation.output);
	return {
		renderer,
		preparing,
		outputUrl: absoluteOutput ? pathToFileURL(absoluteOutput).href : "",
		runProgress,
		async write(markdown) {
			if (absoluteOutput === void 0) out.write(markdown);
			else await writeFileAtomically(absoluteOutput, markdown);
		}
	};
}
async function execute(invocation, runtime) {
	const { out, err } = runtime;
	const cwd = invocation.cwd;
	if (invocation.resolvePrevious && invocation.range.mode === "auto") {
		const trace = invocation.debug ? createTraceWriter(err) : void 0;
		const { from } = await resolveAutoRange(invocation.range.target, gitRepoRefs(cwd, trace));
		out.write(`${from.ref}\n`);
		return;
	}
	const { renderer, preparing, outputUrl, runProgress, write } = resolvePresentation(invocation, runtime);
	try {
		const { run, header } = await runStage(preparing, "Preparing", async (debug) => {
			const trace = invocation.debug ? debug : void 0;
			const run = await prepareRun({
				range: invocation.range,
				cwd,
				repoOverride: invocation.repo,
				refresh: invocation.refresh,
				githubAdapter: runtime.githubAdapter,
				trace,
				diagnostic: debug
			});
			return {
				run,
				header: renderer ? await resolveHeaderFields(run, {
					version: pkg.version,
					build: {
						sha: commitSha,
						url: buildCommitUrl(pkg.repository?.url, commitSha)
					},
					output: invocation.output,
					outputUrl,
					cwd,
					trace
				}) : void 0
			};
		}, () => ({
			type: "preparing-complete",
			stage: "Preparing"
		}));
		const { repo, range, config, lookup } = run;
		const progress = runProgress(repo);
		if (renderer && header) {
			renderer.headerBox(header);
			renderer.blank();
		}
		await write(await runPipeline({
			from: range.from.ref,
			to: range.to.ref,
			cwd,
			repository: repo,
			config,
			all: invocation.all,
			lookup,
			scan: runtime.scan,
			progress
		}));
		renderer?.success(finalLine(invocation.output, outputUrl));
	} finally {
		renderer?.dispose();
	}
}
function isCommanderError(error) {
	return hasStringProp(error, "code") && error.code.startsWith("commander.");
}
/**
* A grep-style synopsis shown when changelog is run with no arguments. Full option help stays
* available via --help.
*/
function usageText() {
	return [
		"usage: changelog [-C dir] [-O file] [--all] [--refresh]",
		"                 [--show-missing] [--show-commits] [--show-all]",
		"                 [--repo owner/repo] [--resolve-previous] [--debug] [-q]",
		"                 <version> | <from> <to> | <from>..<to>"
	].join("\n");
}
/**
* Execute a complete invocation and return the process exit code. Returns 0 on success, 1 on
* runtime failure, and 2 on usage or argument error. Does not mutate process.exitCode.
*/
async function main(args = argv, runtime) {
	const out = runtime?.stdout ?? stdout;
	const err = runtime?.stderr ?? stderr;
	const baseCwd = runtime?.cwd ?? process.cwd();
	if (args.length <= 2) {
		err.write(`${usageText()}\n`);
		return 2;
	}
	let debugMode = false;
	const internalRuntime = {
		out,
		err,
		githubAdapter: runtime?.githubAdapter ?? defaultGitHubAdapter,
		scan: runtime?.scan
	};
	const program = buildProgram(async (invocation) => {
		debugMode = invocation.debug;
		await execute(invocation, internalRuntime);
	}, { baseCwd });
	program.exitOverride();
	program.configureOutput({
		writeOut: (text) => out.write(text),
		writeErr: (text) => err.write(text)
	});
	try {
		await program.parseAsync(args);
		return 0;
	} catch (error) {
		if (isCommanderError(error)) {
			const code = error.code ?? "";
			if ((error.exitCode ?? 2) === 0) return 0;
			if (code === "commander.invalidArgument") err.write(`error: ${error.message}\n`);
			return 2;
		}
		const message = debugMode && error instanceof Error ? error.stack ?? error.message : error instanceof Error ? error.message : String(error);
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
function isMainModule(moduleUrl, entry) {
	if (entry === void 0) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
	} catch {
		return false;
	}
}
if (isMainModule(import.meta.url, argv[1])) main().then((code) => {
	process.exitCode = code;
}).catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
//#endregion
export { isMainModule, main };
