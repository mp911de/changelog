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

import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replace a file atomically without following an existing destination symlink. The temporary file
 * is created exclusively in the destination directory so another process cannot substitute it.
 */
export async function writeFileAtomically(path: string, content: string): Promise<void> {
	const temp = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(temp, "wx");
		await file.writeFile(content, "utf8");
		await file.close();
		file = undefined;
		await rename(temp, path);
	} catch (error) {
		await file?.close().catch(() => {});
		await unlink(temp).catch(() => {});
		throw error;
	}
}
