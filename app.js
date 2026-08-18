const CONFIG = window.CONFERENCE_HELPER_CONFIG;
const STORAGE_KEY = 'conference-copilot-session-v2';
const REALTIME_CALL_URL = 'https://api.openai.com/v1/realtime/translations/calls';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const AUTO_LANGUAGE = { code: 'auto', locale: navigator.language || 'en-US', label: '자동 감지' };

const LANGUAGES = [
    { code: 'de', locale: 'de-DE', label: 'Deutsch' },
    { code: 'en', locale: 'en-US', label: 'English' },
    { code: 'es', locale: 'es-ES', label: 'Español' },
    { code: 'fr', locale: 'fr-FR', label: 'Français' },
    { code: 'id', locale: 'id-ID', label: 'Bahasa Indonesia' },
    { code: 'it', locale: 'it-IT', label: 'Italiano' },
    { code: 'ja', locale: 'ja-JP', label: '日本語' },
    { code: 'ko', locale: 'ko-KR', label: '한국어' },
    { code: 'pt', locale: 'pt-PT', label: 'Português' },
    { code: 'ru', locale: 'ru-RU', label: 'Русский' },
    { code: 'th', locale: 'th-TH', label: 'ไทย' },
    { code: 'vi', locale: 'vi-VN', label: 'Tiếng Việt' },
    { code: 'zh', locale: 'zh-CN', label: '中文' }
];

const elements = Object.fromEntries([
    'accountBadge', 'audioLevel', 'audioSource', 'clearTranscriptButton', 'elapsedTime',
    'engineBadge', 'engineMetric', 'exportSummaryButton', 'exportTranscriptButton',
    'generateSummaryButton', 'glossary', 'loginButton', 'loginModal', 'microphoneSelect',
    'pauseAudioButton', 'saveMetric', 'segmentMetric', 'sessionHeading', 'sessionState',
    'sessionStateText', 'sessionTitle', 'signOutButton', 'sourceCaption',
    'sourceCaptionLabel', 'sourceLanguage', 'startButton', 'stopButton', 'summaryContent',
    'summaryPanelTitle', 'targetLanguage', 'toast', 'transcriptList', 'translatedAudio',
    'translatedCaption', 'translatedCaptionLabel', 'translatedVolume',
    'translatedVolumeValue'
].map((id) => [id, document.getElementById(id)]));

const state = {
    auth: null,
    currentSegment: { source: '', translated: '', startedAt: 0 },
    dataChannel: null,
    elapsedTimer: null,
    engine: 'idle',
    flushTimer: null,
    meterAnimation: null,
    meterContext: null,
    mode: 'meeting',
    peerConnection: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    recognition: null,
    recognitionRestarts: 0,
    running: false,
    segments: [],
    sessionStartedAt: 0,
    sourceStream: null,
    stopping: false,
    summary: null,
    translatedAudioMuted: false,
    translationQueue: Promise.resolve(),
    user: null
};

class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function languageByCode(code) {
    if (code === 'auto') return AUTO_LANGUAGE;
    return LANGUAGES.find((language) => language.code === code) || AUTO_LANGUAGE;
}

function showToast(message, type = 'info') {
    elements.toast.textContent = message;
    elements.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        elements.toast.className = 'toast';
    }, 3600);
}

function setSessionState(status, text) {
    elements.sessionState.dataset.state = status;
    elements.sessionStateText.textContent = text;
}

