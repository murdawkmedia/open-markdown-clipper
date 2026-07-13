import {
	ClipDestination,
	ClipDocument,
	DestinationError,
	DestinationKind,
	DestinationResult,
} from './types';

const REQUIRED_DESTINATIONS: readonly DestinationKind[] = [
	'clipboard',
	'download',
	'custom-uri',
	'local-http',
];

export interface DestinationRegistry {
	resolve(kind: DestinationKind): ClipDestination;
}

function isDestinationKind(value: unknown): value is DestinationKind {
	return typeof value === 'string'
		&& REQUIRED_DESTINATIONS.includes(value as DestinationKind);
}

export function createDestinationRegistry(
	destinations: readonly ClipDestination[],
): DestinationRegistry {
	const entries = new Map<DestinationKind, ClipDestination>();

	for (const candidate of destinations) {
		const { kind, send } = candidate;
		if (!isDestinationKind(kind) || typeof send !== 'function') {
			throw new DestinationError('invalid-destination');
		}
		if (entries.has(kind)) {
			throw new DestinationError('duplicate-destination');
		}

		entries.set(kind, Object.freeze({
			kind,
			send: (
				document: ClipDocument,
				signal?: AbortSignal,
			): Promise<DestinationResult> => send.call(candidate, document, signal),
		}));
	}

	if (REQUIRED_DESTINATIONS.some((kind) => !entries.has(kind))) {
		throw new DestinationError('missing-destination');
	}

	return Object.freeze({
		resolve(kind: DestinationKind): ClipDestination {
			if (!isDestinationKind(kind)) {
				throw new DestinationError('destination-not-found');
			}
			const destination = entries.get(kind);
			if (!destination) {
				throw new DestinationError('destination-not-found');
			}
			return destination;
		},
	});
}

export function resolveDestination(
	registry: DestinationRegistry,
	kind: DestinationKind,
): ClipDestination {
	return registry.resolve(kind);
}
