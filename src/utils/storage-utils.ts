import browser from './browser-polyfill';
import {
	Settings,
	PropertyType,
	HistoryEntry,
	Rating,
	ClipAction,
	ClipStats,
} from '../types/types';
import { DestinationKind } from '../destinations/types';
import { debugLog } from './debug';
import {
	emptyClipStats,
	isCanonicalClipStats,
	migrateClipAction,
	sanitizeClipStats,
	saturatingClipCount,
} from './clip-stats';
import { createClipHistoryEntry, sanitizeClipHistory } from './clip-history';
import { ClipRecordingError, sendClipRecordingMessage } from './clip-recorder';

export type {
	Settings,
	PropertyType,
	HistoryEntry,
	Rating,
	ClipAction,
	ClipStats,
};

export let generalSettings: Settings = {
	betaFeatures: false,
	openBehavior: 'popup',
	highlighterEnabled: true,
	alwaysShowHighlights: false,
	highlightBehavior: 'highlight-inline',
	showMoreActionsButton: false,
	propertyTypes: [],
	readerSettings: {
		fontSize: 16,
		lineHeight: 1.6,
		maxWidth: 38,
		lightTheme: 'default',
		darkTheme: 'same',
		appearance: 'auto',
		fonts: [],
		defaultFont: '',
		blendImages: true,
		colorLinks: false,
		followLinks: true,
		pinPlayer: true,
		autoScroll: true,
		highlightActiveLine: true,
		customCss: ''
	},
	stats: emptyClipStats(),
	ratings: [],
	defaultDestination: 'download',
	customUriTemplate: '',
	localHttpEndpoint: '',
};

export function setLocalStorage(key: string, value: any): Promise<void> {
	return browser.storage.local.set({ [key]: value });
}

export function getLocalStorage(key: string): Promise<any> {
	return browser.storage.local.get(key).then((result: {[key: string]: any}) => result[key]);
}

interface StorageData {
	general_settings?: {
		showMoreActionsButton?: boolean;
		betaFeatures?: boolean;
		openBehavior?: unknown;
		saveBehavior?: 'addToObsidian' | 'copyToClipboard' | 'saveFile';
		defaultDestination?: unknown;
		customUriTemplate?: unknown;
		localHttpEndpoint?: unknown;
	};
	highlighter_settings?: {
		highlighterEnabled?: boolean;
		alwaysShowHighlights?: boolean;
		highlightBehavior?: string;
	};
	reader_settings?: {
		fontSize?: number;
		lineHeight?: number;
		maxWidth?: number;
		lightTheme?: string;
		darkTheme?: string;
		appearance?: 'auto' | 'light' | 'dark';
		fonts?: string[];
		defaultFont?: string;
		blendImages?: boolean;
		colorLinks?: boolean;
		followLinks?: boolean;
		pinPlayer?: boolean;
		autoScroll?: boolean;
		highlightActiveLine?: boolean;
		customCss?: string;
	};
	property_types?: PropertyType[];
	stats?: unknown;
	ratings?: Rating[];
	migrationVersion?: number;
	destinationSecrets?: unknown;
}

const CURRENT_MIGRATION_VERSION = 4;
const RETIRED_SYNC_KEYS = ['destinationSecrets', 'interpreter_settings'];
const RETIRED_LOCAL_KEYS = ['provider_presets'];
const MAX_DESTINATION_SETTING_LENGTH = 2048;
const DESTINATION_KINDS: readonly DestinationKind[] = [
	'clipboard',
	'download',
	'custom-uri',
	'local-http',
];

function isDestinationKind(value: unknown): value is DestinationKind {
	return typeof value === 'string' && DESTINATION_KINDS.includes(value as DestinationKind);
}

function migrateDestination(value: unknown, legacyValue: unknown): DestinationKind {
	if (isDestinationKind(value)) return value;
	if (value !== undefined) return 'download';
	if (legacyValue === 'copyToClipboard') return 'clipboard';
	if (legacyValue === 'saveFile' || legacyValue === 'addToObsidian') return 'download';
	return 'download';
}

function boundedString(value: unknown): string {
	return typeof value === 'string' ? value.slice(0, MAX_DESTINATION_SETTING_LENGTH) : '';
}

function sanitizeOpenBehavior(value: unknown): Settings['openBehavior'] {
	return value === 'reader' ? 'reader' : 'popup';
}