function setEngine(engine, label) {
    state.engine = engine;
    elements.engineBadge.textContent = label.toUpperCase();
    elements.engineMetric.textContent = label;
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatClock(date = new Date()) {
    return date.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function safeFilename(value) {
    return String(value || 'conference-session')
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'conference-session';
}

function downloadText(filename, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function requestId() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

async function api(path, { method = 'GET', body, timeoutMs = 45000 } = {}) {
    if (!state.user) throw new ApiError(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
    const token = await state.user.getIdToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(CONFIG.backendUrl + path, {
            method,
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
                'X-Request-Id': requestId()
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') throw new ApiError(504, 'TIMEOUT', '요청 시간이 초과됐습니다.');
        throw new ApiError(0, 'NETWORK_ERROR', '서버에 연결할 수 없습니다.');
    } finally {
        clearTimeout(timer);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new ApiError(
            response.status,
            payload?.error?.code || 'API_ERROR',
            payload?.error?.message || '요청을 처리하지 못했습니다.'
        );
    }
    return payload;
}

function populateLanguages() {
    const autoOption = document.createElement('option');
    autoOption.value = AUTO_LANGUAGE.code;
    autoOption.textContent = AUTO_LANGUAGE.label;
    elements.sourceLanguage.append(autoOption);
    for (const language of LANGUAGES) {
        const sourceOption = document.createElement('option');
        sourceOption.value = language.code;
        sourceOption.textContent = language.label;
        elements.sourceLanguage.append(sourceOption);

        const targetOption = sourceOption.cloneNode(true);
        elements.targetLanguage.append(targetOption);
    }
    elements.sourceLanguage.value = 'auto';
    elements.targetLanguage.value = 'ko';
}

async function refreshMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const microphones = devices.filter((device) => device.kind === 'audioinput');
        const previous = elements.microphoneSelect.value;
        elements.microphoneSelect.replaceChildren();
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '기본 마이크';
        elements.microphoneSelect.append(defaultOption);
        microphones.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || '마이크 ' + (index + 1);
            elements.microphoneSelect.append(option);
        });
        if ([...elements.microphoneSelect.options].some((option) => option.value === previous)) {
            elements.microphoneSelect.value = previous;
        }
    } catch (error) {
        console.warn('Microphone enumeration failed', error);
    }
}

function settingsSnapshot() {
    return {
        title: elements.sessionTitle.value.trim(),
        mode: state.mode,
        sourceLanguage: elements.sourceLanguage.value,
        targetLanguage: elements.targetLanguage.value,
        glossary: elements.glossary.value.trim()
    };
}

function persistSession() {
    const payload = {
        version: 2,
        settings: settingsSnapshot(),
        segments: state.segments.slice(-500),
        summary: state.summary,
        savedAt: new Date().toISOString()
    };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        elements.saveMetric.textContent = '저장됨';
    } catch (error) {
        console.warn('Session persistence failed', error);
        elements.saveMetric.textContent = '저장 실패';
    }
}

function restoreSession() {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!stored || stored.version !== 2) return;
        const settings = stored.settings || {};
        elements.sessionTitle.value = settings.title || '';
        elements.sourceLanguage.value = settings.sourceLanguage || 'auto';
        elements.targetLanguage.value = settings.targetLanguage || 'ko';
        elements.glossary.value = settings.glossary || '';
        state.mode = settings.mode === 'presentation' ? 'presentation' : 'meeting';
        state.segments = Array.isArray(stored.segments) ? stored.segments.slice(-500) : [];
        state.summary = stored.summary || null;
        syncModeControls();
        renderTranscript();
        if (state.summary) renderSummary(state.summary);
    } catch (error) {
        console.warn('Stored session could not be restored', error);
        localStorage.removeItem(STORAGE_KEY);
    }
}

function updateSessionLabels() {
    const source = languageByCode(elements.sourceLanguage.value);
    const target = languageByCode(elements.targetLanguage.value);
    elements.sourceCaptionLabel.textContent = '원문 · ' + source.label;
    elements.translatedCaptionLabel.textContent = '통역 · ' + target.label;
    const title = elements.sessionTitle.value.trim();
    elements.sessionHeading.textContent = title || '새 컨퍼런스 세션';
}

function syncModeControls() {
    document.querySelectorAll('.mode-option').forEach((button) => {
        button.classList.toggle('active', button.dataset.mode === state.mode);
    });
    const meeting = state.mode === 'meeting';
    elements.summaryPanelTitle.textContent = meeting ? '회의록' : '발표 요약';
    elements.generateSummaryButton.textContent = meeting ? 'AI 회의록 생성' : 'AI 발표 요약';
}

function setControlsRunning(running) {
    elements.startButton.hidden = running;
    elements.stopButton.hidden = !running;
    elements.pauseAudioButton.disabled = !running || state.engine !== 'realtime';
    for (const control of [
        elements.audioSource,
        elements.microphoneSelect,
        elements.sourceLanguage,
        elements.targetLanguage
    ]) {
        control.disabled = running;
    }
    document.querySelectorAll('.mode-option').forEach((button) => {
        button.disabled = running;
    });
}

