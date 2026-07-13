import { describe, expect, it, vi } from 'vitest';
import {
	createCustomUriDestination,
	validateFinalCustomUri,
} from './custom-uri';
import { ClipDocument, DestinationError } from './types';

const DOCUMENT: ClipDocument = Object.freeze({
	title: 'Private page',
	markdown: '# private markdown',
	sourceUrl: 'https://example.com/private?x=1&y=2',
	capturedAt: '2026-07-12T18:00:00.000Z',
});

async function expectCode(run: () => Promise<unknown>, code: string) {
	try {
		await run();
		throw new Error('expected destination to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).code).toBe(code);
		expect((error as Error).message).toBe(code);
		expect((error as Error).message).not.toContain(DOCUMENT.markdown);
		expect((error as Error).message).not.toContain(DOCUMENT.sourceUrl);
	}
}

function setup(template = 'notes-app://capture?title={title}&source={sourceUrl}') {
	const effects: string[] = [];
	const copy = vi.fn(async () => {
		effects.push('copy');
		return true;
	});
	const openUri = vi.fn(async (_uri: string) => {
		effects.push('open');
	});
	const destination = createCustomUriDestination({ template, copy, openUri });
	return { copy, destination, effects, openUri };
}

describe('final custom URI validation', () => {
	it('returns a bounded custom-scheme URI unchanged', () => {
		const uri = `notes:${'x'.repeat(2042)}`;
		expect(validateFinalCustomUri(uri)).toBe(uri);
	});

	it.each([
		'',
		'capture?title=Private%20page',
		'1notes://capture',
		'http://127.0.0.1/capture',
		'https://example.com/capture',
		'javascript:alert(1)',
		'data:text/plain,private',
		'file:///tmp/private',
		'about:blank',
		'blob:https://example.com/id',
		'browser://settings',
		'browser-extension://extension/page',
		'brave://settings',
		'chrome://settings',
		'chrome-distiller://private',
		'chrome-error://private',
		'chrome-extension://extension/page',
		'chrome-search://local-ntp/local-ntp.html',
		'chrome-untrusted://new-tab-page',
		'devtools://devtools/bundled/inspector.html',
		'edge://settings',
		'filesystem:https://example.com/temporary/id',
		'ftp://example.com/private',
		'gopher://example.com/private',
		'git://example.com/private',
		'imap://example.com/private',
		'irc://example.com/private',
		'ircs://example.com/private',
		'jar:https://example.com/archive.jar!/page.html',
		'ldap://example.com/private',
		'ldaps://example.com/private',
		'nfs://example.com/private',
		'nntp://example.com/private',
		'moz-extension://extension/page',
		'ms-browser-extension://extension/page',
		'opera://settings',
		'opera-extension://extension/page',
		'resource://private',
		'rtmp://example.com/private',
		'rtsp://example.com/private',
		'rtsps://example.com/private',
		'rsync://example.com/private',
		'safari-extension://extension/page',
		'safari-web-extension://extension/page',
		'sftp://example.com/private',
		'smb://example.com/private',
		'ssh://example.com/private',
		'telnet://example.com/private',
		'view-source:https://example.com/private',
		'vivaldi://settings',
		'ws://127.0.0.1/private',
		'wss://example.com/private',
		'notes:clip?title={title}',
		'notes:clip?title=title}',
		'notes:clip?title={title',
		'notes:private value',
		'notes:private\tvalue',
		'notes:private\nvalue',
		'notes:private\u0000value',
		'notes:private\u001fvalue',
		'notes:private\u007fvalue',
		'notes:private\u0085value',
		42,
		null,
	])('rejects a non-final or unsafe URI without echoing it: %s', (uri) => {
		try {
			validateFinalCustomUri(uri as string);
			throw new Error('expected final URI validation to reject');
		} catch (error) {
			expect(error).toBeInstanceOf(DestinationError);
			expect((error as DestinationError).code).toBe('invalid-custom-uri');
			expect((error as Error).message).toBe('invalid-custom-uri');
			if (String(uri).length > 0) {
				expect((error as Error).message).not.toContain(String(uri));
			}
		}
	});

	it.each([
		'notes-app://capture?title=Page',
		'knowledge-base://new?name=Page',
		'vscode://file/example.md',
	])('allows a non-network application scheme: %s', (uri) => {
		expect(validateFinalCustomUri(uri)).toBe(uri);
	});

	it('rejects a final URI over 2,048 characters with a bounded error', () => {
		expect(() => validateFinalCustomUri(`notes:${'x'.repeat(2043)}`))
			.toThrow(new DestinationError('custom-uri-too-long'));
	});
});

describe('custom URI destination', () => {
	it('copies Markdown before opening an encoded metadata-only URI', async () => {
		const { copy, destination, effects, openUri } = setup();

		await expect(destination.send(DOCUMENT)).resolves.toEqual({
			destination: 'custom-uri',
		});
		expect(copy).toHaveBeenCalledWith(DOCUMENT.markdown);
		expect(openUri).toHaveBeenCalledWith(
			'notes-app://capture?title=Private%20page&source=https%3A%2F%2Fexample.com%2Fprivate%3Fx%3D1%26y%3D2',
		);
		expect(effects).toEqual(['copy', 'open']);
		expect(openUri.mock.calls[0][0]).not.toContain(DOCUMENT.markdown);
	});

	it.each([
		'http://127.0.0.1/capture?title={title}',
		'https://example.com/capture?title={title}',
		'javascript:alert(1)',
		'data:text/plain,{title}',
		'file:///tmp/{title}',
		'about:blank',
		'blob:https://example.com/id',
		'filesystem:https://example.com/temporary/id',
		'chrome://settings',
		'chrome-extension://extension/page',
		'chrome-search://local-ntp/local-ntp.html',
		'chrome-untrusted://new-tab-page',
		'moz-extension://extension/page',
		'edge://settings',
		'brave://settings',
		'opera://settings',
		'vivaldi://settings',
		'ms-browser-extension://extension/page',
		'safari-web-extension://extension/page',
		'view-source:https://example.com',
		'jar:https://example.com/archive.jar!/page.html',
		'capture?title={title}',
		'1notes://capture?title={title}',
		'://capture?title={title}',
	])('rejects unsafe or missing custom schemes: %s', async (template) => {
		const { destination, copy, openUri } = setup(template);
		await expectCode(() => destination.send(DOCUMENT), 'invalid-custom-uri');
		expect(copy).not.toHaveBeenCalled();
		expect(openUri).not.toHaveBeenCalled();
	});

	it.each([
		'notes-app://capture?markdown={markdown}',
		'notes-app://capture?content={content}',
		'notes-app://capture?secret={unknown}',
		'notes-app://capture?title={title',
		'notes-app://capture?title=title}',
	])('rejects content and unknown placeholders: %s', async (template) => {
		const { destination, copy, openUri } = setup(template);
		await expectCode(() => destination.send(DOCUMENT), 'invalid-custom-uri');
		expect(copy).not.toHaveBeenCalled();
		expect(openUri).not.toHaveBeenCalled();
	});

	it.each([
		'notes-app://capture?title=private\u0000value',
		'notes-app://capture?title=private\u001bvalue',
		'notes-app://capture?title={title}\n',
		'notes-app://capture?title=private value',
		'notes-app://capture?title=private\u0085value',
	])('rejects raw whitespace and controls: %s', async (template) => {
		await expectCode(() => setup(template).destination.send(DOCUMENT), 'invalid-custom-uri');
	});

	it('accepts an output exactly 2,048 characters long', async () => {
		const template = `notes:${'x'.repeat(2042)}`;
		const { destination, openUri } = setup(template);
		await expect(destination.send(DOCUMENT)).resolves.toEqual({ destination: 'custom-uri' });
		expect(openUri).toHaveBeenCalledWith(template);
	});

	it('rejects an output over 2,048 characters before copying', async () => {
		const { destination, copy, openUri } = setup(`notes:${'x'.repeat(2043)}`);
		await expectCode(() => destination.send(DOCUMENT), 'custom-uri-too-long');
		expect(copy).not.toHaveBeenCalled();
		expect(openUri).not.toHaveBeenCalled();
	});

	it('rejects metadata that cannot be URI-encoded before copying', async () => {
		const { destination, copy, openUri } = setup();
		await expectCode(
			() => destination.send({ ...DOCUMENT, title: '\ud800' }),
			'invalid-custom-uri',
		);
		expect(copy).not.toHaveBeenCalled();
		expect(openUri).not.toHaveBeenCalled();
	});

	it('does not open the URI when copying fails', async () => {
		const openUri = vi.fn();
		const destination = createCustomUriDestination({
			template: 'notes:clip',
			copy: vi.fn(async () => false),
			openUri,
		});
		await expectCode(() => destination.send(DOCUMENT), 'custom-uri-copy-failed');
		expect(openUri).not.toHaveBeenCalled();
	});

	it('maps clipboard and URI effect rejections to bounded errors', async () => {
		const copyFailure = createCustomUriDestination({
			template: 'notes:clip',
			copy: vi.fn(async () => { throw new Error(DOCUMENT.markdown); }),
			openUri: vi.fn(),
		});
		await expectCode(() => copyFailure.send(DOCUMENT), 'custom-uri-copy-failed');

		const openFailure = createCustomUriDestination({
			template: 'notes:clip',
			copy: vi.fn(async () => true),
			openUri: vi.fn(async () => { throw new Error(DOCUMENT.sourceUrl); }),
		});
		await expectCode(() => openFailure.send(DOCUMENT), 'custom-uri-open-failed');
	});

	it('does not invoke effects when the caller has already aborted', async () => {
		const { destination, copy, openUri } = setup();
		const controller = new AbortController();
		controller.abort();
		await expectCode(() => destination.send(DOCUMENT, controller.signal), 'delivery-aborted');
		expect(copy).not.toHaveBeenCalled();
		expect(openUri).not.toHaveBeenCalled();
	});
});
