export type DestinationKind = 'clipboard' | 'download' | 'custom-uri' | 'local-http';

export interface ClipDocument {
	readonly title: string;
	readonly markdown: string;
	readonly sourceUrl: string;
	readonly capturedAt: string;
}

export interface DestinationResult {
	readonly destination: DestinationKind;
	readonly receipt?: string;
}

export interface ClipDestination {
	readonly kind: DestinationKind;
	send(document: ClipDocument, signal?: AbortSignal): Promise<DestinationResult>;
}

export class DestinationError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'DestinationError';
	}
}
