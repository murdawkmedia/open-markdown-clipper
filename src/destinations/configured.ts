import { CopyEffect, createClipboardDestination } from './clipboard';
import { createCustomUriDestination, OpenUriEffect } from './custom-uri';
import { createDownloadDestination, SaveEffect } from './download';
import { createLocalHttpDestination } from './local-http';
import { createDestinationRegistry, DestinationRegistry } from './registry';

export interface ConfiguredDestinationPreferences {
	customUriTemplate: string;
	localHttpEndpoint: string;
}

export interface ConfiguredDestinationEffects {
	copy: CopyEffect;
	save: SaveEffect;
	openUri: OpenUriEffect;
	fetchImpl: typeof fetch;
}

export function createConfiguredDestinationRegistry(
	preferences: ConfiguredDestinationPreferences,
	token: string,
	effects: ConfiguredDestinationEffects,
): DestinationRegistry {
	const { customUriTemplate, localHttpEndpoint } = preferences;
	const { copy, save, openUri, fetchImpl } = effects;

	return createDestinationRegistry([
		createClipboardDestination(copy),
		createDownloadDestination(save),
		createCustomUriDestination({
			template: customUriTemplate,
			copy,
			openUri,
		}),
		createLocalHttpDestination({
			endpoint: localHttpEndpoint,
			token,
			fetchImpl,
		}),
	]);
}