async function captureSourceStream() {
    if (!navigator.mediaDevices) {
        throw new Error('이 브라우저는 오디오 캡처를 지원하지 않습니다.');
    }

    if (elements.audioSource.value === 'tab') {
        if (!navigator.mediaDevices.getDisplayMedia) {
            throw new Error('브라우저 탭 음원 캡처를 지원하지 않습니다.');
        }
        const audio = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        };
        const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
        if (supported.suppressLocalAudioPlayback) audio.suppressLocalAudioPlayback = true;
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio });
        if (!stream.getAudioTracks().length) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error('공유 창에서 탭을 선택하고 “탭 오디오 공유”를 켜세요.');
        }
        stream.getTracks().forEach((track) => {
            track.addEventListener('ended', () => {
                if (state.running) stopSession();
            }, { once: true });
        });
        return stream;
    }

    const deviceId = elements.microphoneSelect.value;
    const audio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

function startAudioMeter(stream) {
    stopAudioMeter();
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const context = new AudioContextClass();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        const source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        const samples = new Uint8Array(analyser.frequencyBinCount);
        state.meterContext = context;

        const draw = () => {
            if (!state.running) return;
            analyser.getByteFrequencyData(samples);
            const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            elements.audioLevel.style.width = Math.min(100, average * 1.45) + '%';
            state.meterAnimation = requestAnimationFrame(draw);
        };
        draw();
    } catch (error) {
        console.warn('Audio meter unavailable', error);
    }
}

function stopAudioMeter() {
    if (state.meterAnimation) cancelAnimationFrame(state.meterAnimation);
    if (state.meterContext) state.meterContext.close().catch(() => {});
    state.meterAnimation = null;
    state.meterContext = null;
    elements.audioLevel.style.width = '0%';
}

function beginElapsedTimer() {
    clearInterval(state.elapsedTimer);
    state.sessionStartedAt = Date.now();
    elements.elapsedTime.textContent = '00:00:00';
    state.elapsedTimer = setInterval(() => {
        elements.elapsedTime.textContent = formatDuration(Date.now() - state.sessionStartedAt);
    }, 1000);
}

function appendRealtimeDelta(kind, delta) {
    if (!delta || (!state.running && !state.stopping)) return;
    if (!state.currentSegment.startedAt) state.currentSegment.startedAt = Date.now();
    state.currentSegment[kind] += delta;

    if (kind === 'source') {
        elements.sourceCaption.textContent = state.currentSegment.source.trim() || '…';
    } else {
        elements.translatedCaption.textContent = state.currentSegment.translated.trim() || '…';
    }

    clearTimeout(state.flushTimer);
    const hasPair = state.currentSegment.source.trim() && state.currentSegment.translated.trim();
    state.flushTimer = setTimeout(() => flushCurrentSegment(), hasPair ? 1700 : 3200);
}

function flushCurrentSegment({ force = false } = {}) {
    clearTimeout(state.flushTimer);
    const source = state.currentSegment.source.trim();
    const translated = state.currentSegment.translated.trim();
    if (!source && !translated) return;
    if (!force && (!source || !translated)) {
        state.flushTimer = setTimeout(() => flushCurrentSegment({ force: true }), 1600);
        return;
    }
    addSegment({
        source,
        translated,
        time: formatClock(new Date(state.currentSegment.startedAt || Date.now())),
        elapsed: formatDuration((state.currentSegment.startedAt || Date.now()) - state.sessionStartedAt),
        engine: state.engine
    });
    state.currentSegment = { source: '', translated: '', startedAt: 0 };
}

function addSegment(segment) {
    if (!segment.source && !segment.translated) return;
    const previous = state.segments[state.segments.length - 1];
    if (previous && previous.source === segment.source && previous.translated === segment.translated) return;
    state.segments.push({
        id: requestId(),
        source: segment.source || '',
        translated: segment.translated || '',
        time: segment.time || formatClock(),
        elapsed: segment.elapsed || '00:00:00',
        engine: segment.engine || state.engine
    });
    if (state.segments.length > 500) state.segments.shift();
    state.summary = null;
    renderTranscript();
    resetSummaryPlaceholder();
    persistSession();
}

function handleRealtimeEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'session.output_transcript.delta') {
        appendRealtimeDelta('translated', event.delta);
    } else if (event.type === 'session.input_transcript.delta') {
        appendRealtimeDelta('source', event.delta);
    } else if (event.type === 'error') {
        const message = event.error?.message || '실시간 통역 오류가 발생했습니다.';
        showToast(message, 'error');
    } else if (event.type === 'session.closed' && state.running) {
        scheduleRealtimeReconnect();
    }
}

