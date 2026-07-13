import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DestinationError, DestinationKind } from '../destinations/types';
import {
	createDocumentClipboardEffect,
	createDocumentDestinationRuntime,
	dispatchDocumentDestinationMessage,
} from './document-destination-runtime';

const TITLE = 'Exact private title 72af';
const MARKDOWN = '# Exact private Markdown\n';
const SOURCE_URL = 'https://example.com/private?token=72af';
const TOKEN = 'test-local-token-72af';
const CAPTURED_AT = new Date('2026-07-13T08:00:00.000Z');
const PRIVATE_ERROR = 'private runtime error 72af';

type ConsoleSpy = ReturnType<typeof vi.spyOn>;
let consoleSpies: ConsoleSpy[] = [];

function fakeDocument() {
	const textArea = {
		value: '',
		style: {} as CSSStyleDeclaration,
		setAttribute: vi.fn(),
		select: vi.fn(),
		remove: vi.fn(),
	};
	const body = { appendChild: vi.fn() };
	const document = {
		URL: SOURCE_URL,
		title: 'Fallback title',
		body,
		createElement: vi.fn(() => textArea),
		execCommand: vi.fn(() => true),
	} as unknown as Document;

	return { body, document, textArea };
}

function response(status = 204): Response {
	return {
		body: null,
		ok: status >= 200 && status < 300,
		redirected: false,
		status,
		type: 'basic',
	} as Response;
}

