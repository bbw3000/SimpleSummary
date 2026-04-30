import { t } from './i18n.js';

let previewStreamText = '';
let previewStreamThinking = '';
let previewPendingText = '';
let previewPendingThinking = '';
let previewRawCarry = '';
let previewStreamInThinking = false;
let previewFlushRaf = 0;
let previewScrollRaf = 0;

/**
 * Extract visible content and thinking content from LLM output.
 * Prioritizes reasoning_content, then falls back to <think>/<thinking> tags.
 */
export function extractVisibleAndThinking(raw, reasoning = '') {
    if (!raw && !reasoning) return { visible: '', thinking: '' };

    let result = raw || '';
    let thinkingContent = reasoning || '';

    if (!thinkingContent && raw) {
        const thinkRegex = /<(thinking|think)>([\s\S]*?)<\/(thinking|think)>/gi;
        let lastIndex = 0;
        let match;

        result = '';
        thinkRegex.lastIndex = 0;

        while ((match = thinkRegex.exec(raw)) !== null) {
            if (match[1].toLowerCase() !== match[3].toLowerCase()) continue;

            result += raw.slice(lastIndex, match.index);

            const thinkText = match[2].trim();
            if (thinkText) {
                if (thinkingContent) thinkingContent += '\n\n---\n\n';
                thinkingContent += thinkText;
            }

            lastIndex = match.index + match[0].length;
        }

        result += raw.slice(lastIndex);
    }

    return {
        visible: result.trim(),
        thinking: thinkingContent.trim(),
    };
}

function getPreviewTextElement() {
    return document.getElementById('sp-preview-textarea');
}

function setPreviewText(value) {
    const el = getPreviewTextElement();
    if (!el) return;
    el.textContent = value || '';
    el.classList.toggle('sp-preview-text-empty', !el.textContent);
}

function appendPreviewText(value) {
    const el = getPreviewTextElement();
    if (!el || !value) return;
    el.textContent += value;
    el.classList.toggle('sp-preview-text-empty', !el.textContent);
}

export function setPreviewTextReadonly(readonly) {
    const el = getPreviewTextElement();
    if (!el) return;
    el.contentEditable = readonly ? 'false' : 'true';
}

export function getPreviewTextValue() {
    return (getPreviewTextElement()?.textContent ?? '');
}

function scrollPreviewBodyToEnd() {
    const body = document.getElementById('sp-preview-body');
    if (!body) return;
    body.scrollTop = body.scrollHeight;
}

export function collapsePreviewThinking() {
    const det = document.getElementById('sp-thinking-details');
    if (det) det.open = false;
    requestAnimationFrame(scrollPreviewBodyToEnd);
}

export function resetPreviewThinkingUI({ clearText = true } = {}) {
    previewStreamText = '';
    previewStreamThinking = '';
    previewPendingText = '';
    previewPendingThinking = '';
    previewRawCarry = '';
    previewStreamInThinking = false;
    if (previewFlushRaf) cancelAnimationFrame(previewFlushRaf);
    if (previewScrollRaf) cancelAnimationFrame(previewScrollRaf);
    previewFlushRaf = 0;
    previewScrollRaf = 0;

    const panel = document.getElementById('sp-preview-thinking-panel');
    const pre = document.getElementById('sp-thinking-pre');
    const det = document.getElementById('sp-thinking-details');

    if (panel) panel.style.display = 'none';
    if (pre) pre.textContent = '';
    if (det) det.open = false;
    if (clearText) setPreviewText('');
}

function flushPreviewStreamToDom() {
    previewFlushRaf = 0;

    const hasNewText = !!previewPendingText;
    const shouldScroll = !!(previewPendingText || previewPendingThinking);
    if (previewPendingText) appendPreviewText(previewPendingText);

    const panel = document.getElementById('sp-preview-thinking-panel');
    const pre = document.getElementById('sp-thinking-pre');
    const det = document.getElementById('sp-thinking-details');

    if (previewPendingThinking) {
        if (panel) panel.style.display = 'block';
        if (pre) pre.textContent += previewPendingThinking;
        if (det) det.open = true;
    }

    if (hasNewText && previewStreamThinking) collapsePreviewThinking();

    if (shouldScroll) {
        requestAnimationFrame(scrollPreviewBodyToEnd);
    }

    previewStreamText += previewPendingText;
    previewStreamThinking += previewPendingThinking;
    previewPendingText = '';
    previewPendingThinking = '';
}

function schedulePreviewStreamFlush() {
    if (previewFlushRaf) return;
    previewFlushRaf = requestAnimationFrame(flushPreviewStreamToDom);
}

export function appendPreviewStreamDelta(content = '', reasoning = '') {
    if (content) {
        const parsed = consumeStreamingContentChunk(content);
        if (parsed.visible) previewPendingText += parsed.visible;
        if (parsed.thinking) previewPendingThinking += parsed.thinking;
    }
    if (reasoning) previewPendingThinking += reasoning;
    schedulePreviewStreamFlush();
}

function consumeStreamingContentChunk(chunk) {
    const combined = previewRawCarry + String(chunk || '');
    previewRawCarry = '';

    if (!combined) return { visible: '', thinking: '' };

    let visible = '';
    let thinking = '';
    const tagRegex = /<(\/?)((?:thinking)|(?:think))>/ig;
    let lastIndex = 0;
    let match;

    while ((match = tagRegex.exec(combined)) !== null) {
        const before = combined.slice(lastIndex, match.index);
        if (before) {
            if (previewStreamInThinking) thinking += before;
            else visible += before;
        }

        previewStreamInThinking = !match[1];
        lastIndex = match.index + match[0].length;
    }

    let tail = combined.slice(lastIndex);
    const lastLt = tail.lastIndexOf('<');
    if (lastLt >= 0 && tail.indexOf('>', lastLt) < 0) {
        previewRawCarry = tail.slice(lastLt);
        tail = tail.slice(0, lastLt);
    }

    if (tail) {
        if (previewStreamInThinking) thinking += tail;
        else visible += tail;
    }

    return { visible, thinking };
}

export function updatePreviewFromRaw(raw, reasoning = '') {
    const { visible, thinking } = extractVisibleAndThinking(raw, reasoning);
    previewStreamText = visible;
    previewStreamThinking = thinking;
    previewPendingText = '';
    previewPendingThinking = '';
    previewRawCarry = '';
    previewStreamInThinking = false;

    setPreviewText(visible);

    const panel = document.getElementById('sp-preview-thinking-panel');
    const pre = document.getElementById('sp-thinking-pre');
    const det = document.getElementById('sp-thinking-details');

    if (thinking) {
        if (panel) panel.style.display = 'block';
        if (pre) pre.textContent = thinking;
        if (det) det.open = true;
    } else {
        resetPreviewThinkingUI({ clearText: false });
    }
    requestAnimationFrame(scrollPreviewBodyToEnd);
}

export function getPreviewSummaryTextToSave() {
    return getPreviewTextValue().trim();
}
