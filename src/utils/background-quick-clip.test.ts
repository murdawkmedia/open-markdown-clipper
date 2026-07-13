import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BACKGROUND_QUICK_CLIP_READY_ATTEMPTS,
	BACKGROUND_QUICK_CLIP_READY_DELAY_MS,
	BackgroundQuickClipEffects,
	createBackgroundQuickClipController,
} from './background-quick-clip';

const FIRST_NONCE = '00000000-0000-4000-8000-000000000001';
const SECOND_NONCE = '00000000-0000-4000-8000-000000000002';
const PRIVATE_ERROR = 'private source-page content must not escape';

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

function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => undefined);
}

function setup(overrides: Partial<BackgroundQuickClipEffects> = {}) {
	const effectsLog: string[] = [];
	const setPopup = vi.fn(async ({ popup }: { readonly popup: string; readonly tabId?: number }): Promise<void> => {
		effectsLog.push(`popup:${popup}`);
	});
	const openPopup = vi.fn(async (_details?: { readonly windowId: number }): Promise<void> => {
		effectsLog.push('open');
	});
	const sendMessage = vi.fn(async (message: {
		readonly action: 'quickClipReady' | 'triggerQuickClip';
		readonly tabId: number;
		readonly nonce: string;
	}): Promise<unknown> => {
		effectsLog.push(`message:${message.action}:${message.tabId}:${message.nonce}`);
		return message.action === 'quickClipReady'
			? { ready: true, nonce: message.nonce }
			: { success: true, nonce: message.nonce };
	});
	const createNonce = vi.fn(() => FIRST_NONCE);
	const now = vi.fn(() => 1_750_000_000_000);
	const delay = vi.fn(async (milliseconds: number): Promise<void> => {
		effectsLog.push(`delay:${milliseconds}`);
	});
	const effects: BackgroundQuickClipEffects = {
		setPopup,
		openPopup,
		sendMessage,
		createNonce,
		now,
		delay,
		...overrides,
	};
	const controller = createBackgroundQuickClipController(effects, 'popup.html');

	return {
		controller,
		effects,
		effectsLog,
		setPopup,
		openPopup,
		sendMessage,
		createNonce,
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
		vi.restoreAllMocks();
	}
});

