// @vitest-environment jsdom

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { DestinationError } from './destinations/types';
import * as readerModule from './utils/reader';

type TestDestination = 'clipboard' | 'download';
type TestAction = {
	readonly destination?: TestDestination;
	readonly label: string;
	readonly icon: Node;
};
type TestRuntime = {
	deliver(destination?: TestDestination): Promise<unknown>;
};
type TestDestinationMenu = HTMLDivElement & {
	dispose(): void;
};
type TestRevision = {
	readonly revision: number;
	readonly previousReady: boolean;
};
type TestReadinessGate = {
	begin(): TestRevision;
	beginFresh(): TestRevision;
	complete(revision: TestRevision): boolean;
	restore(revision: TestRevision): boolean;
	deactivate(): void;
	state(): { readonly revision: number; readonly ready: boolean };
};
type TestReadinessGateConstructor = new () => TestReadinessGate;
type TestDropdownController = {
	open(): void;
	close(): void;
	toggle(): void;
};
type TestDropdownControllerFactory = (
	trigger: HTMLButtonElement,
	dropdown: HTMLElement,
) => TestDropdownController;
type TestAwaitedToggleWire = (
	button: HTMLButtonElement,
	isOpen: () => boolean,
	toggle: () => boolean | Promise<boolean>,
) => void;
type ReaderDestinationMenuFactory = (
	doc: Document,
	runtime: TestRuntime,
	readiness: TestReadinessGate,
	actions: readonly TestAction[],
	messages: {
		readonly success: string;
		readonly failure: string;
		readonly outcomeUnknown?: string;
	},
) => TestDestinationMenu;

const READER_SOURCE = readFileSync(
	join(process.cwd(), 'src', 'utils', 'reader.ts'),
	'utf8',
);
const READER_HTML = readFileSync(
	join(process.cwd(), 'src', 'reader.html'),
	'utf8',
);
const EN_MESSAGES = JSON.parse(readFileSync(
	join(process.cwd(), 'src', '_locales', 'en', 'messages.json'),
	'utf8',
)) as Record<string, { message: string }>;

function destinationMenuFactory(): ReaderDestinationMenuFactory | undefined {
	return (readerModule as unknown as {
		createReaderDestinationMenu?: ReaderDestinationMenuFactory;
	}).createReaderDestinationMenu;
}

function readinessGateConstructor(): TestReadinessGateConstructor | undefined {
	return (readerModule as unknown as {
		ReaderDestinationReadinessGate?: TestReadinessGateConstructor;
	}).ReaderDestinationReadinessGate;
}

function dropdownControllerFactory(): TestDropdownControllerFactory | undefined {
	return (readerModule as unknown as {
		createReaderDropdownController?: TestDropdownControllerFactory;
	}).createReaderDropdownController;
}

function awaitedToggleWire(): TestAwaitedToggleWire | undefined {
	return (readerModule as unknown as {
		wireAwaitedReaderToggle?: TestAwaitedToggleWire;
	}).wireAwaitedReaderToggle;
}

function readyGate(): TestReadinessGate | undefined {
	const Gate = readinessGateConstructor();
	if (!Gate) return undefined;
	const gate = new Gate();
	gate.complete(gate.beginFresh());
	return gate;
}

