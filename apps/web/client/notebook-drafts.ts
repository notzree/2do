import { z } from "zod";
import { writePage, type WritePage } from "@2do/api/notebook";

const prefix = "2do.notebook-draft.v1:";
const maxEntries = 24;
// Enough for both a 1 MiB in-flight PUT and a newer document being typed.
const maxEntryBytes = 2 * 1024 * 1024 + 2048;
const record = z.object({
	updatedAt: z.number(),
	current: writePage,
	sent: z.union([z.literal(true), writePage]).optional(),
	conflict: z.boolean(),
});
export type StoredDraft = z.infer<typeof record>;

async function claim(locks: LockManager, name: string): Promise<(() => void) | undefined> {
	const claimed = Promise.withResolvers<(() => void) | undefined>();
	void locks.request(name, { ifAvailable: true }, (lock) => {
		if (!lock) { claimed.resolve(undefined); return; }
		const held = Promise.withResolvers<void>();
		claimed.resolve(held.resolve);
		return held.promise;
	}).catch(claimed.reject);
	return claimed.promise;
}

export class NotebookDraft {
	constructor(
		private readonly storage: Storage,
		private readonly key: string,
		readonly release: () => void,
		readonly recovered?: StoredDraft,
	) {}

	save(current: WritePage, attempted: WritePage | undefined, conflict: boolean) {
		const value = JSON.stringify({
			updatedAt: Date.now(), current, conflict,
			sent: attempted?.doc === current.doc ? true : attempted,
		} satisfies StoredDraft);
		if (value.length > maxEntryBytes || (value.length > maxEntryBytes / 4 &&
			new TextEncoder().encode(value).length > maxEntryBytes))
			throw new Error("This notebook draft is too large for browser backup.");
		if (this.storage.getItem(this.key) === null && draftKeys(this.storage, prefix).length >= maxEntries)
			throw new Error("Browser backup is full.");
		this.storage.setItem(this.key, value);
	}
	clear() { this.storage.removeItem(this.key); }
}

function draftKeys(storage: Storage, startsWith: string) {
	const keys: string[] = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (key?.startsWith(startsWith)) keys.push(key);
	}
	return keys;
}

export async function openNotebookDraft(scope: string, date: string, storage = localStorage, locks = navigator.locks) {
	const dayPrefix = prefix + encodeURIComponent(scope) + ":" + date + ":";
	// The lock lives with the browser document and releases even when its process dies.
	// Two live tabs must retain independent recoverable copies at the same base revision.
	for (const key of draftKeys(storage, dayPrefix)) {
		const release = await claim(locks, key);
		if (!release) continue;
		let recovered: StoredDraft | undefined;
		try {
			const value = storage.getItem(key);
			if (value && value.length <= maxEntryBytes) recovered = record.parse(JSON.parse(value));
		} finally {
			if (!recovered) release();
		}
		if (recovered) return new NotebookDraft(storage, key, release, recovered);
	}
	const key = dayPrefix + crypto.randomUUID();
	const release = await claim(locks, key);
	if (!release) throw new Error("Browser draft backup unavailable.");
	return new NotebookDraft(storage, key, release);
}