async function connectRealtime(stream) {
    const session = await api('/realtime/session', {
        method: 'POST',
        body: { targetLanguage: elements.targetLanguage.value },
        timeoutMs: 30000
    });

    if (!session.client_secret) throw new Error('실시간 세션 키가 없습니다.');
    state.peerConnection?.close();
    const peerConnection = new RTCPeerConnection();
    state.peerConnection = peerConnection;
    const events = peerConnection.createDataChannel('oai-events');
    state.dataChannel = events;

    stream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
    });

    peerConnection.ontrack = ({ streams }) => {
        const [translatedStream] = streams;
        if (!translatedStream) return;
        elements.translatedAudio.srcObject = translatedStream;
        elements.translatedAudio.volume = Number(elements.translatedVolume.value);
        elements.translatedAudio.muted = state.translatedAudioMuted;
        elements.translatedAudio.play().catch(() => {
            showToast('통역 음성을 들으려면 “번역 음성” 버튼을 한 번 눌러주세요.');
        });
    };

    events.onmessage = ({ data }) => {
        try {
            handleRealtimeEvent(JSON.parse(data));
        } catch (error) {
            console.warn('Invalid realtime event', error);
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (!state.running || peerConnection !== state.peerConnection) return;
        if (peerConnection.connectionState === 'connected') {
            state.reconnectAttempts = 0;
            setSessionState('live', '실시간 통역 중');
        } else if (peerConnection.connectionState === 'disconnected') {
            setSessionState('connecting', '연결 복구 중');
            scheduleRealtimeReconnect();
        } else if (peerConnection.connectionState === 'failed') {
            scheduleRealtimeReconnect(true);
        }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
        response = await fetch(REALTIME_CALL_URL, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + session.client_secret,
                'Content-Type': 'application/sdp'
            },
            body: offer.sdp,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
    if (!response.ok) {
        const details = await response.text();
        throw new Error('Realtime WebRTC 연결 실패: ' + details.slice(0, 180));
    }
    await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: await response.text()
    });
}

function scheduleRealtimeReconnect(immediate = false) {
    if (!state.running || state.engine !== 'realtime' || state.reconnectTimer) return;
    if (state.reconnectAttempts >= 2) {
        showToast('실시간 연결을 복구하지 못했습니다. 세션을 다시 시작하세요.', 'error');
        stopSession();
        return;
    }
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(async () => {
        state.reconnectTimer = null;
        try {
            await connectRealtime(state.sourceStream);
        } catch (error) {
            console.error(error);
            scheduleRealtimeReconnect();
        }
    }, immediate ? 200 : 1400 * state.reconnectAttempts);
}

function recentTranslationContext() {
    return state.segments.slice(-4)
        .map((segment) => segment.source + ' → ' + segment.translated)
        .join('\n');
}

async function translateFallbackText(text) {
    const cleanText = text.trim();
    if (!cleanText || !state.running) return;
    elements.sourceCaption.textContent = cleanText;
    elements.translatedCaption.textContent = '번역 중…';
    try {
        const result = await api('/translate', {
            method: 'POST',
            body: {
                text: cleanText,
                sourceLang: elements.sourceLanguage.value,
                targetLang: elements.targetLanguage.value,
                glossary: elements.glossary.value.trim(),
                context: recentTranslationContext()
            },
            timeoutMs: 30000
        });
        elements.translatedCaption.textContent = result.translatedText;
        addSegment({
            source: cleanText,
            translated: result.translatedText,
            time: formatClock(),
            elapsed: formatDuration(Date.now() - state.sessionStartedAt),
            engine: result.engine || 'fallback'
        });
    } catch (error) {
        elements.translatedCaption.textContent = '번역 실패';
        showToast(error.message, 'error');
        addSegment({
            source: cleanText,
            translated: '',
            time: formatClock(),
            elapsed: formatDuration(Date.now() - state.sessionStartedAt),
            engine: 'fallback-error'
        });
    }
}

