// @vitest-environment jsdom

import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__getMockStorage,
	__resetMockStorage,
	__seedMockStorage,
} from '../utils/__mocks__/webextension-polyfill';
import browser from '../utils/browser-polyfill';
import { DataConsentController } from '../utils/data-consent';
import * as generalSettingsManager from './general-settings';
import { initializeDestinationSettings } from './general-settings';

const SETTINGS_HTML = readFileSync(join(process.cwd(), 'src', 'settings.html'), 'utf8');
const SETTINGS_SOURCE = readFileSync(
	join(process.cwd(), 'src', 'managers', 'general-settings.ts'),
	'utf8',
);
const TOKEN = 'test-token-123456';

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function consentController(
	overrides: Partial<DataConsentController> = {},
): DataConsentController {
	return {
		prime: vi.fn(async (): Promise<'supported'> => 'supported'),
		hasConsent: vi.fn(async () => true),
		requestFromUserGesture: vi.fn(async () => true),
		...overrides,
	};
}

function localControls(): Array<HTMLInputElement | HTMLButtonElement> {
	return [
		document.getElementById('local-http-endpoint') as HTMLInputElement,
		document.getElementById('local-http-token') as HTMLInputElement,
		document.getElementById('save-local-http-token') as HTMLButtonElement,
		document.getElementById('clear-local-http-token') as HTMLButtonElement,
		document.getElementById('test-local-http') as HTMLButtonElement,
	];
}

function loadSettingsDom(): void {
	document.open();
	document.write(SETTINGS_HTML);
	document.close();
}

