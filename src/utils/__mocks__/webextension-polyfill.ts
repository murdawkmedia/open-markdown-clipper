// Mock for webextension-polyfill in test environment
export const runtime = {
	getURL: (path: string) => `chrome-extension://mock-id/${path}`,
	sendMessage: async () => ({}),
	onMessage: {
		addListener: () => {},
		removeListener: () => {},
	},
};

type MockStorageArea = 'local' | 'sync';
type MockStorageRecord = Record<string, unknown>;
type StorageKeys = string | string[] | Record<string, unknown> | null | undefined;

const mockStorage: Record<MockStorageArea, MockStorageRecord> = {
	local: {},
	sync: {},
};

function cloneValue<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function selectStorage(area: MockStorageArea, keys: StorageKeys): MockStorageRecord {
	const data = mockStorage[area];
	if (keys == null) return cloneValue(data);
	if (typeof keys === 'string') {
		return keys in data ? { [keys]: cloneValue(data[keys]) } : {};
	}
	if (Array.isArray(keys)) {
		const selected: MockStorageRecord = {};
		for (const key of keys) {
			if (key in data) selected[key] = cloneValue(data[key]);
		}
		return selected;
	}
	const selected: MockStorageRecord = {};
	for (const [key, fallback] of Object.entries(keys)) {
		selected[key] = key in data ? cloneValue(data[key]) : cloneValue(fallback);
	}
	return selected;
}

function createStorageArea(area: MockStorageArea) {
	return {
		get: async (keys?: StorageKeys) => selectStorage(area, keys),
		set: async (values: MockStorageRecord) => {
			Object.assign(mockStorage[area], cloneValue(values));
		},
		remove: async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				delete mockStorage[area][key];
			}
		},
		clear: async () => {
			for (const key of Object.keys(mockStorage[area])) {
				delete mockStorage[area][key];
			}
		},
	};
}

export function __resetMockStorage(): void {
	for (const area of ['local', 'sync'] as const) {
		for (const key of Object.keys(mockStorage[area])) {
			delete mockStorage[area][key];
		}
	}
}

export function __seedMockStorage(area: MockStorageArea, values: MockStorageRecord): void {
	Object.assign(mockStorage[area], cloneValue(values));
}

export function __getMockStorage(area: MockStorageArea): MockStorageRecord {
	return cloneValue(mockStorage[area]);
}

export const storage = {
	local: createStorageArea('local'),
	sync: createStorageArea('sync'),
	onChanged: {
		addListener: () => {},
		removeListener: () => {},
	},
};

export const tabs = {
	query: async () => [],
	sendMessage: async () => ({}),
};

export const i18n = {
	getMessage: (key: string) => key,
};

export default {
	runtime,
	storage,
	tabs,
	i18n,
};
