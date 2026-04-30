const STORAGE_VERSION = 1;

export function createDefaultChatState(chatId = '') {
    return {
        version: STORAGE_VERSION,
        chatId,
        segments: [],
        updatedAt: Date.now(),
    };
}

export function normalizeRange(range) {
    const start = Number(range?.start);
    const end = Number(range?.end);
    return {
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : -1,
    };
}

export function normalizeChatState(state, chatId = '') {
    const next = {
        ...createDefaultChatState(chatId),
        ...(state && typeof state === 'object' ? state : {}),
    };
    next.chatId = chatId || next.chatId || '';
    next.version = STORAGE_VERSION;
    const legacySnapshots = Array.isArray(next.snapshots) ? next.snapshots : [];
    next.segments = Array.isArray(next.segments) ? next.segments : legacySnapshots.map((snap, idx) => ({
        id: snap?.id || `seg_${Date.now()}_${idx}`,
        timestamp: Number(snap?.timestamp) || Date.now(),
        summaryText: String(snap?.summaryText || ''),
        updatedAt: Number(snap?.updatedAt) || Number(snap?.timestamp) || Date.now(),
        range: snap?.hiddenRange && typeof snap.hiddenRange === 'object'
            ? {
                start: Number(snap.hiddenRange.start) || 0,
                end: Number(snap.hiddenRange.end) || -1,
            }
            : { start: 0, end: -1 },
    }));
    if (!Number.isFinite(Number(next.updatedAt))) next.updatedAt = Date.now();
    for (const segment of next.segments) {
        if (segment && typeof segment === 'object') {
            if (!Number.isFinite(Number(segment.updatedAt))) {
                segment.updatedAt = Number(segment.timestamp) || Date.now();
            }
            if (!segment.range || typeof segment.range !== 'object') {
                segment.range = { start: 0, end: -1 };
            }
            segment.range = normalizeRange(segment.range);
        }
    }
    return next;
}

export function getSegmentLabel(segment) {
    const range = normalizeRange(segment?.range);
    if (range.start > range.end) return '\u2014';
    if (range.start === range.end) return `${range.start}F`;
    return `${range.start}~${range.end}F`;
}

export function createSegmentController({ getMeta, ensureMeta, saveMeta, onChange } = {}) {
    const notifyChanged = () => {
        if (typeof onChange === 'function') onChange();
    };

    const getSegments = () => {
        const meta = getMeta?.();
        if (!meta || !Array.isArray(meta.segments)) return [];
        return meta.segments;
    };

    const getChatSummary = () => {
        const segments = getSegments();
        if (!segments.length) return '';
        return segments
            .map(segment => String(segment?.summaryText || '').trim())
            .filter(Boolean)
            .join('\n\n');
    };

    const getSegmentIndexById = (id) => getSegments().findIndex(segment => segment.id === id);

    const getSegmentById = (id) => {
        if (!id) return null;
        return getSegments().find(segment => segment.id === id) || null;
    };

    const getLatestSegment = () => {
        const segments = getSegments();
        return segments.length ? segments[segments.length - 1] : null;
    };

    const setSegmentSummaryText = (id, txt) => {
        const meta = ensureMeta?.();
        if (!meta) return null;
        const segment = getSegmentById(id);
        if (!segment) return null;
        segment.summaryText = String(txt ?? '');
        segment.updatedAt = Date.now();
        saveMeta?.();
        notifyChanged();
        return segment;
    };

    const createSegment = (summaryText, range) => {
        const meta = ensureMeta?.();
        if (!meta) return null;
        const segment = {
            id: `seg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
            timestamp: Date.now(),
            summaryText: String(summaryText || ''),
            updatedAt: Date.now(),
            range: normalizeRange(range),
        };
        meta.segments.push(segment);
        saveMeta?.();
        notifyChanged();
        return segment;
    };

    const deleteLatestSegment = () => {
        const meta = getMeta?.();
        if (!meta || !Array.isArray(meta.segments) || !meta.segments.length) return null;
        const latest = meta.segments[meta.segments.length - 1];
        meta.segments.pop();
        saveMeta?.();
        notifyChanged();
        return latest;
    };

    return {
        getSegments,
        getChatSummary,
        getSegmentIndexById,
        getSegmentById,
        getLatestSegment,
        setSegmentSummaryText,
        createSegment,
        deleteLatestSegment,
    };
}
