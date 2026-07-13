import { Template } from '../types/types';
import { templates, saveTemplateSettings, editingTemplateIndex, loadTemplates } from '../managers/template-manager';
import { showTemplateEditor, updateTemplateList } from '../managers/template-ui';
import { sanitizeFileName } from './string-utils';
import { generalSettings, loadSettings } from '../utils/storage-utils';
import { addPropertyType, updatePropertyTypesList } from '../managers/property-types-manager';
import { hideModal } from '../utils/modal-utils';
import { showImportModal } from './import-modal';
import browser from '../utils/browser-polyfill';
import { saveFile } from './file-utils';
import { copyToClipboard } from './clipboard-utils';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import { getMessage } from './i18n';
import { sanitizeClipStats } from './clip-stats';

const SCHEMA_VERSION = '0.1.0';

// Add these type definitions at the top
interface StorageData {
	[key: string]: any;
	template_list?: string[];
}

function record(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, any>
		: {};
}

function omitRetiredTemplateContext(value: unknown): Partial<Template> {
	const { context: _retiredContext, ...template } = record(value);
	return template as Partial<Template>;
}

function text(value: unknown, maxLength: number): string | undefined {
	return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function finiteNumber(value: unknown, min: number, max: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
		? value
		: undefined;
}

function sanitizeGeneralSettings(value: unknown): Record<string, any> {
	const input = record(value);
	const destinations = ['clipboard', 'download', 'custom-uri', 'local-http'];
	const openBehaviors = ['popup', 'reader'];
	return {
		showMoreActionsButton: typeof input.showMoreActionsButton === 'boolean' ? input.showMoreActionsButton : false,
		betaFeatures: typeof input.betaFeatures === 'boolean' ? input.betaFeatures : false,
		openBehavior: openBehaviors.includes(input.openBehavior) ? input.openBehavior : 'popup',
		defaultDestination: destinations.includes(input.defaultDestination) ? input.defaultDestination : 'download',
		customUriTemplate: text(input.customUriTemplate, 2048) ?? '',
		localHttpEndpoint: text(input.localHttpEndpoint, 2048) ?? '',
	};
}

function sanitizeHighlighterSettings(value: unknown): Record<string, any> {
	const input = record(value);
	return {
		highlighterEnabled: typeof input.highlighterEnabled === 'boolean' ? input.highlighterEnabled : false,
		alwaysShowHighlights: typeof input.alwaysShowHighlights === 'boolean' ? input.alwaysShowHighlights : false,
		highlightBehavior: text(input.highlightBehavior, 64) ?? 'highlight-inline',
	};
}

function sanitizeReaderSettings(value: unknown): Record<string, any> {
	const input = record(value);
	const output: Record<string, any> = {};
	for (const key of ['fontSize', 'lineHeight', 'maxWidth'] as const) {
		const sanitized = finiteNumber(input[key], 0, 10_000);
		if (sanitized !== undefined) output[key] = sanitized;
	}
	for (const key of ['lightTheme', 'darkTheme', 'defaultFont'] as const) {
		const sanitized = text(input[key], 128);
		if (sanitized !== undefined) output[key] = sanitized;
	}
	if (['auto', 'light', 'dark'].includes(input.appearance)) output.appearance = input.appearance;
	if (Array.isArray(input.fonts)) {
		output.fonts = input.fonts
			.filter((font: unknown): font is string => typeof font === 'string')
			.slice(0, 100)
			.map((font: string) => font.slice(0, 128));
	}
	for (const key of [
		'blendImages',
		'colorLinks',
		'followLinks',
		'pinPlayer',
		'autoScroll',
		'highlightActiveLine',
	] as const) {
		if (typeof input[key] === 'boolean') output[key] = input[key];
	}
	const customCss = text(input.customCss, 100_000);
	if (customCss !== undefined) output.customCss = customCss;
	return output;
}

function sanitizePropertyTypes(value: unknown): Record<string, any>[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((property) => record(property))
		.filter((property) => typeof property.name === 'string' && typeof property.type === 'string')
		.slice(0, 256)
		.map((property) => {
			const safe: Record<string, any> = {
				name: property.name.slice(0, 512),
				type: property.type.slice(0, 64),
			};
			const defaultValue = text(property.defaultValue, 100_000);
			if (defaultValue !== undefined) safe.defaultValue = defaultValue;
			return safe;
		});
}

function sanitizeTemplateIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.filter((id): id is string => {
		if (
			typeof id !== 'string'
			|| id.length === 0
			|| id.length > 128
			|| !/^[a-z0-9_-]+$/i.test(id)
			|| seen.has(id)
		) return false;
		seen.add(id);
		return true;
	});
}

