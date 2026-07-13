export const MAX_QUICK_CLIP_READY_ATTEMPTS = 60;
export const MAX_QUICK_CLIP_READY_DELAY_MS = 1_000;
export const MAX_QUICK_CLIP_EFFECT_TIMEOUT_MS = 5_000;
export const QUICK_CLIP_DELIVERY_TIMEOUT_MS = 15_000;
export const QUICK_CLIP_RESPONSE_GRACE_MS = 1_000;
export const QUICK_CLIP_POPUP_DEADLINE_BUDGET_MS =
	QUICK_CLIP_DELIVERY_TIMEOUT_MS - QUICK_CLIP_RESPONSE_GRACE_MS;
export const MIN_QUICK_CLIP_NONCE_LENGTH = 16;
export const MAX_QUICK_CLIP_NONCE_LENGTH = 128;

export interface QuickClipPopupDetails {
	readonly popup: string;
}

interface QuickClipMessageTarget {
	readonly tabId: number;
	readonly nonce: string;
}

export type QuickClipMessage = QuickClipMessageTarget & (
	| { readonly action: 'quickClipReady' }
	| {
		readonly action: 'triggerQuickClip';
		readonly deadline: number;
	}
);

export interface QuickClipCommandOptions {
	readonly tabId: unknown;
	readonly nonce: unknown;
	readonly normalPopup: unknown;
	readonly readyAttempts: unknown;
	readonly readyDelayMs: unknown;
	readonly effectTimeoutMs: unknown;
	readonly now: () => unknown;
	readonly setPopup: (
		details: QuickClipPopupDetails,
	) => void | Promise<unknown>;
	readonly openPopup: () => void | Promise<unknown>;
	readonly sendMessage: (message: QuickClipMessage) => unknown | Promise<unknown>;
	readonly delay: (milliseconds: number) => void | Promise<unknown>;
}

interface ValidQuickClipCommandOptions {
	readonly tabId: number;
	readonly nonce: string;
	readonly normalPopup: string;
	readonly readyAttempts: number;
	readonly readyDelayMs: number;
	readonly effectTimeoutMs: number;
	readonly now: () => unknown;
	readonly setPopup: QuickClipCommandOptions['setPopup'];
	readonly openPopup: QuickClipCommandOptions['openPopup'];
	readonly sendMessage: QuickClipCommandOptions['sendMessage'];
	readonly delay: QuickClipCommandOptions['delay'];
}

interface EffectResult<T> {
	readonly ok: boolean;
	readonly value?: T;
}

interface ActiveQuickClipInvocation {
	readonly tabId: number;
	readonly promise: Promise<boolean>;
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;
let activeInvocation: ActiveQuickClipInvocation | undefined;

function validateOptions(
	options: QuickClipCommandOptions,
): ValidQuickClipCommandOptions | undefined {
	try {
		const {
			tabId,
			nonce,
			normalPopup,
			readyAttempts,
			readyDelayMs,
			effectTimeoutMs,
			now,
			setPopup,
			openPopup,
			sendMessage,
			delay,
		} = options;

		if (
			typeof tabId !== 'number'
			|| !Number.isSafeInteger(tabId)
			|| tabId < 0
			|| typeof nonce !== 'string'
			|| nonce.length < MIN_QUICK_CLIP_NONCE_LENGTH
			|| nonce.length > MAX_QUICK_CLIP_NONCE_LENGTH
			|| !NONCE_PATTERN.test(nonce)
			|| typeof normalPopup !== 'string'
			|| typeof readyAttempts !== 'number'
			|| !Number.isSafeInteger(readyAttempts)
			|| readyAttempts < 1
			|| readyAttempts > MAX_QUICK_CLIP_READY_ATTEMPTS
			|| typeof readyDelayMs !== 'number'
			|| !Number.isFinite(readyDelayMs)
			|| readyDelayMs < 0
			|| readyDelayMs > MAX_QUICK_CLIP_READY_DELAY_MS
			|| typeof effectTimeoutMs !== 'number'
			|| !Number.isSafeInteger(effectTimeoutMs)
			|| effectTimeoutMs < 1
			|| effectTimeoutMs > MAX_QUICK_CLIP_EFFECT_TIMEOUT_MS
			|| typeof now !== 'function'
			|| typeof setPopup !== 'function'
			|| typeof openPopup !== 'function'
			|| typeof sendMessage !== 'function'
			|| typeof delay !== 'function'
		) {
			return undefined;
		}

		return {
			tabId,
			nonce,
			normalPopup,
			readyAttempts,
			readyDelayMs,
			effectTimeoutMs,
			now,
			setPopup,
			openPopup,
			sendMessage,
			delay,
		};
	} catch {
		return undefined;
	}
}

function isExactNonceBoundTrueResponse(
	value: unknown,
	property: 'ready' | 'success',
	nonce: string,
): boolean {
	if (typeof value !== 'object' || value === null) return false;

	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== 2
			|| !keys.includes(property)
			|| !keys.includes('nonce')
		) {
			return false;
		}

