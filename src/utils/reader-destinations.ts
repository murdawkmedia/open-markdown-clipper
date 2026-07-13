import {
	deliverToDestination,
	DestinationSuccessRecorder,
} from '../core/destination-delivery';
import {
	ConfiguredDestinationEffects,
	ConfiguredDestinationPreferences,
	createConfiguredDestinationRegistry,
} from '../destinations/configured';
import {
	DestinationError,
	DestinationKind,
	DestinationResult,
} from '../destinations/types';
import { isTransmittingDestination } from './data-consent';
import type { TransmittingDestination } from './data-consent';

export interface ReaderClipSnapshot {
	readonly title: string;
	readonly markdown: string;
	readonly sourceUrl: string;
}

export interface ReaderDestinationPreferences extends ConfiguredDestinationPreferences {
	readonly defaultDestination: DestinationKind;
}

export interface ReaderDestinationOptions {
	readonly destination?: DestinationKind;
	readonly preferences: ReaderDestinationPreferences;
	readonly capture: () => ReaderClipSnapshot | Promise<ReaderClipSnapshot>;
	readonly now: () => Date;
	readonly getLocalHttpToken: () => Promise<string>;
	readonly hasTransmissionConsent: (destination: TransmittingDestination) => Promise<boolean>;
	readonly effects: ConfiguredDestinationEffects;
	readonly recordSuccess: DestinationSuccessRecorder;
}

export async function deliverReaderDestination(
	options: ReaderDestinationOptions,
): Promise<DestinationResult> {
	try {
		const {
			destination,
			preferences,
			capture,
			now,
			getLocalHttpToken,
			hasTransmissionConsent,
			effects,
			recordSuccess,
		} = options;
		const kind = destination ?? preferences.defaultDestination;
		const ensureTransmissionConsent = async (): Promise<void> => {
			if (
				isTransmittingDestination(kind)
				&& await hasTransmissionConsent(kind) !== true
			) {
				throw new DestinationError('destination-delivery-failed');
			}
		};
		const configuredPreferences: ConfiguredDestinationPreferences = {
			customUriTemplate: preferences.customUriTemplate,
			localHttpEndpoint: preferences.localHttpEndpoint,
		};
		const configuredEffects: ConfiguredDestinationEffects = {
			copy: effects.copy,
			save: effects.save,
			openUri: effects.openUri,
			fetchImpl: effects.fetchImpl,
		};
		await ensureTransmissionConsent();
		const captured = await capture();
		const snapshot: ReaderClipSnapshot = Object.freeze({
			title: captured.title,
			markdown: captured.markdown,
			sourceUrl: captured.sourceUrl,
		});
		await ensureTransmissionConsent();
		let token = '';
		if (kind === 'local-http') {
			token = await getLocalHttpToken();
			await ensureTransmissionConsent();
		}
		const registry = createConfiguredDestinationRegistry(
			configuredPreferences,
			token,
			configuredEffects,
		);

		return await deliverToDestination(
			kind,
			snapshot.title,
			snapshot.markdown,
			snapshot.sourceUrl,
			now,
			registry,
			recordSuccess,
		);
	} catch (error) {
		if (
			error instanceof DestinationError
			&& error.code === 'local-http-outcome-unknown'
		) {
			throw new DestinationError('local-http-outcome-unknown');
		}
		throw new DestinationError('destination-delivery-failed');
	}
}
