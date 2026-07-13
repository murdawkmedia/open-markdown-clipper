// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
	createSettingsExportData,
	createSettingsImportData,
} from './import-export';

const PRIVATE_TOKEN = 'private-token-123';
const PROVIDER_KEY = 'provider-secret-123';
const RETIRED_SETTINGS_KEY = ['inter', 'preter_settings'].join('');
const RETIRED_CREDENTIAL_FIELD = ['api', 'Key'].join('');

function unsafeSettings(): Record<string, any> {
	return {
		general_settings: {
			showMoreActionsButton: true,
			betaFeatures: false,
			openBehavior: 'popup',
			defaultDestination: 'local-http',
			customUriTemplate: 'notes:clip?title={title}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
			saveBehavior: 'addToObsidian',
			legacyMode: true,
			silentOpen: true,
		},
		highlighter_settings: {
			highlighterEnabled: true,
			alwaysShowHighlights: false,
			highlightBehavior: 'highlight-inline',
			privateExtra: PRIVATE_TOKEN,
		},
		reader_settings: { fontSize: 16, customCss: '.article {}', privateExtra: PRIVATE_TOKEN },
		[RETIRED_SETTINGS_KEY]: {
			providers: [{
				id: 'provider-1',
				[RETIRED_CREDENTIAL_FIELD]: PROVIDER_KEY,
			}],
			privateExtra: PRIVATE_TOKEN,
		},
		property_types: [{ name: 'title', type: 'text', defaultValue: '{{title}}' }],
		stats: { addToObsidian: 1, saveFile: 2, copyToClipboard: 3, share: 0 },
		template_list: ['safe-template', '../unsafe-template'],
		'template_safe-template': {
			id: 'safe-template',
			name: 'Safe template',
			behavior: 'create',
			noteNameFormat: '{{title}}',
			path: 'Clippings',
			vault: 'Legacy workspace',
			noteContentFormat: '{{content}}',
			context: `private template context ${PRIVATE_TOKEN}`,
			properties: [{
				id: 'title-property',
				name: 'title',
				value: '{{title}}',
				type: 'text',
				privateExtra: PRIVATE_TOKEN,
			}],
			triggers: ['https://example.com'],
			privateExtra: PRIVATE_TOKEN,
		},
		'template_../unsafe-template': { private: PRIVATE_TOKEN },
		template_orphan: { private: PRIVATE_TOKEN },
		destinationSecrets: { localHttpToken: PRIVATE_TOKEN },
		vaults: ['Private vault'],
		migrationVersion: 2,
		unexpected: PRIVATE_TOKEN,
	};
}