function sanitizeTemplate(value: unknown, id: string): Record<string, any> | null {
	const input = record(value);
	const name = text(input.name, 512);
	const noteNameFormat = text(input.noteNameFormat, 2048);
	const path = text(input.path, 2048);
	const noteContentFormat = text(input.noteContentFormat, 1_000_000);
	const behaviors = [
		'create',
		'append-specific',
		'append-daily',
		'prepend-specific',
		'prepend-daily',
		'overwrite',
	];
	if (
		name === undefined
		|| noteNameFormat === undefined
		|| path === undefined
		|| noteContentFormat === undefined
		|| !behaviors.includes(input.behavior)
		|| !Array.isArray(input.properties)
	) return null;

	const properties = input.properties
		.map((property: unknown) => record(property))
		.filter((property: Record<string, any>) => (
			typeof property.name === 'string' && typeof property.value === 'string'
		))
		.slice(0, 256)
		.map((property: Record<string, any>) => {
			const safe: Record<string, any> = {
				name: property.name.slice(0, 512),
				value: property.value.slice(0, 1_000_000),
			};
			const propertyId = text(property.id, 128);
			if (propertyId !== undefined) safe.id = propertyId;
			const propertyType = text(property.type, 64);
			if (propertyType !== undefined) safe.type = propertyType;
			return safe;
		});

	const safe: Record<string, any> = {
		id,
		name,
		behavior: input.behavior,
		noteNameFormat,
		path,
		noteContentFormat,
		properties,
	};
	if (Array.isArray(input.triggers)) {
		safe.triggers = input.triggers
			.filter((trigger: unknown): trigger is string => typeof trigger === 'string')
			.slice(0, 256)
			.map((trigger: string) => trigger.slice(0, 2048));
	}
	return safe;
}

function decodeAndSanitizeTemplate(value: unknown, id: string): Record<string, any> | null {
	let decoded = value;
	if (Array.isArray(value)) {
		if (
			value.length === 0
			|| value.length > 256
			|| !value.every((chunk) => typeof chunk === 'string' && chunk.length <= 8000)
		) return null;
		try {
			const decompressed = decompressFromUTF16((value as string[]).join(''));
			if (typeof decompressed !== 'string' || decompressed.length > 2_000_000) return null;
			decoded = JSON.parse(decompressed);
		} catch {
			return null;
		}
	}
	return sanitizeTemplate(decoded, id);
}

export function createSettingsExportData(source: StorageData): StorageData {
	const exported: StorageData = {
		general_settings: sanitizeGeneralSettings(source.general_settings),
		highlighter_settings: sanitizeHighlighterSettings(source.highlighter_settings),
		reader_settings: sanitizeReaderSettings(source.reader_settings),
		property_types: sanitizePropertyTypes(source.property_types),
		stats: sanitizeClipStats(source.stats),
	};

	const templateIds = sanitizeTemplateIds(source.template_list);
	const exportedTemplateIds: string[] = [];
	for (const id of templateIds) {
		const key = `template_${id}`;
		if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
		const template = decodeAndSanitizeTemplate(source[key], id);
		if (!template) continue;
		exported[key] = template;
		exportedTemplateIds.push(id);
	}
	exported.template_list = exportedTemplateIds;
	return exported;
}

export function createSettingsImportData(source: StorageData): StorageData {
	return createSettingsExportData(source);
}

export async function exportTemplate(): Promise<void> {
	if (editingTemplateIndex === -1) {
		alert(getMessage('selectTemplateToExport'));
		return;
	}

	const template = templates[editingTemplateIndex] as Template;
	const sanitizedName = sanitizeFileName(template.name);
	const fileName = `${sanitizedName.replace(/\s+/g, '-').toLowerCase()}-clipper.json`;

	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const orderedTemplate: Partial<Template> & { schemaVersion: string } = {
		schemaVersion: SCHEMA_VERSION,
		name: template.name,
		behavior: template.behavior,
		noteContentFormat: template.noteContentFormat,
		properties: template.properties.map(({ name, value, type }) => ({
			name,
			value,
			type: type || generalSettings.propertyTypes.find(pt => pt.name === name)?.type || 'text'
		})),
		triggers: template.triggers,
	};

	// Only include noteNameFormat and path for non-daily note behaviors
	if (!isDailyNote) {
		orderedTemplate.noteNameFormat = template.noteNameFormat;
		orderedTemplate.path = template.path;
	}

	const content = JSON.stringify(orderedTemplate, null, '\t');
	
	await saveFile({
		content,
		fileName,
		mimeType: 'application/json',
		onError: () => undefined
	});
}

