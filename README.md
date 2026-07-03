# Changelog Tool

A standalone command-line application for generating GitHub release notes from a commit range giving you that polished open-source maintainer feel.
It scans non-merge commits and resolves GitHub references to issues and pull requests to create a curated changelog. We have you covered with zero-conf, issue caching and configurable sections (in case you like configuration).

These are both generated using the changelog tool:

- [Changelog Tool 0.1.2](https://github.com/mp911de/changelog/releases/tag/0.1.2)
- [R2DBC MSSQL 1.0.5.RELEASE](https://github.com/r2dbc/r2dbc-mssql/releases/tag/v1.0.5.RELEASE),

Changelog Tool requires Node.js 24 or later, Git, and [`gh`](https://cli.github.com/).

If you have spare time or looking for a detailed description of how commit messages are matched to issues and pull requests, how those references are grouped into sections, and how contributors are credited, see the [Reference Documentation](REFERENCE.adoc).

## `npx` Quickstart

```shell
npx mp911de/changelog <version>
```

Changelog Tool resolves issue titles and labels through the GitHub API: authenticate the [GitHub CLI](https://cli.github.com/) or set `GH_TOKEN`.

## Installation

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
Tag spellings do not need to match the input: `4.0.0` finds a `v4.0.0.RELEASE` tag.
Supported versions include SemVer and common Spring-style forms such as `4.0`, `v4.0.0`, `4.0.0.RELEASE`, `4.0.0.Final`, `4.0.0.RC1`, and `4.0.0.SR1`.

| Command                  | Scans                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `changelog 4.0.4`        | the previous release up to the `4.0.4` tag, or up to the `4.0.x` branch tip before tagging |
| `changelog 4.0.x`        | the latest release on the line up to the branch tip                                        |
| `changelog 4.0.0..4.0.4` | exactly the given bounds; same as `changelog 4.0.0 4.0.4`                                  |

In an explicit range, each bound may be a tag, a branch, a commit, or a version; the `from` revision is excluded and the `to` revision is included.
Release notes are written to `release-notes.md` by default.
How ranges are resolved in detail is described in the [Reference Documentation](REFERENCE.adoc).

Running `changelog` with no arguments prints a short usage synopsis:

```
Usage: changelog [options] <target> [to]

Generate GitHub release notes for a commit range.

Arguments:
  target               release version, tag, or maintenance branch (X.Y.x) to
                       generate notes for, or the <from> of an explicit range
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

## Code of Conduct

This project is governed by the [Contributor Covenant](https://www.contributor-covenant.org/).
By participating, you are expected to uphold this code of conduct.

## Security

Do not report security vulnerabilities through a public issue.
Use the private reporting process in [SECURITY.md](SECURITY.md).

## Continuous Integration Builds

CI builds run in [GitHub Actions](https://github.com/mp911de/changelog/actions).

## License

Changelog Tool is released under version 2.0 of the [Apache License](https://www.apache.org/licenses/LICENSE-2.0).
