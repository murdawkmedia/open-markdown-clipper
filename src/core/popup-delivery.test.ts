// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DestinationRegistry } from '../destinations/registry';
import { ClipDestination, DestinationError, DestinationKind } from '../destinations/types';
import {
	captureStablePopupSnapshot,
	createPopupDestinationDelivery,
	createRefreshReadinessGate,
	POPUP_DESTINATION_PRESENTATION,
	respondToQuickClip,
} from './popup-delivery';

const SOURCE_URL = 'https://example.com/article';
const CAPTURED_AT = new Date('2026-07-13T08:00:00.000Z');
const TOKEN = 'test-token-123456';
const LABELS: Record<string, string> = {
	clipboardDestination: 'Clipboard',
	downloadDestination: 'Markdown download',
	customUriDestination: 'Custom URI',
	localHttpDestination: 'Local HTTP',
	destinationDeliveryFailed: 'Could not deliver this capture. Copy or download it instead.',
	localHttpOutcomeUnknown: 'Delivery result is unknown. Check the receiver before retrying.',
};

function loadPopupDom(): void {
	document.body.innerHTML = `
		<p class="error-message" style="display:none"></p>
		<p id="delivery-status" role="status" aria-live="polite" hidden></p>
		<div class="clipper">
			<textarea id="note-name-field">Private editable title</textarea>
			<div class="metadata-properties"><input id="private-property" value="private value"></div>
			<textarea id="note-content-field">Private editable body</textarea>
			<div id="action-buttons">
				<button id="clip-btn"></button>
				<button id="more-btn"></button>
				<div id="more-dropdown" class="show"><div class="secondary-actions"></div></div>
			</div>
		</div>`;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
	return {
		document,
		defaultDestination: 'download' as DestinationKind,
		preferences: {
			customUriTemplate: 'notes:clip?title={title}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		},
		getSnapshot: vi.fn(async () => ({
			title: (document.getElementById('note-name-field') as HTMLTextAreaElement).value,
			markdown: '---\nprivate-property: private value\n---\nPrivate editable body',
			sourceUrl: SOURCE_URL,
		})),
		getToken: vi.fn(async () => TOKEN),
		dataConsent: {
			hasConsent: vi.fn(async () => true),
			requestFromUserGesture: vi.fn(async () => true),
		},
		copy: vi.fn(async () => true),
		save: vi.fn(async () => undefined),
		sendRuntimeMessage: vi.fn(async () => ({ success: true })),
		fetchImpl: vi.fn(async () => ({
			body: null,
			ok: true,
			redirected: false,
			status: 201,
			type: 'basic',
		} as Response)) as unknown as typeof fetch,
		recordSuccess: vi.fn(async () => undefined),
		now: vi.fn(() => CAPTURED_AT),
		getMessage: (key: string) => LABELS[key] ?? key,
		initializeIcons: vi.fn(),
		closePopup: vi.fn(),
		canClosePopup: true,
		...overrides,
	};
}

function createReadyController(options: ReturnType<typeof baseOptions>) {
	const controller = createPopupDestinationDelivery(options);
	controller.setReady(true);
	return controller;
}

beforeEach(() => {
	loadPopupDom();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('popup destination presentation', () => {
	it('defines four neutral labelled actions and renders the non-default three as buttons', () => {
		expect(POPUP_DESTINATION_PRESENTATION).toEqual([
			{ destination: 'clipboard', labelKey: 'clipboardDestination', icon: 'copy' },
			{ destination: 'download', labelKey: 'downloadDestination', icon: 'file-down' },
			{ destination: 'custom-uri', labelKey: 'customUriDestination', icon: 'external-link' },
			{ destination: 'local-http', labelKey: 'localHttpDestination', icon: 'send' },
		]);

		createPopupDestinationDelivery(baseOptions({ defaultDestination: 'local-http' }));

		const main = document.getElementById('clip-btn') as HTMLButtonElement;
		expect(main.dataset.destination).toBe('local-http');
		expect(main.textContent).toBe('Local HTTP');
		const secondary = Array.from(document.querySelectorAll<HTMLButtonElement>(
			'.secondary-actions button[data-destination]',
		));
		expect(secondary.map(button => button.dataset.destination)).toEqual([
			'clipboard',
			'download',
			'custom-uri',
		]);
		expect(secondary.map(button => button.textContent?.trim())).toEqual([
			'Clipboard',
			'Markdown download',
			'Custom URI',
		]);
		expect(secondary.every(button => button.type === 'button')).toBe(true);
	});
});

describe('popup destination controller', () => {
	it.each([
		['main', 'local-http'],
		['secondary', 'custom-uri'],
	] as const)(
		'requests transmission consent synchronously from a %s button click before capturing %s',
		async (intent, destination) => {
			const consent = deferred<boolean>();
			const requestFromUserGesture = vi.fn(() => consent.promise);
			const options = baseOptions({
				defaultDestination: intent === 'main' ? destination : 'download',
				dataConsent: {
					hasConsent: vi.fn(async () => true),
					requestFromUserGesture,
				},
			});
			createReadyController(options);
			const button = intent === 'main'
				? document.getElementById('clip-btn') as HTMLButtonElement
				: document.querySelector<HTMLButtonElement>(
					`button[data-destination="${destination}"]`,
				)!;

			button.click();

			expect(requestFromUserGesture).toHaveBeenCalledOnce();
			expect(requestFromUserGesture).toHaveBeenCalledWith(destination);
			expect(options.getSnapshot).not.toHaveBeenCalled();
			expect(options.getToken).not.toHaveBeenCalled();
			expect(options.sendRuntimeMessage).not.toHaveBeenCalled();
			expect(options.fetchImpl).not.toHaveBeenCalled();

			consent.resolve(false);
			await vi.waitFor(() => {
				expect(document.getElementById('delivery-status')!.textContent)
					.toBe(LABELS.destinationDeliveryFailed);
			});
			expect(options.getSnapshot).not.toHaveBeenCalled();
			expect(options.copy).not.toHaveBeenCalled();
			expect(options.recordSuccess).not.toHaveBeenCalled();
	},
	);

	it.each(['clipboard', 'download'] as const)(
		'delivers %s without checking or requesting transmission consent',
		async destination => {
			const options = baseOptions({ defaultDestination: destination });
			const controller = createReadyController(options);

			await expect(controller.deliverDefault('main')).resolves.toBe(true);

			expect(options.dataConsent.requestFromUserGesture).not.toHaveBeenCalled();
			expect(options.dataConsent.hasConsent).not.toHaveBeenCalled();
		},
	);

	it('never prompts for Quick Clip and denies it before capture without an existing grant', async () => {
		const options = baseOptions({
			defaultDestination: 'local-http',
			dataConsent: {
				hasConsent: vi.fn(async () => false),
				requestFromUserGesture: vi.fn(async () => true),
			},
		});
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('quick')).resolves.toBe(false);

		expect(options.dataConsent.hasConsent).toHaveBeenCalledOnce();
		expect(options.dataConsent.hasConsent).toHaveBeenCalledWith('local-http');
		expect(options.dataConsent.requestFromUserGesture).not.toHaveBeenCalled();
		expect(options.getSnapshot).not.toHaveBeenCalled();
		expect(options.getToken).not.toHaveBeenCalled();
		expect(options.fetchImpl).not.toHaveBeenCalled();
	});

	it('observes Local HTTP consent revocation at the network boundary', async () => {
		const hasConsent = vi.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const options = baseOptions({
			defaultDestination: 'local-http',
			dataConsent: {
				hasConsent,
				requestFromUserGesture: vi.fn(async () => true),
			},
		});
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('main')).resolves.toBe(false);

		expect(hasConsent).toHaveBeenCalledTimes(3);
		expect(hasConsent).toHaveBeenCalledWith('local-http');
		expect(options.getSnapshot).toHaveBeenCalledOnce();
		expect(options.getToken).toHaveBeenCalledOnce();
		expect(options.fetchImpl).not.toHaveBeenCalled();
		expect(options.recordSuccess).not.toHaveBeenCalled();
	});

	it('observes Custom URI consent revocation before sending metadata to the background', async () => {
		const hasConsent = vi.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const options = baseOptions({
			defaultDestination: 'custom-uri',
			dataConsent: {
				hasConsent,
				requestFromUserGesture: vi.fn(async () => true),
			},
		});
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('main')).resolves.toBe(false);

		expect(hasConsent).toHaveBeenCalledTimes(3);
		expect(hasConsent).toHaveBeenCalledWith('custom-uri');
		expect(options.getSnapshot).toHaveBeenCalledOnce();
		expect(options.copy).toHaveBeenCalledOnce();
		expect(options.sendRuntimeMessage).not.toHaveBeenCalled();
		expect(options.recordSuccess).not.toHaveBeenCalled();
	});

	it('starts unready and fixed-fails quick clip without any destination effect', async () => {
		const options = baseOptions({ defaultDestination: 'clipboard' });
		const controller = createPopupDestinationDelivery(options);
		const sendResponse = vi.fn();

		await respondToQuickClip(controller, sendResponse);

		expect(sendResponse).toHaveBeenCalledOnce();
		expect(sendResponse).toHaveBeenCalledWith({
			success: false,
			error: 'destination-delivery-failed',
		});
		for (const effect of [
			options.getSnapshot,
			options.getToken,
			options.copy,
			options.save,
			options.sendRuntimeMessage,
			options.fetchImpl,
			options.recordSuccess,
			options.closePopup,
		]) {
			expect(effect).not.toHaveBeenCalled();
		}
		expect(Array.from(document.querySelectorAll<HTMLButtonElement>(
			'[data-destination], #more-btn',
		)).every(button => button.disabled)).toBe(true);
	});

	it('threads Quick Clip cancellation through snapshot capture and stops before delivery', async () => {
		const pendingSnapshot = deferred<{
			title: string;
			markdown: string;
			sourceUrl: string;
		}>();
		const getSnapshot = vi.fn((_signal?: AbortSignal) => pendingSnapshot.promise);
		const options = baseOptions({ getSnapshot });
		const controller = createReadyController(options);
		const abortController = new AbortController();

		const delivery = controller.deliverDefault('quick', abortController.signal);
		await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
		abortController.abort();
		pendingSnapshot.resolve({
			title: 'Late private title',
			markdown: 'Late private body',
			sourceUrl: SOURCE_URL,
		});

		await expect(delivery).resolves.toBe(false);
		expect(getSnapshot).toHaveBeenCalledWith(abortController.signal);
		expect(options.save).not.toHaveBeenCalled();
		expect(options.recordSuccess).not.toHaveBeenCalled();
	});

	it('settles promptly on abort even when snapshot work ignores cancellation', async () => {
		const getSnapshot = vi.fn((_signal?: AbortSignal) => new Promise<never>(() => undefined));
		const options = baseOptions({ getSnapshot });
		const controller = createReadyController(options);
		const abortController = new AbortController();
		const delivery = controller.deliverDefault('quick', abortController.signal);
		await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());

		abortController.abort();
		const outcome = await Promise.race([
			delivery,
			new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), 25)),
		]);

		expect(outcome).toBe(false);
		expect(options.save).not.toHaveBeenCalled();
		expect(options.recordSuccess).not.toHaveBeenCalled();
	});

	it('snapshots once and delivers one exact frozen document to the selected default destination', async () => {
		const send = vi.fn(async (clipDocument) => {
			expect(Object.isFrozen(clipDocument)).toBe(true);
			expect(clipDocument).toEqual({
				title: 'Private editable title',
				markdown: '---\nprivate-property: private value\n---\nPrivate editable body',
				sourceUrl: SOURCE_URL,
				capturedAt: CAPTURED_AT.toISOString(),
			});
			return { destination: 'download' as const, receipt: 'Private editable title.md' };
		});
		const resolve = vi.fn((kind: DestinationKind): ClipDestination => ({ kind, send }));
		const registryFactory = vi.fn((): DestinationRegistry => ({ resolve }));
		const options = baseOptions({ registryFactory });
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('main')).resolves.toBe(true);

		expect(options.getSnapshot).toHaveBeenCalledOnce();
		expect(registryFactory).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledWith('download');
		expect(send).toHaveBeenCalledOnce();
		expect(options.recordSuccess).toHaveBeenCalledWith(
			'download',
			SOURCE_URL,
			'Private editable title',
		);
		expect(options.closePopup).toHaveBeenCalledOnce();
	});

	it('delivers the selected secondary destination without closing the popup', async () => {
		const resolve = vi.fn((kind: DestinationKind): ClipDestination => ({
			kind,
			send: vi.fn(async () => ({ destination: kind })),
		}));
		const options = baseOptions({
			registryFactory: () => ({ resolve }),
		});
		const controller = createReadyController(options);

		await expect(controller.deliver('clipboard', 'secondary')).resolves.toBe(true);

		expect(resolve).toHaveBeenCalledWith('clipboard');
		expect(options.recordSuccess).toHaveBeenCalledWith(
			'clipboard',
			SOURCE_URL,
			'Private editable title',
		);
		expect(options.closePopup).not.toHaveBeenCalled();
	});

	it('warns that the outcome is unknown and keeps fallbacks usable after a dispatched Local HTTP failure', async () => {
		const privateAdapterError = 'private-adapter-error-f662';
		const fetchImpl = vi.fn(async () => {
			throw new Error(`${privateAdapterError}: Private editable title Private editable body`);
		}) as unknown as typeof fetch;
		const consoleSpies = (['debug', 'error', 'info', 'log', 'warn'] as const)
			.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
		const options = baseOptions({
			defaultDestination: 'local-http',
			fetchImpl,
		});
		const controller = createReadyController(options);

		try {
			await expect(controller.deliverDefault('main')).resolves.toBe(false);
			const status = document.getElementById('delivery-status')!;
			expect(status.hidden).toBe(false);
			expect(status.textContent).toBe(LABELS.localHttpOutcomeUnknown);
			expect(status.textContent).not.toContain(privateAdapterError);
			expect((document.getElementById('note-name-field') as HTMLTextAreaElement).value)
				.toBe('Private editable title');
			expect((document.getElementById('note-content-field') as HTMLTextAreaElement).value)
				.toBe('Private editable body');
			expect((document.getElementById('private-property') as HTMLInputElement).value)
				.toBe('private value');
			for (const kind of ['clipboard', 'download']) {
				const button = document.querySelector<HTMLButtonElement>(`[data-destination="${kind}"]`);
				expect(button).not.toBeNull();
				expect(button!.disabled).toBe(false);
			}
			expect(options.recordSuccess).not.toHaveBeenCalled();
			expect(options.closePopup).not.toHaveBeenCalled();
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of consoleSpies) spy.mockRestore();
		}
	});

	it('keeps an in-flight Local HTTP abort outcome unknown through the popup boundary', async () => {
		let rejectFetch!: (reason?: unknown) => void;
		const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
			new Promise<Response>((_resolve, reject) => {
				rejectFetch = reject;
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
					once: true,
				});
			})
		)) as unknown as typeof fetch;
		const options = baseOptions({ defaultDestination: 'local-http', fetchImpl });
		const controller = createReadyController(options);
		const abortController = new AbortController();

		const delivery = controller.deliverDefault('main', abortController.signal);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
		abortController.abort();
		rejectFetch(new DestinationError('delivery-aborted'));

		await expect(delivery).resolves.toBe(false);
		expect(document.getElementById('delivery-status')!.textContent)
			.toBe(LABELS.localHttpOutcomeUnknown);
		expect(options.recordSuccess).not.toHaveBeenCalled();
		expect(options.closePopup).not.toHaveBeenCalled();
	});

	it('deduplicates an in-flight delivery and restores all destination controls', async () => {
		const pending = deferred<{ destination: 'download' }>();
		const send = vi.fn(() => pending.promise);
		const options = baseOptions({
			registryFactory: () => ({
				resolve: () => ({ kind: 'download' as const, send }),
			}),
		});
		const controller = createReadyController(options);

		const first = controller.deliverDefault('main');
		const second = controller.deliverDefault('main');
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-destination], #more-btn'))
			.every(button => button.disabled)).toBe(true);
		pending.resolve({ destination: 'download' });
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

		expect(options.getSnapshot).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledOnce();
		expect(options.recordSuccess).toHaveBeenCalledOnce();
		expect(options.closePopup).toHaveBeenCalledOnce();
		expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-destination], #more-btn'))
			.every(button => !button.disabled)).toBe(true);
	});

	it('fixed-fails a quick request that overlaps a secondary delivery with a different intent', async () => {
		const pending = deferred<{ destination: 'download' }>();
		const send = vi.fn(() => pending.promise);
		const options = baseOptions({
			registryFactory: () => ({
				resolve: () => ({ kind: 'download' as const, send }),
			}),
		});
		const controller = createReadyController(options);
		const first = controller.deliverDefault('secondary');
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		const sendResponse = vi.fn();

		await respondToQuickClip(controller, sendResponse);

		expect(sendResponse).toHaveBeenCalledOnce();
		expect(sendResponse).toHaveBeenCalledWith({
			success: false,
			error: 'destination-delivery-failed',
		});
		expect(options.closePopup).not.toHaveBeenCalled();
		expect(options.recordSuccess).not.toHaveBeenCalled();
		pending.resolve({ destination: 'download' });
		await expect(first).resolves.toBe(true);
		expect(send).toHaveBeenCalledOnce();
		expect(options.recordSuccess).toHaveBeenCalledOnce();
		expect(options.closePopup).not.toHaveBeenCalled();
	});

	it('rejects a different destination while one delivery is in flight', async () => {
		const pending = deferred<{ destination: 'clipboard' }>();
		const send = vi.fn(() => pending.promise);
		const resolve = vi.fn((kind: DestinationKind) => ({ kind, send }));
		const options = baseOptions({ registryFactory: () => ({ resolve }) });
		const controller = createReadyController(options);
		const first = controller.deliver('clipboard', 'secondary');
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

		await expect(controller.deliver('download', 'main')).resolves.toBe(false);

		expect(resolve).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledWith('clipboard');
		expect(options.closePopup).not.toHaveBeenCalled();
		pending.resolve({ destination: 'clipboard' });
		await expect(first).resolves.toBe(true);
		expect(options.recordSuccess).toHaveBeenCalledOnce();
		expect(options.closePopup).not.toHaveBeenCalled();
	});

	it.each([
		'clipboard',
		'download',
		'custom-uri',
	] as const)('delivers %s without retrieving the local HTTP token', async destination => {
		const getToken = vi.fn(async () => {
			throw new Error('token storage unavailable');
		});
		const options = baseOptions({ defaultDestination: destination, getToken });
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('secondary')).resolves.toBe(true);

		expect(getToken).not.toHaveBeenCalled();
		expect(options.recordSuccess).toHaveBeenCalledWith(
			destination,
			SOURCE_URL,
			'Private editable title',
		);
	});

	it('closes only an ordinary popup after a successful main delivery', async () => {
		const options = baseOptions({ canClosePopup: false });
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('main')).resolves.toBe(true);
		expect(options.closePopup).not.toHaveBeenCalled();

		const ordinaryOptions = baseOptions();
		const ordinaryController = createReadyController(ordinaryOptions);
		await expect(ordinaryController.deliver('clipboard', 'secondary')).resolves.toBe(true);
		expect(ordinaryOptions.closePopup).not.toHaveBeenCalled();
		await expect(ordinaryController.deliverDefault('main')).resolves.toBe(true);
		expect(ordinaryOptions.closePopup).toHaveBeenCalledOnce();
	});

	it('sends the exact custom URI runtime message and accepts only the fixed success response', async () => {
		const sendRuntimeMessage = vi.fn(async () => ({ success: true }));
		const options = baseOptions({
			defaultDestination: 'custom-uri',
			sendRuntimeMessage,
		});
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('secondary')).resolves.toBe(true);
		expect(sendRuntimeMessage).toHaveBeenCalledOnce();
		expect(sendRuntimeMessage).toHaveBeenCalledWith({
			action: 'openCustomUri',
			uri: 'notes:clip?title=Private%20editable%20title',
		});

		const nonFixedOptions = baseOptions({
			defaultDestination: 'custom-uri',
			sendRuntimeMessage: vi.fn(async () => ({ success: true, extra: 'not-fixed' })),
		});
		const nonFixedController = createReadyController(nonFixedOptions);
		await expect(nonFixedController.deliverDefault('secondary')).resolves.toBe(false);
		expect(nonFixedOptions.recordSuccess).not.toHaveBeenCalled();
	});

	it('applies changed default and destination preferences only after an active delivery', async () => {
		const pendingSave = deferred<void>();
		const save = vi.fn(() => pendingSave.promise);
		const sendRuntimeMessage = vi.fn(async () => ({ success: true }));
		const options = baseOptions({ save, sendRuntimeMessage });
		const controller = createReadyController(options);
		const first = controller.deliverDefault('secondary');
		await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

		controller.updateConfiguration({
			defaultDestination: 'custom-uri',
			preferences: {
				customUriTemplate: 'fresh:clip?source={sourceUrl}',
				localHttpEndpoint: 'http://127.0.0.1:9911/fresh',
			},
		});
		expect((document.getElementById('clip-btn') as HTMLButtonElement).dataset.destination)
			.toBe('download');

		pendingSave.resolve();
		await expect(first).resolves.toBe(true);
		expect((document.getElementById('clip-btn') as HTMLButtonElement).dataset.destination)
			.toBe('custom-uri');
		await expect(controller.deliverDefault('secondary')).resolves.toBe(true);
		expect(sendRuntimeMessage).toHaveBeenLastCalledWith({
			action: 'openCustomUri',
			uri: 'fresh:clip?source=https%3A%2F%2Fexample.com%2Farticle',
		});
	});
});