function startBrowserFallback() {
    if (!SpeechRecognition) {
        throw new Error('실시간 API와 브라우저 음성인식을 모두 사용할 수 없습니다.');
    }
    const recognition = new SpeechRecognition();
    state.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.lang = languageByCode(elements.sourceLanguage.value).locale;

    recognition.onstart = () => {
        state.recognitionRestarts = 0;
        setSessionState('live', '폴백 통역 중');
    };

    recognition.onresult = (event) => {
        let interim = '';
        const finalParts = [];
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result.isFinal) finalParts.push(result[0].transcript);
            else interim += result[0].transcript;
        }
        if (interim.trim()) elements.sourceCaption.textContent = interim.trim();
        const finalText = finalParts.join(' ').trim();
        if (finalText) {
            state.translationQueue = state.translationQueue.then(() => translateFallbackText(finalText));
        }
    };

    recognition.onerror = (event) => {
        const terminal = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error);
        if (terminal) {
            showToast('마이크 권한 또는 오디오 입력을 확인하세요.', 'error');
            stopSession();
        } else if (event.error !== 'aborted') {
            console.warn('Speech recognition error', event.error);
        }
    };

    recognition.onend = () => {
        if (!state.running || state.engine !== 'browser-fallback') return;
        if (state.recognitionRestarts >= 6) {
            showToast('브라우저 음성인식이 반복 종료됐습니다. 세션을 다시 시작하세요.', 'error');
            stopSession();
            return;
        }
        state.recognitionRestarts += 1;
        setTimeout(() => {
            if (!state.running) return;
            try {
                recognition.start();
            } catch (error) {
                console.warn('Recognition restart failed', error);
            }
        }, Math.min(2500, 300 * state.recognitionRestarts));
    };

    recognition.start();
    setEngine('browser-fallback', '브라우저 STT + AI 번역');
}

async function startSession() {
    if (state.running) return;
    if (!state.user) {
        elements.loginModal.hidden = false;
        return;
    }

    updateSessionLabels();
    setSessionState('connecting', '오디오 연결 중');
    elements.startButton.disabled = true;
    state.running = true;
    state.reconnectAttempts = 0;
    setControlsRunning(true);
    beginElapsedTimer();
    elements.sourceCaption.textContent = '오디오 입력을 기다리는 중…';
    elements.translatedCaption.textContent = '통역 모델을 연결하는 중…';

    try {
        state.sourceStream = await captureSourceStream();
        await refreshMicrophones();
        startAudioMeter(state.sourceStream);
        setSessionState('connecting', 'AI 통역 연결 중');
        try {
            await connectRealtime(state.sourceStream);
            setEngine('realtime', 'Realtime 음성 통역');
            setControlsRunning(true);
            setSessionState('live', '실시간 통역 중');
            elements.pauseAudioButton.disabled = false;
            elements.sourceCaption.textContent = '발표자의 음성을 듣고 있습니다…';
            elements.translatedCaption.textContent = '첫 번역을 준비하고 있습니다…';
            showToast('실시간 음성 통역이 시작됐습니다.');
        } catch (error) {
            console.warn('Realtime unavailable; evaluating fallback', error);
            state.peerConnection?.close();
            state.peerConnection = null;
            if (error instanceof ApiError && [400, 401, 403, 429].includes(error.status)) {
                throw error;
            }
            if (elements.audioSource.value === 'tab') throw error;
            startBrowserFallback();
            elements.sourceCaption.textContent = '브라우저 음성인식으로 듣고 있습니다…';
            elements.translatedCaption.textContent = 'AI 텍스트 번역 폴백을 사용합니다.';
            showToast('Realtime 연결이 불가해 호환 모드로 전환했습니다.');
        }
    } catch (error) {
        console.error(error);
        showToast(error.message || '세션을 시작하지 못했습니다.', 'error');
        await stopSession({ silent: true });
        setSessionState('error', '시작 실패');
    } finally {
        elements.startButton.disabled = false;
    }
}

async function stopSession({ silent = false } = {}) {
    if (!state.running && !state.sourceStream && !state.peerConnection) return;
    state.stopping = true;
    state.running = false;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;

    if (state.recognition) {
        state.recognition.onend = null;
        try { state.recognition.stop(); } catch {}
        state.recognition = null;
    }

    if (state.sourceStream) {
        state.sourceStream.getTracks().forEach((track) => track.stop());
    }
    if (state.engine === 'realtime') {
        await new Promise((resolve) => setTimeout(resolve, 850));
    }
    flushCurrentSegment({ force: true });
    state.dataChannel?.close();
    state.peerConnection?.close();
    state.dataChannel = null;
    state.peerConnection = null;
    state.sourceStream = null;
    elements.translatedAudio.srcObject = null;
    stopAudioMeter();

    state.currentSegment = { source: '', translated: '', startedAt: 0 };
    state.stopping = false;
    setEngine('idle', '대기');
    setControlsRunning(false);
    setSessionState('idle', '세션 종료됨');
    elements.pauseAudioButton.textContent = '번역 음성 끄기';
    elements.sourceCaption.textContent = '세션이 종료되었습니다.';
    elements.translatedCaption.textContent = '기록을 확인하거나 AI 요약을 생성하세요.';
    persistSession();
    if (!silent) showToast('세션을 종료하고 기록을 저장했습니다.');
}

