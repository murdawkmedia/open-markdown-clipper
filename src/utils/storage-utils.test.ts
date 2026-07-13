import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from './browser-polyfill';
import {
	__getMockStorage,
	__resetMockStorage,
	__seedMockStorage,
} from './__mocks__/webextension-polyfill';
import {
	addHistoryEntry,
	getClipHistory,
	loadSettings,
	recordClipInStorage,
	saveSettings,
} from './storage-utils';

const RETIRED_SYNC_SETTINGS_KEY = ['inter', 'preter_settings'].join('');
const RETIRED_LOCAL_PRESETS_KEY = ['provider', '_presets'].join('');
const RETIRED_ENABLE_FIELD = ['inter', 'preterEnabled'].join('');
const RETIRED_CREDENTIAL_FIELD = ['api', 'Key'].join('');

beforeEach(() => {
	__resetMockStorage();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('open behavior security migration', () => {
	it.each([
		'embedded',
		true,
		false,
		'unknown-mode',
	])('maps legacy or unsupported %p to popup and rewrites sync storage', async openBehavior => {
		__seedMockStorage('sync', {
			general_settings: {
				openBehavior,
				betaFeatures: true,
			},
			migrationVersion: 4,
		});

		const settings = await loadSettings();

		expect(settings.openBehavior).toBe('popup');
		expect(__getMockStorage('sync').general_settings).toMatchObject({
			openBehavior: 'popup',
			betaFeatures: true,
		});
	});

	it('preserves the supported reader behavior without widening the runtime type', async () => {
		__seedMockStorage('sync', {
			general_settings: { openBehavior: 'reader' },
			migrationVersion: 4,
		});

		expect((await loadSettings()).openBehavior).toBe('reader');
		expect(__getMockStorage('sync').general_settings).toEqual({ openBehavior: 'reader' });
	});

	it('sanitizes an unsupported caller value before saving', async () => {
		await loadSettings();

		await saveSettings({ openBehavior: 'embedded' } as unknown as Parameters<typeof saveSettings>[0]);

		expect((__getMockStorage('sync').general_settings as Record<string, unknown>).openBehavior)
			.toBe('popup');
	});
});

describe('destination preferences', () => {
	it('uses private-by-default public destination settings', async () => {
		const settings = await loadSettings();

		expect(settings.defaultDestination).toBe('download');
		expect(settings.customUriTemplate).toBe('');
		expect(settings.localHttpEndpoint).toBe('');
	});

	it('drops legacy application-only settings from the runtime model', async () => {
		__seedMockStorage('sync', {
			general_settings: {
				legacyMode: true,
				silentOpen: true,
				saveBehavior: 'copyToClipboard',
			},
			vaults: ['Legacy workspace'],
		});

		const settings = await loadSettings() as unknown as Record<string, unknown>;
		expect(settings).not.toHaveProperty('vaults');
		expect(settings).not.toHaveProperty('legacyMode');
		expect(settings).not.toHaveProperty('silentOpen');
		expect(settings).not.toHaveProperty('saveBehavior');
	});

	it.each([
		['addToObsidian', 'download'],
		['saveFile', 'download'],
		['copyToClipboard', 'clipboard'],
	])('migrates legacy %s to %s', async (saveBehavior, expected) => {
		__seedMockStorage('sync', {
			general_settings: { saveBehavior },
			migrationVersion: 1,
		});

		const settings = await loadSettings();
		expect(settings.defaultDestination).toBe(expected);
		expect(__getMockStorage('sync').migrationVersion).toBe(4);
	});

	it('keeps a valid destination and maps invalid values to download', async () => {
		__seedMockStorage('sync', {
			general_settings: { defaultDestination: 'local-http' },
		});
		expect((await loadSettings()).defaultDestination).toBe('local-http');

		__resetMockStorage();
		__seedMockStorage('sync', {
			general_settings: {
				defaultDestination: 'private-cloud',
				saveBehavior: 'copyToClipboard',
			},
		});
		expect((await loadSettings()).defaultDestination).toBe('download');
	});

	it('bounds loaded destination strings without trimming them', async () => {
		const oversized = ` ${'x'.repeat(3000)} `;
		__seedMockStorage('sync', {
			general_settings: {
				customUriTemplate: oversized,
				localHttpEndpoint: oversized,
			},
		});

		const settings = await loadSettings();
		expect(settings.customUriTemplate).toHaveLength(2048);
		expect(settings.customUriTemplate.startsWith(' ')).toBe(true);
		expect(settings.localHttpEndpoint).toHaveLength(2048);
	});

	it('saves only the public destination fields, never legacy routing controls', async () => {
		await loadSettings();
		await saveSettings({
			defaultDestination: 'custom-uri',
			customUriTemplate: 'notes:clip?title={title}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		});

		const general = __getMockStorage('sync').general_settings as Record<string, unknown>;
		expect(general).toMatchObject({
			defaultDestination: 'custom-uri',
			customUriTemplate: 'notes:clip?title={title}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		});
		expect(general).not.toHaveProperty('saveBehavior');
		expect(general).not.toHaveProperty('legacyMode');
		expect(general).not.toHaveProperty('silentOpen');
	});

	it('purges forbidden destination secrets from sync without migrating them', async () => {
		__seedMockStorage('sync', {
			destinationSecrets: { localHttpToken: 'test-private-token-123' },
		});

		await loadSettings();
		expect(__getMockStorage('sync')).not.toHaveProperty('destinationSecrets');
		expect(__getMockStorage('local')).toEqual({});

		__seedMockStorage('sync', {
			destinationSecrets: { localHttpToken: 'test-another-private-token' },
		});
		await saveSettings();
		expect(__getMockStorage('sync')).not.toHaveProperty('destinationSecrets');
	});

	it('purges retired model credentials without reading local presets or logging secrets', async () => {
		const syncSecret = ['retired-sync', 'provider-value', '123'].join('-');
		const localSecret = ['retired-local', 'provider-value', '456'].join('-');
		__seedMockStorage('sync', {
			[RETIRED_SYNC_SETTINGS_KEY]: {
				providers: [{ id: 'provider-1', [RETIRED_CREDENTIAL_FIELD]: syncSecret }],
				models: [{ id: 'model-1', providerId: 'provider-1' }],
				enabled: true,
			},
		});
		__seedMockStorage('local', {
			[RETIRED_LOCAL_PRESETS_KEY]: [{ id: 'provider-1', [RETIRED_CREDENTIAL_FIELD]: localSecret }],
			history: [{ safe: true }],
		});
		const localGet = vi.spyOn(browser.storage.local, 'get');
		const logs = [
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'info').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
		];

		const settings = await loadSettings() as unknown as Record<string, unknown>;

		expect(__getMockStorage('sync')).not.toHaveProperty(RETIRED_SYNC_SETTINGS_KEY);
		expect(__getMockStorage('local')).not.toHaveProperty(RETIRED_LOCAL_PRESETS_KEY);
		expect(__getMockStorage('local')).toHaveProperty('history');
		for (const retiredField of [
			['inter', 'preterModel'].join(''),
			'models',
			'providers',
			RETIRED_ENABLE_FIELD,
			['inter', 'preterAutoRun'].join(''),
			'defaultPromptContext',
		]) {
			expect(settings).not.toHaveProperty(retiredField);
		}
		expect(localGet).not.toHaveBeenCalled();
		const renderedLogs = JSON.stringify(logs.flatMap(spy => spy.mock.calls));
		expect(renderedLogs).not.toContain(syncSecret);
		expect(renderedLogs).not.toContain(localSecret);
	});

	it('never recreates retired model settings while saving', async () => {
		const storedValue = ['retired-save', 'value', '789'].join('-');
		const callerValue = ['caller', 'value', 'abc'].join('-');
		__seedMockStorage('sync', {
			[RETIRED_SYNC_SETTINGS_KEY]: { providers: [{ [RETIRED_CREDENTIAL_FIELD]: storedValue }] },
		});

		await saveSettings({
			[RETIRED_ENABLE_FIELD]: true,
			providers: [{ [RETIRED_CREDENTIAL_FIELD]: callerValue }],
		} as unknown as Parameters<typeof saveSettings>[0]);

		expect(__getMockStorage('sync')).not.toHaveProperty(RETIRED_SYNC_SETTINGS_KEY);
	});
});

describe('generic clip statistics', () => {
	it('uses exactly the five generic action counters by default', async () => {
		const settings = await loadSettings();

		expect(settings.stats).toEqual({
			clipboard: 0,
			download: 0,
			'custom-uri': 0,
			'local-http': 0,
			share: 0,
		});
		expect(__getMockStorage('sync').stats).toEqual(settings.stats);
	});

	it('sums legacy and generic counters, rewrites generic-only storage, and is idempotent', async () => {
		__seedMockStorage('sync', {
			migrationVersion: 2,
			stats: {
				clipboard: 5,
				copyToClipboard: 3,
				download: 7,
				saveFile: 2,
				addToObsidian: 11,
				'custom-uri': 13,
				'local-http': 17,
				share: 19,
				privateCounter: 23,
			},
		});

		const expected = {
			clipboard: 8,
			download: 20,
			'custom-uri': 13,
			'local-http': 17,
			share: 19,
		};
		expect((await loadSettings()).stats).toEqual(expected);
		expect(__getMockStorage('sync')).toMatchObject({
			migrationVersion: 4,
			stats: expected,
		});

		expect((await loadSettings()).stats).toEqual(expected);
		expect(__getMockStorage('sync').stats).toEqual(expected);
	});

	it('increments every generic action', async () => {
		await loadSettings();

		for (const action of ['clipboard', 'download', 'custom-uri', 'local-http', 'share'] as const) {
			await recordClipInStorage(action);
		}

		expect(__getMockStorage('sync').stats).toEqual({
			clipboard: 1,
			download: 1,
			'custom-uri': 1,
			'local-http': 1,
			share: 1,
		});
		expect(__getMockStorage('local')).toEqual({});
	});

	it('floors fractions, rejects corrupt counts, and saturates overflow safely', async () => {
		__seedMockStorage('sync', {
			stats: {
				clipboard: 2.9,
				copyToClipboard: 1.7,
				download: Number.MAX_SAFE_INTEGER,
				saveFile: Number.MAX_SAFE_INTEGER,
				addToObsidian: -4,
				'custom-uri': '7',
				'local-http': Number.MAX_VALUE,
				share: -1,
			},
		});

		expect((await loadSettings()).stats).toEqual({
			clipboard: 3,
			download: Number.MAX_SAFE_INTEGER,
			'custom-uri': 0,
			'local-http': Number.MAX_SAFE_INTEGER,
			share: 0,
		});

		await recordClipInStorage('download');
		expect(__getMockStorage('sync').stats).toMatchObject({
			download: Number.MAX_SAFE_INTEGER,
		});
	});

	it('ignores stale caller stats during ordinary settings saves', async () => {
		await loadSettings();
		const set = vi.spyOn(browser.storage.sync, 'set');

		await saveSettings({
			betaFeatures: true,
			stats: {
				clipboard: 90,
				download: 91,
				'custom-uri': 92,
				'local-http': 93,
				share: 94,
			},
		});

		expect(__getMockStorage('sync').stats).toEqual({
			clipboard: 0,
			download: 0,
			'custom-uri': 0,
			'local-http': 0,
			share: 0,
		});
		expect(__getMockStorage('sync').general_settings).toMatchObject({ betaFeatures: true });
		expect(set.mock.calls[set.mock.calls.length - 1]?.[0]).not.toHaveProperty('stats');
	});

	it('preserves both a delayed stat recording and an interleaved unrelated settings save', async () => {
		await loadSettings();
		const originalGet = browser.storage.sync.get.bind(browser.storage.sync);
		const originalSet = browser.storage.sync.set.bind(browser.storage.sync);
		const get = vi.spyOn(browser.storage.sync, 'get');
		let releaseRecording!: () => void;
		const recordingMayFinish = new Promise<void>((resolve) => {
			releaseRecording = resolve;
		});
		let recordingReachedWrite!: () => void;
		const recordingAtWrite = new Promise<void>((resolve) => {
			recordingReachedWrite = resolve;
		});
		let recordingWrite: Record<string, unknown> | undefined;
		let delayedRecordingWrite = false;
		vi.spyOn(browser.storage.sync, 'set').mockImplementation(async (values) => {
			const stats = values.stats as Record<string, unknown> | undefined;
			if (stats?.clipboard === 1 && !delayedRecordingWrite) {
				delayedRecordingWrite = true;
				recordingWrite = values;
				recordingReachedWrite();
				await recordingMayFinish;
			}
			await originalSet(values);
		});

		const recording = recordClipInStorage('clipboard');
		await recordingAtWrite;
		await saveSettings({ betaFeatures: true });
		releaseRecording();
		await recording;

		expect(get).toHaveBeenCalledWith(['stats', 'migrationVersion']);
		expect(Object.keys(recordingWrite ?? {}).sort()).toEqual(['migrationVersion', 'stats']);
		expect(__getMockStorage('sync').stats).toEqual({
			clipboard: 1,
			download: 0,
			'custom-uri': 0,
			'local-http': 0,
			share: 0,
		});
		expect(__getMockStorage('sync').general_settings).toMatchObject({ betaFeatures: true });

		// Keep the bound reference live so the spy cannot accidentally replace the real read.
		expect(await originalGet('stats')).toHaveProperty('stats');
	});
});

describe('generic local clip history', () => {
	function historyEntry(overrides: Record<string, unknown> = {}) {
		return {
			datetime: new Date().toISOString(),
			url: 'https://example.com/article',
			action: 'clipboard',
			...overrides,
		};
	}

	it('recovers from cyclic and non-JSON-safe raw history without throwing', async () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		const valid = historyEntry();
		const raw = [
			...cyclic,
			{ ...valid, extra: cyclic },
		];
		const get = vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ history: raw });
		const set = vi.spyOn(browser.storage.local, 'set').mockResolvedValue();

		await expect(getClipHistory()).resolves.toEqual([valid]);
		expect(set).toHaveBeenCalledWith({ history: [valid] });

		get.mockRestore();
		set.mockRestore();
	});

	it('rejects malformed, too-old, and implausibly future timestamps', async () => {
		const now = Date.now();
		const valid = historyEntry();
		__seedMockStorage('local', {
			history: [
				valid,
				historyEntry({ datetime: 'not-a-date' }),
				historyEntry({ datetime: 'July 13, 2026 06:00:00 GMT' }),
				historyEntry({ datetime: '1999-12-31T23:59:59.999Z' }),
				historyEntry({ datetime: new Date(now + 25 * 60 * 60 * 1000).toISOString() }),
			],
		});

		expect(await getClipHistory()).toEqual([valid]);
	});

	it('keeps only HTTP(S) URLs, drops queries for privacy, and strips credentials and fragments', async () => {
		const oversized = `https://example.com/${'x'.repeat(2048)}`;
		const sanitized = historyEntry({ url: 'https://example.com/path' });
		__seedMockStorage('local', {
			history: [
				{ ...sanitized,
					url: 'https://user:password@example.com/path?token=sensitive#private-fragment',
				},
				historyEntry({ url: 'not a URL' }),
				historyEntry({ url: 'ftp://example.com/file' }),
				historyEntry({ url: oversized }),
			],
		});

		const history = await getClipHistory();
		expect(history).toEqual([sanitized]);
		expect(JSON.stringify(history)).not.toContain('password');
		expect(JSON.stringify(history)).not.toContain('token=');
		expect(JSON.stringify(history)).not.toContain('private-fragment');
	});

	it('rejects oversized titles instead of persisting partial private content', async () => {
		const valid = historyEntry({ title: 'x'.repeat(512) });
		__seedMockStorage('local', {
			history: [
				historyEntry({ title: 'x'.repeat(513) }),
				valid,
			],
		});

		expect(await getClipHistory()).toEqual([valid]);
	});

	it('applies the same URL privacy policy to new runtime writes', async () => {
		await addHistoryEntry(
			'clipboard',
			'https://user:password@example.com/path?token=sensitive#private-fragment',
			'Article',
		);

		expect(__getMockStorage('local').history).toMatchObject([{
			url: 'https://example.com/path',
			action: 'clipboard',
			title: 'Article',
		}]);
	});

	it('maps legacy actions, rejects invalid records, and strips private or unknown fields on read', async () => {
		__seedMockStorage('local', {
			history: [
				{
					datetime: '2026-07-13T01:00:00.000Z',
					url: 'https://example.com/generic',
					action: 'local-http',
					title: 'Generic',
					vault: 'Private vault',
					path: 'Private/path',
					secret: 'sensitive-value',
				},
				{
					datetime: '2026-07-13T00:00:00.000Z',
					url: 'https://example.com/copy',
					action: 'copyToClipboard',
				},
				{
					datetime: '2026-07-12T23:00:00.000Z',
					url: 'https://example.com/save',
					action: 'saveFile',
				},
				{
					datetime: '2026-07-12T22:00:00.000Z',
					url: 'https://example.com/legacy',
					action: 'addToObsidian',
				},
				{ datetime: '2026-07-12T21:00:00.000Z', url: 'https://example.com', action: 'upload' },
				{ datetime: '2026-07-12T20:00:00.000Z', action: 'share' },
				{ datetime: 123, url: 'https://example.com', action: 'share' },
				{ datetime: '2026-07-12T19:00:00.000Z', url: 'https://example.com', action: 'share', title: 42 },
				null,
				['not', 'a', 'record'],
			],
		});

		const expected = [
			{
				datetime: '2026-07-13T01:00:00.000Z',
				url: 'https://example.com/generic',
				action: 'local-http',
				title: 'Generic',
			},
			{
				datetime: '2026-07-13T00:00:00.000Z',
				url: 'https://example.com/copy',
				action: 'clipboard',
			},
			{
				datetime: '2026-07-12T23:00:00.000Z',
				url: 'https://example.com/save',
				action: 'download',
			},
			{
				datetime: '2026-07-12T22:00:00.000Z',
				url: 'https://example.com/legacy',
				action: 'download',
			},
		];

		expect(await getClipHistory()).toEqual(expected);
		expect(__getMockStorage('local').history).toEqual(expected);
		expect(await getClipHistory()).toEqual(expected);
	});

	it('migrates existing entries on write and records only generic fields', async () => {
		__seedMockStorage('local', {
			history: [{
				datetime: '2026-07-12T20:00:00.000Z',
				url: 'https://example.com/legacy',
				action: 'addToObsidian',
				vault: 'Private vault',
				path: 'Private/path',
			}],
		});

		await addHistoryEntry('custom-uri', 'https://example.com/new', 'New clip');

		const history = await getClipHistory();
		expect(history).toHaveLength(2);
		expect(history[0]).toMatchObject({
			url: 'https://example.com/new',
			action: 'custom-uri',
			title: 'New clip',
		});
		expect(Object.keys(history[0]).sort()).toEqual(['action', 'datetime', 'title', 'url']);
		expect(history[1]).toEqual({
			datetime: '2026-07-12T20:00:00.000Z',
			url: 'https://example.com/legacy',
			action: 'download',
		});
	});

	it('normalizes a legacy runtime action before writing a new entry', async () => {
		await addHistoryEntry(
			'saveFile' as unknown as Parameters<typeof addHistoryEntry>[0],
			'https://example.com/legacy-caller',
		);

		expect(__getMockStorage('local').history).toMatchObject([{
			url: 'https://example.com/legacy-caller',
			action: 'download',
		}]);
	});

	it('records history through the generic increment signature', async () => {
		await recordClipInStorage('clipboard', 'https://example.com/article', 'Article');

		const [entry] = await getClipHistory();
		expect(entry).toMatchObject({
			url: 'https://example.com/article',
			action: 'clipboard',
			title: 'Article',
		});
		expect(entry).not.toHaveProperty('vault');
		expect(entry).not.toHaveProperty('path');
	});

	it('retains at most the newest 1000 valid entries', async () => {
		const history = Array.from({ length: 1005 }, (_, index) => ({
			datetime: `2026-07-13T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
			url: `https://example.com/${index}`,
			action: 'share',
		}));
		__seedMockStorage('local', { history });

		const loaded = await getClipHistory();
		expect(loaded).toHaveLength(1000);
		expect(loaded[0].url).toBe('https://example.com/0');
		expect(loaded[999].url).toBe('https://example.com/999');
		expect(__getMockStorage('local').history).toHaveLength(1000);
	});
});
