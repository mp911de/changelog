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

export function hasCode(error: unknown, code: string | number): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(
			error as {
				code?: unknown;
			}
		).code === code
	);
}

export function hasStatus(error: unknown, status: number): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(
			error as {
				status?: unknown;
			}
		).status === status
	);
}
