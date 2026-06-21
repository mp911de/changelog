# Changelog Tool

This is the home of Changelog Tool, a standalone command-line application for generating GitHub release notes from a commit range.
It scans non-merge commits, resolves referenced GitHub issues and pull requests, and groups the resulting changes into configurable sections.

Changelog Tool requires Node.js 24 or later, Git, and [`gh`](https://cli.github.com/).

For a detailed description of how commit messages are matched to issues and pull requests, how those references are grouped into sections, and how contributors are credited, see the [Reference Documentation](REFERENCE.adoc).

## Code of Conduct

This project is governed by the [Contributor Covenant](https://www.contributor-covenant.org/).
By participating, you are expected to uphold this code of conduct.

## `npx` Quickstart

```shell
npx mp911de/changelog <version>
```

## Alternative: Installation

```shell
npm install --global @mp911de/changelog
```

## Usage

Run Changelog Tool in the Git repository for which release notes should be generated:

```shell
changelog [options] <version>
changelog [options] <from> <to>
changelog [options] <from>..<to>
```

With a single release version, Changelog Tool resolves the previous release tag and the appropriate upper bound automatically.
Supported versions include SemVer and common Spring-style forms such as `4.0`, `v4.0.0`, `4.0.0.RELEASE`, and `4.0.0.Final`.

An explicit range may instead be given as two arguments or in Git's two-dot notation.
The `from` revision is excluded and the `to` revision is included.
For example, `changelog 4.0.0..4.0.4` is equivalent to `changelog 4.0.0 4.0.4`.
Release notes are written to `release-notes.md` by default.
GitHub authentication is obtained from the `GH_TOKEN` environment variable or an authenticated GitHub CLI installation.

## Security

Do not report security vulnerabilities through a public issue.
Use the private reporting process in [SECURITY.md](SECURITY.md).

Running `changelog` with no arguments prints a short usage synopsis:

```
Usage: changelog [options] <target> [to]

Generate GitHub release notes for a commit range.

Arguments:
  target               release version to generate notes for, or the <from> of an explicit
                       range
  to                   explicit upper bound; supplying it treats <target> as the <from>
                       lower bound

Options:
  -V, --version        output the version number
  -C <directory>       run as if started in the given directory
  -O, --output <file>  output file, or - for stdout (default: "release-notes.md")
  --all                collect unclassified issues under an Other Changes section (default:
                       false)
  --refresh            force re-fetch and overwrite cached tickets (default: false)
  --show-missing       list only commits without ticket reference (default: false)
  --show-commits       list every scanned commit (default: false)
  --show-all           list every commit and every looked-up ticket outcome (default:
                       false)
  --repo <owner/repo>  override the auto-detected repository
  --resolve-previous   print the resolved previous version tag and exit (default: false)
  --debug              trace the git and GitHub calls being made (default: false)
  -q, --quiet          suppress all output except errors (default: false)
  -h, --help           display help for command
```

`-O -` implies `--quiet`, so standard output carries only the changelog; with `--debug` the trace is written to standard error. `--quiet` and `--debug` cannot be combined.

## Build from Source

See [Contributing](CONTRIBUTING.adoc) for build instructions and contribution guidelines.

## Continuous Integration Builds

CI builds run in [GitHub Actions](https://github.com/mp911de/changelog/actions).

## License

Changelog Tool is released under version 2.0 of the [Apache License](https://www.apache.org/licenses/LICENSE-2.0).
