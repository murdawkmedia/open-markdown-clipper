import { validateFinalCustomUri } from '../destinations/custom-uri';
import { DestinationError } from '../destinations/types';

export type CustomUriOpener = (uri: string) => void | Promise<void>;

export interface CustomUriBackgroundEffects {
	readonly hasTransmissionConsent: () => Promise<boolean>;
	readonly queryTabs: (query: {
		readonly active: true;
		readonly currentWindow: true;
	}) => Promise<readonly { readonly id?: unknown }[]>;
	readonly updateTab: (tabId: number, uri: string) => void | Promise<void>;
}

export type CustomUriBackgroundResponse =
	| { readonly success: true }
	| { readonly success: false; readonly error: 'custom-uri-open-failed' };

export type CustomUriSendResponse = (response: CustomUriBackgroundResponse) => void;

function invalidMessage(): never {
	throw new DestinationError('invalid-custom-uri');
}

function readCustomUri(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) invalidMessage();

	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) invalidMessage();

		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== 2
			|| !keys.includes('action')
			|| !keys.includes('uri')
		) {
			invalidMessage();
		}

		const descriptors = Object.getOwnPropertyDescriptors(value);
		const action = descriptors.action;
		const uri = descriptors.uri;
		if (
			!action
			|| !uri
			|| !action.enumerable
			|| !uri.enumerable
			|| !('value' in action)
			|| !('value' in uri)
			|| action.value !== 'openCustomUri'
		) {
			invalidMessage();
		}

		// Structured cloning rejects Proxy objects without reading accessor values.
		if (typeof globalThis.structuredClone !== 'function') invalidMessage();
		globalThis.structuredClone(value);
		return uri.value;
	} catch {
		invalidMessage();
	}
}

function hasOwnOpenCustomUriAction(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	try {
		const action = Object.getOwnPropertyDescriptor(value, 'action');
		return Boolean(
			action
			&& 'value' in action
			&& action.value === 'openCustomUri',
		);
	} catch {
		return false;
	}
}

function safelyRespond(
	sendResponse: CustomUriSendResponse,
	response: CustomUriBackgroundResponse,
): void {
	try {
		sendResponse(response);
	} catch {
		// The sender may close the message port before an asynchronous effect settles.
	}
}

export function dispatchOpenCustomUriMessage(
	value: unknown,
	effects: CustomUriBackgroundEffects,
	sendResponse: CustomUriSendResponse,
): true | undefined {
	if (!hasOwnOpenCustomUriAction(value)) return undefined;

	void handleOpenCustomUriMessage(value, async (uri) => {
		if (await effects.hasTransmissionConsent() !== true) {
			throw new DestinationError('custom-uri-open-failed');
		}
		const tabs = await effects.queryTabs({ active: true, currentWindow: true });
		const tabId = tabs[0]?.id;
		if (
			typeof tabId !== 'number'
			|| !Number.isInteger(tabId)
			|| tabId < 0
		) {
			throw new DestinationError('custom-uri-open-failed');
		}
		await effects.updateTab(tabId, uri);
	}).then(
		() => safelyRespond(sendResponse, { success: true }),
		() => safelyRespond(sendResponse, {
			success: false,
			error: 'custom-uri-open-failed',
		}),
	);

	return true;
}

export async function handleOpenCustomUriMessage(
	value: unknown,
	opener: CustomUriOpener,
): Promise<void> {
	const uri = validateFinalCustomUri(readCustomUri(value));
	try {
		await opener(uri);
	} catch {
		throw new DestinationError('custom-uri-open-failed');
	}
}