export function importTemplate(input?: HTMLInputElement): void {
	if (!input) {
		input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
	}

	const handleFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (e: ProgressEvent<FileReader>) => {
			try {
				const importedTemplate = omitRetiredTemplateContext(JSON.parse(e.target?.result as string));
				if (!validateImportedTemplate(importedTemplate)) {
					throw new Error('Invalid template file');
				}

				importedTemplate.id = Date.now().toString() + Math.random().toString(36).slice(2, 9);
				
				// Handle property types and preserve existing IDs or generate new ones
				if (importedTemplate.properties) {
					importedTemplate.properties = await Promise.all(importedTemplate.properties.map(async (prop: any) => {
						// Add or update the property type
						await addPropertyType(prop.name, prop.type || 'text', prop.value || '');
						
						// Use the type from generalSettings, which will be either the existing type or the newly added one
						const type = generalSettings.propertyTypes.find(pt => pt.name === prop.name)?.type || 'text';
						return {
							id: prop.id || (Date.now().toString() + Math.random().toString(36).slice(2, 9)),
							name: prop.name,
							value: prop.value,
							type: type
						};
					}));
				}

				let newName = importedTemplate.name as string;
				let counter = 1;
				while (templates.some(t => t.name === newName)) {
					newName = `${importedTemplate.name} (${counter++})`;
				}
				importedTemplate.name = newName;

				templates.unshift(importedTemplate as Template);

				saveTemplateSettings();
				updateTemplateList();
				showTemplateEditor(importedTemplate as Template);
				hideModal(document.getElementById('import-modal'));
			} catch {
				alert(getMessage('failedToImportTemplate'));
			}
		};
		reader.readAsText(file);
	};

	if (input.files && input.files.length > 0) {
		handleFile(input.files[0]);
	} else {
		input.onchange = (event: Event) => {
			const file = (event.target as HTMLInputElement).files?.[0];
			if (file) {
				handleFile(file);
			}
		};
		input.click();
	}
}

function validateImportedTemplate(template: Partial<Template>): boolean {
	const requiredFields: (keyof Template)[] = ['name', 'behavior', 'properties', 'noteContentFormat'];
	const validTypes = ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime'];
	
	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const hasRequiredFields = requiredFields.every(field => template.hasOwnProperty(field));
	const hasValidProperties = Array.isArray(template.properties) &&
		template.properties!.every((prop: any) => 
			prop.hasOwnProperty('name') && 
			prop.hasOwnProperty('value') && 
			(!prop.hasOwnProperty('type') || validTypes.includes(prop.type))
		);

	// Check for noteNameFormat and path only if it's not a daily note template
	const hasValidNoteNameAndPath = isDailyNote || (template.hasOwnProperty('noteNameFormat') && template.hasOwnProperty('path'));

	return hasRequiredFields && hasValidProperties && hasValidNoteNameAndPath;
}

function preventDefaults(e: Event): void {
	e.preventDefault();
	e.stopPropagation();
}

function handleDrop(e: DragEvent): void {
	const dt = e.dataTransfer;
	const files = dt?.files;

	if (files && files.length) {
		handleFiles(files);
	}
}

function handleFiles(files: FileList): void {
	Array.from(files).forEach(importTemplateFile);
}

async function processImportedTemplate(importedTemplate: Partial<Template>): Promise<Template> {
	importedTemplate = omitRetiredTemplateContext(importedTemplate);
	if (!validateImportedTemplate(importedTemplate)) {
		throw new Error('Invalid template file');
	}

	importedTemplate.id = Date.now().toString() + Math.random().toString(36).slice(2, 9);
	
	// Process property types
	if (importedTemplate.properties) {
		for (const prop of importedTemplate.properties) {
			const existingPropertyType = generalSettings.propertyTypes.find(pt => pt.name === prop.name);
			if (!existingPropertyType) {
				// Only add the property type if it doesn't exist
				await addPropertyType(prop.name, prop.type || 'text', prop.value || '');
			} else {
			}
		}
		
		// Reassign properties with existing or new types
		importedTemplate.properties = importedTemplate.properties.map(prop => {
			const existingPropertyType = generalSettings.propertyTypes.find(pt => pt.name === prop.name);
			return {
				id: prop.id || (Date.now().toString() + Math.random().toString(36).slice(2, 9)),
				name: prop.name,
				value: prop.value,
				type: existingPropertyType ? existingPropertyType.type : (prop.type || 'text')
			};
		});
	}

	// Ensure unique name
	let newName = importedTemplate.name as string;
	let counter = 1;
	while (templates.some(t => t.name === newName)) {
		newName = `${importedTemplate.name} (${counter++})`;
	}
	importedTemplate.name = newName;

	return importedTemplate as Template;
}

