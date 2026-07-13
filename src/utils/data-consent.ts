import { DestinationKind } from '../destinations/types';

export const DATA_TRANSMISSION_PERMISSIONS = [
	'authenticationInfo',
	'browsingActivity',
	'websiteContent',
	'websiteActivity',
] as const;

export const CUSTOM_URI_DATA_PERMISSIONS = [
	'browsingActivity',
	'websiteContent',
	'websiteActivity',
] as const;

type DataTransmissionPermission = typeof DATA_TRANSMISSION_PERMISSIONS[number];
type DataConsentSupport = 'unknown' | 'supported' | 'unsupported';
export type TransmittingDestination = Extract<
	DestinationKind,
	'custom-uri' | 'local-http'
>;

export interface DataCollectionPermissions {
	readonly data_collection?: readonly string[];
}

export interface DataConsentPermissionsApi {
	getAll(): Promise<DataCollectionPermissions>;
	request(permissions: {
		readonly data_collection: readonly DataTransmissionPermission[];
	}): Promise<boolean>;
}

export interface DataConsentController {
	prime(): Promise<DataConsentSupport>;
	hasConsent(destination: TransmittingDestination): Promise<boolean>;
	requestFromUserGesture(destination: TransmittingDestination): Promise<boolean>;
}

export type DataConsentRuntimeMessage = (
	message: unknown,
) => Promise<unknown>;

export type DataConsentCheckResponse = {
	readonly granted: boolean;
};

export type DataConsentCheckSendResponse = (
	response: DataConsentCheckResponse,
) => void;

function permissionsForDestination(
	destination: TransmittingDestination,
): readonly DataTransmissionPermission[] {
	return destination === 'local-http'
		? DATA_TRANSMISSION_PERMISSIONS
		: CUSTOM_URI_DATA_PERMISSIONS;
}

export function isTransmittingDestination(
	destination: DestinationKind,
): destination is TransmittingDestination {
	return destination === 'custom-uri' || destination === 'local-http';
}

function isExactGrantedResponse(value: unknown): value is DataConsentCheckResponse {
	if (typeof value !== 'object' || value === null) return false;

	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 1 || keys[0] !== 'granted') return false;
		const granted = Object.getOwnPropertyDescriptor(value, 'granted');
		if (
			!granted
			|| !granted.enumerable
			|| !('value' in granted)
			|| typeof granted.value !== 'boolean'
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

export async function checkDataTransmissionConsentViaRuntime(
	sendRuntimeMessage: DataConsentRuntimeMessage,
	destination: TransmittingDestination,
): Promise<boolean> {
	try {
		const response = await sendRuntimeMessage({
			action: 'checkDataTransmissionConsent',
			destination,
		});
		return isExactGrantedResponse(response) && response.granted;
	} catch {
		return false;
	}
}

type InspectedConsentCheck =
	| { readonly status: 'unrelated' }
	| { readonly status: 'invalid' }
	| {
		readonly status: 'valid';
		readonly destination: TransmittingDestination;
	};

function inspectConsentCheckMessage(value: unknown): InspectedConsentCheck {
	if (typeof value !== 'object' || value === null) return { status: 'unrelated' };

	try {
		const action = Object.getOwnPropertyDescriptor(value, 'action');
		if (!action || !('value' in action) || action.value !== 'checkDataTransmissionConsent') {
			return { status: 'unrelated' };
		}
		const destination = Object.getOwnPropertyDescriptor(value, 'destination');
		if (
			Object.getPrototypeOf(value) !== Object.prototype
			|| !action.enumerable
			|| !destination?.enumerable
			|| !('value' in destination)
			|| !isTransmittingDestination(destination.value as DestinationKind)
			|| Reflect.ownKeys(value).length !== 2
			|| !Reflect.ownKeys(value).includes('destination')
			|| typeof globalThis.structuredClone !== 'function'
		) {
			return { status: 'invalid' };
		}
		globalThis.structuredClone(value);
		return {
			status: 'valid',
			destination: destination.value as TransmittingDestination,
		};
	} catch {
		return { status: 'invalid' };
	}
}

function safelySendConsentCheckResponse(
	sendResponse: DataConsentCheckSendResponse,
	granted: boolean,
): void {
	try {
		sendResponse({ granted });
	} catch {
		// The sender may close the message port while the read-only check settles.
	}
}

export function dispatchDataTransmissionConsentCheckMessage(
	value: unknown,
	hasConsent: (destination: TransmittingDestination) => Promise<boolean>,
	sendResponse: DataConsentCheckSendResponse,
): true | undefined {
	const inspected = inspectConsentCheckMessage(value);
	if (inspected.status === 'unrelated') return undefined;
	if (inspected.status === 'invalid') {
		safelySendConsentCheckResponse(sendResponse, false);
		return true;
	}

	void Promise.resolve()
		.then(() => hasConsent(inspected.destination))
		.then(
			granted => safelySendConsentCheckResponse(sendResponse, granted === true),
			() => safelySendConsentCheckResponse(sendResponse, false),
		);
	return true;
}

function hasDataCollectionSupport(
	permissions: DataCollectionPermissions,
): permissions is Required<Pick<DataCollectionPermissions, 'data_collection'>> {
	return Object.prototype.hasOwnProperty.call(permissions, 'data_collection');
}

export function createDataConsentController(
	permissionsApi: DataConsentPermissionsApi,
): DataConsentController {
	let support: DataConsentSupport = 'unknown';

	return {
		async prime(): Promise<DataConsentSupport> {
			try {
				const permissions = await permissionsApi.getAll();
				support = hasDataCollectionSupport(permissions) ? 'supported' : 'unsupported';
			} catch {
				support = 'unknown';
			}
			return support;
		},

		async hasConsent(destination: TransmittingDestination): Promise<boolean> {
			try {
				const permissions = await permissionsApi.getAll();
				if (!hasDataCollectionSupport(permissions)) {
					support = 'unsupported';
					return true;
				}

				support = 'supported';
				return permissionsForDestination(destination)
					.every(permission => permissions.data_collection.includes(permission));
			} catch {
				return false;
			}
		},

		async requestFromUserGesture(destination: TransmittingDestination): Promise<boolean> {
			if (support === 'unsupported') return true;
			if (support !== 'supported') return false;

			try {
				// This API call must remain the first asynchronous operation in the
				// user-gesture handler so Firefox can display its built-in prompt.
				return await permissionsApi.request({
					data_collection: permissionsForDestination(destination),
				});
			} catch {
				return false;
			}
		},
	};
}
