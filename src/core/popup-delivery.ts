import { deliverToDestination } from './destination-delivery';
import {
	ConfiguredDestinationEffects,
	ConfiguredDestinationPreferences,
	createConfiguredDestinationRegistry,
} from '../destinations/configured';
import { DestinationRegistry } from '../destinations/registry';
import { DestinationError, DestinationKind } from '../destinations/types';
import {
	DataConsentController,
	isTransmittingDestination,
} from '../utils/data-consent';

export const POPUP_DESTINATION_PRESENTATION = [
	{ destination: 'clipboard', labelKey: 'clipboardDestination', icon: 'copy' },
	{ destination: 'download', labelKey: 'downloadDestination', icon: 'file-down' },
	{ destination: 'custom-uri', labelKey: 'customUriDestination', icon: 'external-link' },
	{ destination: 'local-http', labelKey: 'localHttpDestination', icon: 'send' },
] as const;

export type PopupDeliveryIntent = 'main' | 'secondary' | 'quick';

export interface PopupClipSnapshot {
	readonly title: string;
	readonly markdown: string;
	readonly sourceUrl: string;
}

export interface PopupRefreshToken {
	readonly revision: number;
	readonly tabId: number;
}

export interface PopupRefreshReadinessGate {
	begin(tabId: number): PopupRefreshToken;
	isCurrent(token: PopupRefreshToken, currentTabId: number | undefined): boolean;
	complete(
		token: PopupRefreshToken,
		succeeded: boolean,
		currentTabId: number | undefined,
		refreshedUrl: string | null,
	): boolean;
	currentRevision(): number;
	isReady(): boolean;
	readyUrl(): string | null;
}

export function createRefreshReadinessGate(
	setReady: (ready: boolean) => void,
): PopupRefreshReadinessGate {
	let revision = 0;
	let ready = false;
	let successfulRefreshUrl: string | null = null;

	const isCurrent = (
		token: PopupRefreshToken,
		currentTabId: number | undefined,
	): boolean => token.revision === revision && token.tabId === currentTabId;

	return {
		begin(tabId) {
			const token = Object.freeze({ revision: ++revision, tabId });
			ready = false;
			successfulRefreshUrl = null;
			setReady(false);
			return token;
		},
		isCurrent,
		complete(token, succeeded, currentTabId, refreshedUrl) {
			if (!isCurrent(token, currentTabId)) return false;
			if (!succeeded || !refreshedUrl) {
				ready = false;
				successfulRefreshUrl = null;
				setReady(false);
				return false;
			}
			ready = true;
			successfulRefreshUrl = refreshedUrl;
			setReady(true);
			return true;
		},
		currentRevision: () => revision,
		isReady: () => ready,
		readyUrl: () => successfulRefreshUrl,
	};
}

interface StableSnapshotState<TTemplate extends object> {
	readonly tabId: number | undefined;
	readonly template: TTemplate | null;
	readonly revision: number;
	readonly ready: boolean;
	readonly readyUrl: string | null;
}

interface StableSnapshotDom<TProperties> {
	readonly title: string;
	readonly noteContent: string;
	readonly properties: TProperties;
}

export interface StablePopupSnapshotOptions<
	TTemplate extends object,
	TProperties,
> {
	readonly getState: () => StableSnapshotState<TTemplate>;
	readonly readDom: () => StableSnapshotDom<TProperties>;
	readonly buildMarkdown: (
		properties: TProperties,
		noteContent: string,
		signal?: AbortSignal,
	) => Promise<string>;
	readonly getSourceUrl: (tabId: number, signal?: AbortSignal) => Promise<string>;
}

function requireActiveSnapshot(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DestinationError('destination-delivery-failed');
	}
}

async function awaitWhileActive<T>(
	work: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	requireActiveSnapshot(signal);
	if (!signal) return work;

	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new DestinationError('destination-delivery-failed'));
		signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

export async function captureStablePopupSnapshot<
	TTemplate extends object,
	TProperties,
