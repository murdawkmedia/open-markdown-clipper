import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	CUSTOM_URI_DATA_PERMISSIONS,
	DATA_TRANSMISSION_PERMISSIONS,
	checkDataTransmissionConsentViaRuntime,
	createDataConsentController,
	dispatchDataTransmissionConsentCheckMessage,
	isTransmittingDestination,
} from './data-consent';

interface MutablePermissions {
	data_collection?: string[];
}

function permissionsApi(initial: MutablePermissions = {}) {
	let current = initial;
	const getAll = vi.fn(async () => current);
	const request = vi.fn(async () => true);

	return {
		api: { getAll, request },
		getAll,
		request,
		setCurrent(next: MutablePermissions) {
			current = next;
		},
	};
}

describe('data transmission consent', () => {
	it('declares the exact Firefox data categories used by external destinations', () => {
		expect(DATA_TRANSMISSION_PERMISSIONS).toEqual([
			'authenticationInfo',
			'browsingActivity',
			'websiteContent',
			'websiteActivity',
		]);
	});

	it.each([
		['clipboard', false],
		['download', false],
		['custom-uri', true],
		['local-http', true],
	] as const)('classifies %s transmission as %s', (destination, expected) => {
		expect(isTransmittingDestination(destination)).toBe(expected);
	});

	it('treats a browser without data_collection support as compatible without requesting', async () => {
		const permissions = permissionsApi({});
		const controller = createDataConsentController(permissions.api);

		await expect(controller.prime()).resolves.toBe('unsupported');
		await expect(controller.requestFromUserGesture('local-http')).resolves.toBe(true);
		await expect(controller.hasConsent('custom-uri')).resolves.toBe(true);
		expect(permissions.request).not.toHaveBeenCalled();
	});

	it.each([
		['custom-uri', CUSTOM_URI_DATA_PERMISSIONS],
		['local-http', DATA_TRANSMISSION_PERMISSIONS],
	] as const)('requests only the %s categories synchronously after support is primed', async (
		destination,
		expectedPermissions,
	) => {
		const permissions = permissionsApi({ data_collection: [] });
		const controller = createDataConsentController(permissions.api);
		await controller.prime();

		const requestPromise = controller.requestFromUserGesture(destination);

		expect(permissions.request).toHaveBeenCalledTimes(1);
		expect(permissions.request).toHaveBeenCalledWith({
			data_collection: expectedPermissions,
		});
		await expect(requestPromise).resolves.toBe(true);
	});

	it('fails closed before support detection instead of prompting after asynchronous setup', async () => {
		const permissions = permissionsApi({ data_collection: [] });
		const controller = createDataConsentController(permissions.api);

		await expect(controller.requestFromUserGesture('local-http')).resolves.toBe(false);
		expect(permissions.getAll).not.toHaveBeenCalled();
		expect(permissions.request).not.toHaveBeenCalled();
	});

	it('requires only each destination category set and observes a later revocation', async () => {
		const permissions = permissionsApi({
			data_collection: [...DATA_TRANSMISSION_PERMISSIONS],
		});
		const controller = createDataConsentController(permissions.api);
		await controller.prime();

		await expect(controller.hasConsent('local-http')).resolves.toBe(true);
		permissions.setCurrent({
			data_collection: ['browsingActivity', 'websiteContent'],
		});
		await expect(controller.hasConsent('custom-uri')).resolves.toBe(false);
		permissions.setCurrent({
			data_collection: [...CUSTOM_URI_DATA_PERMISSIONS],
		});
		await expect(controller.hasConsent('custom-uri')).resolves.toBe(true);
		await expect(controller.hasConsent('local-http')).resolves.toBe(false);
	});

	it('fails closed when a supported permissions check or request fails', async () => {
		const permissions = permissionsApi({ data_collection: [] });
		const controller = createDataConsentController(permissions.api);
		await controller.prime();
		permissions.getAll.mockRejectedValueOnce(new Error('synthetic check failure'));
		permissions.request.mockRejectedValueOnce(new Error('synthetic request failure'));

		await expect(controller.hasConsent('local-http')).resolves.toBe(false);
		await expect(controller.requestFromUserGesture('local-http')).resolves.toBe(false);
	});

	it('declares schema-valid optional Firefox consent only on the gecko manifest block', () => {
		const manifest = JSON.parse(readFileSync(
			new URL('../manifest.firefox.json', import.meta.url),
			'utf8',
		)) as {
			browser_specific_settings: {
				gecko: { data_collection_permissions?: unknown };
				gecko_android: { data_collection_permissions?: unknown };
			};
		};

		expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({
			required: ['none'],
			optional: DATA_TRANSMISSION_PERMISSIONS,
		});
		expect(manifest.browser_specific_settings.gecko_android)
			.not.toHaveProperty('data_collection_permissions');
	});

	it('checks consent through an exact content-free background message', async () => {
		const sendRuntimeMessage = vi.fn(async () => ({ granted: true }));

		await expect(checkDataTransmissionConsentViaRuntime(sendRuntimeMessage, 'custom-uri'))
			.resolves.toBe(true);
		expect(sendRuntimeMessage).toHaveBeenCalledWith({
			action: 'checkDataTransmissionConsent',
			destination: 'custom-uri',
		});
	});

	it.each([
		null,
		{},
		{ granted: false },
		{ granted: true, privateBody: 'must-not-be-accepted' },
		Object.assign(Object.create(null), { granted: true }),
	])('fails closed on a non-exact background consent response %#', async response => {
		await expect(checkDataTransmissionConsentViaRuntime(
			async () => response,
			'local-http',
		))
			.resolves.toBe(false);
	});

	it('dispatches only the exact read-only consent check and returns a fixed response', async () => {
		const hasConsent = vi.fn(async () => false);
		const sendResponse = vi.fn();

		expect(dispatchDataTransmissionConsentCheckMessage(
			{ action: 'checkDataTransmissionConsent', destination: 'local-http' },
			hasConsent,
			sendResponse,
		)).toBe(true);
		await vi.waitFor(() => {
			expect(sendResponse).toHaveBeenCalledWith({ granted: false });
		});
		expect(hasConsent).toHaveBeenCalledOnce();
		expect(hasConsent).toHaveBeenCalledWith('local-http');
		expect(sendResponse).toHaveBeenCalledOnce();
	});

	it('ignores unrelated messages and fixed-fails malformed consent checks without querying grants', async () => {
		const hasConsent = vi.fn(async () => true);
		const unrelatedResponse = vi.fn();
		const malformedResponse = vi.fn();

		expect(dispatchDataTransmissionConsentCheckMessage(
			{ action: 'somethingElse' },
			hasConsent,
			unrelatedResponse,
		)).toBeUndefined();
		expect(dispatchDataTransmissionConsentCheckMessage(
			{ action: 'checkDataTransmissionConsent', extra: 'private' },
			hasConsent,
			malformedResponse,
		)).toBe(true);
		expect(dispatchDataTransmissionConsentCheckMessage(
			{ action: 'checkDataTransmissionConsent', destination: 'download' },
			hasConsent,
			malformedResponse,
		)).toBe(true);
		await vi.waitFor(() => {
			expect(malformedResponse).toHaveBeenCalledWith({ granted: false });
		});
		expect(hasConsent).not.toHaveBeenCalled();
		expect(unrelatedResponse).not.toHaveBeenCalled();
	});
});