function action(destination: TestDestination | undefined, label: string): TestAction {
	return {
		destination,
		label,
		icon: document.createElement('span'),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

describe('reader destination wiring and public branding', () => {
	it('exposes focused destination controls backed by the document runtime', () => {
		expect(destinationMenuFactory()).toBeTypeOf('function');
		expect(readinessGateConstructor()).toBeTypeOf('function');
		expect(READER_SOURCE).toContain('export function createReaderDestinationMenu');
		expect(READER_SOURCE).toContain("import { createDocumentDestinationRuntime } from './document-destination-runtime';");
		expect(READER_SOURCE).not.toMatch(/copyMarkdownOnReaderPage|saveMarkdownOnReaderPage/);
		expect(READER_SOURCE).not.toMatch(/copyMarkdownToClipboard|saveMarkdownToFile/);
		expect(READER_SOURCE).not.toMatch(/import \{ createMarkdownContent \}|import \{ saveFile \}|import \{ parseForClip \}/);
	});

	it('uses neutral Open Markdown Clipper reader branding', () => {
		expect(READER_HTML).toContain('<title>Open Markdown Clipper</title>');
		expect(READER_SOURCE).toContain("'Open Markdown Clipper'");
		expect(READER_SOURCE).toContain("browser.runtime.getURL('icons/icon16.png')");
		const legacyReaderMessage = ["getMessage('addTo", 'Ob', "sidian')"].join('');
		expect(READER_SOURCE).not.toContain(legacyReaderMessage);
		expect(READER_SOURCE).not.toContain('viewBox\', \'0 0 256 256');
	});

	it('defines fixed, generic reader destination labels and statuses', () => {
		expect(EN_MESSAGES.readerDeliverMarkdown?.message).toBe('Deliver Markdown');
		expect(EN_MESSAGES.readerDefaultDestination?.message).toBe('Default destination');
		expect(EN_MESSAGES.readerClipboardDestination?.message).toBe('Clipboard');
		expect(EN_MESSAGES.readerDownloadDestination?.message).toBe('Download');
		expect(EN_MESSAGES.readerOpenClipper?.message).toBe('Open clipper');
		expect(EN_MESSAGES.readerDeliverySuccess?.message).toBe('Delivered');
		expect(EN_MESSAGES.readerDeliveryFailed?.message).toBe('Delivery failed');
		expect(EN_MESSAGES.localHttpOutcomeUnknown?.message)
			.toBe('Delivery result is unknown. Check the receiver before retrying.');
	});

	it('routes semantic Default, Clipboard, and Download buttons and waits for success', async () => {
		const factory = destinationMenuFactory();
		const gate = readyGate();
		expect(factory).toBeTypeOf('function');
		expect(gate).toBeDefined();
		if (!factory || !gate) return;

		const pending = deferred<unknown>();
		const deliver = vi.fn(() => pending.promise);
		const menu = factory(document, { deliver }, gate, [
			action(undefined, 'Default destination'),
			action('clipboard', 'Clipboard'),
			action('download', 'Download'),
		], { success: 'Delivered', failure: 'Delivery failed' });
		const buttons = Array.from(menu.querySelectorAll('button'));
		const status = menu.querySelector('[role="status"]');

		expect(buttons).toHaveLength(3);
		expect(buttons.map(button => button.type)).toEqual(['button', 'button', 'button']);
		expect(buttons.map(button => button.textContent)).toEqual([
			'Default destination', 'Clipboard', 'Download',
		]);

		buttons[0].click();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
		expect(deliver).toHaveBeenNthCalledWith(1);
		expect(status?.textContent).toBe('');
		expect(buttons.every(button => button.disabled)).toBe(true);

		pending.resolve({ destination: 'local-http' });
		await vi.waitFor(() => expect(status?.textContent).toBe('Delivered'));
		expect(buttons.every(button => !button.disabled)).toBe(true);

		deliver.mockResolvedValueOnce({ destination: 'clipboard' });
		buttons[1].click();
		await vi.waitFor(() => expect(deliver).toHaveBeenNthCalledWith(2, 'clipboard'));

		deliver.mockResolvedValueOnce({ destination: 'download' });
		buttons[2].click();
		await vi.waitFor(() => expect(deliver).toHaveBeenNthCalledWith(3, 'download'));
	});

	it('blocks overlapping delivery and exposes only a fixed generic failure', async () => {
		const factory = destinationMenuFactory();
		const gate = readyGate();
		expect(factory).toBeTypeOf('function');
		expect(gate).toBeDefined();
		if (!factory || !gate) return;

		const pending = deferred<unknown>();
		const deliver = vi.fn(() => pending.promise);
		const consoleSpies = (['debug', 'error', 'info', 'log', 'warn'] as const)
			.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
		try {
			const menu = factory(document, { deliver }, gate, [
				action(undefined, 'Default destination'),
				action('clipboard', 'Clipboard'),
				action('download', 'Download'),
			], { success: 'Delivered', failure: 'Delivery failed' });
			const buttons = Array.from(menu.querySelectorAll('button'));
			const status = menu.querySelector('[role="status"]');

			buttons[0].click();
			buttons[1].click();
			await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

			pending.reject(new Error('private-reader-content-42af'));
			await vi.waitFor(() => expect(status?.textContent).toBe('Delivery failed'));
			expect(status?.textContent).not.toContain('private-reader-content-42af');
			expect(buttons.every(button => !button.disabled)).toBe(true);
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of consoleSpies) spy.mockRestore();
		}
	});

	it('surfaces only the fixed unknown-outcome guidance for an uncertain Local HTTP send', async () => {
		const factory = destinationMenuFactory();
		const gate = readyGate();
		expect(factory).toBeTypeOf('function');
		expect(gate).toBeDefined();
		if (!factory || !gate) return;

		const deliver = vi.fn(async () => {
			throw new DestinationError('local-http-outcome-unknown');
		});
		const menu = factory(document, { deliver }, gate, [
			action(undefined, 'Default destination'),
		], {
			success: 'Delivered',
			failure: 'Delivery failed',
			outcomeUnknown: 'Delivery result is unknown. Check the receiver before retrying.',
		});
		const status = menu.querySelector('[role="status"]');

		menu.querySelector('button')!.click();

		await vi.waitFor(() => expect(status?.textContent)
			.toBe('Delivery result is unknown. Check the receiver before retrying.'));
		expect(status?.textContent).not.toContain('local-http-outcome-unknown');
	});

	it('keeps stale readiness completions from re-enabling a newer revision', () => {
		const Gate = readinessGateConstructor();
		expect(Gate).toBeTypeOf('function');
		if (!Gate) return;

		const gate = new Gate();
		const initial = gate.beginFresh();
		expect(gate.state()).toEqual({ revision: initial.revision, ready: false });
		expect(gate.complete(initial)).toBe(true);
		expect(gate.state().ready).toBe(true);

		const firstNavigation = gate.begin();
		const latestNavigation = gate.begin();
		expect(firstNavigation.previousReady).toBe(true);
		expect(latestNavigation.previousReady).toBe(true);
		expect(gate.complete(firstNavigation)).toBe(false);
		expect(gate.state()).toEqual({
			revision: latestNavigation.revision,
			ready: false,
		});
		expect(gate.restore(latestNavigation)).toBe(true);
		expect(gate.state()).toEqual({
			revision: latestNavigation.revision,
			ready: true,
		});

		gate.deactivate();
		expect(gate.state().ready).toBe(false);
	});

	it('blocks unready clicks and lets an old delivery finish without updating a new page', async () => {
		const factory = destinationMenuFactory();
		const Gate = readinessGateConstructor();
		expect(factory).toBeTypeOf('function');
		expect(Gate).toBeTypeOf('function');
		if (!factory || !Gate) return;

		const gate = new Gate();
		const initial = gate.beginFresh();
		const pending = deferred<unknown>();
		let currentPage = 'old-page';
		const capturedPages: string[] = [];
		const deliver = vi.fn(() => {
			capturedPages.push(currentPage);
			return pending.promise;
		});
		const menu = factory(document, { deliver }, gate, [
			action(undefined, 'Default destination'),
			action('clipboard', 'Clipboard'),
			action('download', 'Download'),
		], { success: 'Delivered', failure: 'Delivery failed' });
		const buttons = Array.from(menu.querySelectorAll('button'));
		const status = menu.querySelector('[role="status"]');

		expect(buttons.every(button => button.disabled)).toBe(true);
		buttons[0].click();
		expect(deliver).not.toHaveBeenCalled();

		gate.complete(initial);
		expect(buttons.every(button => !button.disabled)).toBe(true);
		buttons[0].click();
		expect(deliver).toHaveBeenCalledOnce();
		expect(capturedPages).toEqual(['old-page']);

		const navigation = gate.begin();
		currentPage = 'new-page';
		gate.complete(navigation);
		expect(buttons.every(button => button.disabled)).toBe(true);
		pending.resolve({ destination: 'clipboard' });
		await vi.waitFor(() => expect(buttons.every(button => !button.disabled)).toBe(true));
		expect(status?.textContent).toBe('');
		expect(capturedPages).toEqual(['old-page']);
	});

	it('unsubscribes a disposed reader menu from later readiness revisions', () => {
		const factory = destinationMenuFactory();
		const gate = readyGate();
		expect(factory).toBeTypeOf('function');
		expect(gate).toBeDefined();
		if (!factory || !gate) return;

		const menu = factory(document, { deliver: vi.fn() }, gate, [
			action(undefined, 'Default destination'),
			action('clipboard', 'Clipboard'),
			action('download', 'Download'),
		], { success: 'Delivered', failure: 'Delivery failed' });
		const buttons = Array.from(menu.querySelectorAll('button'));
		expect(menu.dispose).toBeTypeOf('function');
		expect(buttons.every(button => !button.disabled)).toBe(true);

		menu.dispose();
		menu.dispose();
		gate.begin();

		// A detached/disposed menu must not receive the new disabled state.
		expect(buttons.every(button => !button.disabled)).toBe(true);
	});

	it('centralizes dropdown state so aria-expanded always mirrors visibility', () => {
		const factory = dropdownControllerFactory();
		expect(factory).toBeTypeOf('function');
		if (!factory) return;

		const trigger = document.createElement('button');
		const dropdown = document.createElement('div');
		dropdown.classList.add('is-open');
		trigger.setAttribute('aria-expanded', 'true');
		const controller = factory(trigger, dropdown);

		expect(dropdown.classList.contains('is-open')).toBe(false);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		controller.open();
		expect(dropdown.classList.contains('is-open')).toBe(true);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		controller.toggle();
		expect(dropdown.classList.contains('is-open')).toBe(false);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		controller.open();
		controller.close();
		expect(dropdown.classList.contains('is-open')).toBe(false);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(READER_SOURCE).not.toContain("clipDropdown.classList.remove('is-open')");
	});

	it('publishes Open clipper pressed state only after its awaited toggle settles', async () => {
		const wire = awaitedToggleWire();
		expect(wire).toBeTypeOf('function');
		if (!wire) return;

		const button = document.createElement('button');
		let open = false;
		const pending = deferred<boolean>();
		const toggle = vi.fn(() => pending.promise);
		wire(button, () => open, toggle);

		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(button.getAttribute('aria-busy')).toBe('false');
		button.click();
		expect(toggle).toHaveBeenCalledOnce();
		expect(button.disabled).toBe(true);
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect(button.getAttribute('aria-pressed')).toBe('false');

		open = true;
		pending.resolve(true);
		await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
		expect(button.disabled).toBe(false);
		expect(button.getAttribute('aria-busy')).toBe('false');

		const privateFailure = 'private-toggle-failure-52dc';
		toggle.mockRejectedValueOnce(new Error(privateFailure));
		const consoleSpies = (['debug', 'error', 'info', 'log', 'warn'] as const)
			.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
		try {
			button.click();
			await vi.waitFor(() => expect(button.disabled).toBe(false));
			expect(button.getAttribute('aria-pressed')).toBe('true');
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of consoleSpies) spy.mockRestore();
		}
		expect(READER_SOURCE).toContain('if (!this.isReaderPage) return;');
		expect(READER_SOURCE).toContain('return Reader.toggleReaderPageIframe(doc);');
		expect(READER_SOURCE).not.toContain("{ action: 'toggleIframe' }");
	});
});