>(
	options: StablePopupSnapshotOptions<TTemplate, TProperties>,
	signal?: AbortSignal,
): Promise<PopupClipSnapshot> {
	const {
		getState,
		readDom,
		buildMarkdown,
		getSourceUrl,
	} = options;
	requireActiveSnapshot(signal);
	const captured = getState();
	if (
		!captured.ready
		|| captured.tabId === undefined
		|| !captured.template
		|| !captured.readyUrl
	) {
		throw new DestinationError('destination-delivery-failed');
	}

	const dom = readDom();
	const [markdown, sourceUrl] = await awaitWhileActive(Promise.all([
		Promise.resolve().then(() => buildMarkdown(dom.properties, dom.noteContent, signal)),
		Promise.resolve().then(() => getSourceUrl(captured.tabId!, signal)),
	]), signal);
	requireActiveSnapshot(signal);
	const current = getState();
	if (
		!current.ready
		|| current.tabId !== captured.tabId
		|| current.template !== captured.template
		|| current.revision !== captured.revision
		|| current.readyUrl !== captured.readyUrl
		|| sourceUrl !== captured.readyUrl
	) {
		throw new DestinationError('destination-delivery-failed');
	}

	return {
		title: dom.title,
		markdown,
		sourceUrl: captured.readyUrl,
	};
}

type RuntimeMessage = (message: unknown) => Promise<unknown>;
type RegistryFactory = (
	preferences: ConfiguredDestinationPreferences,
	token: string,
	effects: ConfiguredDestinationEffects,
) => DestinationRegistry;

export interface PopupDestinationDeliveryOptions {
	readonly document: Document;
	readonly defaultDestination: DestinationKind;
	readonly preferences: ConfiguredDestinationPreferences;
	readonly getSnapshot: (signal?: AbortSignal) => Promise<PopupClipSnapshot>;
	readonly getToken: (signal?: AbortSignal) => Promise<string>;
	readonly dataConsent: Pick<
		DataConsentController,
		'hasConsent' | 'requestFromUserGesture'
	>;
	readonly copy: ConfiguredDestinationEffects['copy'];
	readonly save: ConfiguredDestinationEffects['save'];
	readonly sendRuntimeMessage: RuntimeMessage;
	readonly fetchImpl: typeof fetch;
	readonly recordSuccess: (
		destination: DestinationKind,
		sourceUrl: string,
		title: string,
	) => void | Promise<void>;
	readonly now: () => Date;
	readonly getMessage: (key: string) => string;
	readonly initializeIcons?: (root: HTMLElement) => void;
	readonly closePopup: () => void;
	readonly canClosePopup: boolean;
	readonly registryFactory?: RegistryFactory;
}

export interface PopupDestinationConfigurationUpdate {
	readonly defaultDestination?: DestinationKind;
	readonly preferences?: Partial<ConfiguredDestinationPreferences>;
}

export interface PopupDestinationDelivery {
	deliver(
		destination: DestinationKind,
		intent: PopupDeliveryIntent,
		signal?: AbortSignal,
	): Promise<boolean>;
	deliverDefault(intent: PopupDeliveryIntent, signal?: AbortSignal): Promise<boolean>;
	setReady(ready: boolean): void;
	isReady(): boolean;
	updateConfiguration(update: PopupDestinationConfigurationUpdate): void;
	closeAfterQuickSuccess(): void;
}

function isFixedRuntimeSuccess(response: unknown): boolean {
	return !!response
		&& typeof response === 'object'
		&& Object.keys(response).length === 1
		&& Object.prototype.hasOwnProperty.call(response, 'success')
		&& (response as { success?: unknown }).success === true;
}

function destinationControls(document: Document): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll<HTMLButtonElement>(
		'button[data-destination], #more-btn',
	));
}

function setDeliveryStatus(
	document: Document,
	message: string,
): void {
	const status = document.getElementById('delivery-status');
	if (!status) return;
	status.textContent = message;
	status.hidden = message.length === 0;
}

