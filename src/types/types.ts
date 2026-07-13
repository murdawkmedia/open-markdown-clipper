import type { DestinationKind } from '../destinations/types';

export interface Template {
	id: string;
	name: string;
	behavior: 'create' | 'append-specific' | 'append-daily' | 'prepend-specific' | 'prepend-daily' | 'overwrite';
	noteNameFormat: string;
	path: string;
	noteContentFormat: string;
	properties: Property[];
	triggers?: string[];
}

export interface Property {
	id?: string;
	name: string;
	value: string;
	type?: string;
}

export interface ExtractedContent {
	[key: string]: string;
}

export type FilterFunction = (value: string, param?: string) => string | any[];

export interface PropertyType {
	name: string;
	type: string;
	defaultValue?: string;
}

export interface Rating {
	rating: number;
	date: string;
}

export type ClipAction = DestinationKind | 'share';

export interface ClipStats {
	clipboard: number;
	download: number;
	'custom-uri': number;
	'local-http': number;
	share: number;
}

export interface ReaderSettings {
	fontSize: number;
	lineHeight: number;
	maxWidth: number;
	lightTheme: string;
	darkTheme: string;
	appearance: 'auto' | 'light' | 'dark';
	fonts: string[];
	defaultFont: string;
	blendImages: boolean;
	colorLinks: boolean;
	followLinks: boolean;
	pinPlayer: boolean;
	autoScroll: boolean;
	highlightActiveLine: boolean;
	customCss: string;
}

export interface Settings {
	showMoreActionsButton: boolean;
	betaFeatures: boolean;
	openBehavior: 'popup' | 'reader';
	highlighterEnabled: boolean;
	alwaysShowHighlights: boolean;
	highlightBehavior: string;
	propertyTypes: PropertyType[];
	readerSettings: ReaderSettings;
	stats: ClipStats;
	ratings: Rating[];
	defaultDestination: DestinationKind;
	customUriTemplate: string;
	localHttpEndpoint: string;
}

export interface HistoryEntry {
	datetime: string;
	url: string;
	action: ClipAction;
	title?: string;
}

export interface ConversationMessage {
	author: string;
	content: string;
	timestamp?: string;
	metadata?: Record<string, any>;
}

export interface ConversationMetadata {
	title?: string;
	description?: string;
	site: string;
	url: string;
	messageCount: number;
	startTime?: string;
	endTime?: string;
}

export interface Footnote {
	url: string;
	text: string;
}
