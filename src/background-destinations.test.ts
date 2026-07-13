import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DestinationError } from './destinations/types';
import {
	CustomUriBackgroundEffects,
	dispatchOpenCustomUriMessage,
	handleOpenCustomUriMessage,
} from './utils/custom-uri-opener';

const VALID_URI = 'notes-app://capture?title=Private%20page';
const PRIVATE_CONTENT = '# private markdown that must not escape';

type ConsoleSpy = ReturnType<typeof vi.spyOn>;
let consoleSpies: ConsoleSpy[] = [];

function spyOnEveryConsoleMethod(): ConsoleSpy[] {
	const methods = new Set<string>();
	let owner: object | null = console;
	while (owner && owner !== Object.prototype) {
		for (const key of Object.getOwnPropertyNames(owner)) {
			if (key !== 'constructor') methods.add(key);
		}
		owner = Object.getPrototypeOf(owner);
	}

	return [...methods].flatMap((method) => {
		if (typeof (console as unknown as Record<string, unknown>)[method] !== 'function') {
			return [];
		}
		try {
			return [vi.spyOn(console as any, method as any).mockImplementation(() => undefined)];
		} catch {
			return [];
		}
	});
}

async function expectCode(
	value: unknown,
	opener: (uri: string) => void | Promise<void>,
	code = 'invalid-custom-uri',
): Promise<void> {
	try {
		await handleOpenCustomUriMessage(value, opener);
		throw new Error('expected custom URI message to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).code).toBe(code);
		expect((error as Error).message).toBe(code);
		expect((error as Error).message).not.toContain(PRIVATE_CONTENT);
		expect(Object.keys(error as object).sort()).toEqual(['code', 'name']);
		expect(JSON.stringify(error)).not.toContain(PRIVATE_CONTENT);
	}
}

beforeEach(() => {
	consoleSpies = spyOnEveryConsoleMethod();
});

afterEach(() => {
	try {
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	}
});

describe('background custom URI message boundary', () => {
	it('awaits the opener for an exact, plain, metadata-only message', async () => {
		const effects: string[] = [];
		let finishOpening!: () => void;
		const opening = new Promise<void>((resolve) => {
			finishOpening = resolve;
		});
		const opener = vi.fn(async (uri: string) => {
			effects.push(`opening:${uri}`);
			await opening;
			effects.push('opened');
		});

		const pending = handleOpenCustomUriMessage(
			Object.freeze({ action: 'openCustomUri', uri: VALID_URI }),
			opener,
		);
		await Promise.resolve();
		expect(effects).toEqual([`opening:${VALID_URI}`]);

		finishOpening();
		await expect(pending).resolves.toBeUndefined();
		expect(effects).toEqual([`opening:${VALID_URI}`, 'opened']);
		expect(opener).toHaveBeenCalledWith(VALID_URI);
	});

	it.each([
		null,
		undefined,
		'openCustomUri',
		42,
		[],
		new Date(),
		Object.create(null),
		Object.create({ action: 'openCustomUri', uri: VALID_URI }),
		Object.assign(Object.create({ inherited: PRIVATE_CONTENT }), {
			action: 'openCustomUri',
			uri: VALID_URI,
		}),
	])('rejects non-plain and inherited message shapes: %p', async (value) => {
		const opener = vi.fn();
		await expectCode(value, opener);
		expect(opener).not.toHaveBeenCalled();
	});

	it.each([
		{ action: 'wrongAction', uri: VALID_URI },
		{ action: 'openCustomUri' },
		{ uri: VALID_URI },
		{ action: 'openCustomUri', uri: 42 },
		{ action: 'openCustomUri', uri: VALID_URI, extra: PRIVATE_CONTENT },
	])('rejects messages that are not exactly the required action and URI: %p', async (value) => {
		const opener = vi.fn();
		await expectCode(value, opener);
		expect(opener).not.toHaveBeenCalled();
	});

	it.each(['content', 'markdown', 'authorization', 'headers', 'token'])
		('rejects a message carrying an extra %s field', async (field) => {
			const opener = vi.fn();
			await expectCode({
				action: 'openCustomUri',
				uri: VALID_URI,
				[field]: PRIVATE_CONTENT,
			}, opener);
			expect(opener).not.toHaveBeenCalled();
		});

	it('rejects symbol and non-enumerable keys', async () => {
		const symbolMessage = {
			action: 'openCustomUri',
			uri: VALID_URI,
			[Symbol('private')]: PRIVATE_CONTENT,
		};
		const hiddenMessage = { action: 'openCustomUri', uri: VALID_URI };
		Object.defineProperty(hiddenMessage, 'hidden', { value: PRIVATE_CONTENT });
		const hiddenRequiredProperty = { action: 'openCustomUri' };
		Object.defineProperty(hiddenRequiredProperty, 'uri', { value: VALID_URI });

		for (const value of [symbolMessage, hiddenMessage, hiddenRequiredProperty]) {
			const opener = vi.fn();
			await expectCode(value, opener);
			expect(opener).not.toHaveBeenCalled();
		}
	});

	it('rejects accessors without invoking them', async () => {
		for (const field of ['action', 'uri'] as const) {
			const getter = vi.fn(() => {
				throw new Error(PRIVATE_CONTENT);
			});
			const value: Record<string, unknown> = field === 'action'
				? { uri: VALID_URI }
				: { action: 'openCustomUri' };
			Object.defineProperty(value, field, { enumerable: true, get: getter });

			const opener = vi.fn();
			await expectCode(value, opener);
			expect(getter).not.toHaveBeenCalled();
			expect(opener).not.toHaveBeenCalled();
		}
	});

	it('rejects transparent and trapping proxy-like inputs with bounded errors', async () => {
		const transparent = new Proxy({ action: 'openCustomUri', uri: VALID_URI }, {});
		const trapping = new Proxy({ action: 'openCustomUri', uri: VALID_URI }, {
			getPrototypeOf() {
				throw new DestinationError(PRIVATE_CONTENT);
			},
		});

		for (const value of [transparent, trapping]) {
			const opener = vi.fn();
			await expectCode(value, opener);
			expect(opener).not.toHaveBeenCalled();
		}
	});

	it.each([
		'capture?title=private',
		'https://example.com/private',
		'notes:clip?content={content}',
		`notes:${'x'.repeat(2043)}`,
	])('validates the final URI before opening: %s', async (uri) => {
		const opener = vi.fn();
		const expectedCode = uri.length > 2048
			? 'custom-uri-too-long'
			: 'invalid-custom-uri';
		await expectCode({ action: 'openCustomUri', uri }, opener, expectedCode);
		expect(opener).not.toHaveBeenCalled();
	});

	it.each([
		() => { throw new Error(PRIVATE_CONTENT); },
		async () => { throw new Error(PRIVATE_CONTENT); },
	])('maps opener failures to one content-free error', async (opener) => {
		await expectCode(
			{ action: 'openCustomUri', uri: VALID_URI },
			opener,
			'custom-uri-open-failed',
		);
	});

	it('fails closed when structured cloning is unavailable', async () => {
		vi.stubGlobal('structuredClone', undefined);
		const opener = vi.fn();

		await expectCode({ action: 'openCustomUri', uri: VALID_URI }, opener);
		expect(opener).not.toHaveBeenCalled();
	});
});

function setupBackgroundEffects(
	overrides: Partial<CustomUriBackgroundEffects> = {},
): {
	effects: CustomUriBackgroundEffects;
	hasTransmissionConsent: ReturnType<typeof vi.fn>;
	queryTabs: ReturnType<typeof vi.fn>;
	updateTab: ReturnType<typeof vi.fn>;
} {
	const queryTabs = vi.fn(async () => [{ id: 7 }]);
	const updateTab = vi.fn(async () => undefined);
	const hasTransmissionConsent = vi.fn(async () => true);
	return {
		effects: {
			hasTransmissionConsent,
			queryTabs,
			updateTab,
			...overrides,
		},
		hasTransmissionConsent,
		queryTabs,
		updateTab,
	};
}

describe('production custom URI background dispatch', () => {
	it('wires the read-only consent dispatcher and a background URI recheck', () => {
		const background = readFileSync(new URL('./background.ts', import.meta.url), 'utf8');

		expect(background).toMatch(/createDataConsentController\(/);
		expect(background).toMatch(/dispatchDataTransmissionConsentCheckMessage\([\s\S]*dataConsentController\.hasConsent/);
		expect(background).toMatch(/dispatchOpenCustomUriMessage\([\s\S]*hasTransmissionConsent:\s*\(\)\s*=>\s*dataConsentController\.hasConsent\('custom-uri'\)/);
	});

	it('ignores unrelated raw messages before using effects', () => {
		const { effects, queryTabs, updateTab } = setupBackgroundEffects();
		const sendResponse = vi.fn();

		expect(dispatchOpenCustomUriMessage(
			{ action: 'openLegacyUri', url: VALID_URI },
			effects,
			sendResponse,
		)).toBeUndefined();
		expect(queryTabs).not.toHaveBeenCalled();
		expect(updateTab).not.toHaveBeenCalled();
		expect(sendResponse).not.toHaveBeenCalled();
	});

	it('returns true immediately and waits for tab navigation before success', async () => {
		let finishUpdate!: () => void;
		const updating = new Promise<void>((resolve) => {
			finishUpdate = resolve;
		});
		const updateTab = vi.fn(async () => updating);
		const { effects, queryTabs } = setupBackgroundEffects({ updateTab });
		const sendResponse = vi.fn();

		const handled = dispatchOpenCustomUriMessage(
			{ action: 'openCustomUri', uri: VALID_URI },
			effects,
			sendResponse,
		);

		expect(handled).toBe(true);
		await vi.waitFor(() => expect(updateTab).toHaveBeenCalledTimes(1));
		expect(queryTabs).toHaveBeenCalledWith({ active: true, currentWindow: true });
		expect(updateTab).toHaveBeenCalledWith(7, VALID_URI);
		expect(sendResponse).not.toHaveBeenCalled();

		finishUpdate();
		await vi.waitFor(() => {
			expect(sendResponse).toHaveBeenCalledWith({ success: true });
		});
	});

	it('fails closed after revocation before querying or navigating any tab', async () => {
		const { effects, hasTransmissionConsent, queryTabs, updateTab } = setupBackgroundEffects();
		hasTransmissionConsent.mockResolvedValue(false);
		const sendResponse = vi.fn();

		expect(dispatchOpenCustomUriMessage(
			{ action: 'openCustomUri', uri: VALID_URI },
			effects,
			sendResponse,
		)).toBe(true);
		await vi.waitFor(() => {
			expect(sendResponse).toHaveBeenCalledWith({
				success: false,
				error: 'custom-uri-open-failed',
			});
		});
		expect(hasTransmissionConsent).toHaveBeenCalledOnce();
		expect(queryTabs).not.toHaveBeenCalled();
		expect(updateTab).not.toHaveBeenCalled();
		expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(VALID_URI);
	});

	it.each([
		['query failure', async () => { throw new Error(PRIVATE_CONTENT); }, undefined],
		['no active tab', async () => [], undefined],
		['missing tab id', async () => [{}], undefined],
		['negative tab id', async () => [{ id: -1 }], undefined],
		['fractional tab id', async () => [{ id: 1.5 }], undefined],
		['infinite tab id', async () => [{ id: Number.POSITIVE_INFINITY }], undefined],
		['non-numeric tab id', async () => [{ id: '7' }], undefined],
		['update failure', async () => [{ id: 7 }], async () => { throw new Error(PRIVATE_CONTENT); }],
	] as const)('returns only the fixed failure response for %s', async (
		_name,
		queryTabs,
		updateOverride,
	) => {
		const updateTab = updateOverride ?? (async () => undefined);
		const { effects } = setupBackgroundEffects({
			queryTabs: vi.fn(queryTabs),
			updateTab: vi.fn(updateTab),
		});
		const sendResponse = vi.fn();

		expect(dispatchOpenCustomUriMessage(
			{ action: 'openCustomUri', uri: VALID_URI },
			effects,
			sendResponse,
		)).toBe(true);
		await vi.waitFor(() => {
			expect(sendResponse).toHaveBeenCalledWith({
				success: false,
				error: 'custom-uri-open-failed',
			});
		});
		expect(sendResponse).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(PRIVATE_CONTENT);
	});

	it('maps malformed openCustomUri messages without querying tabs', async () => {
		const { effects, queryTabs, updateTab } = setupBackgroundEffects();
		const sendResponse = vi.fn();

		expect(dispatchOpenCustomUriMessage(
			{ action: 'openCustomUri', uri: 'https://example.com/private' },
			effects,
			sendResponse,
		)).toBe(true);
		await vi.waitFor(() => {
			expect(sendResponse).toHaveBeenCalledWith({
				success: false,
				error: 'custom-uri-open-failed',
			});
		});
		expect(queryTabs).not.toHaveBeenCalled();
		expect(updateTab).not.toHaveBeenCalled();
	});

	it('contains sendResponse failures instead of creating a rejected task', async () => {
		const { effects } = setupBackgroundEffects();
		const sendResponse = vi.fn(() => {
			throw new Error(PRIVATE_CONTENT);
		});

		expect(dispatchOpenCustomUriMessage(
			{ action: 'openCustomUri', uri: VALID_URI },
			effects,
			sendResponse,
		)).toBe(true);
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
	});
});
