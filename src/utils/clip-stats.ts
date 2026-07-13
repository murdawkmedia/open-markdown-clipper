import type { ClipAction, ClipStats } from '../types/types';

export const CLIP_ACTIONS = [
	'clipboard',
	'download',
	'custom-uri',
	'local-http',
	'share',
] as const satisfies readonly ClipAction[];

const MAX_COUNT = Number.MAX_SAFE_INTEGER;

function sourceRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export function sanitizeClipCount(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.floor(value), MAX_COUNT);
}

export function saturatingClipCount(...values: unknown[]): number {
	let total = 0;
	for (const value of values) {
		const count = sanitizeClipCount(value);
		if (total >= MAX_COUNT - count) return MAX_COUNT;
		total += count;
	}
	return total;
}

export function emptyClipStats(): ClipStats {
	return {
		clipboard: 0,
		download: 0,
		'custom-uri': 0,
		'local-http': 0,
		share: 0,
	};
}

export function sanitizeClipStats(value: unknown): ClipStats {
	const input = sourceRecord(value);
	return {
		clipboard: saturatingClipCount(input.clipboard, input.copyToClipboard),
		download: saturatingClipCount(input.download, input.saveFile, input.addToObsidian),
		'custom-uri': sanitizeClipCount(input['custom-uri']),
		'local-http': sanitizeClipCount(input['local-http']),
		share: sanitizeClipCount(input.share),
	};
}

export function isCanonicalClipStats(value: unknown, expected: ClipStats): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	return keys.length === CLIP_ACTIONS.length
		&& CLIP_ACTIONS.every((action) => input[action] === expected[action]);
}

export function migrateClipAction(value: unknown): ClipAction | null {
	if (typeof value !== 'string') return null;
	if ((CLIP_ACTIONS as readonly string[]).includes(value)) return value as ClipAction;
	if (value === 'copyToClipboard') return 'clipboard';
	if (value === 'saveFile' || value === 'addToObsidian') return 'download';
	return null;
}