beforeEach(() => {
	__resetMockStorage();
	loadSettingsDom();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('destination settings markup', () => {
	it('offers four labelled destinations and no legacy vault controls', () => {
		const select = document.getElementById('default-destination') as HTMLSelectElement;
		expect(select).not.toBeNull();
		expect(Array.from(select.options).map(({ value }) => value)).toEqual([
			'clipboard',
			'download',
			'custom-uri',
			'local-http',
		]);
		expect(document.querySelector('label[for="default-destination"]')).not.toBeNull();
		expect(document.getElementById('vault-input')).toBeNull();
		expect(document.getElementById('vault-list')).toBeNull();
		expect(document.getElementById('template-vault')).toBeNull();
		expect(document.getElementById('legacy-mode-toggle')).toBeNull();
		expect(document.getElementById('silent-open-toggle')).toBeNull();
		expect(document.getElementById('save-behavior-dropdown')).toBeNull();
		expect(document.body.textContent).not.toMatch(
			new RegExp(['Ob', 'sidian'].join(''), 'i'),
		);
	});

	it('uses bounded, labelled secret controls and a polite status region', () => {
		const customUri = document.getElementById('custom-uri-template') as HTMLInputElement;
		const endpoint = document.getElementById('local-http-endpoint') as HTMLInputElement;
		const token = document.getElementById('local-http-token') as HTMLInputElement;
		expect(customUri.maxLength).toBe(2048);
		expect(endpoint.type).toBe('url');
		expect(endpoint.maxLength).toBe(2048);
		expect(token.type).toBe('password');
		expect(token.autocomplete).toBe('off');
		expect(token.maxLength).toBe(512);
		const customUriDescription = document.getElementById(
			'custom-uri-template-description',
		)!.textContent ?? '';
		const endpointDescription = document.getElementById(
			'local-http-endpoint-description',
		)!.textContent ?? '';
		expect(customUriDescription).toContain('synchronized and included in settings exports');
		expect(customUriDescription).toContain('Never put secrets here');
		expect(endpointDescription).toContain('synchronized and included in settings exports');
		expect(endpointDescription).toContain('Never put secrets here');
		const readerCssDescription = document.querySelector(
			'[data-i18n="readerCustomCssDescription"]',
		)!.textContent ?? '';
		expect(readerCssDescription).toContain('load remote resources');
		expect(readerCssDescription).toContain('full settings imports you trust');
		for (const id of [
			'default-destination',
			'custom-uri-template',
			'local-http-endpoint',
			'local-http-token',
		]) {
			expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
		}
		for (const id of [
			'save-local-http-token',
			'clear-local-http-token',
			'test-local-http',
		]) {
			const button = document.getElementById(id) as HTMLButtonElement;
			expect(button.textContent?.trim()).not.toBe('');
			expect(document.querySelector(`label[for="${id}"]`)).toBeNull();
		}
		const status = document.getElementById('destination-status')!;
		expect(status.getAttribute('role')).toBe('status');
		expect(status.getAttribute('aria-live')).toBe('polite');
		expect(status.closest('#custom-uri-settings, #local-http-settings')).toBeNull();
		expect(status.closest('#destination-settings-group')).not.toBeNull();
	});
});

describe('destination settings behavior', () => {
	it.each(['custom-uri', 'local-http'] as const)(
		'requests consent synchronously when selecting %s and reverts without saving on denial',
		async destination => {
			__seedMockStorage('sync', {
				migrationVersion: 2,
				general_settings: { defaultDestination: 'download' },
			});
			const pendingConsent = deferred<boolean>();
			const dataConsent = consentController({
				requestFromUserGesture: vi.fn(() => pendingConsent.promise),
			});
			await initializeDestinationSettings({ dataConsent });
			const setSpy = vi.spyOn(browser.storage.sync, 'set');
			const select = document.getElementById('default-destination') as HTMLSelectElement;

			select.value = destination;
			select.dispatchEvent(new Event('change', { bubbles: true }));

			expect(dataConsent.requestFromUserGesture).toHaveBeenCalledOnce();
			expect(dataConsent.requestFromUserGesture).toHaveBeenCalledWith(destination);
			expect(setSpy).not.toHaveBeenCalled();
			pendingConsent.resolve(false);
			await vi.waitFor(() => expect(select.value).toBe('download'));
			expect(setSpy).not.toHaveBeenCalled();
			expect(document.getElementById('destination-status')!.textContent)
				.toContain('Could not save');
		},
	);

	it.each(['custom-uri', 'local-http'] as const)(
		'saves %s only after the requested grants are confirmed',
		async destination => {
			__seedMockStorage('sync', {
				migrationVersion: 2,
				general_settings: { defaultDestination: 'download' },
			});
			const dataConsent = consentController();
			await initializeDestinationSettings({ dataConsent });
			const select = document.getElementById('default-destination') as HTMLSelectElement;

			select.value = destination;
			select.dispatchEvent(new Event('change', { bubbles: true }));

			expect(dataConsent.requestFromUserGesture).toHaveBeenCalledOnce();
			expect(dataConsent.requestFromUserGesture).toHaveBeenCalledWith(destination);
			await vi.waitFor(() => {
				const stored = __getMockStorage('sync').general_settings as Record<string, unknown>;
				expect(stored.defaultDestination).toBe(destination);
			});
			expect(dataConsent.hasConsent).toHaveBeenCalledOnce();
			expect(dataConsent.hasConsent).toHaveBeenCalledWith(destination);
		},
	);

	it.each(['clipboard', 'download'] as const)(
		'saves %s without checking or requesting transmission consent',
		async destination => {
			__seedMockStorage('sync', {
				migrationVersion: 2,
				general_settings: { defaultDestination: 'download' },
			});
			const dataConsent = consentController();
			await initializeDestinationSettings({ dataConsent });
			const select = document.getElementById('default-destination') as HTMLSelectElement;

			select.value = destination;
			select.dispatchEvent(new Event('change', { bubbles: true }));
			await vi.waitFor(() => {
				const stored = __getMockStorage('sync').general_settings as Record<string, unknown>;
				expect(stored.defaultDestination).toBe(destination);
			});
			expect(dataConsent.requestFromUserGesture).not.toHaveBeenCalled();
			expect(dataConsent.hasConsent).not.toHaveBeenCalled();
		},
	);

	it('gates connection testing in its click gesture before reading the token or making a request', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: {
				defaultDestination: 'local-http',
				localHttpEndpoint: 'http://127.0.0.1:8765/captures',
			},
		});
		__seedMockStorage('local', {
			destinationSecrets: { localHttpToken: TOKEN },
		});
		const pendingConsent = deferred<boolean>();
		const dataConsent = consentController({
			requestFromUserGesture: vi.fn(() => pendingConsent.promise),
		});
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		await initializeDestinationSettings({ dataConsent, fetchImpl });
		const getSpy = vi.spyOn(browser.storage.local, 'get');

		(document.getElementById('test-local-http') as HTMLButtonElement).click();

		expect(dataConsent.requestFromUserGesture).toHaveBeenCalledOnce();
		expect(dataConsent.requestFromUserGesture).toHaveBeenCalledWith('local-http');
		expect(getSpy).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
		pendingConsent.resolve(false);
		await vi.waitFor(() => {
			expect(document.getElementById('destination-status')!.textContent)
				.toBe('Connection failed. Check the endpoint and access token.');
		});
		expect(getSpy).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('observes consent revocation after token access and before the connection request', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: {
				defaultDestination: 'local-http',
				localHttpEndpoint: 'http://127.0.0.1:8765/captures',
			},
		});
		__seedMockStorage('local', {
			destinationSecrets: { localHttpToken: TOKEN },
		});
		const hasConsent = vi.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const dataConsent = consentController({ hasConsent });
		const fetchImpl = vi.fn(async () => ({
			body: null,
			ok: true,
			redirected: false,
			status: 204,
			type: 'basic',
		} as Response)) as unknown as typeof fetch;
		await initializeDestinationSettings({ dataConsent, fetchImpl });

		(document.getElementById('test-local-http') as HTMLButtonElement).click();

		await vi.waitFor(() => {
			expect(document.getElementById('destination-status')!.textContent)
				.toBe('Connection failed. Check the endpoint and access token.');
		});
		expect(hasConsent).toHaveBeenCalledTimes(2);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('shows only the panel for the selected configurable destination', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: { defaultDestination: 'download' },
		});
		await initializeDestinationSettings();

		const select = document.getElementById('default-destination') as HTMLSelectElement;
		const customPanel = document.getElementById('custom-uri-settings')!;
		const httpPanel = document.getElementById('local-http-settings')!;
		expect(customPanel.hidden).toBe(true);
		expect(httpPanel.hidden).toBe(true);

		select.value = 'custom-uri';
		select.dispatchEvent(new Event('change'));
		expect(customPanel.hidden).toBe(false);
		expect(httpPanel.hidden).toBe(true);

		select.value = 'local-http';
		select.dispatchEvent(new Event('change'));
		expect(customPanel.hidden).toBe(true);
		expect(httpPanel.hidden).toBe(false);
	});

	it('serializes direct destination preference saves', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: { defaultDestination: 'custom-uri' },
		});
		await initializeDestinationSettings();

		const firstWrite = deferred<void>();
		const originalSet = browser.storage.sync.set.bind(browser.storage.sync);
		let writeCount = 0;
		const setSpy = vi.spyOn(browser.storage.sync, 'set').mockImplementation(async values => {
			writeCount += 1;
			if (writeCount === 1) await firstWrite.promise;
			await originalSet(values);
		});
		const customUri = document.getElementById('custom-uri-template') as HTMLInputElement;
		const endpoint = document.getElementById('local-http-endpoint') as HTMLInputElement;
		customUri.value = 'notes:clip?title={title}';
		customUri.dispatchEvent(new Event('change', { bubbles: true }));
		endpoint.value = 'http://127.0.0.1:8765/captures';
		endpoint.dispatchEvent(new Event('change', { bubbles: true }));

		try {
			await vi.waitFor(() => expect(setSpy).toHaveBeenCalledOnce());
			expect(setSpy).toHaveBeenCalledTimes(1);
		} finally {
			firstWrite.resolve();
		}
		await vi.waitFor(() => expect(setSpy).toHaveBeenCalledTimes(2));
		const stored = __getMockStorage('sync').general_settings as Record<string, unknown>;
		expect(stored.customUriTemplate).toBe('notes:clip?title={title}');
		expect(stored.localHttpEndpoint).toBe('http://127.0.0.1:8765/captures');
	});

	it('keeps all destination events out of general form autosave', async () => {
		vi.useFakeTimers();
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: { defaultDestination: 'local-http' },
		});
		await initializeDestinationSettings();
		const initializeAutoSave = (
			generalSettingsManager as unknown as Record<string, unknown>
		).initializeAutoSave;
		expect(initializeAutoSave).toBeTypeOf('function');
		if (typeof initializeAutoSave !== 'function') return;
		initializeAutoSave();

		const setSpy = vi.spyOn(browser.storage.sync, 'set');
		const token = document.getElementById('local-http-token') as HTMLInputElement;
		token.value = TOKEN;
		token.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(501);
		await Promise.resolve();
		await Promise.resolve();
		expect(setSpy).not.toHaveBeenCalled();
	});

	it('does not read destination controls during an unrelated general autosave', async () => {
		vi.useFakeTimers();
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: {
				defaultDestination: 'custom-uri',
				customUriTemplate: 'notes:stored?title={title}',
				openBehavior: 'popup',
			},
		});
		await initializeDestinationSettings();
		const initializeAutoSave = generalSettingsManager.initializeAutoSave;
		initializeAutoSave();

		const customUri = document.getElementById('custom-uri-template') as HTMLInputElement;
		customUri.value = 'notes:unsaved?title={title}';
		const openBehavior = document.getElementById('open-behavior-dropdown') as HTMLSelectElement;
		openBehavior.value = 'reader';
		const setSpy = vi.spyOn(browser.storage.sync, 'set');
		openBehavior.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(501);
		await Promise.resolve();
		await Promise.resolve();

		expect(setSpy).toHaveBeenCalledOnce();
		const stored = __getMockStorage('sync').general_settings as Record<string, unknown>;
		expect(stored.openBehavior).toBe('reader');
		expect(stored.customUriTemplate).toBe('notes:stored?title={title}');
	});

	it('tests the exact loopback endpoint with authenticated HEAD and no capture payload', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: {
				defaultDestination: 'local-http',
				localHttpEndpoint: 'http://127.0.0.1:8765/captures',
			},
		});
		__seedMockStorage('local', {
			destinationSecrets: { localHttpToken: TOKEN },
		});
		const response = deferred<Response>();
		const fetchImpl = vi.fn(() => response.promise) as unknown as typeof fetch;
		await initializeDestinationSettings({ fetchImpl });

		const testButton = document.getElementById('test-local-http') as HTMLButtonElement;
		testButton.click();
		testButton.click();
		expect(localControls().every(control => control.disabled)).toBe(true);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [endpoint, request] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
		expect(endpoint).toBe('http://127.0.0.1:8765/captures');
		expect(request).toMatchObject({
			method: 'HEAD',
			credentials: 'omit',
			cache: 'no-store',
			redirect: 'error',
		});
		expect(request.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
		expect(request.body).toBeUndefined();
		expect(request.method).not.toBe('POST');
		expect(request.signal).toBeInstanceOf(AbortSignal);
		expect(SETTINGS_SOURCE).not.toContain('buildClipDocument');
		expect(SETTINGS_SOURCE).not.toContain('createLocalHttpDestination');
		response.resolve(({
			body: null,
			ok: true,
			redirected: false,
			status: 204,
			type: 'basic',
		}) as Response);
		await vi.waitFor(() => {
			expect(document.getElementById('destination-status')!.textContent).toBe('Connection succeeded.');
		});
		expect(localControls().every(control => !control.disabled)).toBe(true);
		const status = document.getElementById('destination-status')!.textContent ?? '';
		expect(status).not.toContain(TOKEN);
		expect(status).not.toContain('127.0.0.1');
	});

	it('retains invalid token input and supports guarded save and clear', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			general_settings: { defaultDestination: 'local-http' },
		});
		await initializeDestinationSettings();
		const token = document.getElementById('local-http-token') as HTMLInputElement;
		const saveButton = document.getElementById('save-local-http-token') as HTMLButtonElement;
		const clearButton = document.getElementById('clear-local-http-token') as HTMLButtonElement;

		token.value = 'too-short';
		saveButton.click();
		expect(localControls().every(control => control.disabled)).toBe(true);
		await vi.waitFor(() => {
			expect(document.getElementById('destination-status')!.textContent).toContain('Could not save');
		});
		expect(token.value).toBe('too-short');
		expect(localControls().every(control => !control.disabled)).toBe(true);

		token.value = TOKEN;
		saveButton.click();
		expect(localControls().every(control => control.disabled)).toBe(true);
		await vi.waitFor(() => {
			expect(document.getElementById('destination-status')!.textContent).toBe('Access token saved locally.');
		});
		expect((__getMockStorage('local').destinationSecrets as Record<string, unknown>).localHttpToken).toBe(TOKEN);
		expect(token.value).toBe('');
		expect(localControls().every(control => !control.disabled)).toBe(true);

		clearButton.click();
		expect(localControls().every(control => control.disabled)).toBe(true);
		await vi.waitFor(() => {
			expect(document.getElementById('destination-status')!.textContent).toBe('Access token cleared.');
		});
		expect(__getMockStorage('local')).not.toHaveProperty('destinationSecrets');
		expect(localControls().every(control => !control.disabled)).toBe(true);
	});
});
