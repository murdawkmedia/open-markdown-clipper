import {
	MAX_QUICK_CLIP_NONCE_LENGTH,
	MIN_QUICK_CLIP_NONCE_LENGTH,
	QUICK_CLIP_DELIVERY_TIMEOUT_MS,
} from '../utils/quick-clip-command';

const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;
const TAB_ID_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface QuickClipPopupContext {
	readonly tabId: number;
	readonly nonce: string;
}

export interface QuickClipPopupDeliveryController {
	isReady(): boolean;
	deliverDefault(intent: 'quick', signal?: AbortSignal): Promise<boolean>;
	closeAfterQuickSuccess(): void;
}

export interface QuickClipPopupDispatcherOptions {
	readonly context: QuickClipPopupContext | undefined;
	readonly getController: () => QuickClipPopupDeliveryController | null | undefined;
	readonly now?: () => number;
}

type QuickClipPopupResponse =
	| { readonly ready: boolean; readonly nonce: string }
	| { readonly success: boolean; readonly nonce: string };

type SendQuickClipPopupResponse = (response: QuickClipPopupResponse) => void;

interface ParsedQuickClipReadyMessage {
	readonly action: 'quickClipReady';
	readonly tabId: number;
	readonly nonce: string;
}

interface ParsedQuickClipTriggerMessage {
	readonly action: 'triggerQuickClip';
	readonly tabId: number;
	readonly nonce: string;
	readonly deadline: number;
}

type ParsedQuickClipPopupMessage =
	| ParsedQuickClipReadyMessage
	| ParsedQuickClipTriggerMessage;

interface QuickClipTriggerResult {
	readonly success: boolean;
	readonly controller?: QuickClipPopupDeliveryController;
}

function isSafeTabId(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isSafeNonce(value: string): boolean {
	return value.length >= MIN_QUICK_CLIP_NONCE_LENGTH
		&& value.length <= MAX_QUICK_CLIP_NONCE_LENGTH
		&& NONCE_PATTERN.test(value);
}

/**
 * Parse only the dedicated popup URL emitted by the Quick Clip command.
 * Raw parsing deliberately rejects encoded names/values, duplicates, and extras.
 */
export function parseQuickClipPopupContext(search: unknown): QuickClipPopupContext | undefined {
	if (typeof search !== 'string' || !search.startsWith('?') || search.includes('#')) {
		return undefined;
	}

	const segments = search.slice(1).split('&');
	if (segments.length !== 3) return undefined;

	const values: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const segment of segments) {
		const equalsIndex = segment.indexOf('=');
		if (
			equalsIndex < 1
			|| segment.indexOf('=', equalsIndex + 1) !== -1
		) {
			return undefined;
		}

		const name = segment.slice(0, equalsIndex);
		const value = segment.slice(equalsIndex + 1);
		if (
			(name !== 'quick' && name !== 'tabId' && name !== 'nonce')
			|| Object.prototype.hasOwnProperty.call(values, name)
		) {
			return undefined;
		}
		values[name] = value;
	}

	if (
		values.quick !== '1'
		|| !TAB_ID_PATTERN.test(values.tabId ?? '')
		|| !isSafeNonce(values.nonce ?? '')
	) {
		return undefined;
	}

	const tabId = Number(values.tabId);
	if (!isSafeTabId(tabId)) return undefined;

	return { tabId, nonce: values.nonce };
}

