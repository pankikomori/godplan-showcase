(function () {
    'use strict';

    const ROLE_LABELS = {
        auto: '자동 판단',
        drafting_tool: '초안 작성자',
        reviewer: '검토자',
        brainstorming_partner: '브레인스토밍 파트너'
    };
    const AREA_LABELS = {
        information_research: '정보 수집·리서치',
        document_content_production: '문서·콘텐츠 생산',
        decision_support: '의사결정 보조',
        daily_personal_management: '일상·개인 관리',
        simulation_training: '시뮬레이션·훈련',
        counseling_support: '상담·관계 지원'
    };
    const STAGE_LABELS = {
        1: '단순 작업',
        2: '전문 문제 해결',
        3: '상담·역할극',
        4: '한계·철학적 추론'
    };
    const PROCESS_STEPS = ['요청 이해', '역할 선택', '전문 처리', '자체 검토'];
    const HANDOFF_PROMPTS = {
        drafting_tool: '이 답변을 바로 사용할 수 있는 완성된 초안으로 만들어줘.',
        reviewer: '방금 답변의 오류, 누락, 근거와 위험 요소를 다시 검토해줘.',
        brainstorming_partner: '이 답변을 바탕으로 다른 대안 3가지를 함께 찾아줘.'
    };

    let selectedRole = 'auto';
    let latestCapability = null;
    let latestEngine = '';
    let processTimer = null;
    let processIndex = 0;
    const VOICE_REMINDER_STORAGE_KEY = 'godplan_voice_reminders_v1';
    const voiceRuntime = {
        enabled: false,
        recognition: null,
        restartTimer: null,
        awaitingCommand: false,
        speaking: false,
        voiceRequestPending: false,
        pendingReminder: null,
        reminderTimers: new Map()
    };

    function createElement(tag, className, attributes = {}) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        Object.entries(attributes).forEach(([key, value]) => {
            if (key === 'text') element.textContent = value;
            else element.setAttribute(key, value);
        });
        return element;
    }

    function detectPreview(input) {
        const text = String(input || '').replace(/\s+/g, ' ').trim();
        let area = 'daily_personal_management';
        if (/(상사|동료|친구|가족|연인|인간관계|거절|갈등|커리어|진로|번아웃|힘들|위로|상담)/i.test(text)) area = 'counseling_support';
        else if (/(면접|역할극|회화|협상|설득|훈련|시뮬레이션)/i.test(text)) area = 'simulation_training';
        else if (/(논문|판례|법령|리서치|뉴스|시장\s*분석|자료\s*조사|요약|원리|개념)/i.test(text)) area = 'information_research';
        else if (/(이메일|기안서|보도자료|제안서|코드|버그|대본|콘텐츠|초안|작성)/i.test(text)) area = 'document_content_production';
        else if (/(데이터\s*분석|가설|시나리오|장단점|비교|위험|리스크|투자|주식|윤리|딜레마|ESG)/i.test(text)) area = 'decision_support';

        let stage = 1;
        if (/(로또|복권|주식\s*뭐\s*사|수익\s*보장|자아|consciousness|윤리적?\s*딜레마)/i.test(text)) stage = 4;
        else if (area === 'counseling_support' || /(역할극|번아웃|힘들|진로|거절)/i.test(text)) stage = 3;
        else if (/(ESG|공시|가이드라인|메모리\s*누수|리팩터링|대법원|판례\s*흐름|전문|아키텍처)/i.test(text)) stage = 2;

        let role = selectedRole;
        if (role === 'auto') {
            if (/(검토|리뷰|교정|검증|평가|분석|오류|버그|위험|비교)/i.test(text)) role = 'reviewer';
            else if (/(아이디어|브레인스토밍|대안|역할극|연습|시뮬레이션|상담)/i.test(text)) role = 'brainstorming_partner';
            else role = ['information_research', 'decision_support'].includes(area) ? 'reviewer' : 'drafting_tool';
        }
        return { area, stage, role, confidence: text ? 0.82 : 0 };
    }

    function normalizeWakeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function setVoiceState(phase, message, transcript = '') {
        const panel = document.getElementById('godplan-voice-runtime');
        if (!panel) return;
        panel.dataset.phase = phase;
        const status = panel.querySelector('#godplan-voice-status');
        const liveTranscript = panel.querySelector('#godplan-voice-transcript');
        if (status) status.textContent = message;
        if (liveTranscript && transcript) liveTranscript.textContent = transcript;
        document.body.dataset.voiceRuntime = phase;
    }

    function isWakePhrase(value) {
        return /(?:^|\s)갓\s*플(?:아|이야|,|\s|$)/i.test(normalizeWakeText(value));
    }

    function stripWakePhrase(value) {
        return normalizeWakeText(value)
            .replace(/^.*?갓\s*플(?:아|이야)?\s*[,，]?\s*/i, '')
            .trim();
    }

    function speakVoiceReply(text, options = {}) {
        const message = normalizeWakeText(text).slice(0, 360);
        if (!message || !('speechSynthesis' in window)) {
            if (options.resume !== false) restartWakeRecognition();
            return;
        }
        window.speechSynthesis.cancel();
        stopWakeRecognition({ preserveEnabled: true });
        voiceRuntime.speaking = true;
        setVoiceState('speaking', '갓플이 답하고 있습니다', message);
        const utterance = new SpeechSynthesisUtterance(message);
        utterance.lang = 'ko-KR';
        utterance.rate = 1.02;
        utterance.pitch = 0.92;
        const voices = window.speechSynthesis.getVoices();
        utterance.voice = voices.find((voice) => /^ko(?:-|_)/i.test(voice.lang)) || null;
        const finish = () => {
            voiceRuntime.speaking = false;
            if (!options.keepAwaiting) voiceRuntime.awaitingCommand = false;
            if (voiceRuntime.enabled && options.resume !== false) restartWakeRecognition();
            else setVoiceState(voiceRuntime.enabled ? 'waiting' : 'off', voiceRuntime.enabled ? '“갓플”이라고 부르면 듣습니다' : '음성 호출이 꺼져 있습니다');
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        window.speechSynthesis.speak(utterance);
    }

    function summarizeVoiceReply(payload) {
        const source = normalizeWakeText(payload?.reply || payload?.summary || payload?.headline || '요청 처리가 완료되었습니다.');
        if (source.length <= 280) return source;
        const sentences = source.match(/[^.!?。]+[.!?。]?/g) || [source];
        return sentences.slice(0, 2).join(' ').trim().slice(0, 280);
    }

    function cleanVoiceActionTitle(action) {
        const source = normalizeWakeText(action?.target?.matchedText || action?.title || '새 일정');
        return source
            .replace(/^.*?갓\s*플(?:아|이야)?\s*[,，]?\s*/i, '')
            .replace(/(오늘|내일|모레|다음\s*주|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/g, '')
            .replace(/(오전|오후|아침|저녁|밤)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/g, '')
            .replace(/(\d+|한|두)\s*(분|시간|일)\s*전(?:에)?/g, '')
            .replace(/(일정|약속)?\s*(추가|등록|만들어|잡아|해)(?:하고)?\s*/g, '')
            .replace(/(알려\s*줘|알림|리마인드|주세요|해줘)/g, '')
            .replace(/\s+/g, ' ').trim() || '새 일정';
    }

    function actionDayKey(action) {
        if (action?.timeRange?.day) return action.timeRange.day;
        if (!action?.timeRange?.date) return null;
        const day = new Date(`${action.timeRange.date}T12:00:00`).getDay();
        return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
    }

    async function applyVoicePlannerAction(action, button) {
        if (action.type !== 'create_task') return false;
        const dayButton = document.querySelector(`.day-button[data-day="${actionDayKey(action)}"]`);
        if (dayButton) dayButton.click();
        await new Promise((resolve) => window.setTimeout(resolve, 60));
        const input = document.getElementById('quick-task-input');
        const submit = document.getElementById('quick-task-submit');
        if (!input || !submit) return false;
        const startTime = action?.timeRange?.startTime;
        input.value = `${startTime ? `${startTime} ` : ''}${cleanVoiceActionTitle(action)}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        submit.click();
        button.textContent = '일정 반영 완료';
        button.disabled = true;
        button.closest('.godplan-voice-proposal-item')?.classList.add('is-applied');
        if (voiceRuntime.pendingReminder) await confirmPendingVoiceReminder();
        return true;
    }

    function renderVoicePlannerActions(payload) {
        const panel = document.getElementById('godplan-voice-runtime');
        if (!panel) return;
        panel.querySelector('.godplan-voice-proposals')?.remove();
        const actions = Array.isArray(payload?.godPlan?.actions) ? payload.godPlan.actions : [];
        if (!actions.length || payload?.godPlan?.routingDestination !== 'PLANNERS_CORE') return;
        const wrapper = createElement('div', 'godplan-voice-proposals', { 'aria-label': '음성 명령 실행안' });
        actions.forEach((action) => {
            const item = createElement('div', 'godplan-voice-proposal-item');
            const when = [action?.timeRange?.date, action?.timeRange?.startTime].filter(Boolean).join(' · ');
            const copy = createElement('div', 'godplan-voice-proposal-copy');
            copy.append(
                createElement('strong', '', { text: cleanVoiceActionTitle(action) }),
                createElement('span', '', { text: when || '시간 미지정 · 플래너에서 조정 가능' })
            );
            item.append(copy);
            if (action.type === 'create_task') {
                const apply = createElement('button', '', { type: 'button', text: action.requiresConfirmation ? '확인 후 일정 추가' : '일정에 반영' });
                apply.addEventListener('click', () => void applyVoicePlannerAction(action, apply));
                item.append(apply);
            }
            wrapper.append(item);
        });
        panel.append(wrapper);
    }

    function dateAtLocalTime(base, hours, minutes) {
        const value = new Date(base);
        value.setHours(hours, minutes, 0, 0);
        return value;
    }

    function parseVoiceReminder(text, now = new Date()) {
        const source = normalizeWakeText(text);
        if (!/(알려\s*줘|알림|리마인드)/i.test(source)) return null;
        const timeMatch = source.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
        if (!timeMatch) return null;
        let hours = Number(timeMatch[2]);
        const minutes = Number(timeMatch[3] || 0);
        const period = timeMatch[1] || '';
        if (/(오후|저녁|밤)/.test(period) && hours < 12) hours += 12;
        if (/(오전|아침)/.test(period) && hours === 12) hours = 0;
        if (hours > 23 || minutes > 59) return null;

        const eventDate = new Date(now);
        const explicitDate = source.match(/(?:(\d{4})[.\-/년]\s*)?(\d{1,2})[.\-/월]\s*(\d{1,2})(?:일)?/);
        if (explicitDate) {
            const year = Number(explicitDate[1] || now.getFullYear());
            eventDate.setFullYear(year, Number(explicitDate[2]) - 1, Number(explicitDate[3]));
            if (!explicitDate[1] && eventDate < now) eventDate.setFullYear(year + 1);
        } else if (/모레/.test(source)) {
            eventDate.setDate(eventDate.getDate() + 2);
        } else if (/내일/.test(source)) {
            eventDate.setDate(eventDate.getDate() + 1);
        } else if (!/오늘/.test(source)) {
            const weekdays = [['일요일', 0], ['월요일', 1], ['화요일', 2], ['수요일', 3], ['목요일', 4], ['금요일', 5], ['토요일', 6]];
            const matchedWeekday = weekdays.find(([label]) => source.includes(label));
            if (matchedWeekday) {
                let offset = (matchedWeekday[1] - now.getDay() + 7) % 7;
                if (/다음\s*주/.test(source)) offset += 7;
                if (offset === 0) offset = 7;
                eventDate.setDate(eventDate.getDate() + offset);
            }
        }

        const eventAt = dateAtLocalTime(eventDate, hours, minutes);
        if (eventAt <= now && /오늘/.test(source)) eventAt.setDate(eventAt.getDate() + 1);
        const leadMatch = source.match(/(\d+|한|두)\s*(분|시간|일)\s*전(?:에)?/);
        const leadValue = leadMatch?.[1] === '한' ? 1 : leadMatch?.[1] === '두' ? 2 : Number(leadMatch?.[1] || 0);
        const leadUnit = leadMatch?.[2] || '분';
        const leadMinutes = leadUnit === '일' ? leadValue * 1440 : leadUnit === '시간' ? leadValue * 60 : leadValue;
        const notifyAt = new Date(eventAt.getTime() - leadMinutes * 60000);
        if (notifyAt <= now) return null;
        const title = source
            .replace(/^.*?갓\s*플(?:아|이야)?\s*[,，]?\s*/i, '')
            .replace(/(오늘|내일|모레|다음\s*주|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/g, '')
            .replace(/(?:(\d{4})[.\-/년]\s*)?(\d{1,2})[.\-/월]\s*(\d{1,2})(?:일)?/g, '')
            .replace(/(오전|오후|아침|저녁|밤)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/g, '')
            .replace(/(\d+|한|두)\s*(분|시간|일)\s*전(?:에)?/g, '')
            .replace(/(일정|약속)?\s*(추가|등록|만들어|잡아|해)\s*(주|줘|주세요)?/g, '')
            .replace(/(알려\s*줘|알림|리마인드)/g, '')
            .replace(/\s+/g, ' ').trim() || '갓플 일정';
        return {
            id: `voice-reminder-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            title: title.slice(0, 80),
            eventAt: eventAt.toISOString(),
            notifyAt: notifyAt.toISOString(),
            createdAt: now.toISOString(),
            source: 'voice'
        };
    }

    function readVoiceReminders() {
        try {
            const value = JSON.parse(localStorage.getItem(VOICE_REMINDER_STORAGE_KEY) || '[]');
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    }

    function saveVoiceReminders(reminders) {
        localStorage.setItem(VOICE_REMINDER_STORAGE_KEY, JSON.stringify(reminders.slice(-100)));
        renderVoiceReminderSummary();
    }

    function showVoiceNotification(reminder) {
        const body = `${new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(reminder.eventAt))} 일정입니다.`;
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`갓플 · ${reminder.title}`, { body, tag: reminder.id, requireInteraction: true });
        }
        speakVoiceReply(`${reminder.title} 일정 알림입니다. ${body}`, { resume: false });
        const reminders = readVoiceReminders().filter((item) => item.id !== reminder.id);
        saveVoiceReminders(reminders);
    }

    function armVoiceReminder(reminder) {
        const delay = new Date(reminder.notifyAt).getTime() - Date.now();
        if (delay <= 0 || delay > 2147483647 || voiceRuntime.reminderTimers.has(reminder.id)) return;
        const timer = window.setTimeout(() => {
            voiceRuntime.reminderTimers.delete(reminder.id);
            showVoiceNotification(reminder);
        }, delay);
        voiceRuntime.reminderTimers.set(reminder.id, timer);
    }

    function restoreVoiceReminders() {
        const now = Date.now();
        const reminders = readVoiceReminders().filter((item) => new Date(item.eventAt).getTime() > now - 15 * 60000);
        saveVoiceReminders(reminders);
        reminders.forEach(armVoiceReminder);
    }

    function renderVoiceReminderSummary() {
        const summary = document.getElementById('godplan-voice-reminder-summary');
        if (!summary) return;
        const reminders = readVoiceReminders().filter((item) => new Date(item.notifyAt).getTime() > Date.now());
        summary.textContent = reminders.length ? `예약된 음성 알림 ${reminders.length}개` : '예약된 음성 알림 없음';
    }

    async function requestVoiceNotificationPermission() {
        const button = document.getElementById('godplan-voice-notification');
        if (!('Notification' in window)) {
            setVoiceState('error', '이 브라우저에서는 시스템 알림을 지원하지 않습니다');
            return false;
        }
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (button) button.textContent = permission === 'granted' ? '알림 허용됨' : '알림 허용';
        setVoiceState(permission === 'granted' ? 'waiting' : 'error', permission === 'granted' ? '일정 알림을 사용할 수 있습니다' : '알림 권한이 필요합니다');
        return permission === 'granted';
    }

    async function confirmPendingVoiceReminder() {
        const reminder = voiceRuntime.pendingReminder;
        if (!reminder) return;
        if ('Notification' in window && Notification.permission !== 'granted') {
            const granted = await requestVoiceNotificationPermission();
            if (!granted) return;
        }
        const reminders = readVoiceReminders();
        if (!reminders.some((item) => item.id === reminder.id)) reminders.push(reminder);
        saveVoiceReminders(reminders);
        armVoiceReminder(reminder);
        voiceRuntime.pendingReminder = null;
        const confirm = document.getElementById('godplan-voice-reminder-confirm');
        if (confirm) confirm.hidden = true;
        setVoiceState('waiting', `‘${reminder.title}’ 알림을 예약했습니다`);
        speakVoiceReply(`${reminder.title} 알림을 예약했습니다.`);
    }

    function presentPendingVoiceReminder(reminder) {
        voiceRuntime.pendingReminder = reminder;
        const confirm = document.getElementById('godplan-voice-reminder-confirm');
        if (!confirm) return;
        const formatted = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(reminder.notifyAt));
        confirm.textContent = `${formatted} 알림 예약`;
        confirm.hidden = false;
    }

    function executeVoiceCommand(command) {
        const input = document.getElementById('agent-request');
        const generate = document.getElementById('generate-agent');
        if (!input || !generate || !command) return;
        voiceRuntime.voiceRequestPending = true;
        voiceRuntime.pendingReminder = parseVoiceReminder(command);
        if (voiceRuntime.pendingReminder) presentPendingVoiceReminder(voiceRuntime.pendingReminder);
        input.value = command;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setVoiceState('processing', '요청을 이해하고 해결하고 있습니다', command);
        stopWakeRecognition({ preserveEnabled: true });
        window.setTimeout(() => generate.click(), 80);
    }

    function handleWakeTranscript(value, isFinal = true) {
        const transcript = normalizeWakeText(value);
        if (!transcript) return;
        setVoiceState(voiceRuntime.awaitingCommand ? 'listening' : 'waiting', voiceRuntime.awaitingCommand ? '말씀하세요. 듣고 있습니다' : '“갓플” 호출을 기다리고 있습니다', transcript);
        if (!isFinal) return;
        if (voiceRuntime.awaitingCommand) {
            const command = isWakePhrase(transcript) ? stripWakePhrase(transcript) : transcript;
            if (command) {
                voiceRuntime.awaitingCommand = false;
                executeVoiceCommand(command);
            }
            return;
        }
        if (!isWakePhrase(transcript)) return;
        const command = stripWakePhrase(transcript);
        if (command) {
            executeVoiceCommand(command);
        } else {
            voiceRuntime.awaitingCommand = true;
            speakVoiceReply('네, 듣고 있어요. 말씀하세요.', { keepAwaiting: true });
        }
    }

    function createWakeRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;
        const recognition = new SpeechRecognition();
        recognition.lang = 'ko-KR';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => setVoiceState('waiting', '“갓플”이라고 부르면 듣습니다');
        recognition.onresult = (event) => {
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                handleWakeTranscript(event.results[index][0]?.transcript || '', event.results[index].isFinal);
            }
        };
        recognition.onerror = (event) => {
            if (['not-allowed', 'service-not-allowed'].includes(event.error)) {
                voiceRuntime.enabled = false;
                setVoiceState('error', '마이크 권한을 허용해야 “갓플” 호출을 사용할 수 있습니다');
                const toggle = document.getElementById('godplan-voice-toggle');
                if (toggle) toggle.textContent = '“갓플” 호출 켜기';
            } else if (!['no-speech', 'aborted'].includes(event.error)) {
                setVoiceState('error', '음성 인식을 다시 연결하고 있습니다');
            }
        };
        recognition.onend = () => {
            if (voiceRuntime.recognition === recognition) voiceRuntime.recognition = null;
            if (voiceRuntime.enabled && !voiceRuntime.speaking && document.visibilityState === 'visible') restartWakeRecognition();
        };
        return recognition;
    }

    function restartWakeRecognition() {
        window.clearTimeout(voiceRuntime.restartTimer);
        if (!voiceRuntime.enabled || voiceRuntime.speaking || document.visibilityState !== 'visible' || voiceRuntime.recognition) return;
        voiceRuntime.restartTimer = window.setTimeout(() => {
            if (!voiceRuntime.enabled || voiceRuntime.recognition) return;
            const recognition = createWakeRecognition();
            if (!recognition) {
                voiceRuntime.enabled = false;
                setVoiceState('unsupported', '이 브라우저에서는 호출어 음성 인식을 지원하지 않습니다');
                return;
            }
            voiceRuntime.recognition = recognition;
            try {
                recognition.start();
            } catch {
                voiceRuntime.recognition = null;
                setVoiceState('error', '마이크 연결을 다시 시도해 주세요');
            }
        }, 240);
    }

    function stopWakeRecognition(options = {}) {
        window.clearTimeout(voiceRuntime.restartTimer);
        const recognition = voiceRuntime.recognition;
        voiceRuntime.recognition = null;
        if (!options.preserveEnabled) voiceRuntime.enabled = false;
        if (recognition) {
            recognition.onend = null;
            try { recognition.stop(); } catch {}
        }
    }

    function toggleWakeRuntime() {
        const toggle = document.getElementById('godplan-voice-toggle');
        if (voiceRuntime.enabled) {
            stopWakeRecognition();
            window.speechSynthesis?.cancel();
            voiceRuntime.speaking = false;
            voiceRuntime.awaitingCommand = false;
            if (toggle) toggle.textContent = '“갓플” 호출 켜기';
            setVoiceState('off', '음성 호출이 꺼져 있습니다');
            return;
        }
        if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
            setVoiceState('unsupported', 'Chrome·Edge 또는 지원되는 앱에서 사용할 수 있습니다');
            return;
        }
        voiceRuntime.enabled = true;
        if (toggle) toggle.textContent = '음성 호출 끄기';
        setVoiceState('connecting', '마이크 권한을 확인하고 있습니다');
        restartWakeRecognition();
    }

    function initializeVoiceRuntime(firstSlide) {
        if (document.getElementById('godplan-voice-runtime')) return;
        const panel = createElement('section', 'godplan-voice-runtime', { id: 'godplan-voice-runtime', 'data-phase': 'off', 'aria-label': '갓플 음성 호출' });
        panel.innerHTML = `
            <div class="godplan-voice-orb" aria-hidden="true"><span></span></div>
            <div class="godplan-voice-main">
                <div class="godplan-voice-heading"><strong>“갓플” 음성 호출</strong><span id="godplan-voice-status" aria-live="polite">음성 호출이 꺼져 있습니다</span></div>
                <p id="godplan-voice-transcript">호출어는 브라우저에서 감지하고, 호출 이후의 명령만 AI 요청으로 사용합니다.</p>
                <div class="godplan-voice-reminder-summary" id="godplan-voice-reminder-summary">예약된 음성 알림 없음</div>
            </div>
            <div class="godplan-voice-actions">
                <button id="godplan-voice-toggle" type="button">“갓플” 호출 켜기</button>
                <button id="godplan-voice-notification" type="button">알림 허용</button>
                <button id="godplan-voice-reminder-confirm" type="button" hidden>알림 예약</button>
            </div>
        `;
        document.getElementById('jarvis-study-support')?.insertAdjacentElement('afterend', panel);
        panel.querySelector('#godplan-voice-toggle')?.addEventListener('click', toggleWakeRuntime);
        panel.querySelector('#godplan-voice-notification')?.addEventListener('click', requestVoiceNotificationPermission);
        panel.querySelector('#godplan-voice-reminder-confirm')?.addEventListener('click', confirmPendingVoiceReminder);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') stopWakeRecognition({ preserveEnabled: true });
            else if (voiceRuntime.enabled) restartWakeRecognition();
        });
        document.getElementById('inline-action-cards')?.addEventListener('click', (event) => {
            const apply = event.target.closest('[data-inline-action]');
            if (!apply || !voiceRuntime.pendingReminder) return;
            const poll = window.setInterval(() => {
                if (apply.textContent.includes('반영 완료')) {
                    window.clearInterval(poll);
                    void confirmPendingVoiceReminder();
                } else if (!apply.disabled) {
                    window.clearInterval(poll);
                }
            }, 180);
            window.setTimeout(() => window.clearInterval(poll), 12000);
        });
        restoreVoiceReminders();
        window.godPlanVoiceRuntime = {
            simulateTranscript: (text) => handleWakeTranscript(text, true),
            parseReminder: (text, now) => parseVoiceReminder(text, now ? new Date(now) : new Date()),
            stop: () => stopWakeRecognition(),
            getState: () => ({ enabled: voiceRuntime.enabled, awaitingCommand: voiceRuntime.awaitingCommand, speaking: voiceRuntime.speaking })
        };
    }

    function initialize() {
        const carousel = document.getElementById('assistant-carousel');
        const input = document.getElementById('agent-request');
        const generate = document.getElementById('generate-agent');
        const firstSlide = carousel?.querySelector('.assistant-slide:not(.assistant-answer-slide)');
        const answerSlide = carousel?.querySelector('.assistant-answer-slide');
        if (!carousel || !input || !generate || !firstSlide || !answerSlide || document.getElementById('jarvis-role-switch')) return;

        document.body.classList.add('jarvis-assistant-ux');
        document.title = '갓생러 플래너 | 자비스형 AI 비서 UX';

        const originalTitle = firstSlide.querySelector('h3');
        originalTitle.classList.add('jarvis-console-heading');
        originalTitle.textContent = 'AI 비서에게 무엇이든 요청하세요';
        originalTitle.insertAdjacentElement('beforebegin', createElement('div', 'jarvis-console-kicker', { text: 'ADAPTIVE INTELLIGENCE CONSOLE' }));

        const scopeNote = createElement('div', 'jarvis-scope-note');
        scopeNote.innerHTML = '<span>텍스트·음성·코드·이미지로 변환 가능한 지적·행정 업무를 한곳에서 처리합니다.</span><strong>실행 전 사용자 승인</strong>';
        firstSlide.querySelector('.zero-friction-promise')?.insertAdjacentElement('afterend', scopeNote);

        const studySupport = createElement('section', 'jarvis-study-support', { id: 'jarvis-study-support', 'aria-label': '학생과 수험생 공부계획 지원' });
        studySupport.innerHTML = `
            <div class="jarvis-study-icon" aria-hidden="true">학습</div>
            <div class="jarvis-study-copy">
                <strong>모든 학생·수험생의 공부계획을 함께 설계합니다</strong>
                <span>초·중·고·대학생부터 입시·공시·자격증 수험생까지, 목표와 시험일·가용 시간을 기준으로 현실적인 계획을 만듭니다.</span>
                <div class="jarvis-study-points" aria-label="공부계획 지원 항목">
                    <span>시험일까지 역산</span><span>과목별 시간 배분</span><span>복습·오답 루틴</span><span>밀린 진도 재설계</span>
                </div>
            </div>
            <button class="jarvis-study-start" id="jarvis-study-start" type="button">공부계획 시작</button>
        `;
        scopeNote.insertAdjacentElement('afterend', studySupport);

        studySupport.querySelector('#jarvis-study-start')?.addEventListener('click', () => {
            input.value = '시험 또는 학습 목표, 시험일까지 남은 기간, 과목, 하루에 공부할 수 있는 시간을 바탕으로 주간 공부계획과 복습·오답 루틴을 짜줘.';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus({ preventScroll: true });
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        const roleSwitch = createElement('div', 'jarvis-role-switch', { id: 'jarvis-role-switch', role: 'group', 'aria-label': 'AI 비서 역할 선택' });
        [
            ['auto', '자동 판단'],
            ['drafting_tool', '초안 작성'],
            ['reviewer', '검토'],
            ['brainstorming_partner', '함께 생각']
        ].forEach(([role, label]) => {
            const button = createElement('button', 'jarvis-role-button', {
                type: 'button',
                'data-role': role,
                'aria-pressed': String(role === selectedRole),
                text: label
            });
            button.addEventListener('click', () => selectRole(role));
            roleSwitch.append(button);
        });
        firstSlide.querySelector('.mode-switch')?.insertAdjacentElement('beforebegin', roleSwitch);

        const contextDrawer = createElement('details', 'jarvis-context-drawer');
        contextDrawer.innerHTML = '<summary>이번 요청에 반영할 문맥</summary><div class="jarvis-context-chips" id="jarvis-context-chips"></div>';
        document.getElementById('mode-hint')?.insertAdjacentElement('afterend', contextDrawer);

        const intentRibbon = createElement('div', 'jarvis-intent-ribbon', { id: 'jarvis-intent-ribbon', hidden: '' });
        intentRibbon.innerHTML = '<span class="jarvis-intent-badge">자동 판단</span><span class="jarvis-intent-copy"><strong>요청을 기다리고 있습니다</strong><span>입력 후 역할과 처리 깊이를 확인합니다.</span></span><span class="jarvis-intent-confidence"></span>';
        contextDrawer.insertAdjacentElement('afterend', intentRibbon);

        const processRail = createElement('div', 'jarvis-process-rail', { id: 'jarvis-process-rail', hidden: '', 'aria-live': 'polite' });
        processRail.innerHTML = `<div class="jarvis-process-message" id="jarvis-process-message">요청을 이해하고 있습니다.</div><ol class="jarvis-process-steps">${PROCESS_STEPS.map((step) => `<li class="jarvis-process-step">${step}</li>`).join('')}</ol>`;
        intentRibbon.insertAdjacentElement('afterend', processRail);

        enhanceAnswerSlide(answerSlide);
        updateContextChips();
        ['assistant-age', 'assistant-occupation', 'assistant-work-type', 'assistant-condition-toggle'].forEach((id) => {
            document.getElementById(id)?.addEventListener('change', updateContextChips);
            document.getElementById(id)?.addEventListener('input', updateContextChips);
        });
        document.getElementById('upload-file-input')?.addEventListener('change', updateContextChips);

        carousel.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach((field) => {
            field.addEventListener('keydown', (event) => {
                if (['ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
            });
        });

        document.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const target = event.target;
            const isEditing = target instanceof HTMLElement && (
                target.matches('input, textarea, select, [contenteditable="true"]') ||
                Boolean(target.closest('[contenteditable="true"]'))
            );
            if (isEditing || carousel.contains(target)) return;
            const rect = carousel.getBoundingClientRect();
            const visible = rect.bottom > 0 && rect.top < window.innerHeight;
            if (!visible) return;
            event.preventDefault();
            document.getElementById(event.key === 'ArrowLeft' ? 'assistant-slide-prev' : 'assistant-slide-next')?.click();
        });

        generate.addEventListener('click', () => beginRequest(input.value), true);
        document.getElementById('assistant-followup-send')?.addEventListener('click', () => {
            beginRequest(document.getElementById('assistant-followup-input')?.value || '');
        }, true);

        wrapFetch();
    }

    function selectRole(role) {
        selectedRole = role;
        document.querySelectorAll('.jarvis-role-button').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.role === role));
        });
        const input = document.getElementById('agent-request');
        if (input?.value.trim()) renderIntent(detectPreview(input.value));
    }

    function updateContextChips() {
        const container = document.getElementById('jarvis-context-chips');
        if (!container) return;
        const values = [
            document.getElementById('assistant-age')?.value,
            document.getElementById('assistant-occupation')?.value,
            document.getElementById('assistant-work-type')?.value,
            document.getElementById('assistant-condition-toggle')?.checked ? '현재 컨디션 반영' : '',
            document.getElementById('upload-file-input')?.files?.length ? `첨부 ${document.getElementById('upload-file-input').files.length}개` : ''
        ].filter(Boolean);
        container.replaceChildren(...(values.length ? values : ['프로필 없이 요청 내용만 반영']).map((value) => createElement('span', 'jarvis-context-chip', { text: value })));
    }

    function beginRequest(text) {
        if (!String(text || '').trim()) return;
        const preview = detectPreview(text);
        renderIntent(preview);
        startProcess(preview);
    }

    function renderIntent(capability) {
        const ribbon = document.getElementById('jarvis-intent-ribbon');
        if (!ribbon || !capability) return;
        ribbon.hidden = false;
        const area = AREA_LABELS[capability.area] || capability.label || '요청 분석';
        const role = ROLE_LABELS[capability.role || capability.activeRole] || '자동 판단';
        const stage = STAGE_LABELS[capability.stage || capability.evaluationStage] || '요청 처리';
        ribbon.querySelector('.jarvis-intent-badge').textContent = area;
        ribbon.querySelector('.jarvis-intent-copy strong').textContent = `${role} 역할로 처리합니다`;
        ribbon.querySelector('.jarvis-intent-copy span').textContent = `${stage} · 필요한 결과부터 제시합니다.`;
        const confidence = Number(capability.confidence) || 0;
        ribbon.querySelector('.jarvis-intent-confidence').textContent = confidence ? `이해도 ${Math.round(confidence * 100)}%` : '';
    }

    function processMessage(capability, index) {
        const area = capability?.area || 'daily_personal_management';
        const messages = {
            information_research: ['질문의 범위를 파악하고 있습니다.', '근거를 검토할 역할을 선택했습니다.', '주장과 자료를 분리하고 있습니다.', '누락과 불확실성을 확인하고 있습니다.'],
            document_content_production: ['목적과 독자를 파악하고 있습니다.', '초안·검토 역할을 연결했습니다.', '사용 가능한 결과물을 구성하고 있습니다.', '표현과 오류를 다시 확인하고 있습니다.'],
            decision_support: ['판단 목표와 기준을 파악하고 있습니다.', '검토자 역할을 선택했습니다.', '대안과 위험을 비교하고 있습니다.', '가정과 불확실성을 확인하고 있습니다.'],
            counseling_support: ['상황과 원하는 관계를 파악하고 있습니다.', '함께 생각하는 역할을 선택했습니다.', '선택지와 대화 문장을 준비하고 있습니다.', '부담이 적은 다음 행동을 확인하고 있습니다.'],
            simulation_training: ['역할과 목표를 파악하고 있습니다.', '상호작용 역할을 준비했습니다.', '실전 질문과 흐름을 구성하고 있습니다.', '피드백 기준을 확인하고 있습니다.'],
            daily_personal_management: ['요청과 현재 계획을 파악하고 있습니다.', '가장 알맞은 역할을 선택했습니다.', '실행 가능한 순서로 정리하고 있습니다.', '일정 충돌과 변경 범위를 확인하고 있습니다.']
        };
        return (messages[area] || messages.daily_personal_management)[Math.min(index, 3)];
    }

    function startProcess(capability) {
        clearInterval(processTimer);
        processIndex = 0;
        const rail = document.getElementById('jarvis-process-rail');
        if (!rail) return;
        rail.hidden = false;
        updateProcess(capability, 0, false);
        processTimer = window.setInterval(() => {
            if (processIndex < 2) processIndex += 1;
            updateProcess(capability, processIndex, false);
        }, 850);
    }

    function updateProcess(capability, activeIndex, complete) {
        const rail = document.getElementById('jarvis-process-rail');
        if (!rail) return;
        rail.querySelector('#jarvis-process-message').textContent = complete
            ? '결과 작성과 자체 검토를 완료했습니다.'
            : processMessage(capability, activeIndex);
        rail.querySelectorAll('.jarvis-process-step').forEach((step, index) => {
            step.classList.toggle('is-done', complete || index < activeIndex);
            step.classList.toggle('is-active', !complete && index === activeIndex);
        });
    }

    function enhanceAnswerSlide(answerSlide) {
        const title = answerSlide.querySelector('.assistant-answer-head h3');
        const description = answerSlide.querySelector('.assistant-answer-head p');
        if (title) title.textContent = 'AI 비서 작업 결과';
        if (description) description.textContent = '결과를 먼저 확인하고 근거·위험·다음 행동을 이어서 검토하세요.';

        const meta = createElement('div', 'jarvis-answer-meta', { id: 'jarvis-answer-meta', hidden: '' });
        answerSlide.querySelector('.assistant-answer-head')?.insertAdjacentElement('afterend', meta);

        const lenses = createElement('div', 'jarvis-answer-lenses', { role: 'group', 'aria-label': '답변 검토 관점' });
        [['result', '결과'], ['evidence', '근거·검토'], ['next', '다음 행동']].forEach(([view, label], index) => {
            const button = createElement('button', 'jarvis-lens-button', { type: 'button', 'data-view': view, 'aria-pressed': String(index === 0), text: label });
            button.addEventListener('click', () => selectLens(view));
            lenses.append(button);
        });
        meta.insertAdjacentElement('afterend', lenses);

        const insight = createElement('div', 'jarvis-insight-panel', { id: 'jarvis-insight-panel', text: '답변이 완료되면 처리 역할과 검토 기준을 보여드립니다.' });
        lenses.insertAdjacentElement('afterend', insight);

        const actions = document.getElementById('inline-action-cards');
        const executionNote = createElement('div', 'jarvis-execution-note', { id: 'jarvis-execution-note', hidden: '' });
        executionNote.innerHTML = '<span>실행 가능한 변경사항은 검토 후에만 적용됩니다.</span><strong>되돌리기 지원</strong>';
        actions?.insertAdjacentElement('beforebegin', executionNote);

        const handoff = createElement('section', 'jarvis-role-handoff', { id: 'jarvis-role-handoff', 'aria-label': '다음 AI 역할 선택' });
        handoff.innerHTML = '<strong>이어서 무엇을 할까요?</strong><div class="jarvis-handoff-actions"></div>';
        [
            ['drafting_tool', '초안으로 만들기'],
            ['reviewer', '다시 검토하기'],
            ['brainstorming_partner', '다른 대안 찾기']
        ].forEach(([role, label]) => {
            const button = createElement('button', 'jarvis-handoff-button', { type: 'button', 'data-handoff-role': role, text: label });
            button.addEventListener('click', () => prepareFollowup(role));
            handoff.querySelector('.jarvis-handoff-actions').append(button);
        });
        actions?.insertAdjacentElement('afterend', handoff);

        const observer = new MutationObserver(() => {
            executionNote.hidden = !actions?.children.length;
        });
        if (actions) observer.observe(actions, { childList: true, subtree: false });
    }

    function selectLens(view) {
        document.querySelectorAll('.jarvis-lens-button').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.view === view));
        });
        const panel = document.getElementById('jarvis-insight-panel');
        if (!panel) return;
        if (!latestCapability) {
            panel.textContent = '답변이 완료되면 요청의 처리 기준을 보여드립니다.';
            return;
        }
        const role = ROLE_LABELS[latestCapability.activeRole] || '자동 판단';
        const area = AREA_LABELS[latestCapability.area] || latestCapability.label;
        if (view === 'evidence') {
            panel.textContent = `${area} 영역을 ${role} 역할로 처리했습니다. ${latestCapability.responsePolicy?.mustStateLimits ? '가정과 한계를 구분해 확인합니다.' : '요청 목적과 결과 형식을 기준으로 검토합니다.'}`;
        } else if (view === 'next') {
            panel.textContent = '아래 역할 전환 버튼으로 초안 완성, 재검토, 대안 탐색을 이어갈 수 있습니다. 실제 일정 변경은 별도 승인 후 적용됩니다.';
        } else {
            panel.textContent = `${STAGE_LABELS[latestCapability.evaluationStage] || '요청'} 수준으로 처리했습니다. ${latestEngine === 'server-fallback' ? '현재는 안전 처리 모드의 결과입니다.' : '전문 AI 처리 결과입니다.'}`;
        }
    }

    function prepareFollowup(role) {
        const input = document.getElementById('assistant-followup-input');
        if (!input) return;
        input.value = HANDOFF_PROMPTS[role];
        input.focus();
        selectedRole = role;
        document.querySelectorAll('.jarvis-role-button').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.role === role));
        });
    }

    function updateAnswer(payload) {
        const capability = payload?.godPlan?.userContextInterpretation?.assistantCapability;
        const wasVoiceRequest = voiceRuntime.voiceRequestPending;
        if (wasVoiceRequest) {
            voiceRuntime.voiceRequestPending = false;
            renderVoicePlannerActions(payload);
            speakVoiceReply(summarizeVoiceReply(payload));
        }
        if (!capability) return;
        latestCapability = capability;
        latestEngine = payload.engine || '';
        clearInterval(processTimer);
        renderIntent(capability);
        updateProcess(capability, 3, true);

        const meta = document.getElementById('jarvis-answer-meta');
        if (meta) {
            meta.hidden = false;
            meta.replaceChildren(
                createElement('span', 'jarvis-answer-chip', { text: AREA_LABELS[capability.area] || capability.label }),
                createElement('span', 'jarvis-answer-chip', { text: ROLE_LABELS[capability.activeRole] || '자동 판단' }),
                createElement('span', 'jarvis-answer-chip', { text: STAGE_LABELS[capability.evaluationStage] || capability.evaluationLabel })
            );
        }
        selectLens('result');
    }

    function wrapFetch() {
        if (window.__jarvisAssistantFetchWrapped) return;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...originalArgs) => {
            const args = [...originalArgs];
            const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const isAssistantRequest = /\/api\/(?:gemini-manage|assistant\/manage)(?:\?|$)/.test(requestUrl);
            if (isAssistantRequest && selectedRole !== 'auto' && args[1] && typeof args[1].body === 'string') {
                try {
                    const body = JSON.parse(args[1].body);
                    body.passiveContext = { ...(body.passiveContext || {}), assistantRole: selectedRole };
                    args[1] = { ...args[1], body: JSON.stringify(body) };
                } catch {}
            }
            const response = await originalFetch(...args);
            if (isAssistantRequest) {
                void response.clone().json().then(updateAnswer).catch(() => {
                    clearInterval(processTimer);
                });
            }
            return response;
        };
        window.__jarvisAssistantFetchWrapped = true;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
