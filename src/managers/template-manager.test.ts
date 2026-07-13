import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	__getMockStorage,
	__resetMockStorage,
	__seedMockStorage,
} from '../utils/__mocks__/webextension-polyfill';
import { loadTemplates, saveTemplateSettings } from './template-manager';

beforeEach(() => {
	__resetMockStorage();
});

describe('template storage compatibility', () => {
	it('drops the retired model context from loaded and subsequently saved templates', async () => {
		const legacyTemplate = {
			id: 'legacy-template',
			name: 'Legacy template',
			behavior: 'create',
			noteNameFormat: '{{title}}',
			path: 'Clippings',
			noteContentFormat: '{{content}}',
			properties: [],
			triggers: [],
			context: 'private page context',
		};
		__seedMockStorage('sync', {
			template_list: [legacyTemplate.id],
			[`template_${legacyTemplate.id}`]: [compressToUTF16(JSON.stringify(legacyTemplate))],
		});

		const [loaded] = await loadTemplates();
		expect(loaded).not.toHaveProperty('context');

		await saveTemplateSettings();
		const [chunk] = __getMockStorage('sync')[`template_${legacyTemplate.id}`] as string[];
		expect(JSON.parse(decompressFromUTF16(chunk))).not.toHaveProperty('context');
	});
});