function renderDestinationActions(
	document: Document,
	defaultDestination: DestinationKind,
	getMessage: (key: string) => string,
	initializeIcons: ((root: HTMLElement) => void) | undefined,
	onDeliver: (destination: DestinationKind, intent: PopupDeliveryIntent) => void,
): void {
	const mainButton = document.getElementById('clip-btn') as HTMLButtonElement | null;
	const secondaryActions = document.querySelector('.secondary-actions');
	if (!mainButton || !secondaryActions) return;

	const main = POPUP_DESTINATION_PRESENTATION.find(
		action => action.destination === defaultDestination,
	);
	if (!main) return;
	mainButton.type = 'button';
	mainButton.dataset.destination = main.destination;
	mainButton.textContent = getMessage(main.labelKey);
	mainButton.onclick = () => onDeliver(main.destination, 'main');

	secondaryActions.textContent = '';
	for (const action of POPUP_DESTINATION_PRESENTATION) {
		if (action.destination === defaultDestination) continue;

		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'menu-item';
		button.dataset.destination = action.destination;

		const iconContainer = document.createElement('span');
		iconContainer.className = 'menu-item-icon';
		const icon = document.createElement('i');
		icon.setAttribute('data-lucide', action.icon);
		iconContainer.appendChild(icon);

		const title = document.createElement('span');
		title.className = 'menu-item-title';
		title.textContent = getMessage(action.labelKey);
		button.append(iconContainer, title);
		button.addEventListener('click', () => onDeliver(action.destination, 'secondary'));
		secondaryActions.appendChild(button);
		initializeIcons?.(button);
	}
}