function renderTranscript() {
    elements.segmentMetric.textContent = state.segments.length + '개';
    if (!state.segments.length) {
        elements.transcriptList.className = 'transcript-list empty-state';
        elements.transcriptList.replaceChildren(
            createEmptyState('⌁', '아직 기록이 없습니다', '동시통역을 시작하면 원문과 번역이 시간순으로 쌓입니다.')
        );
        elements.exportTranscriptButton.disabled = true;
        return;
    }

    elements.exportTranscriptButton.disabled = false;
    elements.transcriptList.className = 'transcript-list';
    const fragment = document.createDocumentFragment();
    state.segments.forEach((segment) => {
        const entry = document.createElement('article');
        entry.className = 'transcript-entry';
        const time = document.createElement('time');
        time.className = 'transcript-time';
        time.textContent = segment.elapsed || segment.time;
        const body = document.createElement('div');
        body.className = 'transcript-body';
        const source = document.createElement('p');
        source.className = 'transcript-source';
        source.textContent = segment.source || '(원문 없음)';
        const translated = document.createElement('p');
        translated.className = 'transcript-translated';
        translated.textContent = segment.translated || '(번역 없음)';
        body.append(source, translated);
        entry.append(time, body);
        fragment.append(entry);
    });
    elements.transcriptList.replaceChildren(fragment);
    elements.transcriptList.scrollTop = elements.transcriptList.scrollHeight;
}

function createEmptyState(icon, title, description) {
    const wrapper = document.createDocumentFragment();
    const illustration = document.createElement('div');
    illustration.className = 'empty-illustration';
    illustration.textContent = icon;
    const strong = document.createElement('strong');
    strong.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = description;
    wrapper.append(illustration, strong, paragraph);
    return wrapper;
}

function resetSummaryPlaceholder() {
    elements.exportSummaryButton.disabled = true;
    elements.summaryContent.className = 'summary-content empty-state';
    elements.summaryContent.replaceChildren(
        createEmptyState(
            '✦',
            '기록을 구조화된 결과로',
            state.mode === 'meeting'
                ? '핵심 요약, 결정사항, 액션 아이템, 미해결 질문을 자동으로 정리합니다.'
                : '발표 흐름, 핵심 주장, 근거, 한계와 질문을 발표 브리프로 정리합니다.'
        )
    );
}

function createListSection(title, items, ordered = false) {
    if (!Array.isArray(items) || !items.length) return null;
    const section = document.createElement('section');
    section.className = 'summary-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement(ordered ? 'ol' : 'ul');
    items.forEach((item) => {
        const entry = document.createElement('li');
        entry.textContent = item;
        list.append(entry);
    });
    section.append(heading, list);
    return section;
}

function renderSummary(summary) {
    state.summary = summary;
    elements.summaryContent.className = 'summary-content';
    const fragment = document.createDocumentFragment();
    const title = document.createElement('h2');
    title.className = 'summary-title';
    title.textContent = summary.title || elements.sessionTitle.value || '세션 요약';
    const lead = document.createElement('p');
    lead.className = 'summary-lead';
    lead.textContent = summary.executive_summary || '';
    fragment.append(title, lead);

    for (const section of [
        createListSection('핵심 포인트', summary.key_points),
        createListSection('결정사항', summary.decisions),
        createListSection('미해결 질문', summary.open_questions)
    ]) {
        if (section) fragment.append(section);
    }

    if (Array.isArray(summary.action_items) && summary.action_items.length) {
        const section = document.createElement('section');
        section.className = 'summary-section';
        const heading = document.createElement('h3');
        heading.textContent = '액션 아이템';
        const list = document.createElement('div');
        list.className = 'action-list';
        summary.action_items.forEach((action) => {
            const row = document.createElement('div');
            row.className = 'action-item';
            const task = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = action.task;
            const owner = document.createElement('span');
            owner.textContent = action.owner ? '담당: ' + action.owner : '담당 미정';
            task.append(strong, owner);
            const due = document.createElement('span');
            due.textContent = action.due || '일정 미정';
            row.append(task, due);
            list.append(row);
        });
        section.append(heading, list);
        fragment.append(section);
    }

    if (Array.isArray(summary.presentation_outline) && summary.presentation_outline.length) {
        const outlineItems = summary.presentation_outline.map((item) => item.section + ' — ' + item.summary);
        const section = createListSection('발표 흐름', outlineItems, true);
        if (section) fragment.append(section);
    }

    if (Array.isArray(summary.keywords) && summary.keywords.length) {
        const section = document.createElement('section');
        section.className = 'summary-section';
        const heading = document.createElement('h3');
        heading.textContent = '키워드';
        const list = document.createElement('div');
        list.className = 'keyword-list';
        summary.keywords.forEach((keyword) => {
            const item = document.createElement('span');
            item.className = 'keyword';
            item.textContent = keyword;
            list.append(item);
        });
        section.append(heading, list);
        fragment.append(section);
    }

    elements.summaryContent.replaceChildren(fragment);
    elements.exportSummaryButton.disabled = false;
}