describe('settings transfer allowlist', () => {
	it('exports only referenced templates and public settings without credentials', () => {
		const exported = createSettingsExportData(unsafeSettings());
		const serialized = JSON.stringify(exported);

		expect(exported.general_settings).toEqual({
			showMoreActionsButton: true,
			betaFeatures: false,
			openBehavior: 'popup',
			defaultDestination: 'local-http',
			customUriTemplate: 'notes:clip?title={title}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		});
		expect(exported.template_list).toEqual(['safe-template']);
		expect(exported).toHaveProperty('template_safe-template');
		expect(exported).not.toHaveProperty('template_orphan');
		expect(exported).not.toHaveProperty('destinationSecrets');
		expect(exported).not.toHaveProperty('vaults');
		expect(exported).not.toHaveProperty('migrationVersion');
		expect(serialized).not.toContain(PRIVATE_TOKEN);
		expect(serialized).not.toContain(PROVIDER_KEY);
		expect(serialized).not.toContain(`"${RETIRED_CREDENTIAL_FIELD}":`);
		expect(exported).not.toHaveProperty(RETIRED_SETTINGS_KEY);
		expect(exported['template_safe-template']).not.toHaveProperty('privateExtra');
		expect(exported['template_safe-template']).not.toHaveProperty('vault');
		expect(exported['template_safe-template']).not.toHaveProperty('context');
		expect(exported['template_safe-template'].properties[0]).not.toHaveProperty('privateExtra');
		expect(exported.stats).toEqual({
			clipboard: 3,
			download: 3,
			'custom-uri': 0,
			'local-http': 0,
			share: 0,
		});
	});

	it('ignores retired model settings and their credentials during import', () => {
		const imported = createSettingsImportData(unsafeSettings());

		expect(imported).not.toHaveProperty(RETIRED_SETTINGS_KEY);
		expect(imported).not.toHaveProperty('destinationSecrets');
		expect(imported).not.toHaveProperty('unexpected');
		expect(imported.template_list).toEqual(['safe-template']);
		expect(imported['template_safe-template']).not.toHaveProperty('context');
		expect(JSON.stringify(imported)).not.toContain(PROVIDER_KEY);
		expect(JSON.stringify(imported)).not.toContain(PRIVATE_TOKEN);
	});

	it('migrates retired page-embedded behavior to the browser popup', () => {
		const legacy = unsafeSettings();
		legacy.general_settings.openBehavior = 'embedded';

		expect(createSettingsImportData(legacy).general_settings.openBehavior).toBe('popup');
		expect(createSettingsExportData(legacy).general_settings.openBehavior).toBe('popup');
	});

	it('drops invalid nested values even when their parent key is allowed', () => {
		const malicious = unsafeSettings();
		malicious.general_settings.customUriTemplate = {
			[RETIRED_CREDENTIAL_FIELD]: PRIVATE_TOKEN,
		} as unknown as string;
		malicious.highlighter_settings.highlighterEnabled = { secret: PRIVATE_TOKEN } as unknown as boolean;
		malicious.reader_settings.fontSize = { secret: PRIVATE_TOKEN } as unknown as number;
		malicious[RETIRED_SETTINGS_KEY].providers[0].baseUrl = `https://user:${PRIVATE_TOKEN}@provider.example/v1`;
		malicious.property_types[0].defaultValue = { token: PRIVATE_TOKEN } as unknown as string;
		malicious.stats.saveFile = { secret: PRIVATE_TOKEN } as unknown as number;

		const exported = createSettingsExportData(malicious);
		expect(JSON.stringify(exported)).not.toContain(PRIVATE_TOKEN);
		expect((exported.general_settings as Record<string, unknown>).customUriTemplate).toBe('');
		expect((exported.highlighter_settings as Record<string, unknown>).highlighterEnabled).toBe(false);
		expect((exported.reader_settings as Record<string, unknown>).fontSize).toBeUndefined();
		expect(exported).not.toHaveProperty(RETIRED_SETTINGS_KEY);
		expect(exported.stats).toEqual({
			clipboard: 3,
			download: 1,
			'custom-uri': 0,
			'local-http': 0,
			share: 0,
		});
	});

	it('accepts old and new stats but emits only saturated generic counters', () => {
		const source = unsafeSettings();
		source.stats = {
			clipboard: 5,
			copyToClipboard: 2.9,
			download: Number.MAX_SAFE_INTEGER,
			saveFile: 10,
			addToObsidian: -1,
			'custom-uri': 7,
			'local-http': Number.MAX_VALUE,
			share: 4,
			privateCounter: { token: PRIVATE_TOKEN },
		} as unknown as typeof source.stats;

		const exported = createSettingsExportData(source);
		expect(exported.stats).toEqual({
			clipboard: 7,
			download: Number.MAX_SAFE_INTEGER,
			'custom-uri': 7,
			'local-http': Number.MAX_SAFE_INTEGER,
			share: 4,
		});
		expect(JSON.stringify(exported)).not.toContain(PRIVATE_TOKEN);
	});

	it('discards malformed and secret-bearing stats values into generic zero defaults', () => {
		const source = unsafeSettings();
		source.stats = {
			clipboard: { token: PRIVATE_TOKEN },
			copyToClipboard: '3',
			download: -1,
			saveFile: Number.NaN,
			addToObsidian: Number.NEGATIVE_INFINITY,
			'custom-uri': null,
			'local-http': undefined,
			share: Number.POSITIVE_INFINITY,
		} as unknown as typeof source.stats;

		const exported = createSettingsExportData(source);
		expect(exported.stats).toEqual({
			clipboard: 0,
			download: 0,
			'custom-uri': 0,
			'local-http': 0,
			share: 0,
		});
		expect(JSON.stringify(exported)).not.toContain(PRIVATE_TOKEN);
	});
});
