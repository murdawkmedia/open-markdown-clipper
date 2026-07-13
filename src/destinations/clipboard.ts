import { copyToClipboard } from '../utils/clipboard-utils';
import {
	ClipDocument,
	ClipDestination,
	DestinationError,
	DestinationResult,
} from './types';

export type CopyEffect = (markdown: string, signal?: AbortSignal) => Promise<boolean>;

export function createClipboardDestination(
	copy: CopyEffect = copyToClipboard,
): ClipDestination {
	return Object.freeze({
		kind: 'clipboard' as const,
		async send(document: ClipDocument, signal?: AbortSignal): Promise<DestinationResult> {
			if (signal?.aborted) {
				throw new DestinationError('delivery-aborted');
			}

			let copied: boolean;
			try {
				copied = signal
					? await copy(document.markdown, signal)
					: await copy(document.markdown);
			} catch {
				if (signal?.aborted) throw new DestinationError('delivery-aborted');
				throw new DestinationError('clipboard-failed');
			}
			if (signal?.aborted) throw new DestinationError('delivery-aborted');
			if (!copied) throw new DestinationError('clipboard-failed');

			return { destination: 'clipboard' };
		},
	});
}