export async function loadSettings(): Promise<Settings> {
	await Promise.all([
		browser.storage.sync.remove(RETIRED_SYNC_KEYS),
		browser.storage.local.remove(RETIRED_LOCAL_KEYS),
	]);
	const data = await browser.storage.sync.get(null) as StorageData;
	
	// Load default settings first
	const defaultSettings: Settings = {
		showMoreActionsButton: false,
		betaFeatures: false,
		openBehavior: 'popup',
		highlighterEnabled: true,
		alwaysShowHighlights: true,
		highlightBehavior: 'highlight-inline',
		propertyTypes: [],
		defaultDestination: 'download',
		customUriTemplate: '',
		localHttpEndpoint: '',
		readerSettings: {
			fontSize: 16,
			lineHeight: 1.6,
			maxWidth: 38,
			lightTheme: 'default',
			darkTheme: 'same',
			appearance: 'auto',
			fonts: [],
			defaultFont: '',
			blendImages: true,
			colorLinks: false,
			followLinks: true,
			pinPlayer: true,
			autoScroll: true,
			highlightActiveLine: true,
			customCss: ''
		},
		stats: emptyClipStats(),
		ratings: [],
	};

	const stats = sanitizeClipStats(data.stats);
	if (
		!data.migrationVersion
		|| data.migrationVersion < CURRENT_MIGRATION_VERSION
		|| !isCanonicalClipStats(data.stats, stats)
	) {
		await browser.storage.sync.set({
			migrationVersion: CURRENT_MIGRATION_VERSION,
			stats,
		});
		debugLog('Settings', `Updated migration version to ${CURRENT_MIGRATION_VERSION}`);
	}

	const defaultDestination = migrateDestination(
		data.general_settings?.defaultDestination,
		data.general_settings?.saveBehavior,
	);
	const storedOpenBehavior = data.general_settings?.openBehavior;
	const openBehavior = sanitizeOpenBehavior(storedOpenBehavior);
	if (storedOpenBehavior !== undefined && storedOpenBehavior !== openBehavior) {
		await browser.storage.sync.set({
			general_settings: {
				...data.general_settings,
				openBehavior,
			},
		});
	}

	// Load user settings
	const loadedSettings: Settings = {
		showMoreActionsButton: data.general_settings?.showMoreActionsButton ?? defaultSettings.showMoreActionsButton,
		betaFeatures: data.general_settings?.betaFeatures ?? defaultSettings.betaFeatures,
		openBehavior,
		highlighterEnabled: data.highlighter_settings?.highlighterEnabled ?? defaultSettings.highlighterEnabled,
		alwaysShowHighlights: data.highlighter_settings?.alwaysShowHighlights ?? defaultSettings.alwaysShowHighlights,
		highlightBehavior: data.highlighter_settings?.highlightBehavior ?? defaultSettings.highlightBehavior,
		propertyTypes: data.property_types || defaultSettings.propertyTypes,
		readerSettings: {
			fontSize: data.reader_settings?.fontSize ?? defaultSettings.readerSettings.fontSize,
			lineHeight: data.reader_settings?.lineHeight ?? defaultSettings.readerSettings.lineHeight,
			maxWidth: data.reader_settings?.maxWidth ?? defaultSettings.readerSettings.maxWidth,
			lightTheme: data.reader_settings?.lightTheme ?? defaultSettings.readerSettings.lightTheme,
			darkTheme: data.reader_settings?.darkTheme ?? defaultSettings.readerSettings.darkTheme,
			appearance: data.reader_settings?.appearance as 'auto' | 'light' | 'dark' ?? defaultSettings.readerSettings.appearance,
			fonts: data.reader_settings?.fonts ?? defaultSettings.readerSettings.fonts,
			defaultFont: data.reader_settings?.defaultFont ?? defaultSettings.readerSettings.defaultFont,
			blendImages: data.reader_settings?.blendImages ?? defaultSettings.readerSettings.blendImages,
			colorLinks: data.reader_settings?.colorLinks ?? defaultSettings.readerSettings.colorLinks,
			followLinks: data.reader_settings?.followLinks ?? defaultSettings.readerSettings.followLinks,
			pinPlayer: data.reader_settings?.pinPlayer ?? defaultSettings.readerSettings.pinPlayer,
			autoScroll: data.reader_settings?.autoScroll ?? defaultSettings.readerSettings.autoScroll,
			highlightActiveLine: data.reader_settings?.highlightActiveLine ?? defaultSettings.readerSettings.highlightActiveLine,
			customCss: data.reader_settings?.customCss ?? defaultSettings.readerSettings.customCss
		},
		stats,
		ratings: data.ratings || defaultSettings.ratings,
		defaultDestination,
		customUriTemplate: boundedString(data.general_settings?.customUriTemplate),
		localHttpEndpoint: boundedString(data.general_settings?.localHttpEndpoint),
	};

	generalSettings = loadedSettings;
	debugLog('Settings', 'Loaded settings');
	return generalSettings;
}