function setup(defaultDestination: DestinationKind = 'local-http') {
	const events: string[] = [];
	const { document } = fakeDocument();
	const prepare = vi.fn(async () => { events.push('prepare'); });
	const loadSettings = vi.fn(async () => {
		events.push('settings');
		return {
			defaultDestination,
			customUriTemplate: 'notes:clip?title={title}&source={sourceUrl}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		};
	});
	const parseForClip = vi.fn(() => {
		events.push('parse');
		return { content: '<main>exact</main>', title: TITLE };
	});
	const createMarkdownContent = vi.fn((content: string, sourceUrl: string) => {
		events.push('markdown');
		expect(content).toBe('<main>exact</main>');
		expect(sourceUrl).toBe(SOURCE_URL);
		return MARKDOWN;
	});
	const getLocalHttpToken = vi.fn(async () => {
		events.push('token');
		return TOKEN;
	});
	const writeClipboard = vi.fn(async () => { events.push('clipboard'); });
	const save = vi.fn(async () => { events.push('save'); });
	const sendRuntimeMessage = vi.fn(async (message: unknown): Promise<unknown> => {
		if (
			typeof message === 'object'
			&& message !== null
			&& (message as { action?: unknown }).action === 'checkDataTransmissionConsent'
		) {
			events.push('consent');
			return { granted: true };
		}
		events.push('open');
		return { success: true };
	});
	const fetchImpl = vi.fn(async () => {
		events.push('fetch');
		return response();
	}) as unknown as typeof fetch;
	const incrementStat = vi.fn(async () => { events.push('record'); });
	const now = vi.fn(() => {
		events.push('now');
		return CAPTURED_AT;
	});

	const runtime = createDocumentDestinationRuntime({
		document,
		prepare,
		loadSettings,
		parseForClip,
		createMarkdownContent,
		getLocalHttpToken,
		writeClipboard,
		save,
		sendRuntimeMessage,
		fetchImpl,
		incrementStat,
		now,
	});

	return {
		createMarkdownContent,
		document,
		events,
		fetchImpl,
		getLocalHttpToken,
		incrementStat,
		loadSettings,
		parseForClip,
		prepare,
		runtime,
		save,
		sendRuntimeMessage,
		writeClipboard,
	};
}

beforeEach(() => {
	consoleSpies = (['debug', 'error', 'info', 'log', 'warn'] as const)
		.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
});

afterEach(() => {
	try {
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

describe('document destination runtime', () => {
	it('prepares then captures one exact snapshot and records its metadata only after Local HTTP succeeds', async () => {
		const context = setup();

		await expect(context.runtime.deliver()).resolves.toEqual({
			destination: 'local-http',
			receipt: 'HTTP 204',
		});

		expect(context.loadSettings).toHaveBeenCalledOnce();
		expect(context.prepare).toHaveBeenCalledOnce();
		expect(context.parseForClip).toHaveBeenCalledOnce();
		expect(context.parseForClip).toHaveBeenCalledWith(context.document);
		expect(context.createMarkdownContent).toHaveBeenCalledOnce();
		expect(context.getLocalHttpToken).toHaveBeenCalledOnce();
		const [endpoint, request] = vi.mocked(context.fetchImpl).mock.calls[0] as [string, RequestInit];
		expect(endpoint).toBe('http://127.0.0.1:8765/captures');
		expect(JSON.parse(request.body as string)).toEqual({
			title: TITLE,
			markdown: MARKDOWN,
			sourceUrl: SOURCE_URL,
			capturedAt: CAPTURED_AT.toISOString(),
		});
		expect(context.incrementStat).toHaveBeenCalledWith('local-http', SOURCE_URL, TITLE);
		expect(context.events).toEqual([
			'settings', 'consent', 'prepare', 'parse', 'markdown',
			'consent', 'token', 'consent', 'now', 'fetch', 'record',
		]);
		expect(context.sendRuntimeMessage).toHaveBeenCalledWith({
			action: 'checkDataTransmissionConsent',
			destination: 'local-http',
		});
	});

	it('preserves a content-free unknown outcome after Local HTTP dispatch', async () => {
		const context = setup();
		vi.mocked(context.fetchImpl).mockRejectedValue(
			new Error(`${PRIVATE_ERROR}: ${MARKDOWN}`),
		);

		const delivery = context.runtime.deliver();

		await expect(delivery).rejects.toMatchObject({
			name: 'DestinationError',
			code: 'local-http-outcome-unknown',
			message: 'local-http-outcome-unknown',
		});
		await delivery.catch((error: unknown) => {
			expect(String(error)).not.toContain(PRIVATE_ERROR);
			expect(JSON.stringify(error)).not.toContain(PRIVATE_ERROR);
			expect((error as Error).stack).not.toContain(PRIVATE_ERROR);
		});
		expect(context.incrementStat).not.toHaveBeenCalled();
	});

	it('captures synchronously before deferred settings can observe a changed document', async () => {
		const { document } = fakeDocument();
		let content = '<main>old exact content</main>';
		let resolveSettings!: (settings: {
			defaultDestination: DestinationKind;
			customUriTemplate: string;
			localHttpEndpoint: string;
		}) => void;
		const loadSettings = vi.fn(() => new Promise<{
			defaultDestination: DestinationKind;
			customUriTemplate: string;
			localHttpEndpoint: string;
		}>(resolve => { resolveSettings = resolve; }));
		const parseForClip = vi.fn((capturedDocument: Document) => ({
			content,
			title: capturedDocument.title,
		}));
		const createMarkdownContent = vi.fn((html: string, sourceUrl: string) => (
			`${sourceUrl}\n${html}`
		));
		const writeClipboard = vi.fn(async () => undefined);
		const incrementStat = vi.fn(async () => undefined);
		const runtime = createDocumentDestinationRuntime({
			document,
			loadSettings,
			parseForClip,
			createMarkdownContent,
			writeClipboard,
			incrementStat,
		});

		const delivery = runtime.deliver('clipboard');
		expect(parseForClip).toHaveBeenCalledOnce();
		expect(createMarkdownContent).toHaveBeenCalledWith(
			'<main>old exact content</main>',
			SOURCE_URL,
		);

		(document as unknown as { URL: string }).URL = 'https://example.com/new-private';
		document.title = 'New private title';
		content = '<main>new private content</main>';
		resolveSettings({
			defaultDestination: 'clipboard',
			customUriTemplate: '',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		});

		await expect(delivery).resolves.toEqual({ destination: 'clipboard' });
		expect(writeClipboard).toHaveBeenCalledWith(
			`${SOURCE_URL}\n<main>old exact content</main>`,
		);
		expect(incrementStat).toHaveBeenCalledWith(
			'clipboard',
			SOURCE_URL,
			'Fallback title',
		);
	});

	it('keeps the Local HTTP token lazy for explicit clipboard delivery', async () => {
		const context = setup('local-http');

		await expect(context.runtime.deliver('clipboard')).resolves.toEqual({
			destination: 'clipboard',
		});

		expect(context.writeClipboard).toHaveBeenCalledWith(MARKDOWN);
		expect(context.getLocalHttpToken).not.toHaveBeenCalled();
		expect(context.incrementStat).toHaveBeenCalledWith('clipboard', SOURCE_URL, TITLE);
		expect(context.sendRuntimeMessage).not.toHaveBeenCalled();
	});

	it.each(['custom-uri', 'local-http'] as const)(
		'fails %s closed on denied background consent before document capture or secrets',
		async destination => {
			const context = setup(destination);
			context.sendRuntimeMessage.mockResolvedValue({ granted: false });

			await expect(context.runtime.deliver()).rejects.toMatchObject({
				name: 'DestinationError',
				code: 'destination-delivery-failed',
				message: 'destination-delivery-failed',
			});

			expect(context.sendRuntimeMessage).toHaveBeenCalledOnce();
			expect(context.sendRuntimeMessage).toHaveBeenCalledWith({
				action: 'checkDataTransmissionConsent',
				destination,
			});
			expect(context.prepare).not.toHaveBeenCalled();
			expect(context.parseForClip).not.toHaveBeenCalled();
			expect(context.createMarkdownContent).not.toHaveBeenCalled();
			expect(context.getLocalHttpToken).not.toHaveBeenCalled();
			expect(context.writeClipboard).not.toHaveBeenCalled();
			expect(context.fetchImpl).not.toHaveBeenCalled();
			expect(context.incrementStat).not.toHaveBeenCalled();
		},
	);

	it('fails closed on a malformed background consent response without exposing a snapshot', async () => {
		const context = setup('local-http');
		context.sendRuntimeMessage.mockResolvedValue({
			granted: true,
			privateBody: MARKDOWN,
		});

		await expect(context.runtime.deliver()).rejects.toMatchObject({
			code: 'destination-delivery-failed',
		});
		expect(context.parseForClip).not.toHaveBeenCalled();
		expect(context.getLocalHttpToken).not.toHaveBeenCalled();
		expect(context.fetchImpl).not.toHaveBeenCalled();
	});

	it('awaits file saving and does not record success early', async () => {
		const context = setup('download');
		let finishSaving!: () => void;
		context.save.mockImplementation(async () => new Promise<void>(resolve => {
			finishSaving = resolve;
		}));

		const pending = context.runtime.deliver('download');
		await vi.waitFor(() => expect(context.save).toHaveBeenCalledOnce());
		expect(context.incrementStat).not.toHaveBeenCalled();

		finishSaving();
		await expect(pending).resolves.toEqual({
			destination: 'download',
			receipt: `${TITLE}.md`,
		});
		expect(context.save).toHaveBeenCalledWith({
			content: MARKDOWN,
			fileName: `${TITLE}.md`,
			mimeType: 'text/markdown',
		});
		expect(context.incrementStat).toHaveBeenCalledWith('download', SOURCE_URL, TITLE);
	});

	it('accepts only an exact custom-URI runtime success response', async () => {
		const context = setup('custom-uri');

		await expect(context.runtime.deliver()).resolves.toEqual({ destination: 'custom-uri' });
		expect(context.sendRuntimeMessage).toHaveBeenCalledWith({
			action: 'openCustomUri',
			uri: 'notes:clip?title=Exact%20private%20title%2072af&source=https%3A%2F%2Fexample.com%2Fprivate%3Ftoken%3D72af',
		});
		expect(context.incrementStat).toHaveBeenCalledWith('custom-uri', SOURCE_URL, TITLE);

		context.sendRuntimeMessage.mockImplementation(async (message: unknown) => (
			(message as { action?: unknown })?.action === 'checkDataTransmissionConsent'
				? { granted: true }
				: { success: true, extra: PRIVATE_ERROR }
		));
		await expect(context.runtime.deliver()).rejects.toMatchObject({
			name: 'DestinationError',
			code: 'destination-delivery-failed',
			message: 'destination-delivery-failed',
		});
		expect(context.incrementStat).toHaveBeenCalledTimes(1);
	});
});

describe('document clipboard effect', () => {
	it('awaits navigator clipboard success before returning without a fallback', async () => {
		const { document } = fakeDocument();
		let finish!: () => void;
		const writeText = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
		const copy = createDocumentClipboardEffect(document, writeText);

		const pending = copy(MARKDOWN);
		await Promise.resolve();
		expect(document.createElement).not.toHaveBeenCalled();
		finish();
		await expect(pending).resolves.toBe(true);
	});

	it('fails closed without placing Markdown in the page DOM after clipboard rejection', async () => {
		const { body, document, textArea } = fakeDocument();
		const writeText = vi.fn(async () => { throw new Error(PRIVATE_ERROR); });
		const copy = createDocumentClipboardEffect(document, writeText);

		await expect(copy(MARKDOWN)).resolves.toBe(false);
		expect(textArea.value).toBe('');
		expect(body.appendChild).not.toHaveBeenCalled();
		expect(textArea.select).not.toHaveBeenCalled();
		expect(document.execCommand).not.toHaveBeenCalled();
		expect(textArea.remove).not.toHaveBeenCalled();
	});

	it('never consults the legacy document command after clipboard rejection', async () => {
		const { document, textArea } = fakeDocument();
		vi.mocked(document.execCommand).mockImplementation(() => { throw new Error(PRIVATE_ERROR); });
		const copy = createDocumentClipboardEffect(
			document,
			async () => { throw new Error(PRIVATE_ERROR); },
		);

		await expect(copy(MARKDOWN)).resolves.toBe(false);
		expect(document.execCommand).not.toHaveBeenCalled();
		expect(textArea.remove).not.toHaveBeenCalled();
	});
});

describe('document destination message dispatcher', () => {
	it.each([
		['copyMarkdownToClipboard', 'clipboard'],
		['saveMarkdownToFile', 'download'],
	] as const)('awaits exact %s delivery before one success response', async (action, destination) => {
		let finish!: () => void;
		const deliver = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
		const sendResponse = vi.fn();

		expect(dispatchDocumentDestinationMessage({ action }, deliver, sendResponse)).toBe(true);
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(destination));
		expect(sendResponse).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: true }));
		expect(sendResponse).toHaveBeenCalledTimes(1);
	});

	it('returns one content-free failure after rejected delivery', async () => {
		const deliver = vi.fn(async () => { throw new DestinationError(PRIVATE_ERROR); });
		const sendResponse = vi.fn();

		expect(dispatchDocumentDestinationMessage(
			{ action: 'copyMarkdownToClipboard' }, deliver, sendResponse,
		)).toBe(true);
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
			success: false,
			error: 'destination-delivery-failed',
		}));
		expect(sendResponse).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(PRIVATE_ERROR);
	});

	it('ignores an unrelated plain message', () => {
		const deliver = vi.fn();
		const sendResponse = vi.fn();
		expect(dispatchDocumentDestinationMessage({ action: 'ping' }, deliver, sendResponse)).toBeUndefined();
		expect(deliver).not.toHaveBeenCalled();
		expect(sendResponse).not.toHaveBeenCalled();
	});

	it('rejects targeted extras and proxies without delivering', async () => {
		const values = [
			{ action: 'copyMarkdownToClipboard', extra: PRIVATE_ERROR },
			new Proxy({ action: 'saveMarkdownToFile' }, {}),
		];
		for (const value of values) {
			const deliver = vi.fn();
			const sendResponse = vi.fn();
			expect(dispatchDocumentDestinationMessage(value, deliver, sendResponse)).toBe(true);
			await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
				success: false,
				error: 'destination-delivery-failed',
			}));
			expect(deliver).not.toHaveBeenCalled();
			expect(sendResponse).toHaveBeenCalledTimes(1);
		}
	});

	it.each([
		[
			'getOwnPropertyDescriptor',
			() => {
				const trap = vi.fn(() => { throw new Error(PRIVATE_ERROR); });
				return {
					trap,
					value: new Proxy({ action: 'copyMarkdownToClipboard' }, {
						getOwnPropertyDescriptor: trap,
					}),
				};
			},
		],
		[
			'getPrototypeOf',
			() => {
				const trap = vi.fn(() => { throw new Error(PRIVATE_ERROR); });
				return {
					trap,
					value: new Proxy({ action: 'copyMarkdownToClipboard' }, {
						getPrototypeOf: trap,
					}),
				};
			},
		],
		[
			'ownKeys',
			() => {
				const trap = vi.fn(() => { throw new Error(PRIVATE_ERROR); });
				return {
					trap,
					value: new Proxy({ action: 'copyMarkdownToClipboard' }, {
						ownKeys: trap,
					}),
				};
			},
		],
	] as const)('contains a throwing %s Proxy trap behind one fixed failure', async (
		_trapName,
		createValue,
	) => {
		const { trap, value } = createValue();
		const deliver = vi.fn();
		const sendResponse = vi.fn();

		expect(dispatchDocumentDestinationMessage(value, deliver, sendResponse)).toBe(true);
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
			success: false,
			error: 'destination-delivery-failed',
		}));

		expect(trap).toHaveBeenCalledOnce();
		expect(deliver).not.toHaveBeenCalled();
		expect(sendResponse).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(PRIVATE_ERROR);
	});

	it('rejects an action accessor without evaluating it', async () => {
		const getter = vi.fn(() => { throw new Error(PRIVATE_ERROR); });
		const value = {};
		Object.defineProperty(value, 'action', { enumerable: true, get: getter });
		const deliver = vi.fn();
		const sendResponse = vi.fn();

		expect(dispatchDocumentDestinationMessage(value, deliver, sendResponse)).toBe(true);
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
			success: false,
			error: 'destination-delivery-failed',
		}));
		expect(getter).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
	});
});
