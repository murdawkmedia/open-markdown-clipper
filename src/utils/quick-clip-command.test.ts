import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	QuickClipCommandOptions,
	QuickClipMessage,
	QuickClipPopupDetails,
	MAX_QUICK_CLIP_READY_ATTEMPTS,
	QUICK_CLIP_DELIVERY_TIMEOUT_MS,
	QUICK_CLIP_POPUP_DEADLINE_BUDGET_MS,
	QUICK_CLIP_RESPONSE_GRACE_MS,
	runQuickClipCommand,
} from './quick-clip-command';

const NONCE = 'request_nonce-0123456789ABCDEF';
const OTHER_NONCE = 'request_nonce-FEDCBA9876543210';
const PRIVATE_ERROR = 'private source-tab content must not escape';
const NOW_MS = 1_750_000_000_000;
const EXPECTED_DEADLINE_MS = NOW_MS + 14_000;
const MAX_READY_ATTEMPTS = MAX_QUICK_CLIP_READY_ATTEMPTS;
const MAX_READY_DELAY_MS = 1_000;
const MAX_EFFECT_TIMEOUT_MS = 5_000;

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

	return [...methods]
		.filter(method => typeof (console as unknown as Record<string, unknown>)[method] === 'function')
		.map(method => vi.spyOn(console as any, method as any).mockImplementation(() => undefined));
}

function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => undefined);
}

function setup(overrides: Partial<QuickClipCommandOptions> = {}) {
	const effects: string[] = [];
	const setPopup = vi.fn(async ({ popup }: QuickClipPopupDetails): Promise<void> => {
		effects.push(`popup:${popup}`);
	});
	const openPopup = vi.fn(async (): Promise<void> => {
		effects.push('open');
	});
	const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => {
		effects.push(`message:${message.action}:${message.tabId}:${message.nonce}`);
		return message.action === 'quickClipReady'
			? { ready: true, nonce: message.nonce }
			: { success: true, nonce: message.nonce };
	});
	const delay = vi.fn(async (milliseconds: number): Promise<void> => {
		effects.push(`delay:${milliseconds}`);
	});
	const options: QuickClipCommandOptions = {
		tabId: 7,
		nonce: NONCE,
		normalPopup: 'popup.html',
		readyAttempts: 3,
		readyDelayMs: 25,
		effectTimeoutMs: 100,
		now: vi.fn(() => NOW_MS),
		setPopup,
		openPopup,
		sendMessage,
		delay,
		...overrides,
	};

	return {
		effects,
		options,
		setPopup,
		openPopup,
		sendMessage,
		delay,
	};
}

beforeEach(() => {
	consoleSpies = spyOnEveryConsoleMethod();
});

afterEach(() => {
	try {
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	}
});

