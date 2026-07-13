import { createMarkdownContent as renderMarkdown } from 'defuddle/full';
import { SaveEffect } from '../destinations/download';
import {
	DestinationError,
	DestinationKind,
	DestinationResult,
} from '../destinations/types';
import browser from './browser-polyfill';
import { parseForClip as parseDocumentForClip } from './clip-utils';
import {
	checkDataTransmissionConsentViaRuntime,
	isTransmittingDestination,
} from './data-consent';
import { getLocalHttpToken as loadLocalHttpToken } from './destination-secrets';
import { saveFile } from './file-utils';
import {
	deliverReaderDestination,
	ReaderClipSnapshot,
	ReaderDestinationPreferences,
} from './reader-destinations';
import {
	incrementStat as recordClipSuccess,
	loadSettings as loadStoredSettings,
} from './storage-utils';

export type DocumentMessageDestination = Extract<
	DestinationKind,
	'clipboard' | 'download'
>;

export type DocumentDestinationResponse =
	| { readonly success: true }
	| {
		readonly success: false;
		readonly error: 'destination-delivery-failed';
	};

export type DocumentDestinationDeliver = (
	destination: DocumentMessageDestination,
) => unknown | Promise<unknown>;

export type DocumentDestinationSendResponse = (
	response: DocumentDestinationResponse,
) => void;

interface ParsedDocument {
	readonly content: string;
	readonly title?: string | null;
}

interface DocumentDestinationSettings extends ReaderDestinationPreferences {}

export interface DocumentDestinationRuntimeOptions {
	readonly document: Document;
	readonly prepare?: () => void | Promise<void>;
	readonly loadSettings?: () => Promise<DocumentDestinationSettings>;
	readonly parseForClip?: (document: Document) => ParsedDocument;
	readonly createMarkdownContent?: (
		content: string,
		sourceUrl: string,
	) => string;
	readonly getLocalHttpToken?: () => Promise<string>;
	readonly writeClipboard?: (markdown: string) => Promise<void>;
	readonly save?: SaveEffect;
	readonly sendRuntimeMessage?: (message: unknown) => Promise<unknown>;
	readonly fetchImpl?: typeof fetch;
	readonly incrementStat?: (
		action: DestinationKind,
		sourceUrl: string,
		title: string,
	) => void | Promise<void>;
	readonly now?: () => Date;
}

export interface DocumentDestinationRuntime {
	deliver(destination?: DestinationKind): Promise<DestinationResult>;
}

