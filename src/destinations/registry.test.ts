import { describe, expect, it, vi } from 'vitest';
import { createDestinationRegistry, resolveDestination } from './registry';
import {
	ClipDestination,
	DestinationError,
	DestinationKind,
} from './types';

function destination(kind: DestinationKind): ClipDestination {
	return {
		kind,
		send: vi.fn(async () => ({ destination: kind })),
	};
}

const ALL_DESTINATIONS = [
	destination('clipboard'),
	destination('download'),
	destination('custom-uri'),
	destination('local-http'),
];

function expectCode(run: () => unknown, code: string) {
	try {
		run();
		throw new Error('expected registry operation to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).code).toBe(code);
		expect((error as Error).message).toBe(code);
	}
}

describe('destination registry', () => {
	it('resolves each of the four required destinations', () => {
		const registry = createDestinationRegistry(ALL_DESTINATIONS);
		for (const entry of ALL_DESTINATIONS) {
			expect(resolveDestination(registry, entry.kind).kind).toBe(entry.kind);
		}
	});

	it('rejects duplicate destination kinds', () => {
		expectCode(
			() => createDestinationRegistry([...ALL_DESTINATIONS, destination('clipboard')]),
			'duplicate-destination',
		);
	});

	it.each(['clipboard', 'download', 'custom-uri', 'local-http'] as const)(
		'rejects a registry missing %s',
		(missing) => {
			expectCode(
				() => createDestinationRegistry(ALL_DESTINATIONS.filter((entry) => entry.kind !== missing)),
				'missing-destination',
			);
		},
	);

	it('rejects invalid destination kinds at runtime', () => {
		const invalid = { kind: 'private-cloud', send: vi.fn() } as unknown as ClipDestination;
		expectCode(
			() => createDestinationRegistry([...ALL_DESTINATIONS.slice(0, 3), invalid]),
			'invalid-destination',
		);
	});

	it('snapshots adapter kind and send once', async () => {
		let kindReads = 0;
		let sendReads = 0;
		const originalSend = vi.fn(async () => ({ destination: 'clipboard' as const }));
		const accessorAdapter = {
			get kind() {
				kindReads += 1;
				return kindReads === 1 ? 'clipboard' as const : 'local-http' as const;
			},
			get send() {
				sendReads += 1;
				return originalSend;
			},
		};
		const registry = createDestinationRegistry([
			accessorAdapter,
			destination('download'),
			destination('custom-uri'),
			destination('local-http'),
		]);

		const resolved = resolveDestination(registry, 'clipboard');
		await resolved.send({
			title: 'Page',
			markdown: '# Page',
			sourceUrl: 'https://example.com',
			capturedAt: '2026-07-12T18:00:00.000Z',
		});
		expect(resolved.kind).toBe('clipboard');
		expect(kindReads).toBe(1);
		expect(sendReads).toBe(1);
		expect(originalSend).toHaveBeenCalledOnce();
	});

	it('rejects unknown kinds during resolution', () => {
		const registry = createDestinationRegistry(ALL_DESTINATIONS);
		expectCode(
			() => resolveDestination(registry, 'private-cloud' as DestinationKind),
			'destination-not-found',
		);
	});
});
