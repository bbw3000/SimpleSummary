import { createDefaultChatState, normalizeChatState } from './segments.js';

const STORAGE_VERSION = 1;
const SETTINGS_FILE_NAME = 'SP_settings.json';
const BROWSER_SETTINGS_STORAGE_KEY = 'SimpleSummary:browserSettings';
const CUSTOM_PROMPTS_FILE_NAME = 'SP_custom_prompts.json';
const SETTINGS_FILE_DEBOUNCE_MS = 10000;

function encodeTextToBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function getUserFilePath(fileName) {
    return `/user/files/${encodeURIComponent(fileName)}`;
}

export function createStorageManager({ defaultSettings, browserSettingsKeys, moduleName, getST, translate, toast } = {}) {
    const t = typeof translate === 'function' ? translate : (key) => key;
    let settingsState = structuredClone(defaultSettings || {});
    let settingsLoaded = false;
    let settingsLoadPromise = null;
    let customPromptsState = [];
    let customPromptsLoaded = false;
    let customPromptsLoadPromise = null;
    let settingsSaveTimer = null;
    let lastWrittenSettingsJson = null;
    let persistChain = Promise.resolve();

    const getSettings = () => {
        const s = settingsState;
        for (const k of Object.keys(defaultSettings || {})) {
            if (!Object.hasOwn(s, k)) s[k] = defaultSettings[k];
        }
        return s;
    };

    const getRequestHeaders = () => getST?.()?.getRequestHeaders?.() || {};

    const readUserFileText = async (fileName) => {
        const response = await fetch(getUserFilePath(fileName), {
            method: 'GET',
            headers: getRequestHeaders(),
            cache: 'no-store',
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`Failed to load ${fileName}: ${response.status}`);
        }

        const raw = await response.text();
        if (!raw.trim()) return null;
        return raw;
    };

    const writeUserFileText = async (fileName, text) => {
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: {
                ...getRequestHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: fileName,
                data: encodeTextToBase64(String(text ?? '')),
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Failed to save ${fileName}`);
        }
    };

    const getBrowserSettings = () => {
        try {
            const raw = window.localStorage?.getItem(BROWSER_SETTINGS_STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn('[SimpleSummary] Failed to read browser settings.', error);
            return {};
        }
    };

    const saveBrowserSettings = () => {
        const s = getSettings();
        const payload = {};
        for (const key of browserSettingsKeys || []) {
            payload[key] = structuredClone(s[key]);
        }

        try {
            window.localStorage?.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn('[SimpleSummary] Failed to save browser settings.', error);
        }
    };

    const clearBrowserSettings = () => {
        try {
            window.localStorage?.removeItem(BROWSER_SETTINGS_STORAGE_KEY);
        } catch (error) {
            console.warn('[SimpleSummary] Failed to clear browser settings.', error);
        }
    };

    const applyBrowserSettingsToState = () => {
        const browser = getBrowserSettings();
        const s = getSettings();
        for (const key of browserSettingsKeys || []) {
            if (Object.hasOwn(browser, key)) s[key] = browser[key];
        }
    };

    const buildSettingsJson = () => {
        const presetsToSave = Array.isArray(settingsState.presets)
            ? settingsState.presets.map(preset => {
                if (!preset || typeof preset !== 'object') return preset;
                const next = { ...preset };
                delete next.availableModels;
                delete next.modelsFetchedAt;
                return next;
            })
            : [];
        return JSON.stringify({
            version: STORAGE_VERSION,
            presets: presetsToSave,
            chatLogPreprocess: structuredClone(settingsState.chatLogPreprocess || {}),
        }, null, 2);
    };

    const writeSettingsFile = async () => {
        const json = buildSettingsJson();
        if (json === lastWrittenSettingsJson) return;
        await writeUserFileText(SETTINGS_FILE_NAME, json);
        lastWrittenSettingsJson = json;
    };

    const queueSettingsSave = () => {
        saveBrowserSettings();
        clearTimeout(settingsSaveTimer);
        settingsSaveTimer = setTimeout(() => {
            persistChain = persistChain
                .then(() => writeSettingsFile())
                .catch(error => {
                    console.error('[SimpleSummary] Failed to save settings file:', error);
                });
        }, SETTINGS_FILE_DEBOUNCE_MS);
        return persistChain;
    };

    const writeCustomPromptsFile = async () => {
        await writeUserFileText(CUSTOM_PROMPTS_FILE_NAME, JSON.stringify({
            version: STORAGE_VERSION,
            prompts: customPromptsState,
        }, null, 2));
    };

    const queueCustomPromptsSave = () => {
        persistChain = persistChain
            .then(() => writeCustomPromptsFile())
            .catch(error => {
                console.error('[SimpleSummary] Failed to save custom prompts file:', error);
            });
        return persistChain;
    };

    const ensureSettingsLoaded = async () => {
        if (settingsLoaded) return settingsState;
        if (settingsLoadPromise) return settingsLoadPromise;

        settingsLoadPromise = (async () => {
            const browserSettings = getBrowserSettings();
            const next = structuredClone(defaultSettings || {});
            let browserSettingsChanged = false;
            let loadedChatLogPreprocess = false;
            const raw = await readUserFileText(SETTINGS_FILE_NAME);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        const source = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
                        if (Array.isArray(source.presets)) next.presets = structuredClone(source.presets);
                        if (source.chatLogPreprocess && typeof source.chatLogPreprocess === 'object') {
                            next.chatLogPreprocess = structuredClone(source.chatLogPreprocess);
                            loadedChatLogPreprocess = true;
                        }
                        for (const key of browserSettingsKeys || []) {
                            if (!Object.hasOwn(source, key)) continue;
                            next[key] = source[key];
                            browserSettingsChanged = true;
                        }
                    }
                } catch (error) {
                    console.warn('[SimpleSummary] Failed to parse settings file, using defaults.', error);
                }
            }

            for (const key of browserSettingsKeys || []) {
                if (Object.hasOwn(browserSettings, key)) next[key] = browserSettings[key];
            }

            settingsState = next;
            if (!loadedChatLogPreprocess) {
                const legacyPreprocess = browserSettings.chatLogPreprocess;
                if (legacyPreprocess && typeof legacyPreprocess === 'object') {
                    next.chatLogPreprocess = structuredClone(legacyPreprocess);
                    browserSettingsChanged = true;
                }
            }
            if (browserSettingsChanged) saveBrowserSettings();
            lastWrittenSettingsJson = buildSettingsJson();
            settingsLoaded = true;
            return settingsState;
        })();

        return settingsLoadPromise;
    };

    const ensureCustomPromptsLoaded = async () => {
        if (customPromptsLoaded) return customPromptsState;
        if (customPromptsLoadPromise) return customPromptsLoadPromise;

        customPromptsLoadPromise = (async () => {
            const raw = await readUserFileText(CUSTOM_PROMPTS_FILE_NAME);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        customPromptsState = parsed;
                    } else if (parsed && Array.isArray(parsed.prompts)) {
                        customPromptsState = parsed.prompts;
                    }
                } catch (error) {
                    console.warn('[SimpleSummary] Failed to parse custom prompts file, starting fresh.', error);
                    customPromptsState = [];
                }
            }

            customPromptsLoaded = true;
            return customPromptsState;
        })();

        return customPromptsLoadPromise;
    };

    // ── Chat metadata-based segments ──

    const getSegmentsFromMeta = () => {
        const ctx = getST?.();
        const meta = ctx?.chatMetadata;
        if (!meta) return [];
        const state = normalizeChatState(meta.SP, '');
        return state.segments;
    };

    const ensureSegmentsInMeta = () => {
        const ctx = getST?.();
        if (!ctx) return null;
        const meta = ctx.chatMetadata;
        if (!meta) return null;
        if (!meta.SP || typeof meta.SP !== 'object') {
            meta.SP = createDefaultChatState('');
        }
        meta.SP = normalizeChatState(meta.SP, '');
        return meta.SP;
    };

    const saveCurrentChatMetadata = () => {
        const ctx = getST?.();
        if (ctx && typeof ctx.saveMetadataDebounced === 'function') {
            ctx.saveMetadataDebounced();
        }
    };

    const getSegments = () => getSegmentsFromMeta();

    const getChatSummary = () => {
        const segments = getSegments();
        if (!segments.length) return '';
        return segments
            .map(segment => String(segment?.summaryText || '').trim())
            .filter(Boolean)
            .join('\n\n');
    };

    const getSegmentById = (id) => {
        if (!id) return null;
        return getSegments().find(segment => segment.id === id) || null;
    };

    const getLatestSegment = () => {
        const segments = getSegments();
        return segments.length ? segments[segments.length - 1] : null;
    };

    const setSegmentSummaryText = (id, txt) => {
        const state = ensureSegmentsInMeta();
        if (!state) return null;
        const segment = getSegmentById(id);
        if (!segment) return null;
        segment.summaryText = String(txt ?? '');
        segment.updatedAt = Date.now();
        saveCurrentChatMetadata();
        return segment;
    };

    const createSegment = (summaryText, range) => {
        const state = ensureSegmentsInMeta();
        if (!state) return null;
        const segment = {
            id: `seg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
            timestamp: Date.now(),
            summaryText: String(summaryText || ''),
            updatedAt: Date.now(),
            range: { start: Number(range?.start) || 0, end: Number(range?.end) ?? -1 },
        };
        if (!Number.isFinite(segment.range.end)) segment.range.end = -1;
        state.segments.push(segment);
        saveCurrentChatMetadata();
        return segment;
    };

    const deleteLatestSegment = () => {
        const state = ensureSegmentsInMeta();
        if (!state || !Array.isArray(state.segments) || !state.segments.length) return null;
        const removed = state.segments.pop();
        saveCurrentChatMetadata();
        return removed;
    };

    const resetCurrentChatSegments = () => {
        const ctx = getST?.();
        const meta = ctx?.chatMetadata;
        if (!meta) return;
        delete meta.SP;
        saveCurrentChatMetadata();
    };

    const stripLegacyChatMetadata = () => {
        const ctx = getST?.();
        const meta = ctx?.chatMetadata;
        if (!meta || !Object.hasOwn(meta, 'simpleSummary')) return false;
        delete meta.simpleSummary;
        if (typeof ctx.saveMetadata === 'function') {
            ctx.saveMetadata();
        }
        return true;
    };

    const repairSegments = (chatLength) => {
        const state = ensureSegmentsInMeta();
        if (!state || !Array.isArray(state.segments) || !state.segments.length) return 0;

        const lastMsgIndex = chatLength - 1;
        let cutIndex = -1;

        for (let i = 0; i < state.segments.length; i++) {
            const seg = state.segments[i];
            const end = Number(seg?.range?.end);
            if (Number.isFinite(end) && end >= lastMsgIndex) {
                cutIndex = i;
                break;
            }
        }

        if (cutIndex < 0) return 0;

        const removed = state.segments.length - cutIndex;
        state.segments.splice(cutIndex);
        saveCurrentChatMetadata();
        return removed;
    };

    const onCurrentChatChanged = (chatLength) => {
        if (!chatLength || chatLength <= 0) return 0;

        const s = getSettings();
        if (!s.autoRepairSummary) return 0;

        const removed = repairSegments(chatLength);
        if (removed > 0 && typeof toast === 'function') {
            toast(t('toast.segmentsRepaired', { count: removed }));
        }
        return removed;
    };

    return {
        getSettings,
        getBrowserSettings,
        saveBrowserSettings,
        clearBrowserSettings,
        applyBrowserSettingsToState,
        saveSettings: queueSettingsSave,
        getCustomPrompts: () => Array.isArray(customPromptsState) ? customPromptsState : [],
        setCustomPrompts: (prompts) => { customPromptsState = Array.isArray(prompts) ? prompts : []; },
        ensureSettingsLoaded,
        ensureCustomPromptsLoaded,
        queueCustomPromptsSave,
        // Segments via chat_metadata
        getSegmentsFromMeta,
        getChatSummary,
        getSegmentById,
        getLatestSegment,
        setSegmentSummaryText,
        createSegment,
        deleteLatestSegment,
        resetCurrentChatSegments,
        stripLegacyChatMetadata,
        repairSegments,
        onCurrentChatChanged,
    };
}
