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

import { execSync } from "node:child_process";

import { defineConfig } from "tsdown";

// Capture the commit this build is produced from and inline it into src/build-info.ts. Falls back
// to "unknown" when git is unavailable (a tarball checkout, or git missing from PATH) so the build
// never fails on provenance capture.
function commitSha(): string {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

// The `#!/usr/bin/env node` shebang on the src/cli.ts entry is detected by tsdown, which preserves
// it in the bundle and marks the output executable.
export default defineConfig({
	entry: ["src/cli.ts"],
	format: ["esm"],
	platform: "node",
	target: "node24",
	clean: true,
	// Emit dist/cli.js (not the tsdown default .mjs) to match the package's bin entry.
	outExtensions: () => ({ js: ".js" }),
	define: { __COMMIT_SHA__: JSON.stringify(commitSha()) },
});
