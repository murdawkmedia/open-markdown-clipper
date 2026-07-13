import type { ClipAction } from '../types/types';
import browser from './browser-polyfill';
import { CLIP_ACTIONS } from './clip-stats';

export interface ClipRecord {
	readonly clipAction: ClipAction;
	readonly url?: string;
	readonly title?: string;
}

export type ClipRecordEffect = (record: ClipRecord) => void | Promise<void>;

export type ClipRecordingResponse =
	| { readonly success: true }
	| { readonly success: false; readonly error: 'clip-recording-failed' };

export type ClipRecordingSendResponse = (response: ClipRecordingResponse) => void;
export type ClipRecordingMessageSender = (message: unknown) => Promise<unknown>;

export class ClipRecordingError extends Error {
	readonly code = 'clip-recording-failed';

	constructor() {
		super('clip-recording-failed');
		this.name = 'ClipRecordingError';
	}
}

function fail(): never {
	throw new ClipRecordingError();
}

function readClipRecordMessage(value: unknown): ClipRecord {
	if (!value || typeof value !== 'object') fail();

	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) fail();
		const keys = Reflect.ownKeys(value);
		const allowedKeys = ['action', 'clipAction', 'url', 'title'];
		if (
			keys.length < 2
			|| keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
		) fail();

		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of keys as string[]) {
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !('value' in descriptor)) fail();
		}

		const action = descriptors.action?.value;
		const clipAction = descriptors.clipAction?.value;
		const url = descriptors.url?.value;
		const title = descriptors.title?.value;
		if (
			action !== 'recordClip'
			|| !(CLIP_ACTIONS as readonly unknown[]).includes(clipAction)
			|| (url !== undefined && typeof url !== 'string')
			|| (title !== undefined && typeof title !== 'string')
			|| (title !== undefined && url === undefined)
		) fail();

		if (typeof globalThis.structuredClone !== 'function') fail();
		globalThis.structuredClone(value);

		return {
			clipAction: clipAction as ClipAction,
			...(url === undefined ? {} : { url }),
			...(title === undefined ? {} : { title }),
		};
	} catch {
		fail();
	}
}

function hasOwnRecordClipAction(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'action');
		return Boolean(
			descriptor
			&& 'value' in descriptor
			&& descriptor.value === 'recordClip',
		);
	} catch {
		return false;
	}
}

function safelyRespond(
	sendResponse: ClipRecordingSendResponse,
	response: ClipRecordingResponse,
): void {
	try {
		sendResponse(response);
	} catch {
		// The message port may close while the queued storage operation is running.
	}
}

function isExactSuccessResponse(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== 'success') return false;
		const success = Object.getOwnPropertyDescriptor(value, 'success');
		return Boolean(success?.enumerable && 'value' in success && success.value === true);
	} catch {
		return false;
	}
}

export async function handleRecordClipMessage(
	value: unknown,
	recorder: ClipRecordEffect,
): Promise<void> {
	try {
		await recorder(readClipRecordMessage(value));
	} catch {
		throw new ClipRecordingError();
	}
}

export function dispatchRecordClipMessage(
	value: unknown,
	recorder: ClipRecordEffect,
	sendResponse: ClipRecordingSendResponse,
): true | undefined {
	if (!hasOwnRecordClipAction(value)) return undefined;

	void handleRecordClipMessage(value, recorder).then(
		() => safelyRespond(sendResponse, { success: true }),
		() => safelyRespond(sendResponse, {
			success: false,
			error: 'clip-recording-failed',
		}),
	);
	return true;
}

export function createSerializedClipRecorder(
	recorder: ClipRecordEffect,
): ClipRecordEffect {
	let tail: Promise<void> = Promise.resolve();
	return (record) => {
		const operation = tail.then(() => recorder(record));
		tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};
}

export async function sendClipRecordingMessage(
	clipAction: ClipAction,
	url?: string,
	title?: string,
	sendMessage: ClipRecordingMessageSender = (message) => browser.runtime.sendMessage(message),
): Promise<void> {
	const message = {
		action: 'recordClip',
		clipAction,
		...(url === undefined ? {} : { url }),
		...(title === undefined ? {} : { title }),
	};

	try {
		readClipRecordMessage(message);
		const response = await sendMessage(message);
		if (!isExactSuccessResponse(response)) fail();
	} catch {
		throw new ClipRecordingError();
	}
}