export function importTemplateFile(file: File): void {
	const reader = new FileReader();
	reader.onload = async (e: ProgressEvent<FileReader>) => {
		try {
			const importedTemplate = omitRetiredTemplateContext(JSON.parse(e.target?.result as string));
			const processedTemplate = await processImportedTemplate(importedTemplate);
			
			templates.unshift(processedTemplate);
			await saveTemplateSettings();
			updateTemplateList();
			showTemplateEditor(processedTemplate);
		} catch {
			alert(getMessage('failedToImportTemplate'));
		}
	};
	reader.readAsText(file);
}

export function showTemplateImportModal(): void {
	showImportModal(
		'import-modal',
		importTemplateFromJson,
		'.json',
		true,
		'importTemplate'
	);
}

async function importTemplateFromJson(jsonContent: string): Promise<void> {
	try {
		const importedTemplate = omitRetiredTemplateContext(JSON.parse(jsonContent));
		const processedTemplate = await processImportedTemplate(importedTemplate);
		
		templates.unshift(processedTemplate);
		await saveTemplateSettings();
		updateTemplateList();
		showTemplateEditor(processedTemplate);
	} catch {
		throw new Error('Error importing template. Please check the file and try again.');
	}
}

export function copyTemplateToClipboard(template: Template): void {
	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const orderedTemplate: Partial<Template> & { schemaVersion: string } = {
		schemaVersion: SCHEMA_VERSION,
		name: template.name,
		behavior: template.behavior,
		noteContentFormat: template.noteContentFormat,
		properties: template.properties.map(({ name, value, type }) => ({
			name,
			value,
			type: type || generalSettings.propertyTypes.find(pt => pt.name === name)?.type || 'text'
		})),
		triggers: template.triggers,
	};

	// Only include noteNameFormat and path for non-daily note behaviors
	if (!isDailyNote) {
		orderedTemplate.noteNameFormat = template.noteNameFormat;
		orderedTemplate.path = template.path;
	}

	const jsonContent = JSON.stringify(orderedTemplate, null, 2);
	
	copyToClipboard(
		jsonContent
	).then(success => {
		if (success) {
			alert(getMessage('templateCopied'));
		} else {
			alert(getMessage('templateCopyError'));
		}
	});
}

export async function exportAllSettings(): Promise<void> {
	try {
		const allData = await browser.storage.sync.get(null) as StorageData;
		const exportData = createSettingsExportData(allData);

		// Decompress all templates
		const templateIds = exportData.template_list || [];
		for (const id of templateIds) {
			const key = `template_${id}`;
			if (exportData[key] && Array.isArray(exportData[key])) {
				try {
					// Join chunks and decompress
					const compressedData = (exportData[key] as string[]).join('');
					const decompressedData = decompressFromUTF16(compressedData);
					exportData[key] = JSON.parse(decompressedData);
				} catch {}
			}
		}

		const content = JSON.stringify(exportData, null, 2);
		const fileName = 'open-markdown-clipper-settings.json';

		await saveFile({
			content,
			fileName,
			mimeType: 'application/json',
			onError: () => undefined
		});
	} catch {
		alert(getMessage('failedToExportSettings'));
	}
}

export function importAllSettings(): void {
	showImportModal(
		'import-modal',
		importAllSettingsFromJson,
		'.json',
		false,
		'importAllSettings'
	);
}

async function importAllSettingsFromJson(jsonContent: string): Promise<void> {
	try {
		const settings = JSON.parse(jsonContent) as StorageData;
		
		if (confirm(getMessage('confirmReplaceSettings'))) {
			const importData = createSettingsImportData(settings);
			
			// Compress all templates
			const templateIds = importData.template_list || [];
			for (const id of templateIds) {
				const key = `template_${id}`;
				if (importData[key]) {
					try {
						// Check if the data is already compressed (will be an array of strings)
						const isAlreadyCompressed = Array.isArray(importData[key]) && 
							importData[key].every((chunk: any) => typeof chunk === 'string');

						if (!isAlreadyCompressed) {
							// Compress the template data
							const templateStr = JSON.stringify(importData[key]);
							const compressedData = compressToUTF16(templateStr);
							
							// Split into chunks
							const chunks: string[] = [];
							const CHUNK_SIZE = 8000;
							for (let i = 0; i < compressedData.length; i += CHUNK_SIZE) {
								chunks.push(compressedData.slice(i, i + CHUNK_SIZE));
							}
							importData[key] = chunks;
						}
					} catch {}
				}
			}

			await browser.storage.sync.clear();
			await browser.storage.sync.set(importData);
			await loadSettings();
			await loadTemplates();
			updateTemplateList();
			updatePropertyTypesList();
			alert(getMessage('settingsImportSuccess'));
		}
	} catch {
		throw new Error('Error importing settings. Please check the file and try again.');
	}
}
