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

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Use the real Git process so scanner tests cover the production subprocess boundary.
 */
export class FixtureRepo {
	readonly dir: string;
	private fileCounter = 0;

	private constructor(dir: string) {
		this.dir = dir;
	}

	static create(): FixtureRepo {
		const dir = mkdtempSync(join(tmpdir(), "changelog-fixture-"));
		const repo = new FixtureRepo(dir);
		repo.git("init", "-q", "-b", "main");
		repo.git("config", "user.email", "test@example.com");
		repo.git("config", "user.name", "Test User");
		repo.git("config", "commit.gpgsign", "false");
		return repo;
	}

	commit(message: string): string {
		this.fileCounter += 1;
		writeFileSync(
			join(this.dir, `file-${this.fileCounter}.txt`),
			`${this.fileCounter}\n`,
		);
		this.git("add", "-A");
		this.git("commit", "-q", "-m", message);
		return this.git("rev-parse", "HEAD");
	}

	git(...args: string[]): string {
		return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" }).trim();
	}

	cleanup(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}