async function generateSummary() {
    flushCurrentSegment({ force: true });
    if (!state.segments.length) {
        showToast('요약할 통역 기록이 없습니다.', 'error');
        return;
    }
    elements.generateSummaryButton.disabled = true;
    elements.summaryContent.className = 'summary-content summary-loading';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('span');
    text.textContent = state.mode === 'meeting' ? '회의록을 구성하고 있습니다…' : '발표 흐름을 분석하고 있습니다…';
    elements.summaryContent.replaceChildren(spinner, text);

    try {
        const payload = await api('/summaries', {
            method: 'POST',
            body: {
                title: elements.sessionTitle.value.trim(),
                mode: state.mode,
                outputLanguage: elements.targetLanguage.value,
                glossary: elements.glossary.value.trim(),
                entries: state.segments
            },
            timeoutMs: 90000
        });
        renderSummary(payload.summary);
        persistSession();
        showToast(state.mode === 'meeting' ? 'AI 회의록을 완성했습니다.' : 'AI 발표 요약을 완성했습니다.');
    } catch (error) {
        resetSummaryPlaceholder();
        showToast(error.message, 'error');
    } finally {
        elements.generateSummaryButton.disabled = false;
    }
}

function transcriptMarkdown() {
    const settings = settingsSnapshot();
    const lines = [
        '# ' + (settings.title || 'Conference Copilot 기록'),
        '',
        '- 저장 시각: ' + new Date().toLocaleString('ko-KR'),
        '- 유형: ' + (settings.mode === 'meeting' ? '회의' : '발표'),
        '- 언어: ' + languageByCode(settings.sourceLanguage).label + ' → ' + languageByCode(settings.targetLanguage).label,
        '- 기록 수: ' + state.segments.length,
        '',
        '## 전체 기록',
        ''
    ];
    state.segments.forEach((segment) => {
        lines.push('### ' + (segment.elapsed || segment.time));
        lines.push('');
        lines.push('**원문**  ');
        lines.push(segment.source || '(없음)');
        lines.push('');
        lines.push('**통역**  ');
        lines.push(segment.translated || '(없음)');
        lines.push('');
    });
    return lines.join('\n');
}

function summaryMarkdown() {
    const summary = state.summary;
    if (!summary) return '';
    const lines = [
        '# ' + (summary.title || 'AI 세션 요약'),
        '',
        summary.executive_summary || '',
        '',
        '## 핵심 포인트',
        ...(summary.key_points || []).map((item) => '- ' + item),
        '',
        '## 결정사항',
        ...(summary.decisions || []).map((item) => '- ' + item),
        '',
        '## 액션 아이템',
        ...(summary.action_items || []).map((item) =>
            '- [ ] ' + item.task + ' · 담당: ' + (item.owner || '미정') + ' · 일정: ' + (item.due || '미정')
        ),
        '',
        '## 미해결 질문',
        ...(summary.open_questions || []).map((item) => '- ' + item),
        '',
        '## 발표 흐름',
        ...(summary.presentation_outline || []).map((item, index) =>
            (index + 1) + '. **' + item.section + '** — ' + item.summary
        ),
        '',
        '## 키워드',
        (summary.keywords || []).join(', '),
        '',
        '---',
        '',
        'Generated by Conference Copilot'
    ];
    return lines.join('\n');
}

function clearTranscript() {
    if (!state.segments.length) return;
    if (!window.confirm('현재 통역 기록과 AI 요약을 모두 삭제할까요?')) return;
    state.segments = [];
    state.summary = null;
    state.currentSegment = { source: '', translated: '', startedAt: 0 };
    localStorage.removeItem(STORAGE_KEY);
    renderTranscript();
    resetSummaryPlaceholder();
    showToast('세션 기록을 삭제했습니다.');
}

