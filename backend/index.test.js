const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const {
    AppError,
    TARGET_LANGUAGES,
    buildTranscript,
    createApp,
    extractResponseText,
    normalizeLanguage,
    summarySchema
} = require('./index');

const servers = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function startTestServer(overrides = {}) {
    const app = createApp({
        authenticate: async (token) => {
            if (token !== 'test-token') throw new AppError(401, 'INVALID_TOKEN', 'Invalid token.');
            return { uid: 'user-1', email: 'tester@example.com', name: 'Tester' };
        },
        licenseCheck: async () => ({ valid: true, plan: 'test', daysRemaining: null }),
        ...overrides
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    return 'http://127.0.0.1:' + port;
}

test('response text extraction supports raw Responses API output', () => {
    const text = extractResponseText({
        output: [{ content: [{ type: 'output_text', text: '정리된 회의록' }] }]
    });
    assert.equal(text, '정리된 회의록');
});

test('language normalization accepts locale codes and rejects unsupported output', () => {
    assert.equal(normalizeLanguage('ko-KR', TARGET_LANGUAGES, 'en'), 'ko');
    assert.throws(
        () => normalizeLanguage('xx-ZZ', TARGET_LANGUAGES, 'en'),
        (error) => error.code === 'UNSUPPORTED_LANGUAGE'
    );
});

test('transcript builder keeps source and translated text', () => {
    const transcript = buildTranscript([
        { time: '00:10', source: 'Good morning', translated: '좋은 아침입니다' }
    ]);
    assert.match(transcript, /Good morning/);
    assert.match(transcript, /좋은 아침입니다/);
});

test('summary schema is strict at every object boundary', () => {
    const schema = summarySchema();
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.action_items.items.additionalProperties, false);
    assert.equal(schema.properties.presentation_outline.items.additionalProperties, false);
});

test('realtime session returns only a short-lived client secret', async () => {
    const requests = [];
    const baseUrl = await startTestServer({
        openAIRequest: async (pathname, body) => {
            requests.push({ pathname, body });
            return { value: 'ephemeral-secret', expires_at: 1234, internal: 'not-forwarded' };
        }
    });

    const response = await fetch(baseUrl + '/realtime/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: 'ko' })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.client_secret, 'ephemeral-secret');
    assert.equal(payload.internal, undefined);
    assert.equal(requests[0].pathname, '/realtime/translations/client_secrets');
    assert.equal(requests[0].body.session.audio.output.language, 'ko');
});

test('realtime session accepts nested client secret responses', async () => {
    const baseUrl = await startTestServer({
        openAIRequest: async () => ({
            client_secret: { value: 'nested-ephemeral-secret', expires_at: 5678 }
        })
    });

    const response = await fetch(baseUrl + '/realtime/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: 'en' })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.client_secret, 'nested-ephemeral-secret');
    assert.equal(payload.expires_at, 5678);
});

test('summary endpoint rejects empty transcripts before calling the model', async () => {
    let called = false;
    const baseUrl = await startTestServer({
        openAIRequest: async () => {
            called = true;
            return {};
        }
    });

    const response = await fetch(baseUrl + '/summaries', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: [] })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'EMPTY_TRANSCRIPT');
    assert.equal(called, false);
});

test('summary endpoint returns parsed structured notes', async () => {
    const structured = {
        title: 'OLED Review',
        executive_summary: '핵심 결과 검토',
        key_points: ['수명 개선'],
        decisions: ['추가 실험'],
        action_items: [{ owner: null, task: 'DOE 실행', due: null }],
        open_questions: [],
        presentation_outline: [{ section: '결과', summary: '수명 개선 결과' }],
        keywords: ['OLED']
    };
    const baseUrl = await startTestServer({
        openAIRequest: async () => ({
            output: [{ content: [{ type: 'output_text', text: JSON.stringify(structured) }] }]
        })
    });

    const response = await fetch(baseUrl + '/summaries', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode: 'meeting',
            outputLanguage: 'ko',
            entries: [{ time: '00:01', source: 'Run another DOE.', translated: '추가 DOE를 진행합니다.' }]
        })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.summary, structured);
});