function exactSuccessResponse(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;

	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== 'success') return false;
		const success = Object.getOwnPropertyDescriptor(value, 'success');
		if (
			!success
			|| !success.enumerable
			|| !('value' in success)
			|| success.value !== true
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

function defaultClipboardWrite(document: Document): (markdown: string) => Promise<void> {
	return async (markdown) => {
		const clipboard = document.defaultView?.navigator.clipboard;
		if (!clipboard?.writeText) {
			throw new DestinationError('clipboard-unavailable');
		}
		await clipboard.writeText(markdown);
	};
}

export function createDocumentClipboardEffect(
	document: Document,
	writeClipboard: (markdown: string) => Promise<void> = defaultClipboardWrite(document),
): (markdown: string) => Promise<boolean> {
	return async (markdown) => {
		try {
			await writeClipboard(markdown);
			return true;
		} catch {
			// Fail closed. A content script must never place private Markdown in page DOM.
			return false;
		}
	};
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return globalThis.fetch(input, init);
}

export function createDocumentDestinationRuntime(
	options: DocumentDestinationRuntimeOptions,
): DocumentDestinationRuntime {
	const document = options.document;
	const prepare = options.prepare;
	const loadSettings = options.loadSettings ?? loadStoredSettings;
	const parseForClip = options.parseForClip ?? parseDocumentForClip;
	const createMarkdownContent = options.createMarkdownContent ?? renderMarkdown;
	const getLocalHttpToken = options.getLocalHttpToken ?? loadLocalHttpToken;
	const save = options.save ?? saveFile;
	const sendRuntimeMessage = options.sendRuntimeMessage
		?? (message => browser.runtime.sendMessage(message));
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const incrementStat = options.incrementStat ?? recordClipSuccess;
	const now = options.now ?? (() => new Date());
	const copy = createDocumentClipboardEffect(document, options.writeClipboard);

	return Object.freeze({
		async deliver(destination?: DestinationKind): Promise<DestinationResult> {
			try {
				let snapshot: ReaderClipSnapshot | undefined;
				const capture = async (): Promise<ReaderClipSnapshot> => {
					if (snapshot) return snapshot;
					if (prepare) await prepare();
					const sourceUrl = document.URL;
					const parsed = parseForClip(document);
					snapshot = Object.freeze({
						title: parsed.title || document.title || 'Untitled',
						markdown: createMarkdownContent(parsed.content, sourceUrl),
						sourceUrl,
					});
					return snapshot;
				};

				// Local-only explicit commands preserve the immediate document snapshot.
				// A configured external default must be resolved before capture so the
				// background consent check can run first.
				const earlyCapture = destination && !isTransmittingDestination(destination)
					? capture()
					: undefined;
				const preferences = await loadSettings();
				if (earlyCapture) await earlyCapture;

				return await deliverReaderDestination({
					destination,
					preferences,
					capture,
					now,
					getLocalHttpToken,
					hasTransmissionConsent: destination => (
						checkDataTransmissionConsentViaRuntime(sendRuntimeMessage, destination)
					),
					effects: {
						copy,
						save,
						async openUri(uri) {
							const response = await sendRuntimeMessage({
								action: 'openCustomUri',
								uri,
							});
							if (!exactSuccessResponse(response)) {
								throw new DestinationError('custom-uri-open-failed');
							}
						},
						fetchImpl,
					},
					async recordSuccess(result) {
						if (!snapshot) {
							throw new DestinationError('destination-delivery-failed');
						}
						await incrementStat(
							result.destination,
							snapshot.sourceUrl,
							snapshot.title,
						);
					},
				});
			} catch (error) {
				if (
					error instanceof DestinationError
					&& error.code === 'local-http-outcome-unknown'
				) {
					throw new DestinationError('local-http-outcome-unknown');
				}
				throw new DestinationError('destination-delivery-failed');
			}
		},
	});
}

type InspectedMessage =
	| { readonly handled: false }
	| {
		readonly handled: true;
		readonly destination?: DocumentMessageDestination;
	};

function inspectDocumentDestinationMessage(value: unknown): InspectedMessage {
	if (typeof value !== 'object' || value === null) return { handled: false };

	// WebExtension messages have already crossed a structured-clone boundary.
	// Direct callers may still supply Proxies, so reflection stays fail-closed;
	// descriptor-first ordering also rejects accessors without invoking getters.
	let action: PropertyDescriptor | undefined;
	try {
		action = Object.getOwnPropertyDescriptor(value, 'action');
	} catch {
		return { handled: true };
	}
	if (!action) return { handled: false };
	if (!('value' in action)) return { handled: true };

	const destination = action.value === 'copyMarkdownToClipboard'
		? 'clipboard'
		: action.value === 'saveMarkdownToFile'
			? 'download'
			: undefined;
	if (!destination) return { handled: false };

	try {
		if (
			Object.getPrototypeOf(value) !== Object.prototype
			|| !action.enumerable
		) {
			return { handled: true };
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== 'action') {
			return { handled: true };
		}
		if (typeof globalThis.structuredClone !== 'function') {
			return { handled: true };
		}
		globalThis.structuredClone(value);
		return { handled: true, destination };
	} catch {
		return { handled: true };
	}
}

function safelyRespond(
	sendResponse: DocumentDestinationSendResponse,
	response: DocumentDestinationResponse,
): void {
	try {
		sendResponse(response);
	} catch {
		// The sender may close the port while the awaited destination settles.
	}
}

export function dispatchDocumentDestinationMessage(
	value: unknown,
	deliver: DocumentDestinationDeliver,
	sendResponse: DocumentDestinationSendResponse,
): true | undefined {
	const inspected = inspectDocumentDestinationMessage(value);
	if (!inspected.handled) return undefined;

	const delivery = inspected.destination
		? Promise.resolve().then(() => deliver(inspected.destination!))
		: Promise.reject(new DestinationError('destination-delivery-failed'));
	void delivery.then(
		() => safelyRespond(sendResponse, { success: true }),
		() => safelyRespond(sendResponse, {
			success: false,
			error: 'destination-delivery-failed',
		}),
	);
	return true;
}
