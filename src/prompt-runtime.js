import { buildChatAfterText, buildChatText, preprocessChatMessageText } from './chat-log-preprocess.js';

const CHAT_LANG_TOP_N = 3;
const CHAT_LANG_OUTPUT_THRESHOLD = 0.12;
const LATIN_LANGUAGE_STOPWORDS = Object.freeze({
    en: new Set(['the', 'and', 'you', 'that', 'have', 'for', 'with', 'this', 'not', 'are', 'was', 'but', 'what', 'when', 'where', 'who', 'why', 'how', 'your', 'from', 'they', 'their', 'would', 'there', 'been', 'will', 'just', 'can', 'could', 'should', 'like', 'about', 'into', 'more', 'some', 'time', 'then', 'than', 'here', 'out', 'all', 'any', 'our', 'one', 'do', 'did', 'does', 'is', 'am', 'be', 'to', 'of', 'in', 'it', 'on', 'we', 'i', 'a']),
    fr: new Set(['le', 'la', 'les', 'de', 'des', 'et', 'en', 'un', 'une', 'que', 'pour', 'pas', 'dans', 'avec', 'est', 'au', 'aux', 'du', 'ce', 'ça', 'sur', 'qui', 'quoi', 'comme', 'mais', 'ou', 'où', 'être', 'avoir', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles']),
    de: new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'zu', 'mit', 'den', 'des', 'ein', 'eine', 'auf', 'für', 'von', 'dass', 'wie', 'auch', 'aber', 'wir', 'ihr', 'sie', 'im', 'am', 'bin', 'bist', 'sind', 'war', 'waren']),
    es: new Set(['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'para', 'con', 'como', 'pero', 'del', 'al', 'es', 'no', 'sí', 'te', 'me', 'se', 'yo', 'tú', 'usted', 'ustedes', 'nos', 'nosotros', 'ellos', 'ellas']),
    it: new Set(['il', 'lo', 'la', 'gli', 'le', 'di', 'e', 'un', 'una', 'per', 'con', 'non', 'come', 'ma', 'del', 'della', 'degli', 'dei', 'è', 'sono', 'sei', 'siamo', 'siete', 'sono', 'che', 'io', 'tu', 'lui', 'lei', 'noi', 'voi']),
});

function countRegexMatches(text, regex) {
    const matches = String(text || '').match(regex);
    return matches ? matches.length : 0;
}

function collectUserMessageText(messages = [], preprocessSettings = null) {
    const sampleSettings = preprocessSettings && typeof preprocessSettings === 'object'
        ? { ...preprocessSettings, regexRules: [] }
        : null;
    return (Array.isArray(messages) ? messages : [])
        .filter(m => m && !m.is_system && m.is_user)
        .map(m => preprocessChatMessageText(m.mes || '', sampleSettings))
        .filter(Boolean)
        .join('\n\n');
}

export function scoreChatLanguageSample(text) {
    const sample = String(text || '');
    if (!sample.trim()) {
        return { primaryLocale: null, primaryRatio: 0, mixed: false, languages: [] };
    }

    const rawScores = new Map();
    const addScore = (locale, score) => {
        const next = Number(score) || 0;
        if (next <= 0) return;
        rawScores.set(locale, (rawScores.get(locale) || 0) + next);
    };

    const hanCount = countRegexMatches(sample, /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g);
    const hiraCount = countRegexMatches(sample, /[\u3040-\u309F]/g);
    const kataCount = countRegexMatches(sample, /[\u30A0-\u30FF\u31F0-\u31FF]/g);
    const hangulCount = countRegexMatches(sample, /[\uAC00-\uD7AF]/g);
    const cyrillicCount = countRegexMatches(sample, /[\u0400-\u04FF\u0500-\u052F]/g);
    const arabicCount = countRegexMatches(sample, /[\u0600-\u06FF\u0750-\u077F]/g);
    const devanagariCount = countRegexMatches(sample, /[\u0900-\u097F]/g);

    addScore('zh-CN', hanCount);
    addScore('ja', (hiraCount + kataCount) * 2 + (hiraCount + kataCount > 0 ? 0.5 : 0));
    addScore('ko', hangulCount);
    addScore('ru', cyrillicCount);
    addScore('ar', arabicCount);
    addScore('hi', devanagariCount);

    const latinTokens = (sample.toLowerCase().match(/[a-z\u00e0-\u00f6\u00f8-\u00ff']+/g) || []).filter(Boolean);
    if (latinTokens.length) {
        const enStopwordHits = Array.from(LATIN_LANGUAGE_STOPWORDS.en).reduce((count, word) => {
            return count + latinTokens.filter(token => token === word).length;
        }, 0);
        if (enStopwordHits > 0) addScore('en', enStopwordHits * 4);
        for (const [locale, words] of Object.entries(LATIN_LANGUAGE_STOPWORDS)) {
            if (locale === 'en') continue;
            let hits = 0;
            for (const token of latinTokens) {
                if (words.has(token)) hits++;
            }
            if (hits >= 2) addScore(locale, hits * 4);
        }
    }

    if (!rawScores.size) {
        return { primaryLocale: null, primaryRatio: 0, mixed: false, languages: [] };
    }

    const entries = Array.from(rawScores.entries())
        .map(([locale, score]) => ({ locale, score }))
        .sort((a, b) => b.score - a.score || a.locale.localeCompare(b.locale));
    const totalScore = entries.reduce((sum, item) => sum + item.score, 0) || 1;
    const languages = entries.slice(0, CHAT_LANG_TOP_N).map(item => ({
        locale: item.locale,
        ratio: Number((item.score / totalScore).toFixed(3)),
    }));
    const primary = languages[0] || null;
    const secondary = languages[1] || null;

    return {
        primaryLocale: primary?.locale ?? null,
        primaryRatio: primary?.ratio ?? 0,
        mixed: !!(primary && (primary.ratio < 0.65 || (secondary && secondary.ratio >= 0.2))),
        languages,
    };
}

export function createPromptRuntime({ getST, getSegments, getChatSummary, getHomeSummaryRange, getRangeEndValue, getPreprocessConfig, translate } = {}) {
    const t = typeof translate === 'function' ? translate : (key) => key;

    const getLatestSummaryTextForLanguage = (segments = null) => {
        const list = Array.isArray(segments) ? segments : getSegments?.() || [];
        const latest = list.length ? list[list.length - 1] : null;
        return String(latest?.summaryText || '').trim();
    };

    const getChatLangMacroValue = ({ chat = [], messages = null, segments = null } = {}) => {
        const summaryText = getLatestSummaryTextForLanguage(segments);
        const sampleText = summaryText || collectUserMessageText(messages ?? chat, getPreprocessConfig?.());
        const result = scoreChatLanguageSample(sampleText);
        if (!result.languages.length) return '';

        const selected = result.languages.filter((item, index) => index === 0 || item.ratio >= CHAT_LANG_OUTPUT_THRESHOLD);
        if (!selected.length) return '';

        const total = selected.reduce((sum, item) => sum + item.ratio, 0) || 1;
        return selected
            .map(item => `${item.locale}: ${Math.round((item.ratio / total) * 100)}%`)
            .join('\n');
    };

    const resolvePrompt = (template, chatText, chatAfterText = '') => {
        const ctx = getST?.() || {};
        let p = String(template || '');
        p = p.replace(/\{\{chatLog\}\}/gi, chatText);
        p = p.replace(/\{\{chatAfter\}\}/gi, chatAfterText);
        p = p.replace(/\{\{chatLang\}\}/gi, getChatLangMacroValue({ chat: ctx.chat || [] }));
        p = p.replace(/\{\{SPSummaries\}\}/gi, getChatSummary?.() || '');
        p = p.replace(/\{\{latestSegment\}\}/gi, getLatestSummaryTextForLanguage());
        p = p.replace(/\{\{user\}\}/gi, ctx.name1 || 'User');
        p = p.replace(/\{\{char\}\}/gi, ctx.name2 || 'Char');
        try {
            const pd = document.getElementById('persona_description');
            if (pd) p = p.replace(/\{\{persona\}\}/gi, pd.value || '');
        } catch (_) {}
        return p;
    };

    const getChatAfterMacroValue = () => {
        const chat = getST?.()?.chat || [];
        const { start, end: maxHi } = getHomeSummaryRange?.(chat) || { start: 0, end: -1 };
        const rawEnd = Number(getRangeEndValue?.());
        const hi = Number.isFinite(rawEnd) ? Math.floor(rawEnd) : maxHi;
        const clampedHi = Math.min(Math.max(start === -1 ? 0 : start, hi), maxHi);
        return buildChatAfterText(chat, clampedHi, 1, getST?.() || {}, getPreprocessConfig?.());
    };

    const registerMacros = () => {
        try {
            const ctx = getST?.();
            if (!ctx) return;

            const registerNewApi = () => {
                if (!ctx.macros?.register) return false;
                try {
                    ctx.macros.register('SPSummaries', {
                        description: t('macro.spSummaries'),
                        handler: () => getChatSummary?.() || t('macro.spSummariesFallback'),
                    });
                    ctx.macros.register('latestSegment', {
                        description: t('macro.latestSegment'),
                        handler: () => getLatestSummaryTextForLanguage(),
                    });
                    ctx.macros.register('chatAfter', {
                        description: t('macro.chatAfter'),
                        handler: getChatAfterMacroValue,
                    });
                    ctx.macros.register('chatLang', {
                        description: t('macro.chatLang'),
                        handler: () => getChatLangMacroValue({ chat: getST?.()?.chat || [] }),
                    });
                    console.log('[SimpleSummary] macros.register (new API) OK - {{SPSummaries}} / {{latestSegment}} / {{chatAfter}} / {{chatLang}}');
                    return true;
                } catch (err) {
                    console.warn('[SimpleSummary] macros.register failed, will try legacy:', err);
                    return false;
                }
            };

            const registerLegacyApi = () => {
                const legacy = typeof ctx.registerMacro === 'function' ? ctx.registerMacro : null;
                if (!legacy) return false;
                legacy('SPSummaries', () => getChatSummary?.() || t('macro.spSummariesFallback'));
                legacy('latestSegment', () => getLatestSummaryTextForLanguage());
                legacy('chatAfter', getChatAfterMacroValue);
                legacy('chatLang', () => getChatLangMacroValue({ chat: getST?.()?.chat || [] }));
                console.log('[SimpleSummary] registerMacro (legacy) OK');
                return true;
            };

            if (!registerNewApi() && !registerLegacyApi()) {
                console.warn('[SimpleSummary] No macro API - upgrade SillyTavern or check docs.');
            }
        } catch (e) {
            console.error('[SimpleSummary] Macro registration error:', e);
        }
    };

    return {
        buildChatText: (messages) => buildChatText(messages, getST?.() || {}, getPreprocessConfig?.()),
        buildChatAfterText: (chat, endIndex, count = 1) => buildChatAfterText(chat, endIndex, count, getST?.() || {}, getPreprocessConfig?.()),
        getLatestSummaryTextForLanguage,
        getChatLangMacroValue,
        resolvePrompt,
        registerMacros,
    };
}
