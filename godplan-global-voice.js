(function () {
    'use strict';

    if (window.__godPlanGlobalVoiceInstalled) return;
    window.__godPlanGlobalVoiceInstalled = true;

    const PREFERENCE_KEY = 'godplan_global_voice_enabled_v1';
    const AUTO_ENABLE_KEY = 'godplan_global_voice_auto_enabled_v2';
    const COMMAND_IDLE_TIMEOUT_MS = 12000;
    const CONTINUATION_IDLE_TIMEOUT_MS = 10000;
    const ACTIVE_SPEECH_IDLE_TIMEOUT_MS = 8000;
    const RECOGNITION_START_TIMEOUT_MS = 10000;
    const RECOGNITION_RETRY_BASE_MS = 350;
    const RECOGNITION_RETRY_MAX_MS = 5000;
    const MAX_RECOGNITION_FAILURES = 3;
    const SPEECH_WATCHDOG_MIN_MS = 2500;
    const SPEECH_WATCHDOG_MAX_MS = 15000;
    const state = {
        enabled: false,
        recognition: null,
        restartTimer: 0,
        recognitionStartTimer: 0,
        followupTimer: 0,
        interimTimer: 0,
        overlayTimer: 0,
        speechTimer: 0,
        speechToken: 0,
        awaitingCommand: false,
        speaking: false,
        voiceRequestPending: false,
        lastTranscript: '',
        lastTranscriptAt: 0,
        lastWakeAt: 0,
        lastExecutedCommand: '',
        lastExecutedAt: 0,
        commandFinalSegments: [],
        commandInterim: '',
        dictationStartedAt: 0,
        lastDisplayedCommand: '',
        lastRecognitionConfidence: 1,
        restartDelay: 0,
        wakeFragment: '',
        wakeFragmentAt: 0,
        openOnRecognitionStart: false,
        requestExecutionMode: 'direct',
        listeningTimeoutMs: COMMAND_IDLE_TIMEOUT_MS,
        recognitionFailureCount: 0,
        lastRecognitionError: ''
    };

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function collapseRepeatedPhrases(value) {
        const words = normalizeText(value).split(' ').filter(Boolean);
        if (words.length < 2) return words.join(' ');

        let changed = true;
        while (changed) {
            changed = false;
            const maxPhraseLength = Math.min(8, Math.floor(words.length / 2));
            for (let phraseLength = maxPhraseLength; phraseLength >= 1 && !changed; phraseLength -= 1) {
                for (let start = 0; start + phraseLength * 2 <= words.length; start += 1) {
                    const left = words.slice(start, start + phraseLength).join('\u0000');
                    const right = words.slice(start + phraseLength, start + phraseLength * 2).join('\u0000');
                    if (left !== right) continue;
                    words.splice(start + phraseLength, phraseLength);
                    changed = true;
                    break;
                }
            }
        }
        return words.join(' ');
    }

    function transcriptOverlapWordCount(existing, incoming) {
        const left = collapseRepeatedPhrases(existing).split(' ').filter(Boolean);
        const right = collapseRepeatedPhrases(incoming).split(' ').filter(Boolean);
        const maximum = Math.min(left.length, right.length);
        for (let size = maximum; size > 0; size -= 1) {
            if (left.slice(-size).join('\u0000') === right.slice(0, size).join('\u0000')) return size;
        }
        return 0;
    }

    function mergeTranscriptText(existing, incoming) {
        const left = collapseRepeatedPhrases(existing);
        const right = collapseRepeatedPhrases(incoming);
        if (!left) return right;
        if (!right) return left;
        if (left === right || left.includes(right)) return left;
        if (right.includes(left)) return right;

        const leftWords = left.split(' ');
        const rightWords = right.split(' ');
        const overlap = transcriptOverlapWordCount(left, right);
        if (overlap > 0) return collapseRepeatedPhrases([...leftWords, ...rightWords.slice(overlap)].join(' '));

        const compactLeft = left.replace(/\s/g, '');
        const compactRight = right.replace(/\s/g, '');
        const maxCharacters = Math.min(compactLeft.length, compactRight.length, 24);
        for (let size = maxCharacters; size >= 2; size -= 1) {
            if (compactLeft.slice(-size) === compactRight.slice(0, size)) {
                const suffix = compactRight.slice(size);
                return collapseRepeatedPhrases(normalizeText(`${left} ${suffix}`));
            }
        }
        return collapseRepeatedPhrases(`${left} ${right}`);
    }

    function selectBestRecognitionCandidate(result) {
        const confirmed = state.commandFinalSegments.join(' ');
        const candidates = Array.from(result || []).map((alternative, index) => {
            const text = collapseRepeatedPhrases(alternative?.transcript || '');
            const confidence = Number.isFinite(alternative?.confidence) ? alternative.confidence : 0;
            const sensitive = confidence === 0 || confidence < 0.55;
            const wake = findWakePhrase(text, sensitive);
            let score = confidence * 100 - index;
            if (!state.awaitingCommand && wake.matched) score += 1000 + (wake.confidence || 0) * 100;
            if (state.awaitingCommand) {
                score += transcriptOverlapWordCount(confirmed, wake.matched ? wake.command : text) * 18;
                score += Math.min(24, mergeTranscriptText(confirmed, wake.matched ? wake.command : text).length - confirmed.length);
            }
            score -= Math.max(0, normalizeText(alternative?.transcript).length - text.length) * 0.4;
            return { text, score, confidence, sensitive };
        }).filter((candidate) => candidate.text);
        candidates.sort((left, right) => right.score - left.score);
        const selected = candidates[0];
        state.lastRecognitionConfidence = selected?.confidence ?? 1;
        return selected?.text || '';
    }

    function findWakePhrase(value, sensitive = state.lastRecognitionConfidence === 0 || state.lastRecognitionConfidence < 0.55) {
        if (!window.GodPlanWakePhrase) return { matched: false, command: '', confidence: 0 };
        return window.GodPlanWakePhrase.matchWakePhrase(value, { sensitive });
    }

    function findWakePhraseAcrossFragments(value) {
        const transcript = normalizeText(value);
        const direct = findWakePhrase(transcript);
        if (direct.matched) {
            state.wakeFragment = '';
            state.wakeFragmentAt = 0;
            return direct;
        }
        const now = Date.now();
        if (state.wakeFragment && now - state.wakeFragmentAt <= 2000) {
            const combined = findWakePhrase(`${state.wakeFragment} ${transcript}`, true);
            if (combined.matched) {
                state.wakeFragment = '';
                state.wakeFragmentAt = 0;
                return combined;
            }
        }
        if (/^(?:헤이|해이|에이|헤|해|에|갓플|갇플|갓풀|갓블)$/u.test(transcript.replace(/\s+/g, ''))) {
            state.wakeFragment = transcript;
            state.wakeFragmentAt = now;
        }
        return direct;
    }

    function classifyVoiceRequest(value) {
        const text = normalizeText(value);
        const highRisk = /(?:결제|구매|주문|송금|이체|서명|계약\s*(?:체결|서명)|대량\s*(?:발송|전송)|외부\s*(?:발송|제출)|계정\s*(?:삭제|해지)|(?:파일|자료|일정)\s*(?:전체|모두)?\s*(?:삭제|지워))|(?:전체|모두)\s*(?:삭제|지워|없애)/u.test(text);
        const broadScope = /(?:전체|전부|모두|처음부터\s*끝까지|완벽하게|통째로|다\s*(?:해|처리|세팅|맡아)|종합적으로)/u.test(text);
        const structuralWork = /(?:전략|기획|로드맵|프로젝트|출장|여행|행사|런칭|창업|리팩터링|마이그레이션|감사|법률\s*검토|투자\s*검토)/u.test(text);
        const actionCount = (text.match(/(?:하고|해서|한\s*뒤|그다음|그리고|동시에|까지|부터)/gu) || []).length;
        const complex = (broadScope && structuralWork) || actionCount >= 2;
        return {
            mode: highRisk || complex ? 'proposal_first' : 'direct',
            reason: highRisk ? 'high_risk' : complex ? 'complex_request' : 'lightweight'
        };
    }

    function createInterface() {
        document.getElementById('omni-voice-trigger')?.setAttribute('hidden', '');
        const presence = document.createElement('button');
        presence.id = 'godplan-global-voice-presence';
        presence.type = 'button';
        presence.dataset.state = 'off';
        presence.setAttribute('aria-label', '헤이 갓플 음성 호출 켜기');
        presence.setAttribute('aria-pressed', 'false');
        presence.innerHTML = '<span class="godplan-presence-core" aria-hidden="true"><i></i></span><span class="godplan-presence-label">HEY</span>';

        const overlay = document.createElement('section');
        overlay.id = 'godplan-wake-overlay';
        overlay.hidden = true;
        overlay.dataset.phase = 'listening';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'assertive');
        overlay.innerHTML = `
            <div class="godplan-wake-backdrop"></div>
            <div class="godplan-wake-card">
                <div class="godplan-wake-visual" aria-hidden="true">
                    <span class="godplan-wake-ring ring-one"></span>
                    <span class="godplan-wake-ring ring-two"></span>
                    <span class="godplan-wake-orb"></span>
                </div>
                <div class="godplan-wake-copy">
                    <span class="godplan-wake-kicker">GODPLAN IS HERE</span>
                    <strong id="godplan-wake-title">듣고 있어요</strong>
                    <p id="godplan-wake-transcript">무엇을 도와드릴까요?</p>
                </div>
            </div>
        `;
        document.body.append(presence, overlay);
        presence.addEventListener('click', () => {
            if (!state.enabled) {
                state.openOnRecognitionStart = true;
                toggleVoiceRuntime();
                return;
            }
            activateWake();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !overlay.hidden) cancelListeningSession({ silent: true });
        });
        return { presence, overlay };
    }

    function setPresence(phase, label) {
        const presence = document.getElementById('godplan-global-voice-presence');
        if (!presence) return;
        presence.dataset.state = phase;
        presence.setAttribute('aria-pressed', String(state.enabled));
        presence.setAttribute('aria-label', label);
        presence.title = label;
    }

    function showOverlay(phase, title, transcript, options = {}) {
        const overlay = document.getElementById('godplan-wake-overlay');
        if (!overlay) return;
        const phaseTitles = {
            listening: '듣고 있어요',
            processing: '요청을 구분하고 있어요',
            answer: '요청을 처리했어요',
            connecting: '헤이 갓플을 준비하고 있어요',
            error: '다시 확인이 필요해요',
            off: '음성 호출을 껐어요'
        };
        window.clearTimeout(state.overlayTimer);
        overlay.hidden = false;
        overlay.dataset.phase = phase;
        const titleElement = document.getElementById('godplan-wake-title');
        const transcriptElement = document.getElementById('godplan-wake-transcript');
        if (titleElement) titleElement.textContent = normalizeText(title) || phaseTitles[phase] || '헤이 갓플';
        if (transcriptElement) {
            const visibleTranscript = normalizeText(transcript);
            transcriptElement.textContent = visibleTranscript;
            transcriptElement.hidden = !visibleTranscript;
        }
        if (options.hideAfter) state.overlayTimer = window.setTimeout(hideOverlay, options.hideAfter);
    }

    function hideOverlay() {
        window.clearTimeout(state.overlayTimer);
        state.overlayTimer = 0;
        const overlay = document.getElementById('godplan-wake-overlay');
        if (overlay) overlay.hidden = true;
    }

    function stopRecognition(options = {}) {
        window.clearTimeout(state.restartTimer);
        window.clearTimeout(state.recognitionStartTimer);
        state.restartTimer = 0;
        state.recognitionStartTimer = 0;
        const recognition = state.recognition;
        state.recognition = null;
        if (!options.preserveEnabled) state.enabled = false;
        if (recognition) {
            recognition.onstart = null;
            recognition.onspeechstart = null;
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try { recognition.abort(); } catch {
                try { recognition.stop(); } catch {}
            }
        }
    }

    function chooseKoreanVoice() {
        const voices = window.speechSynthesis?.getVoices().filter((voice) => /^ko(?:-|_)/i.test(voice.lang)) || [];
        const score = (voice) => {
            const name = voice.name.toLowerCase();
            let value = 0;
            if (/(natural|neural|premium|enhanced)/.test(name)) value += 100;
            if (/(sunhi|yuna|heami|선희|유나|한국의)/.test(name)) value += 45;
            if (/(microsoft|google|apple)/.test(name)) value += 25;
            if (!voice.localService) value += 8;
            return value;
        };
        return voices.sort((left, right) => score(right) - score(left))[0] || null;
    }

    function resumeAfterSpeech(options = {}) {
        state.speaking = false;
        if (!options.keepAwaiting) state.awaitingCommand = false;
        if (state.awaitingCommand) armFollowupTimeout(state.listeningTimeoutMs);
        if (state.enabled && options.resume !== false) restartRecognition(0);
        setPresence(
            state.awaitingCommand ? 'listening' : state.enabled ? 'ready' : 'off',
            state.awaitingCommand ? '헤이 갓플이 듣고 있습니다' : state.enabled ? '헤이 갓플 호출 대기 중' : '헤이 갓플 음성 호출 켜기'
        );
    }

    function stopSpeech() {
        window.clearTimeout(state.speechTimer);
        state.speechTimer = 0;
        state.speechToken += 1;
        state.speaking = false;
        try { window.speechSynthesis?.cancel(); } catch {}
    }

    function speak(text, options = {}) {
        const message = normalizeText(text).slice(0, 320);
        if (!message || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance === 'undefined') {
            resumeAfterSpeech(options);
            return;
        }
        stopSpeech();
        stopRecognition({ preserveEnabled: true });
        window.clearTimeout(state.followupTimer);
        state.speaking = true;
        setPresence('speaking', '헤이 갓플이 응답하고 있습니다');
        const speechToken = ++state.speechToken;
        const utterance = new window.SpeechSynthesisUtterance(message);
        utterance.lang = 'ko-KR';
        utterance.rate = options.rate || 1;
        utterance.pitch = options.pitch || 0.96;
        utterance.volume = 1;
        utterance.voice = chooseKoreanVoice();
        let completed = false;
        const finish = () => {
            if (completed || speechToken !== state.speechToken) return;
            completed = true;
            window.clearTimeout(state.speechTimer);
            state.speechTimer = 0;
            resumeAfterSpeech(options);
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        const estimatedDuration = Math.round(message.length * 90 / Math.max(0.75, utterance.rate)) + 1800;
        const watchdogDelay = Math.min(SPEECH_WATCHDOG_MAX_MS, Math.max(SPEECH_WATCHDOG_MIN_MS, estimatedDuration));
        state.speechTimer = window.setTimeout(finish, watchdogDelay);
        try {
            window.speechSynthesis.resume?.();
            window.speechSynthesis.speak(utterance);
        } catch {
            finish();
        }
    }

    function resetCommandBuffer() {
        window.clearTimeout(state.interimTimer);
        state.commandFinalSegments = [];
        state.commandInterim = '';
        state.dictationStartedAt = 0;
        state.lastDisplayedCommand = '';
    }

    function getBufferedCommand() {
        const confirmed = state.commandFinalSegments.join(' ');
        return mergeTranscriptText(confirmed, state.commandInterim);
    }

    function cancelListeningSession(options = {}) {
        window.clearTimeout(state.followupTimer);
        window.clearTimeout(state.interimTimer);
        state.followupTimer = 0;
        state.interimTimer = 0;
        if (options.stopSpeaking !== false && state.speaking) stopSpeech();
        state.awaitingCommand = false;
        resetCommandBuffer();
        if (options.silent) hideOverlay();
        setPresence(state.enabled ? 'ready' : 'off', state.enabled ? '헤이 갓플 호출 대기 중' : '헤이 갓플 음성 호출 켜기');
        if (state.enabled && !state.recognition && document.visibilityState === 'visible') restartRecognition(0);
    }

    function recoverListeningTimeout() {
        if (!state.awaitingCommand) return;
        const bufferedCommand = getBufferedCommand();
        if (bufferedCommand) {
            executeVoiceCommand(bufferedCommand);
            return;
        }
        cancelListeningSession({ silent: true, stopSpeaking: false });
        showOverlay('error', '음성을 듣지 못했어요', '작은 HEY 버튼을 누르고 다시 말씀해 주세요.', { hideAfter: 3600 });
    }

    function armFollowupTimeout(delay = COMMAND_IDLE_TIMEOUT_MS) {
        window.clearTimeout(state.followupTimer);
        if (!state.awaitingCommand) return;
        state.followupTimer = window.setTimeout(recoverListeningTimeout, delay);
    }

    function playWakeTone() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        try {
            const context = new AudioContext();
            const gain = context.createGain();
            gain.gain.setValueAtTime(0.0001, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.24);
            gain.connect(context.destination);
            [660, 880].forEach((frequency, index) => {
                const oscillator = context.createOscillator();
                oscillator.type = 'sine';
                oscillator.frequency.value = frequency;
                oscillator.connect(gain);
                oscillator.start(context.currentTime + index * 0.035);
                oscillator.stop(context.currentTime + 0.25);
            });
            window.setTimeout(() => void context.close(), 400);
        } catch {}
    }

    function beginCommandSession() {
        resetCommandBuffer();
        state.awaitingCommand = true;
        state.dictationStartedAt = Date.now();
        state.listeningTimeoutMs = COMMAND_IDLE_TIMEOUT_MS;
        armFollowupTimeout(state.listeningTimeoutMs);
        setPresence('listening', '헤이 갓플이 긴 요청을 듣고 있습니다');
    }

    function beginContinuationSession() {
        resetCommandBuffer();
        state.awaitingCommand = true;
        state.dictationStartedAt = Date.now();
        state.listeningTimeoutMs = CONTINUATION_IDLE_TIMEOUT_MS;
        armFollowupTimeout(state.listeningTimeoutMs);
        setPresence('listening', '헤이 갓플이 후속 요청을 기다리고 있습니다');
    }

    function activateWake() {
        const now = Date.now();
        if (now - state.lastWakeAt < 1400) return;
        state.lastWakeAt = now;
        beginCommandSession();
        showOverlay('listening', '듣고 있어요', '무엇을 도와드릴까요?');
        playWakeTone();
        speak('네.', { keepAwaiting: true, rate: 1.02, pitch: 0.98 });
    }

    function updateCommandBuffer(command, isFinal) {
        const normalized = collapseRepeatedPhrases(command);
        if (!normalized || !state.awaitingCommand) return;
        window.clearTimeout(state.interimTimer);
        if (isFinal) {
            const confirmed = state.commandFinalSegments.join(' ');
            state.commandFinalSegments = [mergeTranscriptText(confirmed, normalized)].filter(Boolean);
            state.commandInterim = '';
        } else {
            state.commandInterim = normalized;
        }
        const bufferedCommand = getBufferedCommand();
        if (bufferedCommand !== state.lastDisplayedCommand) {
            state.lastDisplayedCommand = bufferedCommand;
            showOverlay('listening', isFinal ? '잠시 멈추면 바로 처리할게요' : '계속 듣고 있어요', bufferedCommand.slice(-500));
        }
        setPresence('listening', `헤이 갓플이 요청을 듣고 있습니다 · ${bufferedCommand.length}자`);
        armFollowupTimeout(ACTIVE_SPEECH_IDLE_TIMEOUT_MS);

        const elapsed = Date.now() - state.dictationStartedAt;
        if (elapsed >= 120000) {
            executeVoiceCommand(bufferedCommand);
            return;
        }
        if (!isFinal) return;
        const soundsComplete = /(?:해줘|해주세요|알려줘|알려주세요|정리해줘|부탁해|이상)[.!?]?$/u.test(bufferedCommand);
        state.interimTimer = window.setTimeout(
            () => executeVoiceCommand(getBufferedCommand()),
            soundsComplete ? 800 : 3200
        );
    }

    async function executeVoiceCommand(command) {
        const normalizedCommand = collapseRepeatedPhrases(command)
            .replace(/^\s*(?:음+|어+|저기|그러니까|있잖아|내\s*말은|부탁인데)[,\s]*/u, '')
            .trim();
        const now = Date.now();
        if (!normalizedCommand) {
            recoverListeningTimeout();
            return;
        }
        if (normalizedCommand === state.lastExecutedCommand && now - state.lastExecutedAt < 3500) {
            cancelListeningSession({ silent: true });
            showOverlay('answer', '이미 처리하고 있어요', normalizedCommand, { hideAfter: 2600 });
            return;
        }
        state.lastExecutedCommand = normalizedCommand;
        state.lastExecutedAt = now;
        const requestPolicy = classifyVoiceRequest(normalizedCommand);
        state.requestExecutionMode = requestPolicy.mode;
        const lightweightExecutor = window.executeGodPlanLightweightRequest;
        if (requestPolicy.mode === 'direct' && typeof lightweightExecutor === 'function') {
            window.clearTimeout(state.followupTimer);
            window.clearTimeout(state.interimTimer);
            state.awaitingCommand = false;
            resetCommandBuffer();
            state.voiceRequestPending = false;
            showOverlay('processing', '요청을 처리하고 있어요', '');
            setPresence('processing', '헤이 갓플이 요청을 처리하고 있습니다');
            stopRecognition({ preserveEnabled: true });
            try {
                const lightweightResult = await lightweightExecutor(normalizedCommand);
                if (lightweightResult?.handled) {
                    const reply = normalizeText(lightweightResult.reply || '요청을 처리했습니다.');
                    showOverlay('answer', '요청을 처리했어요', '', { hideAfter: 2400 });
                    beginContinuationSession();
                    speak(reply, { keepAwaiting: true });
                    return;
                }
            } catch {}
        }
        const input = document.getElementById('agent-request');
        const submit = document.getElementById('generate-agent');
        if (!input || !submit) {
            showOverlay('error', '연결할 수 없어요', 'AI 비서 입력 기능을 찾지 못했습니다.', { hideAfter: 5000 });
            speak('AI 비서 입력 기능을 찾지 못했어요.');
            return;
        }
        window.clearTimeout(state.followupTimer);
        window.clearTimeout(state.interimTimer);
        state.awaitingCommand = false;
        resetCommandBuffer();
        state.voiceRequestPending = true;
        input.value = normalizedCommand;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        showOverlay(
            'processing',
            requestPolicy.mode === 'proposal_first' ? '안전한 실행안을 준비할게요' : '바로 확인할게요',
            normalizedCommand
        );
        setPresence('processing', '헤이 갓플이 요청을 처리하고 있습니다');
        stopRecognition({ preserveEnabled: true });
        window.setTimeout(() => {
            if (state.voiceRequestPending) showOverlay('processing', '요청을 처리하고 있어요', '');
        }, 450);
        window.setTimeout(() => submit.click(), 20);
    }

    function handleTranscript(value, isFinal = true) {
        const transcript = normalizeText(value);
        const now = Date.now();
        if (!transcript || transcript === state.lastTranscript && isFinal && now - state.lastTranscriptAt < 1500) return;
        if (!isFinal) {
            if (state.awaitingCommand) {
                const wake = findWakePhrase(transcript);
                updateCommandBuffer(wake.matched ? wake.command : transcript, false);
                return;
            }
            const wake = findWakePhraseAcrossFragments(transcript);
            if (!wake.matched) return;
            if (wake.command) {
                beginCommandSession();
                updateCommandBuffer(wake.command, false);
            } else {
                activateWake();
            }
            return;
        }
        window.clearTimeout(state.interimTimer);
        state.lastTranscript = transcript;
        state.lastTranscriptAt = now;
        if (state.awaitingCommand) {
            const wake = findWakePhrase(transcript);
            const command = wake.matched ? wake.command : transcript;
            if (command) updateCommandBuffer(command, true);
            return;
        }

        const wake = findWakePhraseAcrossFragments(transcript);
        if (!wake.matched) return;
        if (wake.command) {
            beginCommandSession();
            updateCommandBuffer(wake.command, true);
            return;
        }
        activateWake();
    }

    function disableVoiceRuntimeWithError(title, message, options = {}) {
        state.enabled = false;
        state.openOnRecognitionStart = false;
        localStorage.setItem(PREFERENCE_KEY, 'false');
        stopRecognition({ preserveEnabled: true });
        stopSpeech();
        window.clearTimeout(state.followupTimer);
        window.clearTimeout(state.interimTimer);
        state.awaitingCommand = false;
        resetCommandBuffer();
        setPresence(options.unsupported ? 'unsupported' : 'error', message);
        showOverlay('error', title, message, { hideAfter: options.hideAfter || 6500 });
    }

    function markTransientRecognitionFailure(error) {
        state.lastRecognitionError = error || 'unknown';
        state.recognitionFailureCount += 1;
        state.restartDelay = Math.min(
            RECOGNITION_RETRY_MAX_MS,
            RECOGNITION_RETRY_BASE_MS * (2 ** Math.max(0, state.recognitionFailureCount - 1))
        );
        if (state.recognitionFailureCount >= MAX_RECOGNITION_FAILURES) {
            disableVoiceRuntimeWithError(
                '음성 연결을 멈췄어요',
                '마이크 상태를 확인한 뒤 작은 HEY 버튼을 눌러 다시 연결해 주세요.'
            );
            return false;
        }
        setPresence('error', '음성 인식을 다시 연결하고 있습니다');
        if (state.awaitingCommand) {
            showOverlay('connecting', '마이크를 다시 연결하고 있어요', '말씀하신 내용은 유지하고 있습니다.');
        }
        return true;
    }

    function createRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;
        const recognition = new SpeechRecognition();
        recognition.lang = 'ko-KR';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 10;
        recognition.onstart = () => {
            window.clearTimeout(state.recognitionStartTimer);
            state.recognitionStartTimer = 0;
            state.restartDelay = 0;
            setPresence(
                state.awaitingCommand ? 'listening' : 'ready',
                state.awaitingCommand ? '헤이 갓플이 긴 요청을 듣고 있습니다' : '헤이 갓플 호출 대기 중'
            );
            if (state.openOnRecognitionStart) {
                state.openOnRecognitionStart = false;
                window.setTimeout(activateWake, 0);
            }
        };
        recognition.onspeechstart = () => {
            state.restartDelay = 0;
            state.recognitionFailureCount = 0;
            state.lastRecognitionError = '';
            if (state.awaitingCommand) armFollowupTimeout(ACTIVE_SPEECH_IDLE_TIMEOUT_MS);
        };
        recognition.onresult = (event) => {
            state.restartDelay = 0;
            state.recognitionFailureCount = 0;
            state.lastRecognitionError = '';
            if (state.awaitingCommand) armFollowupTimeout(ACTIVE_SPEECH_IDLE_TIMEOUT_MS);
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                const best = selectBestRecognitionCandidate(result);
                handleTranscript(best, result.isFinal);
            }
        };
        recognition.onerror = (event) => {
            window.clearTimeout(state.recognitionStartTimer);
            state.recognitionStartTimer = 0;
            state.lastRecognitionError = event.error || 'unknown';
            if (event.error === 'no-speech') {
                state.restartDelay = 0;
                if (state.awaitingCommand) {
                    showOverlay('listening', '아직 듣고 있어요', getBufferedCommand() || '말씀을 기다리는 중입니다.');
                    armFollowupTimeout(Math.min(state.listeningTimeoutMs, 4000));
                }
                return;
            }
            if (event.error === 'aborted') return;
            if (['not-allowed', 'service-not-allowed'].includes(event.error)) {
                disableVoiceRuntimeWithError('마이크 권한이 필요해요', '브라우저 주소창에서 마이크 권한을 허용한 뒤 다시 눌러 주세요.');
            } else if (event.error === 'audio-capture') {
                disableVoiceRuntimeWithError('마이크를 사용할 수 없어요', '다른 앱의 마이크 사용을 끝내거나 입력 장치를 확인해 주세요.');
            } else if (event.error === 'language-not-supported') {
                disableVoiceRuntimeWithError('한국어 음성 인식을 지원하지 않아요', 'Chrome 또는 Edge의 최신 버전에서 다시 시도해 주세요.', { unsupported: true });
            } else {
                markTransientRecognitionFailure(event.error);
            }
        };
        recognition.onend = () => {
            window.clearTimeout(state.recognitionStartTimer);
            state.recognitionStartTimer = 0;
            if (state.recognition === recognition) state.recognition = null;
            if (state.enabled && !state.speaking && document.visibilityState === 'visible') restartRecognition(state.restartDelay);
        };
        return recognition;
    }

    function restartRecognition(delay = 0) {
        window.clearTimeout(state.restartTimer);
        if (!state.enabled || state.speaking || state.recognition || document.visibilityState !== 'visible') return;
        if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
            disableVoiceRuntimeWithError('음성 호출을 지원하지 않아요', 'Chrome 또는 Edge의 최신 버전을 사용해 주세요.', { unsupported: true });
            return;
        }
        state.restartTimer = window.setTimeout(() => {
            state.restartTimer = 0;
            if (!state.enabled || state.speaking || state.recognition || document.visibilityState !== 'visible') return;
            const recognition = createRecognition();
            if (!recognition) {
                disableVoiceRuntimeWithError('음성 호출을 지원하지 않아요', 'Chrome 또는 Edge의 최신 버전을 사용해 주세요.', { unsupported: true });
                return;
            }
            state.recognition = recognition;
            state.recognitionStartTimer = window.setTimeout(() => {
                if (state.recognition !== recognition) return;
                state.recognition = null;
                recognition.onstart = null;
                recognition.onspeechstart = null;
                recognition.onresult = null;
                recognition.onerror = null;
                recognition.onend = null;
                try { recognition.abort(); } catch {}
                if (markTransientRecognitionFailure('start-timeout')) restartRecognition(state.restartDelay);
            }, RECOGNITION_START_TIMEOUT_MS);
            try {
                recognition.start();
            } catch (error) {
                window.clearTimeout(state.recognitionStartTimer);
                state.recognitionStartTimer = 0;
                state.recognition = null;
                if (markTransientRecognitionFailure(error?.name || 'start-failed')) restartRecognition(state.restartDelay);
            }
        }, Math.max(0, Number(delay) || 0));
    }

    function toggleVoiceRuntime() {
        if (state.enabled) {
            stopRecognition();
            stopSpeech();
            window.clearTimeout(state.followupTimer);
            window.clearTimeout(state.interimTimer);
            state.awaitingCommand = false;
            resetCommandBuffer();
            localStorage.setItem(PREFERENCE_KEY, 'false');
            setPresence('off', '헤이 갓플 음성 호출 켜기');
            showOverlay('off', '음성 호출을 껐어요', '작은 표시를 누르면 다시 켤 수 있습니다.', { hideAfter: 3000 });
            return;
        }
        if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
            disableVoiceRuntimeWithError('음성 호출을 지원하지 않아요', 'Chrome 또는 Edge의 최신 버전을 사용해 주세요.', { unsupported: true });
            return;
        }
        state.enabled = true;
        state.recognitionFailureCount = 0;
        state.lastRecognitionError = '';
        localStorage.setItem(PREFERENCE_KEY, 'true');
        setPresence('connecting', '마이크 권한을 확인하고 있습니다');
        showOverlay('connecting', '헤이 갓플을 준비하고 있어요', '마이크 권한을 확인합니다.', { hideAfter: 4000 });
        restartRecognition(0);
    }

    function summarizeReply(payload) {
        const source = normalizeText(payload?.reply || payload?.summary || payload?.headline || '요청 처리가 완료되었습니다.');
        const sentences = source.match(/[^.!?。]+[.!?。]?/g) || [source];
        return sentences.slice(0, 2).join(' ').trim().slice(0, 220);
    }

    function wrapAssistantFetch() {
        if (window.__godPlanGlobalVoiceFetchWrapped) return;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
            const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const assistantRequest = /\/api\/(?:gemini-manage|assistant\/manage)(?:\?|$)/.test(requestUrl);
            if (assistantRequest && state.voiceRequestPending && typeof args[1]?.body === 'string') {
                try {
                    const requestPayload = JSON.parse(args[1].body);
                    args[1] = {
                        ...args[1],
                        body: JSON.stringify({
                            ...requestPayload,
                            voiceTurn: true,
                            interactionMode: 'voice',
                            responsePreference: 'concise_spoken',
                            intentExtractionMode: 'strict_explicit_requests',
                            executeOnlyExplicitRequests: true,
                            executionPolicy: state.requestExecutionMode,
                            proposalFirst: state.requestExecutionMode === 'proposal_first',
                            directExecutionAllowed: state.requestExecutionMode === 'direct'
                        })
                    };
                } catch {}
            }
            try {
                const response = await originalFetch(...args);
                if (assistantRequest && state.voiceRequestPending) {
                    void response.clone().json().then((payload) => {
                        state.voiceRequestPending = false;
                        const reply = summarizeReply(payload);
                        showOverlay('answer', '처리했어요', reply, { hideAfter: 9000 });
                        beginContinuationSession();
                        speak(reply, { keepAwaiting: true });
                    }).catch(() => {
                        state.voiceRequestPending = false;
                        showOverlay('error', '답변을 읽지 못했어요', '화면에서 결과를 확인해 주세요.', { hideAfter: 5000 });
                    });
                }
                return response;
            } catch (error) {
                if (assistantRequest && state.voiceRequestPending) {
                    state.voiceRequestPending = false;
                    showOverlay('error', '연결이 잠시 끊겼어요', '잠시 후 다시 불러 주세요.', { hideAfter: 5000 });
                    speak('연결이 잠시 끊겼어요. 잠시 후 다시 말씀해 주세요.');
                }
                throw error;
            }
        };
        window.__godPlanGlobalVoiceFetchWrapped = true;
    }

    function initialize() {
        if (document.getElementById('godplan-global-voice-presence')) return;
        createInterface();
        wrapAssistantFetch();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                stopRecognition({ preserveEnabled: true });
            } else if (state.enabled) {
                restartRecognition(0);
            }
        });
        const speechRecognitionSupported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
        localStorage.setItem(AUTO_ENABLE_KEY, 'done');
        state.enabled = speechRecognitionSupported;
        if (speechRecognitionSupported) {
            localStorage.setItem(PREFERENCE_KEY, 'true');
            setPresence('connecting', '헤이 갓플 음성 호출 연결 중');
            restartRecognition(0);
            window.addEventListener('load', () => {
                if (state.enabled) restartRecognition(0);
            }, { once: true });
            window.addEventListener('pageshow', () => {
                state.enabled = true;
                localStorage.setItem(PREFERENCE_KEY, 'true');
                restartRecognition(0);
            });
            window.addEventListener('focus', () => {
                if (state.enabled) restartRecognition(0);
            });
        } else {
            setPresence('unsupported', '이 브라우저는 헤이 갓플 음성 호출을 지원하지 않습니다');
        }
        window.godPlanGlobalVoice = {
            simulateTranscript: (text) => handleTranscript(text, true),
            matchWakePhrase: (text) => ({ ...findWakePhrase(text) }),
            collapseRepeatedPhrases,
            mergeTranscriptText,
            classifyVoiceRequest,
            enable: () => { if (!state.enabled) toggleVoiceRuntime(); },
            disable: () => { if (state.enabled) toggleVoiceRuntime(); },
            getState: () => ({
                enabled: state.enabled,
                awaitingCommand: state.awaitingCommand,
                speaking: state.speaking,
                voiceName: chooseKoreanVoice()?.name || ''
            })
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
})();