function parseExactQuickClipPopupMessage(
	request: unknown,
): ParsedQuickClipPopupMessage | undefined {
	if (typeof request !== 'object' || request === null) return undefined;

	try {
		if (
			Object.getPrototypeOf(request) !== Object.prototype
			|| typeof globalThis.structuredClone !== 'function'
		) {
			return undefined;
		}

		const keys = Reflect.ownKeys(request);
		if (
			(keys.length !== 3 && keys.length !== 4)
			|| !keys.includes('action')
			|| !keys.includes('tabId')
			|| !keys.includes('nonce')
		) {
			return undefined;
		}

		const descriptors = Object.getOwnPropertyDescriptors(request);
		const actionDescriptor = descriptors.action;
		const tabIdDescriptor = descriptors.tabId;
		const nonceDescriptor = descriptors.nonce;
		const deadlineDescriptor = descriptors.deadline;
		for (const descriptor of [
			actionDescriptor,
			tabIdDescriptor,
			nonceDescriptor,
			...(deadlineDescriptor ? [deadlineDescriptor] : []),
		]) {
			if (
				!descriptor
				|| !('value' in descriptor)
				|| !descriptor.enumerable
				|| !descriptor.configurable
				|| !descriptor.writable
			) {
				return undefined;
			}
		}

		const action = actionDescriptor.value;
		const tabId = tabIdDescriptor.value;
		const nonce = nonceDescriptor.value;
		if (
			(action !== 'quickClipReady' && action !== 'triggerQuickClip')
			|| typeof tabId !== 'number'
			|| !isSafeTabId(tabId)
			|| typeof nonce !== 'string'
			|| !isSafeNonce(nonce)
		) {
			return undefined;
		}
		if (
			(action === 'quickClipReady' && (keys.length !== 3 || deadlineDescriptor))
			|| (action === 'triggerQuickClip' && (
				keys.length !== 4
				|| !deadlineDescriptor
				|| !Number.isSafeInteger(deadlineDescriptor.value)
				|| deadlineDescriptor.value < 0
			))
		) {
			return undefined;
		}

		globalThis.structuredClone(request);
		return action === 'triggerQuickClip'
			? { action, tabId, nonce, deadline: deadlineDescriptor!.value }
			: { action, tabId, nonce };
	} catch {
		return undefined;
	}
}

/**
 * Create a global-free runtime listener for one nonce-bound popup launch.
 */
export function createQuickClipPopupDispatcher(
	options: QuickClipPopupDispatcherOptions,
): (
	request: unknown,
	sendResponse: SendQuickClipPopupResponse,
) => true | undefined {
	const { context, getController, now = Date.now } = options;
	const validContext = context
		&& isSafeTabId(context.tabId)
		&& isSafeNonce(context.nonce)
		&& typeof getController === 'function'
		? { tabId: context.tabId, nonce: context.nonce }
		: undefined;
	let triggerResult: Promise<QuickClipTriggerResult> | undefined;
	let closeAttempted = false;

	const runTrigger = async (deadline: number): Promise<QuickClipTriggerResult> => {
		let controller: QuickClipPopupDeliveryController | null | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const startedAt = now();
			if (
				!Number.isSafeInteger(startedAt)
				|| startedAt < 0
				|| deadline <= startedAt
				|| deadline > startedAt + QUICK_CLIP_DELIVERY_TIMEOUT_MS
			) {
				return { success: false };
			}
			controller = getController();
			if (!controller) return { success: false };
			const abortController = new AbortController();
			const aborted = new Promise<boolean>((resolve) => {
				abortController.signal.addEventListener(
					'abort',
					() => resolve(false),
					{ once: true },
				);
			});
			timer = setTimeout(
				() => abortController.abort(),
				deadline - startedAt,
			);
			const delivery = Promise.resolve()
				.then(() => controller!.deliverDefault('quick', abortController.signal))
				.then(success => success === true && !abortController.signal.aborted)
				.catch(() => false);
			const success = await Promise.race([delivery, aborted]);
			return success === true
				? { success: true, controller }
				: { success: false };
		} catch {
			return { success: false };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	return (request, sendResponse) => {
		if (!validContext) return undefined;
		const message = parseExactQuickClipPopupMessage(request);
		if (
			!message
			|| message.tabId !== validContext.tabId
			|| message.nonce !== validContext.nonce
		) {
			return undefined;
		}

		if (message.action === 'quickClipReady') {
			let ready = false;
			try {
				const controller = getController();
				ready = controller?.isReady() === true;
			} catch {
				ready = false;
			}
			try {
				sendResponse({ ready, nonce: validContext.nonce });
			} catch {
				// The requester may have gone away; never expose local failure details.
			}
			return undefined;
		}

		triggerResult ??= runTrigger(message.deadline);
		void triggerResult.then(result => {
			try {
				sendResponse({ success: result.success, nonce: validContext.nonce });
			} catch {
				// The response is best-effort and content-free.
			}

			if (result.success && !closeAttempted) {
				closeAttempted = true;
				try {
					result.controller?.closeAfterQuickSuccess();
				} catch {
					// Delivery already succeeded; closing is best-effort.
				}
			}
		});
		return true;
	};
}