describe('popup refresh and snapshot barriers', () => {
	it('keeps controls disabled until only the latest same-tab refresh succeeds', () => {
		const controller = createPopupDestinationDelivery(baseOptions());
		const gate = createRefreshReadinessGate(ready => controller.setReady(ready));
		const first = gate.begin(11);
		const latest = gate.begin(22);

		expect(gate.complete(first, true, 11, 'https://example.com/old')).toBe(false);
		expect(Array.from(document.querySelectorAll<HTMLButtonElement>(
			'[data-destination], #more-btn',
		)).every(button => button.disabled)).toBe(true);
		expect(gate.complete(latest, true, 22, SOURCE_URL)).toBe(true);
		expect(gate.readyUrl()).toBe(SOURCE_URL);
		expect(Array.from(document.querySelectorAll<HTMLButtonElement>(
			'[data-destination], #more-btn',
		)).every(button => !button.disabled)).toBe(true);
	});

	it('rejects a snapshot whose tab and revision change before assembly completes', async () => {
		const template = {};
		const state = {
			tabId: 31 as number | undefined,
			template: template as object | null,
			revision: 7,
			ready: true,
			readyUrl: 'https://example.com/tab-31' as string | null,
		};
		const pendingMarkdown = deferred<string>();
		const getSnapshot = vi.fn(() => captureStablePopupSnapshot({
			getState: () => ({ ...state }),
			readDom: () => ({
				title: 'Old tab title',
				noteContent: 'Old tab body',
				properties: ['old-tab-property'],
			}),
			buildMarkdown: vi.fn(() => pendingMarkdown.promise),
			getSourceUrl: vi.fn(async tabId => `https://example.com/tab-${tabId}`),
		}));
		const options = baseOptions({ getSnapshot });
		const controller = createReadyController(options);
		const delivery = controller.deliverDefault('main');
		await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());

		state.tabId = 32;
		state.revision = 8;
		pendingMarkdown.resolve('# Old tab body');

		await expect(delivery).resolves.toBe(false);
		for (const effect of [
			options.copy,
			options.save,
			options.sendRuntimeMessage,
			options.fetchImpl,
			options.recordSuccess,
			options.closePopup,
		]) {
			expect(effect).not.toHaveBeenCalled();
		}
	});

	it('returns the cached successful-refresh URL when the live tab URL still matches', async () => {
		const template = {};
		const state = {
			tabId: 41,
			template,
			revision: 9,
			ready: true,
			readyUrl: SOURCE_URL,
		};

		await expect(captureStablePopupSnapshot({
			getState: () => state,
			readDom: () => ({
				title: 'Matching title',
				noteContent: 'Matching body',
				properties: [],
			}),
			buildMarkdown: async (_properties, noteContent) => `# ${noteContent}`,
			getSourceUrl: async () => SOURCE_URL,
		})).resolves.toEqual({
			title: 'Matching title',
			markdown: '# Matching body',
			sourceUrl: SOURCE_URL,
		});
	});

	it('threads cancellation through Markdown and source URL assembly', async () => {
		const template = {};
		const pendingMarkdown = deferred<string>();
		const pendingSourceUrl = deferred<string>();
		const readDom = vi.fn(() => ({
			title: 'Private late title',
			noteContent: 'Private late body',
			properties: [],
		}));
		const buildMarkdown = vi.fn((_properties, _noteContent, _signal?: AbortSignal) => (
			pendingMarkdown.promise
		));
		const getSourceUrl = vi.fn((_tabId, _signal?: AbortSignal) => pendingSourceUrl.promise);
		const abortController = new AbortController();
		const snapshot = captureStablePopupSnapshot({
			getState: () => ({
				tabId: 41,
				template,
				revision: 9,
				ready: true,
				readyUrl: SOURCE_URL,
			}),
			readDom,
			buildMarkdown,
			getSourceUrl,
		}, abortController.signal);
		await vi.waitFor(() => {
			expect(buildMarkdown).toHaveBeenCalledOnce();
			expect(getSourceUrl).toHaveBeenCalledOnce();
		});

		abortController.abort();

		await expect(snapshot).rejects.toMatchObject({
			name: 'DestinationError',
			code: 'destination-delivery-failed',
			message: 'destination-delivery-failed',
		});
		expect(buildMarkdown).toHaveBeenCalledWith([], 'Private late body', abortController.signal);
		expect(getSourceUrl).toHaveBeenCalledWith(41, abortController.signal);
		expect(readDom).toHaveBeenCalledOnce();
	});

	it('rejects DOM from URL A when the tab reaches URL B before a navigation message', async () => {
		const template = {};
		const state = {
			tabId: 51,
			template,
			revision: 12,
			ready: true,
			readyUrl: 'https://example.com/url-a',
		};
		let liveTabUrl = state.readyUrl;
		const queryTab = deferred<void>();
		const getSnapshot = vi.fn(() => captureStablePopupSnapshot({
			getState: () => state,
			readDom: () => ({
				title: 'URL A title',
				noteContent: 'URL A body',
				properties: [],
			}),
			buildMarkdown: async () => '# URL A body',
			getSourceUrl: async () => {
				await queryTab.promise;
				return liveTabUrl;
			},
		}));
		const options = baseOptions({ getSnapshot });
		const controller = createReadyController(options);
		const delivery = controller.deliverDefault('main');
		await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());

		liveTabUrl = 'https://example.com/url-b';
		queryTab.resolve();

		await expect(delivery).resolves.toBe(false);
		for (const effect of [
			options.copy,
			options.save,
			options.sendRuntimeMessage,
			options.fetchImpl,
			options.recordSuccess,
			options.closePopup,
		]) {
			expect(effect).not.toHaveBeenCalled();
		}
	});
});

