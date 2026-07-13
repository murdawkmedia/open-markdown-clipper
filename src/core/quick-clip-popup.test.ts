import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createQuickClipPopupDispatcher,
	parseQuickClipPopupContext,
	QuickClipPopupDeliveryController,
} from './quick-clip-popup';

const NONCE = 'request_nonce-0123456789ABCDEF';
const OTHER_NONCE = 'request_nonce-FEDCBA9876543210';
const PRIVATE_ERROR = 'private quick clip page body 75d3';

function triggerRequest() {
	return {
		action: 'triggerQuickClip' as const,
		tabId: 7,
		nonce: NONCE,
		deadline: Date.now() + 1_000,
	};
}

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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}

function controller(
	overrides: Partial<QuickClipPopupDeliveryController> = {},
): QuickClipPopupDeliveryController {
	return {
		isReady: vi.fn(() => true),
		deliverDefault: vi.fn(async () => true),
		closeAfterQuickSuccess: vi.fn(),
		...overrides,
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

describe('dedicated Quick Clip popup query parser', () => {
	it.each([
		['?quick=1&tabId=0&nonce=request_nonce-0123456789ABCDEF', 0],
		[`?nonce=${NONCE}&quick=1&tabId=7`, 7],
		[`?tabId=${Number.MAX_SAFE_INTEGER}&nonce=${NONCE}&quick=1`, Number.MAX_SAFE_INTEGER],
	])('accepts one exact set of safe launch parameters: %s', (search, tabId) => {
		expect(parseQuickClipPopupContext(search)).toEqual({ tabId, nonce: NONCE });
	});

	it.each([
		'',
		'quick=1&tabId=7&nonce=' + NONCE,
		'?quick=1&tabId=7',
		'?quick=1&tabId=7&nonce=' + NONCE + '&extra=1',
		'?quick=1&quick=1&tabId=7&nonce=' + NONCE,
		'?quick=1&tabId=7&tabId=8&nonce=' + NONCE,
		'?quick=1&tabId=7&nonce=' + NONCE + '&nonce=' + OTHER_NONCE,
		'?quick=01&tabId=7&nonce=' + NONCE,
		'?quick=1&tabId=-1&nonce=' + NONCE,
		'?quick=1&tabId=+1&nonce=' + NONCE,
		'?quick=1&tabId=01&nonce=' + NONCE,
		'?quick=1&tabId=1.0&nonce=' + NONCE,
		'?quick=1&tabId=1e2&nonce=' + NONCE,
		'?quick=1&tabId=9007199254740992&nonce=' + NONCE,
		'?quick=1&tabId=7&nonce=too_short',
		'?quick=1&tabId=7&nonce=' + 'a'.repeat(129),
		'?quick=1&tabId=7&nonce=request_nonce.0123456789ABCDEF',
		'?quick=1&tabId=7&nonce=request%5Fnonce-0123456789ABCDEF',
		'?quick=1&&tabId=7&nonce=' + NONCE,
		'?quick=1&tabId=7&nonce=' + NONCE + '#fragment',
	])('rejects duplicate, missing, extra, encoded, or malformed launch data: %s', search => {
		expect(parseQuickClipPopupContext(search)).toBeUndefined();
	});

	it('fails closed for non-string and trapping input without logging', () => {
		expect(parseQuickClipPopupContext(null)).toBeUndefined();
		expect(parseQuickClipPopupContext(new String(`?quick=1&tabId=7&nonce=${NONCE}`))).toBeUndefined();
	});
});

describe('Quick Clip popup message dispatcher', () => {
	const context = { tabId: 7, nonce: NONCE } as const;

	it('keeps ordinary popup, side-panel, and iframe dispatchers completely silent', () => {
		const delivery = controller();
		const getController = vi.fn(() => delivery);
		const sendResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({
			context: undefined,
			getController,
		});

		expect(dispatch({ action: 'quickClipReady', tabId: 7, nonce: NONCE }, sendResponse)).toBeUndefined();
		expect(dispatch({ action: 'triggerQuickClip', tabId: 7, nonce: NONCE }, sendResponse)).toBeUndefined();
		expect(sendResponse).not.toHaveBeenCalled();
		expect(getController).not.toHaveBeenCalled();
	});

	it.each([
		{ action: 'quickClipReady', tabId: 8, nonce: NONCE },
		{ action: 'quickClipReady', tabId: 7, nonce: OTHER_NONCE },
		{ action: 'triggerQuickClip', tabId: 8, nonce: NONCE },
		{ action: 'triggerQuickClip', tabId: 7, nonce: OTHER_NONCE },
		{ action: 'triggerQuickClip', tabId: 7, nonce: NONCE, extra: true },
		{ action: 'triggerQuickClip', tabId: '7', nonce: NONCE },
		{ action: 'triggerQuickClip', tabId: 7, nonce: NONCE, [Symbol('extra')]: true },
		{ action: 'unrelated', tabId: 7, nonce: NONCE },
	])('keeps mismatched or inexact messages silent: %p', request => {
		const delivery = controller();
		const sendResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

		expect(dispatch(request, sendResponse)).toBeUndefined();
		expect(sendResponse).not.toHaveBeenCalled();
		expect(delivery.deliverDefault).not.toHaveBeenCalled();
	});

	it('rejects accessors and Proxies without invoking private getters', () => {
		const getter = vi.fn(() => 'triggerQuickClip');
		const accessorRequest = { tabId: 7, nonce: NONCE } as Record<string, unknown>;
		Object.defineProperty(accessorRequest, 'action', { enumerable: true, get: getter });
		const transparentProxy = new Proxy(
			{ action: 'triggerQuickClip', tabId: 7, nonce: NONCE },
			{},
		);
		const trappingProxy = new Proxy({}, {
			getPrototypeOf() {
				throw new Error(PRIVATE_ERROR);
			},
		});
		const delivery = controller();
		const sendResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

		for (const request of [accessorRequest, transparentProxy, trappingProxy]) {
			expect(dispatch(request, sendResponse)).toBeUndefined();
		}
		expect(getter).not.toHaveBeenCalled();
		expect(sendResponse).not.toHaveBeenCalled();
		expect(delivery.deliverDefault).not.toHaveBeenCalled();
	});

	it.each([
		[undefined, false],
		[controller({ isReady: vi.fn(() => false) }), false],
		[controller({ isReady: vi.fn(() => true) }), true],
	])('responds to matching readiness with the exact nonce-bound state', (delivery, ready) => {
		const sendResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({
			context,
			getController: () => delivery,
		});

		expect(dispatch({ action: 'quickClipReady', tabId: 7, nonce: NONCE }, sendResponse)).toBeUndefined();
		expect(sendResponse).toHaveBeenCalledOnce();
		expect(sendResponse).toHaveBeenCalledWith({ ready, nonce: NONCE });
		expect(Reflect.ownKeys(sendResponse.mock.calls[0][0])).toEqual(['ready', 'nonce']);
	});

	it('awaits and coalesces matching triggers for the nonce, then responds and closes once', async () => {
		const pending = deferred<boolean>();
		const delivery = controller({
			deliverDefault: vi.fn(async () => pending.promise),
		});
		const firstResponse = vi.fn();
		const secondResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

		expect(dispatch(triggerRequest(), firstResponse)).toBe(true);
		expect(dispatch(triggerRequest(), secondResponse)).toBe(true);
		await vi.waitFor(() => expect(delivery.deliverDefault).toHaveBeenCalledOnce());
		expect(delivery.deliverDefault).toHaveBeenCalledWith('quick', expect.any(AbortSignal));
		expect(firstResponse).not.toHaveBeenCalled();
		expect(secondResponse).not.toHaveBeenCalled();

		pending.resolve(true);
		await vi.waitFor(() => expect(firstResponse).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(secondResponse).toHaveBeenCalledOnce());
		expect(firstResponse).toHaveBeenCalledWith({ success: true, nonce: NONCE });
		expect(secondResponse).toHaveBeenCalledWith({ success: true, nonce: NONCE });
		expect(Reflect.ownKeys(firstResponse.mock.calls[0][0])).toEqual(['success', 'nonce']);
		expect(delivery.closeAfterQuickSuccess).toHaveBeenCalledOnce();
	});

	it('aborts in-flight delivery at the trigger deadline and responds with fixed failure', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_750_000_000_000);
		let deliverySignal: AbortSignal | undefined;
		const delivery = controller({
			deliverDefault: vi.fn((_intent: 'quick', signal?: AbortSignal) => {
				deliverySignal = signal;
				return new Promise<boolean>((resolve) => {
					signal?.addEventListener('abort', () => resolve(false), { once: true });
				});
			}),
		});
		const sendResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({
			context,
			getController: () => delivery,
			now: () => Date.now(),
		});

		expect(dispatch({
			action: 'triggerQuickClip',
			tabId: 7,
			nonce: NONCE,
			deadline: 1_750_000_001_000,
		}, sendResponse)).toBe(true);
		expect(sendResponse).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1_000);

		expect(deliverySignal?.aborted).toBe(true);
		expect(sendResponse).toHaveBeenCalledOnce();
		expect(sendResponse).toHaveBeenCalledWith({ success: false, nonce: NONCE });
		expect(delivery.closeAfterQuickSuccess).not.toHaveBeenCalled();
	});

	it('keeps a completed nonce idempotent without repeating delivery or close', async () => {
		const delivery = controller();
		const firstResponse = vi.fn();
		const repeatedResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

		dispatch(triggerRequest(), firstResponse);
		await vi.waitFor(() => expect(firstResponse).toHaveBeenCalledOnce());
		dispatch(triggerRequest(), repeatedResponse);
		await vi.waitFor(() => expect(repeatedResponse).toHaveBeenCalledOnce());

		expect(delivery.deliverDefault).toHaveBeenCalledOnce();
		expect(delivery.closeAfterQuickSuccess).toHaveBeenCalledOnce();
		expect(repeatedResponse).toHaveBeenCalledWith({ success: true, nonce: NONCE });
	});

	it.each(['returns false', 'throws', 'has no controller'] as const)(
		'responds with fixed failure, does not close, and leaves fallbacks available when delivery %s',
		async mode => {
			const delivery = mode === 'has no controller'
				? undefined
				: controller({
					deliverDefault: mode === 'throws'
						? vi.fn(async () => { throw new Error(PRIVATE_ERROR); })
						: vi.fn(async () => false),
				});
			const sendResponse = vi.fn();
			const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

			expect(dispatch(triggerRequest(), sendResponse)).toBe(true);
			await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());

			expect(sendResponse).toHaveBeenCalledWith({ success: false, nonce: NONCE });
			if (delivery) expect(delivery.closeAfterQuickSuccess).not.toHaveBeenCalled();
			expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(PRIVATE_ERROR);
		},
	);

	it('fails closed if readiness/controller/response/close effects throw and never logs', async () => {
		const delivery = controller({
			isReady: vi.fn(() => { throw new Error(PRIVATE_ERROR); }),
			closeAfterQuickSuccess: vi.fn(() => { throw new Error(PRIVATE_ERROR); }),
		});
		const readinessResponse = vi.fn(() => { throw new Error(PRIVATE_ERROR); });
		const triggerResponse = vi.fn(() => { throw new Error(PRIVATE_ERROR); });
		const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

		expect(dispatch({ action: 'quickClipReady', tabId: 7, nonce: NONCE }, readinessResponse)).toBeUndefined();
		expect(readinessResponse).toHaveBeenCalledWith({ ready: false, nonce: NONCE });
		expect(dispatch(triggerRequest(), triggerResponse)).toBe(true);
		await vi.waitFor(() => expect(delivery.closeAfterQuickSuccess).toHaveBeenCalledOnce());
	});

	it('fails closed when structuredClone is unavailable', () => {
		vi.stubGlobal('structuredClone', undefined);
		const delivery = controller();
		const sendResponse = vi.fn();
		const dispatch = createQuickClipPopupDispatcher({ context, getController: () => delivery });

		expect(dispatch({ action: 'quickClipReady', tabId: 7, nonce: NONCE }, sendResponse)).toBeUndefined();
		expect(sendResponse).not.toHaveBeenCalled();
		expect(delivery.isReady).not.toHaveBeenCalled();
	});
});

