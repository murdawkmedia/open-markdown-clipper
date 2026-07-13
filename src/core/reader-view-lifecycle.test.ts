// @vitest-environment jsdom

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ReaderDestinationReadinessGate } from '../utils/reader';

const READER_SOURCE = readFileSync(
	join(process.cwd(), 'src', 'utils', 'reader.ts'),
	'utf8',
);
const READER_VIEW_SOURCE = readFileSync(
	join(process.cwd(), 'src', 'core', 'reader-view.ts'),
	'utf8',
);

function sliceBetween(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

describe('reader destination lifecycle wiring', () => {
	it('keeps apply unavailable through extraction and content feature initialization', () => {
		const apply = sliceBetween(
			READER_SOURCE,
			'static async apply(doc: Document)',
			'static async restore(doc: Document)',
		);
		const begin = apply.indexOf('this.destinationReadiness.beginFresh()');
		const extraction = apply.indexOf('const contentPromise = this.extractContent(docClone)');
		const features = apply.lastIndexOf('await this.initializeContentFeatures(doc, title)');
		const complete = apply.lastIndexOf('this.destinationReadiness.complete(destinationRevision)');

		expect(begin).toBeGreaterThanOrEqual(0);
		expect(begin).toBeLessThan(extraction);
		expect(complete).toBeGreaterThan(features);
		expect(apply).toContain('this.destinationReadiness.fail(destinationRevision)');
	});

	it('disables on restore and exposes revision-safe navigation methods', () => {
		const restore = sliceBetween(
			READER_SOURCE,
			'static async restore(doc: Document)',
			'private static registerSelectionToHighlightButton',
		);
		expect(restore).toContain('this.destinationReadiness.deactivate()');
		expect(READER_SOURCE).toContain('static beginDestinationNavigation()');
		expect(READER_SOURCE).toContain('static isDestinationNavigationCurrent(');
		expect(READER_SOURCE).toContain('static completeDestinationNavigation(');
		expect(READER_SOURCE).toContain('static restoreDestinationNavigation(');
	});

	it('treats a missing reader content shell as a failed navigation', () => {
		const update = sliceBetween(
			READER_SOURCE,
			'static async updateReaderContent(',
			'static async toggleReaderPageIframe(',
		);
		expect(update).toContain("throw new Error('reader-content-unavailable')");
	});

	it('owns standalone navigation readiness from before fetch through rendered features', () => {
		const loadArticle = sliceBetween(
			READER_VIEW_SOURCE,
			'async function loadArticle(',
			'function setFavicon(',
		);
		const begin = loadArticle.indexOf('Reader.beginDestinationNavigation()');
		const fetch = loadArticle.indexOf('await fetchWithRedirects(newUrl)');
		const update = loadArticle.indexOf('await Reader.updateReaderContent(');
		const complete = loadArticle.indexOf('Reader.completeDestinationNavigation(navigation)');
		const settle = loadArticle.indexOf('Reader.settleDestinationNavigationFailure(');

		expect(begin).toBeGreaterThanOrEqual(0);
		expect(begin).toBeLessThan(fetch);
		expect(loadArticle).toContain('Reader.isDestinationNavigationCurrent(navigation)');
		expect(complete).toBeGreaterThan(update);
		expect(settle).toBeGreaterThan(complete);
	});

	it('fails closed when an error occurs after URL assignment begins', () => {
		const gate = new ReaderDestinationReadinessGate();
		const initial = gate.beginFresh();
		expect(gate.complete(initial)).toBe(true);

		const postMutation = gate.begin();
		expect(gate.settleFailure(postMutation, true)).toBe(true);
		expect(gate.state()).toEqual({
			revision: postMutation.revision,
			ready: false,
		});

		const restored = gate.begin();
		expect(gate.complete(restored)).toBe(true);
		const preMutation = gate.begin();
		expect(gate.settleFailure(preMutation, false)).toBe(true);
		expect(gate.state()).toEqual({
			revision: preMutation.revision,
			ready: true,
		});
	});

	it('marks mutation before history or document state changes and settles failures once', () => {
		const loadArticle = sliceBetween(
			READER_VIEW_SOURCE,
			'async function loadArticle(',
			'function setFavicon(',
		);
		const flag = loadArticle.indexOf('let destinationMutationStarted = false');
		const pushedHistory = loadArticle.indexOf('history.pushState(');
		const replacedHistory = loadArticle.indexOf('history.replaceState(');
		const documentMutation = loadArticle.indexOf("Object.defineProperty(document, 'URL'");
		const firstMark = loadArticle.indexOf('destinationMutationStarted = true');
		const replaceMark = loadArticle.lastIndexOf(
			'destinationMutationStarted = true',
			replacedHistory,
		);
		const lastMark = loadArticle.lastIndexOf('destinationMutationStarted = true');

		expect(flag).toBeGreaterThanOrEqual(0);
		expect(firstMark).toBeGreaterThan(flag);
		expect(firstMark).toBeLessThan(pushedHistory);
		expect(replaceMark).toBeGreaterThan(pushedHistory);
		expect(replaceMark).toBeLessThan(replacedHistory);
		expect(lastMark).toBeLessThan(documentMutation);
		expect(loadArticle).toContain(
			'Reader.settleDestinationNavigationFailure(navigation, destinationMutationStarted)',
		);
		expect(loadArticle).not.toContain('Reader.restoreDestinationNavigation(navigation)');
	});

	it('disposes the destination readiness subscription on reapply and restore', () => {
		const inject = sliceBetween(
			READER_SOURCE,
			'private static injectSettingsBar(doc: Document)',
			'private static updateFontSize(',
		);
		const restore = sliceBetween(
			READER_SOURCE,
			'static async restore(doc: Document)',
			'private static registerSelectionToHighlightButton',
		);

		expect(READER_SOURCE).toContain('private static destinationMenuCleanup');
		expect(inject).toContain('this.destinationMenuCleanup?.()');
		expect(inject).toContain('clipDropdown.dispose()');
		expect(restore).toContain('this.destinationMenuCleanup?.()');
	});
});
