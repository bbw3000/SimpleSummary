import { log } from './logger.js';
import { t } from './i18n.js';

export function formatErrorObject(error) {
    if (error == null) return 'Unknown error';
    if (typeof error !== 'object') return String(error);

    const parts = [];
    if (error.message) parts.push(String(error.message));
    if (error.title && error.title !== error.message) parts.push(String(error.title));
    if (error.detail && error.detail !== error.message) parts.push(String(error.detail));
    if (error.code && error.code !== error.message) parts.push(String(error.code));

    const raw = JSON.stringify(error);
    if (raw && raw !== '{}' && !parts.includes(raw)) parts.push(raw);

    return parts.filter(Boolean).join(' ');
}

export function formatHttpErrorMessage(resp, bodyText = '') {
    const statusText = resp.statusText ? ` ${resp.statusText}` : '';
    const prefix = `HTTP ${resp.status}${statusText}`;
    const text = String(bodyText || '').trim();
    return appendConsoleHint(text ? `${prefix}: ${text}` : prefix);
}

export function appendConsoleHint(message) {
    const text = String(message || 'Unknown error').trim();
    const hint = 'Please check the ST console for details.';
    return text.includes(hint) ? text : `${text}\n${hint}`;
}

export function parseJsonOrNull(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function postStBackendGenerate(body, headers, signal) {
    return await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });
}

export function normalizeBaseUrl(rawUrl, type = 'openai') {
    if (!rawUrl) return '';
    let url = rawUrl.trim();

    if (url.endsWith('#')) url = url.slice(0, -1);
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/(chat\/completions|completions|messages|models)$/, '');

    if (type !== 'google') {
        if (!/\/v1(\/?|$)/.test(url)) url += '/v1';
        url = url.replace(/(\/v1)\/.*$/, '$1');
    }

    return url;
}

function getReverseProxyUrl(rawUrl, type = 'openai') {
    if (!rawUrl) return '';

    if (type === 'google') {
        return String(rawUrl)
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/(chat\/completions|completions|messages|models|v1beta|v1)$/, '');
    }

    return normalizeBaseUrl(rawUrl, type);
}

function buildGenerateMessages(prompt) {
    if (prompt && typeof prompt === 'object') {
        return [
            { role: 'system', content: String(prompt.systemPrompt || 'You are an expert text summariser.') },
            { role: 'user', content: String(prompt.userPrompt || '') },
        ];
    }
    return [
        { role: 'system', content: 'You are an expert text summariser.' },
        { role: 'user', content: String(prompt || '') },
    ];
}

export function getApiTestPrompt() {
    return 'But right now i just need you reply with exactly: OK';
}

function normalizePartText(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
}

function extractGoogleCandidateText(candidate) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) return { content: '', reasoning: '' };

    let content = '', reasoning = '';
    for (const part of parts) {
        const text = normalizePartText(part);
        if (!text) continue;

        if (part?.thought || part?.isThought || part?.reasoning) {
            reasoning += text;
        } else {
            content += text;
        }
    }

    return { content, reasoning };
}

function extractGoogleResponseContent(data) {
    const responseContent = data?.responseContent;
    const parts = responseContent?.parts;
    if (!Array.isArray(parts)) return null;

    const { content, reasoning } = extractGoogleCandidateText({ content: { parts } });
    return { content, reasoning };
}

export function buildStBackendRequestBody(preset, messages, stream) {
    let chat_completion_source = 'openai';
    if (preset.type === 'anthropic') chat_completion_source = 'claude';
    else if (preset.type === 'google') chat_completion_source = 'makersuite';

    const isNativeProvider = preset.type === 'anthropic' || preset.type === 'google';
    const reverseProxy = isNativeProvider
        ? getReverseProxyUrl(preset.url, preset.type)
        : normalizeBaseUrl(preset.url, preset.type);

    const body = {
        chat_completion_source,
        proxy_password: preset.key,
        model: preset.model,
        stream,
        temperature: preset.temperature ?? 0.7,
        top_p: preset.top_p ?? 1.0,
        messages,
    };
    if (preset.en_maxtokens ?? false) body.max_completion_tokens = preset.max_completion_tokens ?? 4000;
    body.reverse_proxy = reverseProxy;
    if (preset.type === 'google') {
        body.include_reasoning = true;
    }
    if (preset.en_topk) body.top_k = preset.top_k ?? 50;
    if (preset.en_freqp) body.frequency_penalty = preset.freq_penalty ?? 0;
    if (preset.en_presp) body.presence_penalty = preset.pres_penalty ?? 0;
    return body;
}

function normalizePiece(c) {
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.map(p => {
        if (typeof p === 'string') return p;
        if (p?.text) return p.text;
        if (p?.type === 'text' && typeof p.text === 'string') return p.text;
        return '';
    }).join('');
}

