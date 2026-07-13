import { DestinationRegistry } from '../destinations/registry';
import {
	DestinationError,
	DestinationKind,
	DestinationResult,
} from '../destinations/types';
import { buildClipDocument } from '../utils/clip-artifact';

export type DestinationSuccessRecorder = (
	result: DestinationResult,
) => void | Promise<void>;

export async function deliverToDestination(
	kind: DestinationKind,
	title: string,
	markdown: string,
	sourceUrl: string,
	now: () => Date,
	registry: DestinationRegistry,
	recordSuccess: DestinationSuccessRecorder,
	signal?: AbortSignal,
): Promise<DestinationResult> {
	const document = buildClipDocument({ title, markdown, sourceUrl, now });
	let result: DestinationResult;
	try {
		if (signal?.aborted) throw new DestinationError('delivery-aborted');
		const destination = registry.resolve(kind);
		result = await destination.send(document, signal);
		if (signal?.aborted && kind !== 'local-http') {
			throw new DestinationError('delivery-aborted');
		}
	} catch (error) {
		if (
			kind === 'local-http'
			&& error instanceof DestinationError
			&& error.code === 'local-http-outcome-unknown'
		) {
			throw new DestinationError('local-http-outcome-unknown');
		}
		throw new DestinationError('destination-delivery-failed');
	}
	try {
		const recording = recordSuccess(result);
		if (signal) {
			void Promise.resolve(recording).catch(() => undefined);
		} else {
			await recording;
		}
	} catch {
		// Delivery is complete; success recording is deliberately best-effort.
	}
	return result;
}