describe('background Quick Clip popup owner', () => {
	it('scopes the temporary popup to tab zero and opens it in source window zero', async () => {
		const { controller, setPopup, openPopup } = setup();

		await expect((controller.run as (...args: unknown[]) => Promise<boolean>)(0, 0)).resolves.toBe(true);

		expect(setPopup.mock.calls[0]).toEqual([{
			popup: `popup.html?quick=1&tabId=0&nonce=${FIRST_NONCE}`,
			tabId: 0,
		}]);
		expect(setPopup.mock.calls[1]).toEqual([{ popup: 'popup.html', tabId: 0 }]);
		expect(openPopup).toHaveBeenCalledWith({ windowId: 0 });
	});

	it('keeps prior Quick Clip tabs aligned with later normal-popup settings', async () => {
		const { controller, setPopup } = setup();

		await expect((controller.run as (...args: unknown[]) => Promise<boolean>)(7, 3)).resolves.toBe(true);
		setPopup.mockClear();
		await expect(controller.setNormalPopup('')).resolves.toBe(true);

		expect(setPopup.mock.calls).toEqual([
			[{ popup: '' }],
			[{ popup: '', tabId: 7 }],
		]);
	});

	it('stops maintaining a tab-scoped override after the tab is released', async () => {
		const { controller, setPopup } = setup();

		await expect(controller.run(7, 3)).resolves.toBe(true);
		controller.releaseTab(7);
		setPopup.mockClear();
		await expect(controller.setNormalPopup('')).resolves.toBe(true);

		expect(setPopup.mock.calls).toEqual([[{ popup: '' }]]);
	});

	it('reconciles valid tracked tabs after a background restart using string popups only', async () => {
		const { controller, setPopup } = setup();

		controller.trackTabs([0, 7, -1, 1.5, '8', null]);
		await expect(controller.setNormalPopup('')).resolves.toBe(true);

		expect(setPopup.mock.calls).toEqual([
			[{ popup: '' }],
			[{ popup: '', tabId: 0 }],
			[{ popup: '', tabId: 7 }],
		]);
		for (const [{ popup }] of setPopup.mock.calls) expect(typeof popup).toBe('string');
	});

	it('runs tab zero through the nonce-bound command protocol', async () => {
		const { controller, effectsLog, createNonce, delay } = setup();

		await expect(controller.run(0, 3)).resolves.toBe(true);

		expect(createNonce).toHaveBeenCalledTimes(1);
		expect(delay).not.toHaveBeenCalled();
		expect(effectsLog).toEqual([
			`popup:popup.html?quick=1&tabId=0&nonce=${FIRST_NONCE}`,
			'open',
			'popup:popup.html',
			`message:quickClipReady:0:${FIRST_NONCE}`,
			`message:triggerQuickClip:0:${FIRST_NONCE}`,
			'popup:popup.html',
			'popup:popup.html',
		]);
	});

	it('uses a fresh nonce for each sequential invocation', async () => {
		const createNonce = vi.fn()
			.mockReturnValueOnce(FIRST_NONCE)
			.mockReturnValueOnce(SECOND_NONCE);
		const { controller, sendMessage } = setup({ createNonce });

		await expect(controller.run(7, 3)).resolves.toBe(true);
		await expect(controller.run(7, 3)).resolves.toBe(true);

		expect(createNonce).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
			{ action: 'quickClipReady', tabId: 7, nonce: FIRST_NONCE },
			{
				action: 'triggerQuickClip',
				tabId: 7,
				nonce: FIRST_NONCE,
				deadline: 1_750_000_014_000,
			},
			{ action: 'quickClipReady', tabId: 7, nonce: SECOND_NONCE },
			{
				action: 'triggerQuickClip',
				tabId: 7,
				nonce: SECOND_NONCE,
				deadline: 1_750_000_014_000,
			},
		]);
	});

	it('uses the accepted readiness caps instead of the legacy half-second guess', async () => {
		const sendMessage = vi.fn(async (message: {
			readonly action: 'quickClipReady' | 'triggerQuickClip';
			readonly nonce: string;
		}): Promise<unknown> => (
			message.action === 'quickClipReady'
				? { ready: false, nonce: message.nonce }
				: { success: true, nonce: message.nonce }
		));
		const { controller, delay } = setup({ sendMessage });

		await expect(controller.run(7, 3)).resolves.toBe(false);
		expect(BACKGROUND_QUICK_CLIP_READY_ATTEMPTS).toBe(60);
		expect(BACKGROUND_QUICK_CLIP_READY_DELAY_MS).toBe(1_000);
		expect(sendMessage).toHaveBeenCalledTimes(60);
		expect(delay).toHaveBeenCalledTimes(59);
		for (const call of delay.mock.calls) expect(call).toEqual([1_000]);
	});

	it('shares one promise for concurrent calls on the same tab and rejects a different tab', async () => {
		let releaseOpen!: () => void;
		const opening = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const openPopup = vi.fn(async () => opening);
		const { controller, setPopup, sendMessage, createNonce } = setup({ openPopup });

		const first = controller.run(7, 3);
		const sameTab = controller.run(7, 3);
		expect(sameTab).toBe(first);
		await expect(controller.run(8, 3)).resolves.toBe(false);
		expect(createNonce).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(openPopup).toHaveBeenCalledTimes(1));

		releaseOpen();
		await expect(Promise.all([first, sameTab])).resolves.toEqual([true, true]);
		expect(setPopup).toHaveBeenCalledTimes(4);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('rejects the same tab from a different source window while a command is active', async () => {
		let releaseOpen!: () => void;
		const opening = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const openPopup = vi.fn(async () => opening);
		const { controller, createNonce } = setup({ openPopup });

		const first = controller.run(7, 3);
		await vi.waitFor(() => expect(openPopup).toHaveBeenCalledTimes(1));
		await expect(controller.run(7, 4)).resolves.toBe(false);
		expect(createNonce).toHaveBeenCalledTimes(1);

		releaseOpen();
		await expect(first).resolves.toBe(true);
	});

	it('retracks the source when navigation clears ownership before the scoped restore', async () => {
		let releaseOpen!: () => void;
		const opening = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const openPopup = vi.fn(async () => opening);
		const { controller, setPopup } = setup({ openPopup });

		const running = controller.run(7, 3);
		await vi.waitFor(() => expect(openPopup).toHaveBeenCalledTimes(1));
		controller.releaseTab(7);
		releaseOpen();
		await expect(running).resolves.toBe(true);
		setPopup.mockClear();
		await expect(controller.setNormalPopup('')).resolves.toBe(true);

		expect(setPopup.mock.calls).toEqual([
			[{ popup: '' }],
			[{ popup: '', tabId: 7 }],
		]);
	});

	it('defers settings popup writes and reapplies only the latest popup after Quick Clip', async () => {
		let releaseOpen!: () => void;
		const opening = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const openPopup = vi.fn(async () => opening);
		const { controller, setPopup } = setup({ openPopup });

		const running = controller.run(7, 3);
		await vi.waitFor(() => expect(openPopup).toHaveBeenCalledTimes(1));
		const firstDeferred = controller.setNormalPopup('');
		const latestDeferred = controller.setNormalPopup('popup.html');
		expect(setPopup).toHaveBeenCalledTimes(1);

		releaseOpen();
		await expect(running).resolves.toBe(true);
		await expect(Promise.all([firstDeferred, latestDeferred])).resolves.toEqual([true, true]);
		expect(setPopup.mock.calls).toEqual([
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: 'popup.html' }],
			[{ popup: 'popup.html', tabId: 7 }],
		]);
	});

	it('loops restoration when the desired popup changes while the latest write is settling', async () => {
		let releaseFinalRestore!: () => void;
		const finalRestore = new Promise<void>((resolve) => {
			releaseFinalRestore = resolve;
		});
		let setCall = 0;
		const setPopup = vi.fn(async (): Promise<void> => {
			setCall += 1;
			if (setCall === 3) await finalRestore;
		});
		const { controller } = setup({ setPopup });

		const running = controller.run(7, 3);
		await vi.waitFor(() => expect(setPopup).toHaveBeenCalledTimes(4));
		const deferred = controller.setNormalPopup('');
		expect(setPopup).toHaveBeenCalledTimes(4);

		releaseFinalRestore();
		await expect(running).resolves.toBe(true);
		await expect(deferred).resolves.toBe(true);
		expect(setPopup.mock.calls).toEqual([
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: 'popup.html' }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: '' }],
			[{ popup: '', tabId: 7 }],
		]);
	});

	it('applies a setting update queued at the restoration handoff before releasing ownership', async () => {
		let controller!: ReturnType<typeof createBackgroundQuickClipController>;
		let lateWrite: Promise<boolean> | undefined;
		let setCall = 0;
		const setPopup = vi.fn(async (): Promise<void> => {
			setCall += 1;
			if (setCall === 3) {
				queueMicrotask(() => {
					queueMicrotask(() => {
						lateWrite = controller.setNormalPopup('');
					});
				});
			}
		});
		const configured = setup({ setPopup });
		controller = configured.controller;

		const running = controller.run(7, 3);
		await vi.waitFor(() => expect(lateWrite).toBeDefined());
		await expect(running).resolves.toBe(true);
		await expect(lateWrite).resolves.toBe(true);
		expect(setPopup.mock.calls).toEqual([
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: 'popup.html' }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: '' }],
			[{ popup: '', tabId: 7 }],
		]);
	});

	it('waits for an existing normal-popup write before taking ownership', async () => {
		let releaseWrite!: () => void;
		const writing = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const setPopup = vi.fn()
			.mockImplementationOnce(async () => writing)
			.mockResolvedValue(undefined);
		const { controller, openPopup } = setup({ setPopup });

		const normalWrite = controller.setNormalPopup('');
		await vi.waitFor(() => expect(setPopup).toHaveBeenCalledTimes(1));
		const running = controller.run(7, 3);
		await Promise.resolve();
		expect(openPopup).not.toHaveBeenCalled();

		releaseWrite();
		await expect(normalWrite).resolves.toBe(true);
		await expect(running).resolves.toBe(true);
		expect(setPopup.mock.calls[0]).toEqual([{ popup: '' }]);
		expect(setPopup.mock.calls[1]).toEqual([
			{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 },
		]);
	});

	it('does not let a pre-existing writer apply a newer setting after Quick Clip takes ownership', async () => {
		let releaseWrite!: () => void;
		const writing = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const setPopup = vi.fn()
			.mockImplementationOnce(async () => writing)
			.mockResolvedValue(undefined);
		const { controller, openPopup } = setup({ setPopup });

		const oldWrite = controller.setNormalPopup('');
		await vi.waitFor(() => expect(setPopup).toHaveBeenCalledTimes(1));
		const running = controller.run(7, 3);
		const latestWrite = controller.setNormalPopup('popup.html');
		releaseWrite();

		await expect(oldWrite).resolves.toBe(true);
		await expect(running).resolves.toBe(true);
		await expect(latestWrite).resolves.toBe(true);
		expect(openPopup).toHaveBeenCalledTimes(1);
		expect(setPopup.mock.calls).toEqual([
			[{ popup: '' }],
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: 'popup.html' }],
			[{ popup: 'popup.html', tabId: 7 }],
		]);
	});

	it('fails closed and restores the latest popup without logging source content', async () => {
		const openPopup = vi.fn(async () => {
			throw new Error(PRIVATE_ERROR);
		});
		const { controller, setPopup, sendMessage } = setup({ openPopup });

		await expect(controller.run(7, 3)).resolves.toBe(false);
		expect(setPopup.mock.calls).toEqual([
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: 'popup.html' }],
			[{ popup: 'popup.html', tabId: 7 }],
		]);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it('keeps the source tracked so the outer restore retries a rejected scoped restore', async () => {
		const setPopup = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error(PRIVATE_ERROR))
			.mockResolvedValue(undefined);
		const { controller } = setup({ setPopup });

		await expect(controller.run(7, 3)).resolves.toBe(false);

		expect(setPopup.mock.calls).toEqual([
			[{ popup: `popup.html?quick=1&tabId=7&nonce=${FIRST_NONCE}`, tabId: 7 }],
			[{ popup: 'popup.html', tabId: 7 }],
			[{ popup: 'popup.html' }],
			[{ popup: 'popup.html', tabId: 7 }],
		]);
	});

	it('bounds a never-settling queued normal-popup write before Quick Clip ownership', async () => {
		vi.useFakeTimers();
		const setPopup = vi.fn()
			.mockImplementationOnce(neverSettles)
			.mockResolvedValue(undefined);
		const { controller } = setup({ setPopup });

		const normalWrite = controller.setNormalPopup('');
		await Promise.resolve();
		await Promise.resolve();
		expect(setPopup).toHaveBeenCalledTimes(1);
		const running = (controller.run as (...args: unknown[]) => Promise<boolean>)(7, 3);
		let normalSettled = false;
		let commandSettled = false;
		normalWrite.finally(() => { normalSettled = true; });
		running.finally(() => { commandSettled = true; });

		await vi.advanceTimersByTimeAsync(5_001);
		await Promise.resolve();

		expect(normalSettled).toBe(true);
		expect(commandSettled).toBe(true);
		await expect(normalWrite).resolves.toBe(false);
		await expect(running).resolves.toBe(true);
	});

	it('bounds a never-settling final normal-popup restoration and releases ownership', async () => {
		vi.useFakeTimers();
		const setPopup = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(neverSettles)
			.mockResolvedValue(undefined);
		const { controller } = setup({ setPopup });

		const running = (controller.run as (...args: unknown[]) => Promise<boolean>)(7, 3);
		let settled = false;
		running.finally(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(5_001);
		await Promise.resolve();

		expect(settled).toBe(true);
		await expect(running).resolves.toBe(false);
		await expect((controller.run as (...args: unknown[]) => Promise<boolean>)(8, 4)).resolves.toBe(true);
	});

	it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7', null, undefined])(
		'rejects invalid tab id %p without invoking effects',
		async (tabId) => {
			const { controller, setPopup, openPopup, sendMessage, createNonce } = setup();

			await expect(controller.run(tabId, 3)).resolves.toBe(false);
			expect(setPopup).not.toHaveBeenCalled();
			expect(openPopup).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(createNonce).not.toHaveBeenCalled();
		},
	);

	it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined])(
		'rejects invalid source window id %p without invoking effects',
		async (windowId) => {
			const { controller, setPopup, openPopup, sendMessage, createNonce } = setup();

			await expect((controller.run as (...args: unknown[]) => Promise<boolean>)(7, windowId)).resolves.toBe(false);
			expect(setPopup).not.toHaveBeenCalled();
			expect(openPopup).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(createNonce).not.toHaveBeenCalled();
		},
	);
});
