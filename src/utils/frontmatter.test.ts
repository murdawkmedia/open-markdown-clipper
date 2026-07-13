import { afterEach, describe, expect, it } from 'vitest';
import { generalSettings } from './storage-utils';
import { generateFrontmatter } from './frontmatter';

const originalPropertyTypes = generalSettings.propertyTypes;

afterEach(() => {
	generalSettings.propertyTypes = originalPropertyTypes;
});

describe('frontmatter settings adapter', () => {
	it('renders ordinary text through the neutral frontmatter wrapper', async () => {
		generalSettings.propertyTypes = [];

		await expect(generateFrontmatter([
			{ name: 'title', value: 'A durable note' },
		])).resolves.toBe([
			'---',
			'title: "A durable note"',
			'---',
			'',
		].join('\n'));
	});

	it('maps configured property types into shared frontmatter generation', async () => {
		generalSettings.propertyTypes = [
			{ name: 'tags', type: 'multitext' },
			{ name: 'rating', type: 'number' },
		];

		await expect(generateFrontmatter([
			{ name: 'tags', value: 'alpha, beta' },
			{ name: 'rating', value: '4.5 stars' },
		])).resolves.toBe([
			'---',
			'tags:',
			'  - "alpha"',
			'  - "beta"',
			'rating: 4.5',
			'---',
			'',
		].join('\n'));
	});
});
