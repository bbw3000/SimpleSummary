import { log } from './logger.js';

const BASE_URL = new URL('../', import.meta.url).href;

export const BUILTIN_LOCALE = 'en';
const BUILTIN_LOCALE_LABEL = 'English';
let builtinStringsPromise = null;

let strings = {};
let currentLocale = BUILTIN_LOCALE;
let availableLocales = [BUILTIN_LOCALE];
let localeLabels = { [BUILTIN_LOCALE]: BUILTIN_LOCALE_LABEL };
let onLocaleChangeCallbacks = [];

async function loadBuiltinStrings() {
    if (builtinStringsPromise) return builtinStringsPromise;

    builtinStringsPromise = (async () => {
        const data = await loadLangFile(BUILTIN_LOCALE);
        return data || {};
    })();

    return builtinStringsPromise;
}

function parseLangFile(text) {
    const result = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key) result[key] = val;
    }
    return result;
}

async function loadLangFile(locale) {
    try {
        const resp = await fetch(`${BASE_URL}language/${locale}.lang`);
        if (!resp.ok) return null;
        const text = await resp.text();
        return parseLangFile(text);
    } catch (_) {
        return null;
    }
}

export function applyAllDataI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = t(key);
        if (val !== key) el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const val = t(key);
        if (val !== key) {
            if ('placeholder' in el) el.placeholder = val;
            else el.setAttribute('data-placeholder', val);
        }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const val = t(key);
        if (val !== key) el.title = val;
    });
}

export function t(key, params) {
    let val = strings[key];
    if (val === undefined) val = key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
            val = val.replace(new RegExp('\\$\\{' + k + '\\}', 'g'), String(v ?? ''));
        }
    }
    return val;
}

export function getCurrentLocale() {
    return currentLocale;
}

export function getAvailableLocales() {
    return availableLocales;
}

export function getLocaleLabel(locale) {
    return localeLabels[locale] || locale;
}

export function onLocaleChange(fn) {
    if (typeof fn === 'function') onLocaleChangeCallbacks.push(fn);
}

export async function setLocale(locale, userChoice = true) {
    if (!locale) locale = BUILTIN_LOCALE;

    const baseStrings = await loadBuiltinStrings();

    if (locale === BUILTIN_LOCALE) {
        strings = { ...baseStrings };
        currentLocale = locale;
    } else {
        const data = await loadLangFile(locale);
        if (!data) {
            log(`Lang file "${locale}" not found, falling back to "${BUILTIN_LOCALE}"`);
            strings = { ...baseStrings };
            currentLocale = BUILTIN_LOCALE;
        } else {
            strings = { ...baseStrings, ...data };
            currentLocale = locale;
        }
    }

    if (userChoice) {
        try {
            const updater = globalThis.SimpleSummaryUpdateLocale;
            if (typeof updater === 'function') {
                updater(currentLocale);
            } else {
                const { extensionSettings } = SillyTavern.getContext();
                const s = extensionSettings.SimpleSummary;
                if (s) s.locale = currentLocale;
                SillyTavern.getContext().saveSettingsDebounced();
            }
        } catch (_) {}
    }

    applyAllDataI18n();
    for (const fn of onLocaleChangeCallbacks) {
        try { fn(currentLocale); } catch (_) {}
    }
}

async function loadLanguageIndex() {
    try {
        const resp = await fetch(`${BASE_URL}language/lang.cfg`);
        if (!resp.ok) return [];
        const text = await resp.text();
        const locales = [];
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(',');
            if (parts.length >= 2) {
                const code = parts[0].trim();
                const name = parts[1].trim();
                if (code) locales.push({ code, name });
            }
        }
        return locales;
    } catch (_) {
        return [];
    }
}

export async function initI18n(savedLocale) {
    const langIndex = await loadLanguageIndex();

    if (!availableLocales.includes(BUILTIN_LOCALE)) {
        availableLocales.unshift(BUILTIN_LOCALE);
    }
    if (!localeLabels[BUILTIN_LOCALE]) {
        localeLabels[BUILTIN_LOCALE] = BUILTIN_LOCALE_LABEL;
    }
    
    for (const { code, name } of langIndex) {
        const data = await loadLangFile(code);
        if (data) {
            if (!availableLocales.includes(code)) {
                availableLocales.push(code);
                localeLabels[code] = name || data['lang.name'] || code;
            }
        }
    }

    let locale = savedLocale || BUILTIN_LOCALE;
    if (locale !== BUILTIN_LOCALE && !availableLocales.includes(locale)) {
        locale = BUILTIN_LOCALE;
    }

    await setLocale(locale, false);
    log('i18n ready — locale:', currentLocale, '| available:', availableLocales.join(', '));
}