describe('Quick Clip command coordinator', () => {
	it('ends popup work before background ownership with a fixed response grace period', () => {
		expect(QUICK_CLIP_RESPONSE_GRACE_MS).toBeGreaterThan(0);
		expect(QUICK_CLIP_POPUP_DEADLINE_BUDGET_MS).toBe(
			QUICK_CLIP_DELIVERY_TIMEOUT_MS - QUICK_CLIP_RESPONSE_GRACE_MS,
		);
		expect(QUICK_CLIP_POPUP_DEADLINE_BUDGET_MS).toBeLessThan(
			QUICK_CLIP_DELIVERY_TIMEOUT_MS,
		);
	});

	it('opens a nonce-targeted popup, restores normal configuration, retries readiness, and triggers once', async () => {
		const effects: string[] = [];
		const responses: Array<unknown | Error> = [
			new Error(PRIVATE_ERROR),
			{ ready: false, nonce: NONCE },
			{ ready: true, nonce: NONCE },
			{ success: true, nonce: NONCE },
		];
		const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => {
			effects.push(`message:${message.action}:${message.tabId}:${message.nonce}`);
			const response = responses.shift();
			if (response instanceof Error) throw response;
			return response;
		});
		const { options, setPopup, openPopup, delay } = setup({
			tabId: 0,
			normalPopup: '',
			sendMessage,
			setPopup: vi.fn(async ({ popup }: QuickClipPopupDetails): Promise<void> => {
				effects.push(`popup:${popup}`);
			}),
			openPopup: vi.fn(async (): Promise<void> => {
				effects.push('open');
			}),
			delay: vi.fn(async (milliseconds: number): Promise<void> => {
				effects.push(`delay:${milliseconds}`);
			}),
		});

		await expect(runQuickClipCommand(options)).resolves.toBe(true);
		expect(options.setPopup).toHaveBeenCalledWith({
			popup: `popup.html?quick=1&tabId=0&nonce=${NONCE}`,
		});
		expect(options.setPopup).toHaveBeenLastCalledWith({ popup: '' });
		expect(options.setPopup).toHaveBeenCalledTimes(2);
		expect(options.openPopup).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls).toEqual([
			[{ action: 'quickClipReady', tabId: 0, nonce: NONCE }],
			[{ action: 'quickClipReady', tabId: 0, nonce: NONCE }],
			[{ action: 'quickClipReady', tabId: 0, nonce: NONCE }],
			[{
				action: 'triggerQuickClip',
				tabId: 0,
				nonce: NONCE,
				deadline: EXPECTED_DEADLINE_MS,
			}],
		]);
		expect(options.delay).toHaveBeenCalledTimes(2);
		expect(options.delay).toHaveBeenNthCalledWith(1, 25);
		expect(options.delay).toHaveBeenNthCalledWith(2, 25);
		expect(effects).toEqual([
			`popup:popup.html?quick=1&tabId=0&nonce=${NONCE}`,
			'open',
			'popup:',
			`message:quickClipReady:0:${NONCE}`,
			'delay:25',
			`message:quickClipReady:0:${NONCE}`,
			'delay:25',
			`message:quickClipReady:0:${NONCE}`,
			`message:triggerQuickClip:0:${NONCE}`,
		]);
		expect(setPopup).not.toHaveBeenCalled();
		expect(openPopup).not.toHaveBeenCalled();
		expect(delay).not.toHaveBeenCalled();
	});

	it('coalesces concurrent invocations for the same tab to the identical promise and effects', async () => {
		let releaseOpen!: () => void;
		const opening = new Promise<void>(resolve => {
			releaseOpen = resolve;
		});
		const first = setup({
			openPopup: vi.fn(async () => opening),
		});
		const second = setup({ nonce: OTHER_NONCE });

		const firstResult = runQuickClipCommand(first.options);
		const secondResult = runQuickClipCommand(second.options);
		expect(secondResult).toBe(firstResult);
		expect(second.setPopup).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(first.options.openPopup).toHaveBeenCalledTimes(1));
		releaseOpen();
		await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([true, true]);
		expect(first.setPopup).toHaveBeenCalledTimes(2);
		expect(first.sendMessage).toHaveBeenCalledTimes(2);
		expect(second.openPopup).not.toHaveBeenCalled();
		expect(second.sendMessage).not.toHaveBeenCalled();
	});

	it('keeps a slow delivery coalesced after the ordinary effect timeout', async () => {
		vi.useFakeTimers();
		let resolveTrigger!: (response: unknown) => void;
		const triggerResponse = new Promise<unknown>(resolve => {
			resolveTrigger = resolve;
		});
		const sendMessage = vi.fn((message: QuickClipMessage): Promise<unknown> => (
			message.action === 'quickClipReady'
				? Promise.resolve({ ready: true, nonce: NONCE })
				: triggerResponse
		));
		const first = setup({
			effectTimeoutMs: MAX_EFFECT_TIMEOUT_MS,
			sendMessage,
		});
		const repeated = setup({ nonce: OTHER_NONCE });

		const firstResult = runQuickClipCommand(first.options);
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
		// A configured Local HTTP delivery may legitimately resolve near its
		// ten-second destination timeout.
		await vi.advanceTimersByTimeAsync(9_000);
		const repeatedResult = runQuickClipCommand(repeated.options);
		const sharedTheOriginalInvocation = repeatedResult === firstResult;

		resolveTrigger({ success: true, nonce: NONCE });
		const results = await Promise.all([firstResult, repeatedResult]);

		expect(sharedTheOriginalInvocation).toBe(true);
		expect(results).toEqual([true, true]);
		expect(repeated.setPopup).not.toHaveBeenCalled();
		expect(repeated.openPopup).not.toHaveBeenCalled();
		expect(repeated.sendMessage).not.toHaveBeenCalled();
	});

	it('returns false for a concurrent different tab without mutating its popup', async () => {
		let releaseOpen!: () => void;
		const opening = new Promise<void>(resolve => {
			releaseOpen = resolve;
		});
		const first = setup({ openPopup: vi.fn(async () => opening) });
		const second = setup({ tabId: 8, nonce: OTHER_NONCE });

		const firstResult = runQuickClipCommand(first.options);
		await expect(runQuickClipCommand(second.options)).resolves.toBe(false);
		expect(second.setPopup).not.toHaveBeenCalled();
		expect(second.openPopup).not.toHaveBeenCalled();
		expect(second.sendMessage).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(first.options.openPopup).toHaveBeenCalledTimes(1));
		releaseOpen();
		await expect(firstResult).resolves.toBe(true);
	});

	it.each([
		'',
		'short_nonce',
		'a'.repeat(129),
		'request nonce 0123456789',
		'request/nonce/0123456789',
		'request?nonce=0123456789',
		'request_nonce-åbcdefghijklmnop',
	])('rejects malformed request nonce %p without invoking effects', async (nonce) => {
		const { options, setPopup, openPopup, sendMessage, delay } = setup({ nonce });
		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(setPopup).not.toHaveBeenCalled();
		expect(openPopup).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		expect(delay).not.toHaveBeenCalled();
	});

	it.each([
		{ stage: 'readiness', response: { ready: true, nonce: OTHER_NONCE }, expectedCalls: 1 },
		{ stage: 'trigger', response: { success: true, nonce: OTHER_NONCE }, expectedCalls: 2 },
	])('returns false when the $stage response echoes a stale nonce', async ({ stage, response, expectedCalls }) => {
		const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => {
			if (stage === 'readiness') return response;
			return message.action === 'quickClipReady'
				? { ready: true, nonce: NONCE }
				: response;
		});
		const { options } = setup({ readyAttempts: 1, sendMessage });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(sendMessage).toHaveBeenCalledTimes(expectedCalls);
	});

	it('restores the supplied normal popup when opening fails', async () => {
		const { effects, options, setPopup, sendMessage } = setup({
			openPopup: vi.fn(async () => {
				effects.push('open');
				throw new Error(PRIVATE_ERROR);
			}),
		});

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(setPopup.mock.calls).toEqual([
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${NONCE}` }],
			[{ popup: 'popup.html' }],
		]);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it('times out after the bounded attempts without sending a trigger', async () => {
		const sendMessage = vi.fn(async (): Promise<unknown> => ({ ready: false, nonce: NONCE }));
		const { options, delay } = setup({ sendMessage });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(sendMessage.mock.calls).toEqual([
			[{ action: 'quickClipReady', tabId: 7, nonce: NONCE }],
			[{ action: 'quickClipReady', tabId: 7, nonce: NONCE }],
			[{ action: 'quickClipReady', tabId: 7, nonce: NONCE }],
		]);
		expect(delay).toHaveBeenCalledTimes(2);
	});

	it('sends the trigger exactly once and returns false when its receiver fails', async () => {
		const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => {
			if (message.action === 'quickClipReady') return { ready: true, nonce: NONCE };
			throw new Error(PRIVATE_ERROR);
		});
		const { options } = setup({ sendMessage });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(sendMessage.mock.calls).toEqual([
			[{ action: 'quickClipReady', tabId: 7, nonce: NONCE }],
			[{
				action: 'triggerQuickClip',
				tabId: 7,
				nonce: NONCE,
				deadline: EXPECTED_DEADLINE_MS,
			}],
		]);
	});

	it.each([
		-1,
		1.5,
		NaN,
		Infinity,
		-Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		'7',
		null,
		undefined,
	])('rejects malformed tab id %p without invoking effects', async (tabId) => {
		const { options, setPopup, openPopup, sendMessage, delay } = setup({ tabId });
		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(setPopup).not.toHaveBeenCalled();
		expect(openPopup).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		expect(delay).not.toHaveBeenCalled();
	});

	it.each([
		null,
		true,
		{ success: 1, nonce: NONCE },
		{ success: false, nonce: NONCE },
		{ success: true },
		{ success: true, nonce: NONCE, extra: PRIVATE_ERROR },
		Object.assign(Object.create({ inherited: PRIVATE_ERROR }), { success: true, nonce: NONCE }),
		Object.create({ success: true, nonce: NONCE }),
		[true, NONCE],
	])('returns false unless the trigger response is exactly nonce-bound success: %p', async (response) => {
		const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => (
			message.action === 'quickClipReady'
				? { ready: true, nonce: NONCE }
				: response
		));
		const { options } = setup({ sendMessage });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('rejects accessor response shapes without evaluating them', async () => {
		const getter = vi.fn(() => {
			throw new Error(PRIVATE_ERROR);
		});
		const response = { nonce: NONCE };
		Object.defineProperty(response, 'success', { enumerable: true, get: getter });
		const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => (
			message.action === 'quickClipReady'
				? { ready: true, nonce: NONCE }
				: response
		));
		const { options } = setup({ sendMessage });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(['transparent', 'trapping'])('fails closed on a %s Proxy response', async (kind) => {
		const target = { success: true, nonce: NONCE };
		const response = kind === 'transparent'
			? new Proxy(target, {})
			: new Proxy(target, {
				getPrototypeOf() {
					throw new Error(PRIVATE_ERROR);
				},
			});
		const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => (
			message.action === 'quickClipReady'
				? { ready: true, nonce: NONCE }
				: response
		));
		const { options } = setup({ sendMessage });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('fails closed when structuredClone is unavailable', async () => {
		vi.stubGlobal('structuredClone', undefined);
		const { options, sendMessage } = setup({ readyAttempts: 1 });

		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ readyAttempts: 0 },
		{ readyAttempts: MAX_READY_ATTEMPTS + 1 },
		{ readyAttempts: 1.5 },
		{ readyDelayMs: -1 },
		{ readyDelayMs: MAX_READY_DELAY_MS + 1 },
		{ effectTimeoutMs: 0 },
		{ effectTimeoutMs: MAX_EFFECT_TIMEOUT_MS + 1 },
		{ effectTimeoutMs: Infinity },
		{ normalPopup: null },
	])('rejects polling, timeout, or popup settings outside explicit bounds: %p', async (override) => {
		const { options, setPopup } = setup(override);
		await expect(runQuickClipCommand(options)).resolves.toBe(false);
		expect(setPopup).not.toHaveBeenCalled();
	});

	it.each(['configure', 'open', 'restore', 'readiness', 'delay', 'trigger'])
		('bounds a never-settling %s effect and returns false', async (stage) => {
			vi.useFakeTimers();
			const setPopup = vi.fn(async (): Promise<unknown> => undefined);
			const openPopup = vi.fn(async (): Promise<unknown> => undefined);
			const sendMessage = vi.fn(async (message: QuickClipMessage): Promise<unknown> => (
				message.action === 'quickClipReady'
					? { ready: true, nonce: NONCE }
					: { success: true, nonce: NONCE }
			));
			const delay = vi.fn(async (): Promise<unknown> => undefined);

			if (stage === 'configure') {
				setPopup.mockImplementationOnce(neverSettles).mockResolvedValueOnce(undefined);
			} else if (stage === 'open') {
				openPopup.mockImplementationOnce(neverSettles);
			} else if (stage === 'restore') {
				setPopup.mockResolvedValueOnce(undefined).mockImplementationOnce(neverSettles);
			} else if (stage === 'readiness') {
				sendMessage.mockImplementationOnce(neverSettles);
			} else if (stage === 'delay') {
				sendMessage.mockResolvedValueOnce({ ready: false, nonce: NONCE });
				delay.mockImplementationOnce(neverSettles);
			} else {
				sendMessage
					.mockResolvedValueOnce({ ready: true, nonce: NONCE })
					.mockImplementationOnce(neverSettles);
			}

			const { options } = setup({
				readyAttempts: stage === 'delay' ? 2 : 1,
				effectTimeoutMs: 10,
				setPopup,
				openPopup,
				sendMessage,
				delay,
			});
			const result = runQuickClipCommand(options);
			await vi.advanceTimersByTimeAsync(
				stage === 'trigger' ? QUICK_CLIP_DELIVERY_TIMEOUT_MS + 1 : 11,
			);
			await expect(result).resolves.toBe(false);
		});

	it('does not invoke caller-supplied source-tab close or navigation extras', async () => {
		const closeSourceTab = vi.fn();
		const navigateSourceTab = vi.fn();
		const { options } = setup();
		const extended = { ...options, closeSourceTab, navigateSourceTab };

		await expect(runQuickClipCommand(extended)).resolves.toBe(true);
		expect(closeSourceTab).not.toHaveBeenCalled();
		expect(navigateSourceTab).not.toHaveBeenCalled();
	});
});
