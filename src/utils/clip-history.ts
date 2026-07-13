import type { ClipAction, HistoryEntry } from '../types/types';
import { migrateClipAction } from './clip-stats';

const MIN_HISTORY_TIME = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_URL_LENGTH = 2048;
const MAX_HISTORY_TITLE_LENGTH = 512;
const MAX_HISTORY_ENTRIES = 1000;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

interface SanitizedHistoryEntry {
	readonly entry: HistoryEntry;
	readonly changed: boolean;
}

export interface SanitizedClipHistory {
	readonly history: HistoryEntry[];
	readonly changed: boolean;
}

function sanitizeDatetime(value: unknown, now: number): string | null {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| value.length > 64
		|| !ISO_DATETIME_PATTERN.test(value)
	) return null;
	const timestamp = Date.parse(value);
	if (
		!Number.isFinite(timestamp)
		|| timestamp < MIN_HISTORY_TIME
		|| timestamp > now + MAX_FUTURE_SKEW_MS
	) return null;
	return new Date(timestamp).toISOString();
}

function sanitizeHistoryUrl(value: unknown): string | null {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| value.length > MAX_HISTORY_URL_LENGTH
		|| value.trim() !== value
	) return null;

	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

		parsed.username = '';
		parsed.password = '';
		parsed.hash = '';
		// Privacy-first policy: history keeps the navigable origin/path but never a query.
		parsed.search = '';

		const sanitized = parsed.toString();
		return sanitized.length <= MAX_HISTORY_URL_LENGTH ? sanitized : null;
	} catch {
		return null;
	}
}

function isCanonicalEntry(
	value: object,
	prototype: object | null,
	descriptors: PropertyDescriptorMap,
	entry: HistoryEntry,
): boolean {
	if (prototype !== Object.prototype) return false;
	let keys: PropertyKey[];
	try {
		keys = Reflect.ownKeys(value);
	} catch {
		return false;
	}
	const expectedKeys = entry.title === undefined
		? ['datetime', 'url', 'action']
		: ['datetime', 'url', 'action', 'title'];
	if (
		keys.length !== expectedKeys.length
		|| keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
	) return false;

	return expectedKeys.every((key) => {
		const descriptor = descriptors[key];
		return Boolean(
			descriptor
			&& descriptor.enumerable
			&& 'value' in descriptor
			&& descriptor.value === entry[key as keyof HistoryEntry],
		);
	});
}

function sanitizeClipHistoryEntry(
	value: unknown,
	now: number,
): SanitizedHistoryEntry | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const datetimeDescriptor = descriptors.datetime;
		const urlDescriptor = descriptors.url;
		const actionDescriptor = descriptors.action;
		const titleDescriptor = descriptors.title;
		if (
			!datetimeDescriptor
			|| !urlDescriptor
			|| !actionDescriptor
			|| !('value' in datetimeDescriptor)
			|| !('value' in urlDescriptor)
			|| !('value' in actionDescriptor)
			|| (titleDescriptor && !('value' in titleDescriptor))
		) return null;

		const datetime = sanitizeDatetime(datetimeDescriptor.value, now);
		const url = sanitizeHistoryUrl(urlDescriptor.value);
		const action = migrateClipAction(actionDescriptor.value);
		const title = titleDescriptor?.value;
		if (
			!datetime
			|| !url
			|| !action
			|| (title !== undefined && (
				typeof title !== 'string'
				|| title.length > MAX_HISTORY_TITLE_LENGTH
			))
		) return null;

		const entry: HistoryEntry = { datetime, url, action };
		if (typeof title === 'string') entry.title = title;
		return {
			entry,
			changed: !isCanonicalEntry(value, prototype, descriptors, entry),
		};
	} catch {
		return null;
	}
}

export function createClipHistoryEntry(
	action: ClipAction,
	url: string,
	title?: string,
	now = Date.now(),
): HistoryEntry | null {
	return sanitizeClipHistoryEntry({
		datetime: new Date(now).toISOString(),
		url,
		action,
		...(title === undefined ? {} : { title }),
	}, now)?.entry ?? null;
}

export function sanitizeClipHistory(
	value: unknown,
	now = Date.now(),
): SanitizedClipHistory {
	if (!Array.isArray(value)) {
		return { history: [], changed: value !== undefined };
	}

	const history: HistoryEntry[] = [];
	let changed = false;
	try {
		if (Object.getPrototypeOf(value) !== Array.prototype) changed = true;
		for (let index = 0; index < value.length; index += 1) {
			const sanitized = sanitizeClipHistoryEntry(value[index], now);
			if (!sanitized) {
				changed = true;
				continue;
			}
			history.push(sanitized.entry);
			if (sanitized.changed) changed = true;
			if (history.length === MAX_HISTORY_ENTRIES) {
				if (index < value.length - 1) changed = true;
				break;
			}
		}
	} catch {
		return { history: [], changed: true };
	}

	if (history.length !== value.length) changed = true;
	return { history, changed };
}