describe('quick clip responses', () => {
	it('uses the configured default, closes on success, and sends only fixed success', async () => {
		const events: string[] = [];
		const options = baseOptions({
			defaultDestination: 'clipboard',
			recordSuccess: vi.fn(async () => { events.push('record'); }),
			closePopup: vi.fn(() => { events.push('close'); }),
		});
		const controller = createReadyController(options);
		const sendResponse = vi.fn(() => { events.push('response'); });

		await respondToQuickClip(controller, sendResponse);

		expect(options.copy).toHaveBeenCalledOnce();
		expect(options.closePopup).toHaveBeenCalledOnce();
		expect(sendResponse).toHaveBeenCalledWith({ success: true });
		expect(events).toEqual(['record', 'response', 'close']);
	});

	it('does not close on failure and sends a content-free fixed failure', async () => {
		const privateError = 'private-quick-error-72c1';
		const options = baseOptions({
			defaultDestination: 'local-http',
			fetchImpl: vi.fn(async () => {
				throw new Error(`${privateError}: Private editable body`);
			}) as unknown as typeof fetch,
		});
		const controller = createReadyController(options);
		const sendResponse = vi.fn();

		await respondToQuickClip(controller, sendResponse);

		expect(options.closePopup).not.toHaveBeenCalled();
		expect(sendResponse).toHaveBeenCalledWith({
			success: false,
			error: 'destination-delivery-failed',
		});
		expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(privateError);
		expect(JSON.stringify(sendResponse.mock.calls)).not.toContain('Private editable body');
	});

	it('sends success once and stays successful when popup closing throws', async () => {
		const options = baseOptions({
			defaultDestination: 'clipboard',
			closePopup: vi.fn(() => { throw new Error('window already gone'); }),
		});
		const controller = createReadyController(options);
		const sendResponse = vi.fn();

		await expect(respondToQuickClip(controller, sendResponse)).resolves.toBeUndefined();

		expect(sendResponse).toHaveBeenCalledOnce();
		expect(sendResponse).toHaveBeenCalledWith({ success: true });
		expect(options.recordSuccess).toHaveBeenCalledOnce();
	});

	it('keeps a successful main delivery successful when popup closing throws', async () => {
		const options = baseOptions({
			closePopup: vi.fn(() => { throw new Error('window already gone'); }),
		});
		const controller = createReadyController(options);

		await expect(controller.deliverDefault('main')).resolves.toBe(true);

		expect(options.recordSuccess).toHaveBeenCalledOnce();
		expect(document.getElementById('delivery-status')!.hidden).toBe(true);
	});
});