function extractSseDeltaText(parsed) {
    if (!parsed || typeof parsed !== 'object') return { content: '', reasoning: '' };
    if (parsed.error) {
        const msg = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error);
        throw new Error(msg);
    }

    const googleResponseContent = extractGoogleResponseContent(parsed);
    if (googleResponseContent) return googleResponseContent;

    const googleCandidate = parsed.candidates?.[0];
    if (googleCandidate?.content?.parts) {
        return extractGoogleCandidateText(googleCandidate);
    }

    const ch = parsed.choices?.[0];
    if (!ch) {
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            return { content: String(parsed.delta.text), reasoning: '' };
        }
        return { content: '', reasoning: '' };
    }

    const d = ch.delta ?? ch.message;
    if (!d) return { content: '', reasoning: '' };

    let reasoning = '';
    if (d.reasoning_content) reasoning = String(d.reasoning_content);

    let c = d.content;
    if (c == null && d.delta?.content != null) c = d.delta.content;
    const content = normalizePiece(c) || (typeof ch.text === 'string' ? ch.text : '');

    return { content, reasoning };
}

function extractFinalMessageText(data) {
    if (!data || typeof data !== 'object') return { content: '', reasoning: '' };

    const googleResponseContent = extractGoogleResponseContent(data);
    if (googleResponseContent) return googleResponseContent;

    const googleCandidate = data.candidates?.[0];
    if (googleCandidate?.content?.parts) {
        return extractGoogleCandidateText(googleCandidate);
    }

    const msg = data.choices?.[0]?.message;
    let content = '';
    let reasoning = '';

    if (msg) {
        if (msg.reasoning_content) reasoning = String(msg.reasoning_content);
        if (msg.content != null) content = normalizePiece(msg.content);
    }

    if (!content) {
        const t = data.choices?.[0]?.text;
        if (typeof t === 'string') content = t;
        else if (data.content?.[0]?.text) content = String(data.content[0].text);
    }

    return { content, reasoning };
}

async function parseSseStream(resp, signal, onDelta) {
    const reader = resp.body?.getReader();
    if (!reader) throw new Error(t('llm.noStreamBody'));
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let fullReasoning = '';

    while (true) {
        if (signal?.aborted) {
            await reader.cancel().catch(() => {});
            throw new DOMException('Aborted', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
            const nl = buffer.indexOf('\n');
            if (nl < 0) break;
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const trimmed = line.replace(/\r$/, '').trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed.startsWith('data:')) {
                const payload = trimmed.slice(5).trimStart();
                if (payload === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(payload);
                    const { content, reasoning } = extractSseDeltaText(parsed);
                    if (content) fullContent += content;
                    if (reasoning) fullReasoning += reasoning;
                    if (onDelta && (content || reasoning)) {
                        onDelta({ content, reasoning, fullContent, fullReasoning });
                    }
                } catch (e) {
                    if (e instanceof SyntaxError) continue;
                    throw e;
                }
            }
        }
    }
    return { content: fullContent, reasoning: fullReasoning };
}

async function generateViaStBackend(getST, preset, prompt, { stream, signal, onDelta } = {}) {
    const body = buildStBackendRequestBody(preset, buildGenerateMessages(prompt), stream);
    const stHeaders = getST().getRequestHeaders?.() || { 'Content-Type': 'application/json' };

    log('── LLM Request (ST backend) ──');
    log('Stream:', stream, '| Model:', preset.model, '| URL norm:', normalizeBaseUrl(preset.url, preset.type));

    const resp = await postStBackendGenerate(body, stHeaders, signal);

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(formatHttpErrorMessage(resp, errText));
    }

    const ct = (resp.headers.get('content-type') || '').toLowerCase();

    if (!stream) {
        const rawText = await resp.text().catch(() => '');
        const data = parseJsonOrNull(rawText) || {};
        if (data?.error) {
            throw new Error(appendConsoleHint(rawText || formatErrorObject(data.error)));
        }
        const result = extractFinalMessageText(data);
        log('LLM json response - content:', result.content.length, 'reasoning:', result.reasoning.length);
        return result;
    }

    if (ct.includes('application/json')) {
        const rawText = await resp.text().catch(() => '');
        const data = parseJsonOrNull(rawText) || {};
        if (data?.error) {
            throw new Error(appendConsoleHint(rawText || formatErrorObject(data.error)));
        }
        const result = extractFinalMessageText(data);
        if (onDelta && (result.content || result.reasoning)) {
            onDelta({
                content: result.content,
                reasoning: result.reasoning,
                fullContent: result.content,
                fullReasoning: result.reasoning,
            });
        }
        log('LLM stream→single JSON - content:', result.content.length, 'reasoning:', result.reasoning.length);
        return result;
    }

    if (!resp.body) throw new Error(t('llm.noStreamResponseBody'));
    const result = await parseSseStream(resp, signal, onDelta);
    log('LLM SSE - content:', result.content.length, 'reasoning:', result.reasoning.length);
    return result;
}

export async function generateSummaryText(getST, preset, prompt, stream, signal, onDelta) {
    return await generateViaStBackend(getST, preset, prompt, { stream, signal, onDelta });
}

export function buildSummaryMessages(prompt) {
    return buildGenerateMessages(prompt);
}