describe('popup source integration', () => {
	const source = readFileSync(join(process.cwd(), 'src', 'core', 'popup.ts'), 'utf8');

	it('wires the dedicated dispatcher and removes the legacy untargeted responder', () => {
		expect(source).toContain("from './quick-clip-popup'");
		expect(source).toContain('createQuickClipPopupDispatcher');
		expect(source).toContain('quickClipMessageDispatcher(request, sendResponse)');
		expect(source).not.toContain('respondToQuickClip');
		expect(source).not.toMatch(/request\.action\s*===\s*["']triggerQuickClip["']/);
	});

	it('threads the Quick Clip abort signal into production snapshot assembly', () => {
		expect(source).toMatch(/async function capturePopupSnapshot\(signal\?: AbortSignal\)/);
		expect(source).toMatch(/captureStablePopupSnapshot<Template, Property\[]>\([\s\S]*\},\s*signal\)/);
		expect(source).toMatch(/buildMarkdown:\s*async \(properties,\s*noteContent,\s*signal\)/);
		expect(source).toMatch(/getSourceUrl:\s*async \(tabId,\s*signal\)/);
		expect(source).not.toContain(['waitFor', 'Inter', 'preter'].join(''));
		expect(source).not.toContain(['handle', 'Inter', 'preterUI'].join(''));
	});

	it('limits redirect bypass and source-tab targeting to a valid dedicated launch', () => {
		expect(source).toContain('parseQuickClipPopupContext(window.location.search)');
		expect(source).toMatch(/!isSidePanel\s*&&\s*!isIframe/);
		expect(source).toContain('isDedicatedQuickClipPopup');
		expect(source).not.toContain("openBehavior === 'embedded'");
		expect(source).toMatch(/openBehavior === 'reader'[^\n]+&& !isDedicatedQuickClipPopup/);
		expect(source).toContain('quickClipPopupContext.tabId');
		expect(source).toContain('currentTabId !== undefined');
		expect(source).not.toMatch(/currentTabId\s*\?\s*\(await getTabInfo/);
	});
});
