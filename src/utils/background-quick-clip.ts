import { runQuickClipCommand } from './quick-clip-command';
import type {
	QuickClipMessage,
	QuickClipPopupDetails,
} from './quick-clip-command';

export type { QuickClipPopupDetails } from './quick-clip-command';

export const BACKGROUND_QUICK_CLIP_READY_ATTEMPTS = 60;
export const BACKGROUND_QUICK_CLIP_READY_DELAY_MS = 1_000;
export const BACKGROUND_QUICK_CLIP_EFFECT_TIMEOUT_MS = 5_000;
export const MAX_BACKGROUND_POPUP_RESTORE_WRITES = 8;

export type NormalActionPopup = '' | 'popup.html';

export interface BackgroundQuickClipPopupDetails {
	readonly popup: string;
	readonly tabId?: number;
}

export interface BackgroundQuickClipOpenPopupDetails {
	readonly windowId: number;
}

export interface BackgroundQuickClipEffects {
	readonly setPopup: (
		details: BackgroundQuickClipPopupDetails,
	) => void | Promise<unknown>;
	readonly openPopup: (
		details: BackgroundQuickClipOpenPopupDetails,
	) => void | Promise<unknown>;
	readonly sendMessage: (
		message: QuickClipMessage,
	) => unknown | Promise<unknown>;
	readonly createNonce: () => unknown;
	readonly now: () => unknown;
	readonly delay: (milliseconds: number) => void | Promise<unknown>;
}

export interface BackgroundQuickClipController {
	readonly run: (tabId: unknown, windowId: unknown) => Promise<boolean>;
	readonly setNormalPopup: (popup: NormalActionPopup) => Promise<boolean>;
	readonly releaseTab: (tabId: unknown) => void;
	readonly trackTabs: (tabIds: unknown) => void;
}

interface ActiveBackgroundQuickClip {
	readonly tabId: number;
	readonly windowId: number;
	readonly promise: Promise<boolean>;
}

function isValidTabId(tabId: unknown): tabId is number {
	return typeof tabId === 'number'
		&& Number.isSafeInteger(tabId)
		&& tabId >= 0;
}

function isValidWindowId(windowId: unknown): windowId is number {
	return typeof windowId === 'number'
		&& Number.isSafeInteger(windowId)
		&& windowId >= 0;
}

