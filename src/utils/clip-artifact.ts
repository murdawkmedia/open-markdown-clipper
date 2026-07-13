import { ClipDocument, DestinationError } from '../destinations/types';

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 512;
export const MAX_SOURCE_URL_LENGTH = 8192;

interface BuildClipDocumentInput {
	readonly title: string;
	readonly markdown: string;
	readonly sourceUrl: string;
	readonly now: () => Date;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function validateTitle(title: string): void {
	if (
		title.trim().length === 0
		|| title.length > MAX_TITLE_LENGTH
		|| CONTROL_CHARACTERS.test(title)
	) {
		throw new DestinationError('invalid-title');
	}
}

function validateMarkdown(markdown: string): void {
	if (markdown.trim().length === 0) {
		throw new DestinationError('invalid-markdown');
	}

	if (new TextEncoder().encode(markdown).byteLength > MAX_MARKDOWN_BYTES) {
		throw new DestinationError('markdown-too-large');
	}
}

function validateSourceUrl(sourceUrl: string): void {
	try {
		if (
			sourceUrl.length === 0
			|| sourceUrl.length > MAX_SOURCE_URL_LENGTH
			|| sourceUrl.trim() !== sourceUrl
			|| CONTROL_CHARACTERS.test(sourceUrl)
		) {
			throw new DestinationError('invalid-source-url');
		}

		const parsed = new URL(sourceUrl);
		if (
			(parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
			|| parsed.username.length > 0
			|| parsed.password.length > 0
		) {
			throw new DestinationError('invalid-source-url');
		}
	} catch {
		throw new DestinationError('invalid-source-url');
	}
}

function getCapturedAt(now: () => Date): string {
	try {
		const capturedAt = now();
		if (!(capturedAt instanceof Date) || !Number.isFinite(capturedAt.getTime())) {
			throw new DestinationError('invalid-captured-at');
		}
		return capturedAt.toISOString();
	} catch {
		throw new DestinationError('invalid-captured-at');
	}
}

export function buildClipDocument(input: BuildClipDocumentInput): ClipDocument {
	const { title, markdown, sourceUrl, now } = input;
	validateTitle(title);
	validateMarkdown(markdown);
	validateSourceUrl(sourceUrl);

	return Object.freeze({
		title,
		markdown,
		sourceUrl,
		capturedAt: getCapturedAt(now),
	});
}