export function createPopupDestinationDelivery(
	options: PopupDestinationDeliveryOptions,
): PopupDestinationDelivery {
	const {
		document,
		defaultDestination: initialDefaultDestination,
		preferences: initialPreferences,
		getSnapshot,
		getToken,
		dataConsent,
		copy,
		save,
		sendRuntimeMessage,
		fetchImpl,
		recordSuccess,
		now,
		getMessage,
		initializeIcons,
		closePopup,
		canClosePopup,
		registryFactory = createConfiguredDestinationRegistry,
	} = options;
	let defaultDestination = initialDefaultDestination;
	let preferences: ConfiguredDestinationPreferences = { ...initialPreferences };
	let pendingConfiguration: {
		defaultDestination: DestinationKind;
		preferences: ConfiguredDestinationPreferences;
	} | null = null;
	let ready = false;
	let activeIdentity: {
		destination: DestinationKind;
		intent: PopupDeliveryIntent;
	} | null = null;
	let inFlightPromise: Promise<boolean> | null = null;
	let controller!: PopupDestinationDelivery;

	const render = (): void => {
		renderDestinationActions(
			document,
			defaultDestination,
			getMessage,
			initializeIcons,
			(destination, intent) => {
				void controller.deliver(destination, intent);
			},
		);
	};

	const updateControls = (): void => {
		const disabled = !ready || activeIdentity !== null;
		for (const control of destinationControls(document)) {
			control.disabled = disabled;
		}
	};

	const applyConfiguration = (
		update: PopupDestinationConfigurationUpdate,
	): void => {
		defaultDestination = update.defaultDestination ?? defaultDestination;
		preferences = {
			...preferences,
			...update.preferences,
		};
		render();
		updateControls();
	};

	const queueConfiguration = (
		update: PopupDestinationConfigurationUpdate,
	): void => {
		if (!activeIdentity) {
			applyConfiguration(update);
			return;
		}
		const base = pendingConfiguration ?? {
			defaultDestination,
			preferences,
		};
		pendingConfiguration = {
			defaultDestination: update.defaultDestination ?? base.defaultDestination,
			preferences: {
				...base.preferences,
				...update.preferences,
			},
		};
	};

	const deliver = (
		destination: DestinationKind,
		intent: PopupDeliveryIntent,
		signal?: AbortSignal,
	): Promise<boolean> => {
		if (!ready || signal?.aborted) {
			setDeliveryStatus(document, getMessage('destinationDeliveryFailed'));
			return Promise.resolve(false);
		}
		if (activeIdentity) {
			if (
				activeIdentity.destination === destination
				&& activeIdentity.intent === intent
			) {
				return inFlightPromise ?? Promise.resolve(false);
			}
			return Promise.resolve(false);
		}

		let initialConsent: Promise<boolean> | undefined;
		if (isTransmittingDestination(destination)) {
			try {
				initialConsent = intent === 'quick'
					? dataConsent.hasConsent(destination)
					: dataConsent.requestFromUserGesture(destination);
			} catch {
				setDeliveryStatus(document, getMessage('destinationDeliveryFailed'));
				return Promise.resolve(false);
			}
		}

		activeIdentity = { destination, intent };
		updateControls();

		const run = async (): Promise<boolean> => {
			setDeliveryStatus(document, '');
			const ensureTransmissionConsent = async (): Promise<void> => {
				if (
					isTransmittingDestination(destination)
					&& await awaitWhileActive(dataConsent.hasConsent(destination), signal) !== true
				) {
					throw new DestinationError('destination-delivery-failed');
				}
			};

			try {
				if (signal?.aborted) throw new DestinationError('destination-delivery-failed');
				if (initialConsent) {
					const granted = await awaitWhileActive(initialConsent, signal);
					if (granted !== true) {
						throw new DestinationError('destination-delivery-failed');
					}
					if (intent !== 'quick') await ensureTransmissionConsent();
				}
				const snapshot = await awaitWhileActive(
					Promise.resolve().then(() => getSnapshot(signal)),
					signal,
				);
				if (!ready || signal?.aborted) {
					throw new DestinationError('destination-delivery-failed');
				}
				await ensureTransmissionConsent();
				const token = destination === 'local-http'
					? await awaitWhileActive(
						Promise.resolve().then(() => getToken(signal)),
						signal,
					)
					: '';
				if (!ready || signal?.aborted) {
					throw new DestinationError('destination-delivery-failed');
				}
				const operationPreferences = { ...preferences };
				const registry = registryFactory(operationPreferences, token, {
					copy,
					save,
					openUri: async (uri, destinationSignal) => {
						if (destinationSignal?.aborted) {
							throw new Error('custom-uri-open-failed');
						}
						await ensureTransmissionConsent();
						const response = await sendRuntimeMessage({
							action: 'openCustomUri',
							uri,
						});
						if (destinationSignal?.aborted || !isFixedRuntimeSuccess(response)) {
							throw new Error('custom-uri-open-failed');
						}
					},
					fetchImpl: (async (input, init) => {
						await ensureTransmissionConsent();
						return fetchImpl(input, init);
					}) as typeof fetch,
				});

				const delivery = deliverToDestination(
					destination,
					snapshot.title,
					snapshot.markdown,
					snapshot.sourceUrl,
					now,
					registry,
					result => recordSuccess(
						result.destination,
						snapshot.sourceUrl,
						snapshot.title,
					),
					signal,
				);
				if (destination === 'local-http') await delivery;
				else await awaitWhileActive(delivery, signal);
			} catch (error) {
				const statusKey = error instanceof DestinationError
					&& error.code === 'local-http-outcome-unknown'
					? 'localHttpOutcomeUnknown'
					: 'destinationDeliveryFailed';
				setDeliveryStatus(document, getMessage(statusKey));
				return false;
			}

			setDeliveryStatus(document, '');
			document.getElementById('more-dropdown')?.classList.remove('show');
			if (canClosePopup && intent === 'main') {
				try {
					closePopup();
				} catch {
					// Delivery is already complete; closing the popup is best-effort.
				}
			}
			return true;
		};

		inFlightPromise = run().finally(() => {
			activeIdentity = null;
			inFlightPromise = null;
			if (pendingConfiguration) {
				const pending = pendingConfiguration;
				pendingConfiguration = null;
				applyConfiguration(pending);
			} else {
				updateControls();
			}
		});
		return inFlightPromise;
	};

	controller = {
		deliver,
		deliverDefault: (intent, signal) => deliver(defaultDestination, intent, signal),
		setReady(nextReady) {
			ready = nextReady;
			updateControls();
		},
		isReady: () => ready,
		updateConfiguration: queueConfiguration,
		closeAfterQuickSuccess: () => {
			if (!canClosePopup) return;
			try {
				closePopup();
			} catch {
				// Delivery is already complete; closing the popup is best-effort.
			}
		},
	};
	render();
	updateControls();
	return controller;
}

export async function respondToQuickClip(
	controller: PopupDestinationDelivery,
	sendResponse: (response: { success: true } | {
		success: false;
		error: 'destination-delivery-failed';
	}) => void,
): Promise<void> {
	const success = await controller.deliverDefault('quick');
	if (success) {
		try {
			sendResponse({ success: true });
		} catch {
			// The message channel may already be gone; never send a second response.
		}
		controller.closeAfterQuickSuccess();
		return;
	}
	try {
		sendResponse({ success: false, error: 'destination-delivery-failed' });
	} catch {
		// The response is best-effort and deliberately attempted only once.
	}
}