async function settlePopupWrite(
	write: () => void | Promise<unknown>,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const writeResult = Promise.resolve()
		.then(write)
		.then(
			() => true,
			() => false,
		);
	const timeoutResult = new Promise<boolean>((resolve) => {
		timer = setTimeout(
			() => resolve(false),
			BACKGROUND_QUICK_CLIP_EFFECT_TIMEOUT_MS,
		);
	});

	try {
		return await Promise.race([writeResult, timeoutResult]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function boundedQuickClipDelay(milliseconds: number): Promise<void> {
	const bounded = Number.isFinite(milliseconds)
		? Math.max(0, Math.min(milliseconds, BACKGROUND_QUICK_CLIP_READY_DELAY_MS))
		: BACKGROUND_QUICK_CLIP_READY_DELAY_MS;
	return new Promise((resolve) => {
		setTimeout(resolve, bounded);
	});
}

export function createBackgroundQuickClipController(
	effects: BackgroundQuickClipEffects,
	initialPopup: NormalActionPopup,
): BackgroundQuickClipController {
	let desiredPopup = initialPopup;
	let desiredRevision = 0;
	let appliedRevision = 0;
	let normalWriteTail: Promise<boolean> = Promise.resolve(true);
	let active: ActiveBackgroundQuickClip | undefined;
	const scopedTabs = new Set<number>();

	async function applyLatestNormalPopup(
		force: boolean,
		allowWhileQuickClipOwnsPopup = false,
	): Promise<boolean> {
		if (active && !allowWhileQuickClipOwnsPopup) return true;
		let shouldWrite = force;
		for (let writes = 0; writes < MAX_BACKGROUND_POPUP_RESTORE_WRITES; writes += 1) {
			if (!shouldWrite && appliedRevision === desiredRevision) return true;
			shouldWrite = false;

			const revision = desiredRevision;
			const popup = desiredPopup;
			const tabs = [...scopedTabs];
			const [globalApplied, ...tabResults] = await Promise.all([
				settlePopupWrite(() => effects.setPopup({ popup })),
				...tabs.map((tabId) => settlePopupWrite(
					() => effects.setPopup({ popup, tabId }),
				)),
			]);
			if (!globalApplied) return false;
			for (let index = 0; index < tabs.length; index += 1) {
				if (tabResults[index] !== true && scopedTabs.has(tabs[index])) return false;
			}
			appliedRevision = revision;
			if (active && !allowWhileQuickClipOwnsPopup) return true;
		}

		return appliedRevision === desiredRevision;
	}

	function enqueueNormalPopupWrite(): Promise<boolean> {
		const write = normalWriteTail.then(
			() => applyLatestNormalPopup(false),
			() => applyLatestNormalPopup(false),
		);
		normalWriteTail = write.catch(() => false);
		return write;
	}

	function setNormalPopup(popup: NormalActionPopup): Promise<boolean> {
		desiredPopup = popup;
		desiredRevision += 1;

		if (active) {
			return active.promise.then(
				() => appliedRevision === desiredRevision,
				() => false,
			);
		}

		return enqueueNormalPopupWrite();
	}

	async function execute(tabId: number, windowId: number): Promise<boolean> {
		await normalWriteTail;

		let commandSucceeded = false;
		try {
			commandSucceeded = await runQuickClipCommand({
				tabId,
				nonce: effects.createNonce(),
				normalPopup: desiredPopup,
				readyAttempts: BACKGROUND_QUICK_CLIP_READY_ATTEMPTS,
				readyDelayMs: BACKGROUND_QUICK_CLIP_READY_DELAY_MS,
				effectTimeoutMs: BACKGROUND_QUICK_CLIP_EFFECT_TIMEOUT_MS,
				now: effects.now,
				setPopup: ({ popup }) => {
					scopedTabs.add(tabId);
					return effects.setPopup({ popup, tabId });
				},
				openPopup: () => effects.openPopup({ windowId }),
				sendMessage: effects.sendMessage,
				delay: effects.delay,
			});
		} catch {
			commandSucceeded = false;
		}

		const popupRestored = await applyLatestNormalPopup(true, true);
		return commandSucceeded && popupRestored;
	}

	function run(tabId: unknown, windowId: unknown): Promise<boolean> {
		if (!isValidTabId(tabId)) return Promise.resolve(false);
		if (!isValidWindowId(windowId)) return Promise.resolve(false);

		if (active) {
			return active.tabId === tabId && active.windowId === windowId
				? active.promise
				: Promise.resolve(false);
		}
		scopedTabs.add(tabId);

		let sharedPromise!: Promise<boolean>;
		sharedPromise = execute(tabId, windowId)
			.catch(() => false)
			.then(async (commandSucceeded) => {
				if (active?.promise !== sharedPromise) return commandSucceeded;

				let popupCurrent = true;
				for (
					let restorationPasses = 0;
					popupCurrent
						&& appliedRevision !== desiredRevision
						&& restorationPasses < MAX_BACKGROUND_POPUP_RESTORE_WRITES;
					restorationPasses += 1
				) {
					popupCurrent = await applyLatestNormalPopup(false, true);
				}

				if (active?.promise === sharedPromise) active = undefined;
				const fullyRestored = popupCurrent && appliedRevision === desiredRevision;
				if (!fullyRestored) void enqueueNormalPopupWrite();
				return commandSucceeded
					&& fullyRestored;
			});
		active = { tabId, windowId, promise: sharedPromise };
		return sharedPromise;
	}

	function releaseTab(tabId: unknown): void {
		if (isValidTabId(tabId)) scopedTabs.delete(tabId);
	}

	function trackTabs(tabIds: unknown): void {
		if (!Array.isArray(tabIds)) return;
		for (const tabId of tabIds) {
			if (isValidTabId(tabId)) scopedTabs.add(tabId);
		}
	}

	return Object.freeze({ run, setNormalPopup, releaseTab, trackTabs });
}