function toggleTranslatedAudio() {
    state.translatedAudioMuted = !state.translatedAudioMuted;
    elements.translatedAudio.muted = state.translatedAudioMuted;
    elements.pauseAudioButton.textContent = state.translatedAudioMuted ? '번역 음성 켜기' : '번역 음성 끄기';
}

async function loadAccount() {
    try {
        const profile = await api('/me');
        const license = profile.license;
        const label = license.plan === 'admin'
            ? '관리자'
            : license.plan === 'trial'
                ? '체험 ' + license.daysRemaining + '일'
                : license.plan;
        elements.accountBadge.textContent = profile.email + ' · ' + label;
        elements.startButton.disabled = !license.valid;
        if (!license.valid) showToast('체험 또는 라이선스가 만료됐습니다.', 'error');
    } catch (error) {
        elements.accountBadge.textContent = '계정 확인 실패';
        elements.startButton.disabled = true;
        showToast(error.message, 'error');
    }
}

function initializeAuth() {
    if (!CONFIG?.firebase || !window.firebase) {
        elements.loginModal.hidden = false;
        elements.loginButton.disabled = true;
        showToast('Firebase 설정을 확인하세요.', 'error');
        return;
    }
    if (!firebase.apps.length) firebase.initializeApp(CONFIG.firebase);
    state.auth = firebase.auth();
    state.auth.onAuthStateChanged(async (user) => {
        state.user = user;
        elements.loginModal.hidden = Boolean(user);
        elements.signOutButton.hidden = !user;
        elements.startButton.disabled = !user;
        if (user) {
            elements.accountBadge.textContent = user.email || '로그인됨';
            await loadAccount();
            await refreshMicrophones();
        } else {
            elements.accountBadge.textContent = '로그인 필요';
            if (state.running) await stopSession({ silent: true });
        }
    });
}

function bindEvents() {
    elements.startButton.addEventListener('click', startSession);
    elements.stopButton.addEventListener('click', () => stopSession());
    elements.pauseAudioButton.addEventListener('click', toggleTranslatedAudio);
    elements.translatedVolume.addEventListener('input', () => {
        const volume = Number(elements.translatedVolume.value);
        elements.translatedAudio.volume = volume;
        elements.translatedVolumeValue.textContent = Math.round(volume * 100) + '%';
    });
    elements.sessionTitle.addEventListener('input', () => {
        updateSessionLabels();
        persistSession();
    });
    elements.glossary.addEventListener('change', persistSession);
    elements.sourceLanguage.addEventListener('change', () => {
        updateSessionLabels();
        persistSession();
    });
    elements.targetLanguage.addEventListener('change', () => {
        updateSessionLabels();
        persistSession();
    });
    elements.audioSource.addEventListener('change', () => {
        elements.microphoneSelect.disabled = elements.audioSource.value !== 'microphone';
    });
    document.querySelectorAll('.mode-option').forEach((button) => {
        button.addEventListener('click', () => {
            state.mode = button.dataset.mode;
            state.summary = null;
            syncModeControls();
            resetSummaryPlaceholder();
            persistSession();
        });
    });
    elements.generateSummaryButton.addEventListener('click', generateSummary);
    elements.exportTranscriptButton.addEventListener('click', () => {
        const name = safeFilename(elements.sessionTitle.value);
        downloadText(name + '-transcript.md', transcriptMarkdown());
    });
    elements.exportSummaryButton.addEventListener('click', () => {
        if (!state.summary) return;
        const name = safeFilename(state.summary.title || elements.sessionTitle.value);
        downloadText(name + '-summary.md', summaryMarkdown());
    });
    elements.clearTranscriptButton.addEventListener('click', clearTranscript);
    elements.loginButton.addEventListener('click', async () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        try {
            await state.auth.signInWithPopup(provider);
        } catch (error) {
            if (error.code === 'auth/popup-blocked') {
                await state.auth.signInWithRedirect(provider);
                return;
            }
            showToast('로그인 실패: ' + error.message, 'error');
        }
    });
    elements.signOutButton.addEventListener('click', async () => {
        await stopSession({ silent: true });
        await state.auth.signOut();
    });
    window.addEventListener('beforeunload', () => {
        state.sourceStream?.getTracks().forEach((track) => track.stop());
        state.peerConnection?.close();
    });
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        registration.update();
    } catch (error) {
        console.warn('Service worker registration failed', error);
    }
}

function initialize() {
    populateLanguages();
    restoreSession();
    updateSessionLabels();
    syncModeControls();
    bindEvents();
    initializeAuth();
    registerServiceWorker();
}

initialize();