export async function saveSettings(settings?: Partial<Settings>): Promise<void> {
	if (settings) {
		const { stats: _backgroundOwnedStats, ...ordinarySettings } = settings;
		generalSettings = { ...generalSettings, ...ordinarySettings };
	}
	generalSettings.defaultDestination = migrateDestination(
		generalSettings.defaultDestination,
		undefined,
	);
	generalSettings.openBehavior = sanitizeOpenBehavior(generalSettings.openBehavior);
	generalSettings.customUriTemplate = boundedString(generalSettings.customUriTemplate);
	generalSettings.localHttpEndpoint = boundedString(generalSettings.localHttpEndpoint);
	generalSettings.stats = sanitizeClipStats(generalSettings.stats);

	await Promise.all([
		browser.storage.sync.remove(RETIRED_SYNC_KEYS),
		browser.storage.local.remove(RETIRED_LOCAL_KEYS),
	]);
	await browser.storage.sync.set({
		general_settings: {
			showMoreActionsButton: generalSettings.showMoreActionsButton,
			betaFeatures: generalSettings.betaFeatures,
			openBehavior: generalSettings.openBehavior,
			defaultDestination: generalSettings.defaultDestination,
			customUriTemplate: generalSettings.customUriTemplate,
			localHttpEndpoint: generalSettings.localHttpEndpoint,
		},
		highlighter_settings: {
			highlighterEnabled: generalSettings.highlighterEnabled,
			alwaysShowHighlights: generalSettings.alwaysShowHighlights,
			highlightBehavior: generalSettings.highlightBehavior
		},
		property_types: generalSettings.propertyTypes,
		reader_settings: {
			fontSize: generalSettings.readerSettings.fontSize,
			lineHeight: generalSettings.readerSettings.lineHeight,
			maxWidth: generalSettings.readerSettings.maxWidth,
			lightTheme: generalSettings.readerSettings.lightTheme,
			darkTheme: generalSettings.readerSettings.darkTheme,
			appearance: generalSettings.readerSettings.appearance,
			fonts: generalSettings.readerSettings.fonts,
			defaultFont: generalSettings.readerSettings.defaultFont,
			blendImages: generalSettings.readerSettings.blendImages,
			colorLinks: generalSettings.readerSettings.colorLinks,
			followLinks: generalSettings.readerSettings.followLinks,
			pinPlayer: generalSettings.readerSettings.pinPlayer,
			autoScroll: generalSettings.readerSettings.autoScroll,
			highlightActiveLine: generalSettings.readerSettings.highlightActiveLine,
			customCss: generalSettings.readerSettings.customCss
		}
	});
}

export async function incrementStat(
	action: ClipAction,
	url?: string,
	title?: string
): Promise<void> {
	await sendClipRecordingMessage(action, url, title);
}

/** Background-only storage effect. Production callers use incrementStat(). */
export async function recordClipInStorage(
	action: ClipAction,
	url?: string,
	title?: string
): Promise<void> {
	const normalizedAction = migrateClipAction(action);
	if (!normalizedAction || (title !== undefined && url === undefined)) {
		throw new ClipRecordingError();
	}
	const entry = url === undefined
		? undefined
		: createClipHistoryEntry(normalizedAction, url, title);
	if (url !== undefined && !entry) throw new ClipRecordingError();

	const stored = await browser.storage.sync.get([
		'stats',
		'migrationVersion',
	]) as Pick<StorageData, 'stats' | 'migrationVersion'>;
	const stats = sanitizeClipStats(stored.stats);
	stats[normalizedAction] = saturatingClipCount(stats[normalizedAction], 1);
	const migrationVersion = typeof stored.migrationVersion === 'number'
		&& Number.isSafeInteger(stored.migrationVersion)
		&& stored.migrationVersion > CURRENT_MIGRATION_VERSION
		? stored.migrationVersion
		: CURRENT_MIGRATION_VERSION;
	await browser.storage.sync.set({ stats, migrationVersion });

	if (entry) await persistHistoryEntry(entry);
}

export async function addHistoryEntry(
	action: ClipAction,
	url: string, 
	title?: string
): Promise<void> {
	const normalizedAction = migrateClipAction(action);
	const entry = normalizedAction
		? createClipHistoryEntry(normalizedAction, url, title)
		: null;
	if (!entry) throw new ClipRecordingError();
	await persistHistoryEntry(entry);
}

async function persistHistoryEntry(entry: HistoryEntry): Promise<void> {
	const result = await browser.storage.local.get('history');
	const { history } = sanitizeClipHistory(result.history);
	history.unshift(entry);
	await browser.storage.local.set({ history: history.slice(0, 1000) });
}

export async function getClipHistory(): Promise<HistoryEntry[]> {
	const result = await browser.storage.local.get('history');
	const { history, changed } = sanitizeClipHistory(result.history);
	if (changed) {
		await browser.storage.local.set({ history });
	}
	return history;
}
