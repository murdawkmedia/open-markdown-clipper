import { describe, expect, it } from 'vitest';
import { DestinationError } from '../destinations/types';
import {
	buildClipDocument,
	MAX_MARKDOWN_BYTES,
	MAX_SOURCE_URL_LENGTH,
} from './clip-artifact';

const NOW = new Date('2026-07-12T18:00:00.000Z');

function build(overrides: Partial<Parameters<typeof buildClipDocument>[0]> = {}) {
	return buildClipDocument({
		title: 'Page',
		markdown: '# Page',
		sourceUrl: 'https://example.com/article',
		now: () => NOW,
		...overrides,
	});
}

function expectCode(run: () => unknown, code: string, secret?: string) {
	try {
		run();
		throw new Error('expected buildClipDocument to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).code).toBe(code);
		expect((error as Error).message).toBe(code);
		if (secret) {
			expect((error as Error).message).not.toContain(secret);
		}
	}
}

describe('buildClipDocument', () => {
	it('returns the exact frozen capture document', () => {
		const document = build();

		expect(document).toEqual({
			title: 'Page',
			markdown: '# Page',
			sourceUrl: 'https://example.com/article',
			capturedAt: '2026-07-12T18:00:00.000Z',
		});
		expect(Object.isFrozen(document)).toBe(true);
	});

	it.each(['', ' ', '\t'])('rejects empty Markdown %#', (markdown) => {
		expectCode(() => build({ markdown }), 'invalid-markdown');
	});

	it('accepts Markdown at the UTF-8 byte ceiling', () => {
		const markdown = 'é'.repeat(MAX_MARKDOWN_BYTES / 2);
		expect(build({ markdown }).markdown).toBe(markdown);
	});

	it('rejects Markdown above the UTF-8 byte ceiling without echoing it', () => {
		const markdown = `private-${'é'.repeat(MAX_MARKDOWN_BYTES / 2)}`;
		expectCode(() => build({ markdown }), 'markdown-too-large', 'private-');
	});

	it.each(['', '   '])('rejects empty titles %#', (title) => {
		expectCode(() => build({ title }), 'invalid-title');
	});

	it('rejects titles longer than 512 characters', () => {
		expectCode(() => build({ title: 'x'.repeat(513) }), 'invalid-title');
	});

	it.each(['private\u0000title', 'private\ntitle', 'private\u007ftitle', 'private\u0085title'])(
		'rejects title control characters without echoing the title %#',
		(title) => {
			expectCode(() => build({ title }), 'invalid-title', 'private');
		},
	);

	it.each([
		'ftp://example.com/file',
		'file:///tmp/page.md',
		'javascript:alert(1)',
		'/relative',
		'not a URL',
		' https://example.com/article',
		'https://example.com/article\n',
		'https://example.com/article\u0085private',
		'https://user:secret@example.com/article',
	])('rejects unsafe source URLs without echoing them: %s', (sourceUrl) => {
		expectCode(() => build({ sourceUrl }), 'invalid-source-url', sourceUrl);
	});

	it('rejects source URLs over the bounded length', () => {
		const sourceUrl = `https://example.com/${'x'.repeat(MAX_SOURCE_URL_LENGTH)}`;
		expectCode(() => build({ sourceUrl }), 'invalid-source-url', sourceUrl);
	});

	it.each([
		() => new Date('invalid'),
		() => new Date(Number.POSITIVE_INFINITY),
	])('rejects invalid capture timestamps', (now) => {
		expectCode(() => build({ now }), 'invalid-captured-at');
	});

	it('snapshots accessor-backed input fields exactly once', () => {
		const reads = { title: 0, markdown: 0, sourceUrl: 0, now: 0 };
		const input = {
			get title() {
				reads.title += 1;
				return reads.title === 1 ? 'Page' : 'private\ntitle';
			},
			get markdown() {
				reads.markdown += 1;
				return reads.markdown === 1 ? '# Page' : '';
			},
			get sourceUrl() {
				reads.sourceUrl += 1;
				return reads.sourceUrl === 1 ? 'https://example.com/article' : 'file:///private';
			},
			get now() {
				reads.now += 1;
				return () => NOW;
			},
		};

		expect(buildClipDocument(input)).toEqual({
			title: 'Page',
			markdown: '# Page',
			sourceUrl: 'https://example.com/article',
			capturedAt: '2026-07-12T18:00:00.000Z',
		});
		expect(reads).toEqual({ title: 1, markdown: 1, sourceUrl: 1, now: 1 });
	});
});