		const descriptors = Object.getOwnPropertyDescriptors(value);
		const result = descriptors[property];
		const echoedNonce = descriptors.nonce;
		if (
			!result
			|| !echoedNonce
			|| !result.enumerable
			|| !echoedNonce.enumerable
			|| !('value' in result)
			|| !('value' in echoedNonce)
			|| result.value !== true
			|| echoedNonce.value !== nonce
			|| typeof globalThis.structuredClone !== 'function'
		) {
			return false;
		}

		globalThis.structuredClone(value);
		return true;
	} catch {
		return false;
	}
}

async function settleEffect<T>(
	effect: () => T | Promise<T>,
	timeoutMs: number,
): Promise<EffectResult<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const effectResult: Promise<EffectResult<T>> = Promise.resolve()
		.then(effect)
		.then(
			value => ({ ok: true, value }),
			() => ({ ok: false }),
		);
	const timeoutResult = new Promise<EffectResult<T>>(resolve => {
		timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
	});

	try {
		return await Promise.race([effectResult, timeoutResult]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function executeQuickClipCommand(
	options: ValidQuickClipCommandOptions,
): Promise<boolean> {
	const {
		tabId,
		nonce,
		normalPopup,
		readyAttempts,
		readyDelayMs,
		effectTimeoutMs,
		now,
		setPopup,
		openPopup,
		sendMessage,
		delay,
	} = options;

	let popupOpened = false;
	let popupRestored = false;
	try {
		const configured = await settleEffect(
			() => setPopup({
				popup: `popup.html?quick=1&tabId=${tabId}&nonce=${encodeURIComponent(nonce)}`,
			}),
			effectTimeoutMs,
		);
		if (configured.ok) {
			const opened = await settleEffect(openPopup, effectTimeoutMs);
			popupOpened = opened.ok;
		}
	} finally {
		const restored = await settleEffect(
			() => setPopup({ popup: normalPopup }),
			effectTimeoutMs,
		);
		popupRestored = restored.ok;
	}

	if (!popupOpened || !popupRestored) return false;

	for (let attempt = 0; attempt < readyAttempts; attempt += 1) {
		const readiness = await settleEffect(
			() => sendMessage({ action: 'quickClipReady', tabId, nonce }),
			effectTimeoutMs,
		);
		const ready = readiness.ok
			&& isExactNonceBoundTrueResponse(readiness.value, 'ready', nonce);

		if (ready) {
			const triggerStartedAt = now();
			if (
				typeof triggerStartedAt !== 'number'
				|| !Number.isSafeInteger(triggerStartedAt)
				|| triggerStartedAt < 0
				|| triggerStartedAt > Number.MAX_SAFE_INTEGER - QUICK_CLIP_POPUP_DEADLINE_BUDGET_MS
			) {
				return false;
			}
			const deadline = triggerStartedAt + QUICK_CLIP_POPUP_DEADLINE_BUDGET_MS;
			// The trigger includes destination delivery. Local HTTP is independently
			// bounded at ten seconds, so keep command ownership long enough for its
			// response while retaining a hard ceiling for a lost popup channel.
			const trigger = await settleEffect(
				() => sendMessage({ action: 'triggerQuickClip', tabId, nonce, deadline }),
				QUICK_CLIP_DELIVERY_TIMEOUT_MS,
			);
			return trigger.ok
				&& isExactNonceBoundTrueResponse(trigger.value, 'success', nonce);
		}

		if (attempt + 1 < readyAttempts) {
			const delayed = await settleEffect(
				() => delay(readyDelayMs),
				effectTimeoutMs,
			);
			if (!delayed.ok) return false;
		}
	}

	return false;
}

export function runQuickClipCommand(
	options: QuickClipCommandOptions,
): Promise<boolean> {
	const validated = validateOptions(options);
	if (!validated) return Promise.resolve(false);

	if (activeInvocation) {
		return activeInvocation.tabId === validated.tabId
			? activeInvocation.promise
			: Promise.resolve(false);
	}

	let sharedPromise!: Promise<boolean>;
	sharedPromise = executeQuickClipCommand(validated)
		.catch(() => false)
		.finally(() => {
			if (activeInvocation?.promise === sharedPromise) {
				activeInvocation = undefined;
			}
		});
	activeInvocation = { tabId: validated.tabId, promise: sharedPromise };
	return sharedPromise;
}
