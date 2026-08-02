(() => {
    'use strict';

    const STORAGE_KEY = 'godsaeng_card_workspace_v1';
    const WAITING_STORAGE_KEY = 'godsaeng_waiting_delegation_v1';
    const CONTACT_STORAGE_KEY = 'godsaeng_contact_context_v1';
    const DEFAULT_ACTIVE = ['productivity', 'briefing', 'assistant', 'planner'];
    const CARD_DEFINITIONS = [
        { id: 'productivity', label: '오늘 일정 압축', short: '압축', selector: '#productivity-coach', size: 'wide' },
        { id: 'briefing', label: '오늘 핵심 브리핑', short: '요약', selector: '#briefing-hub', size: 'wide' },
        { id: 'twin', label: '내 패턴 자동 학습', short: '학습', selector: '#personal-operating-system', size: 'wide' },
        { id: 'outcome', label: '최적 실행 순서', short: '순서', selector: '#outcome-path-engine', size: 'wide' },
        { id: 'checkpoint', label: '멈춘 일 이어하기', short: '이어', selector: '#execution-checkpoint', size: 'wide' },
        { id: 'time', label: '남은 시간 배분', short: '배분', selector: '#time-checkout', size: 'wide' },
        { id: 'leak', label: '놓친 성과 막기', short: '누수', selector: '#result-leak-shield', size: 'wide' },
        { id: 'shutdown', label: '오늘 일정 마치기', short: '종료', selector: '#optimal-shutdown-line', size: 'wide' },
        { id: 'waiting', label: '답 올 때까지 맡기기', short: '맡김', selector: '#waiting-delegation-card', size: 'standard' },
        { id: 'contact', label: '상황별 연락 준비', short: '연락', selector: '#context-contact-card', size: 'standard' },
        { id: 'assistant', label: 'AI에게 계획 맡기기', short: 'AI', selector: '#assistant-carousel', size: 'wide' },
        { id: 'planner', label: '계획 직접 작성', short: '작성', selector: '.layout', size: 'wide' }
    ];

    function readStoredJson(key, fallback) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return parsed ?? fallback;
        } catch {
            return fallback;
        }
    }

    function createId(prefix) {
        if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function toLocalDateTimeValue(date) {
        const value = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(value.getTime())) return '';
        const offset = value.getTimezoneOffset() * 60000;
        return new Date(value.getTime() - offset).toISOString().slice(0, 16);
    }

    function formatDueAt(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '확인 시각 미정';
        return new Intl.DateTimeFormat('ko-KR', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    }

    function safeParseState() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            const active = Array.isArray(parsed.active) ? parsed.active.filter(Boolean) : DEFAULT_ACTIVE.slice();
            const sizes = parsed.sizes && typeof parsed.sizes === 'object' ? parsed.sizes : {};
            return { active, sizes };
        } catch {
            return { active: DEFAULT_ACTIVE.slice(), sizes: {} };
        }
    }

    function initializeMiniCalendar() {
        if (document.getElementById('godplan-mini-calendar')) return;

        const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const plannerDayKeys = ['mon', 'tue', 'wed', 'thu', 'fri'];
        const weekdayLabels = ['일', '월', '화', '수', '목', '금', '토'];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let selectedDate = new Date(today);
        let visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        let lastFocusedElement = null;

        const shell = document.createElement('aside');
        shell.id = 'godplan-mini-calendar';
        shell.className = 'godplan-mini-calendar';
        shell.setAttribute('aria-label', '미니 캘린더');
        shell.innerHTML = `
            <button class="mini-calendar-heading" type="button" data-mini-calendar-open aria-haspopup="dialog">
                <span class="mini-calendar-icon" aria-hidden="true"><i></i></span>
                <span><strong id="mini-calendar-month"></strong><small>일정 한눈에 보기</small></span>
                <span class="mini-calendar-expand" aria-hidden="true">↗</span>
            </button>
            <div class="mini-calendar-weekdays" aria-hidden="true">${weekdayLabels.map((label) => `<span>${label}</span>`).join('')}</div>
            <div class="mini-calendar-grid" id="mini-calendar-grid"></div>
            <button class="mini-calendar-today" type="button" data-mini-calendar-today>오늘 일정 보기</button>
        `;

        const backdrop = document.createElement('div');
        backdrop.id = 'godplan-calendar-backdrop';
        backdrop.className = 'godplan-calendar-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <section class="godplan-calendar-dialog" role="dialog" aria-modal="true" aria-labelledby="godplan-calendar-title">
                <header class="godplan-calendar-dialog-head">
                    <div>
                        <span>MY RHYTHM CALENDAR</span>
                        <h2 id="godplan-calendar-title">나의 일정 캘린더</h2>
                    </div>
                    <button class="godplan-calendar-close" type="button" data-calendar-close aria-label="캘린더 닫기">×</button>
                </header>
                <div class="godplan-calendar-dialog-body">
                    <div class="godplan-calendar-main">
                        <div class="godplan-calendar-toolbar">
                            <button type="button" data-calendar-month="prev" aria-label="이전 달">‹</button>
                            <strong id="godplan-calendar-month-title"></strong>
                            <button type="button" data-calendar-month="next" aria-label="다음 달">›</button>
                        </div>
                        <div class="godplan-calendar-weekdays" aria-hidden="true">${weekdayLabels.map((label) => `<span>${label}</span>`).join('')}</div>
                        <div class="godplan-calendar-grid" id="godplan-calendar-grid"></div>
                    </div>
                    <aside class="godplan-calendar-detail" id="godplan-calendar-detail" aria-live="polite"></aside>
                </div>
            </section>
        `;

        document.body.append(shell, backdrop);

        const dateKey = (date) => [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ].join('-');

        const parseDateKey = (value) => {
            const [year, month, day] = String(value).split('-').map(Number);
            return new Date(year, month - 1, day);
        };

        const getWeekStart = (date = today) => {
            const start = new Date(date);
            const day = start.getDay();
            start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
            start.setHours(0, 0, 0, 0);
            return start;
        };

        const getPlannerDayKey = (date) => {
            const difference = Math.round((date - getWeekStart()) / 86400000);
            return difference >= 0 && difference < plannerDayKeys.length ? plannerDayKeys[difference] : '';
        };

        const getSnapshot = () => {
            try {
                return typeof window.getGodPlanCalendarSnapshot === 'function'
                    ? window.getGodPlanCalendarSnapshot()
                    : { currentDay: '', calendarConnected: false, days: {} };
            } catch {
                return { currentDay: '', calendarConnected: false, days: {} };
            }
        };

        const getTaskDateKey = (task) => {
            if (/^20\d{2}-\d{2}-\d{2}$/.test(String(task?.scheduledDate || ''))) return task.scheduledDate;
            const source = [task?.scheduledStart, ...(Array.isArray(task?.details) ? task.details : [])].join(' ');
            return source.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] || '';
        };

        const getTasksForDate = (date, snapshot) => {
            const selectedKey = dateKey(date);
            const exact = [];
            for (const dayKey of plannerDayKeys) {
                for (const task of snapshot.days?.[dayKey]?.tasks || []) {
                    if (getTaskDateKey(task) === selectedKey) exact.push({ task, dayKey });
                }
            }
            if (exact.length) return exact;

            const currentWeekDay = getPlannerDayKey(date);
            if (!currentWeekDay) return [];
            return (snapshot.days?.[currentWeekDay]?.tasks || [])
                .filter((task) => !getTaskDateKey(task))
                .map((task) => ({ task, dayKey: currentWeekDay }));
        };

        const hasPlannerItems = (date, snapshot) => {
            return getTasksForDate(date, snapshot).length > 0;
        };

        function buildDateCells(month, compact = false) {
            const snapshot = getSnapshot();
            const first = new Date(month.getFullYear(), month.getMonth(), 1);
            const gridStart = new Date(first);
            gridStart.setDate(first.getDate() - first.getDay());
            const cells = [];
            for (let index = 0; index < 42; index += 1) {
                const date = new Date(gridStart);
                date.setDate(gridStart.getDate() + index);
                const outside = date.getMonth() !== month.getMonth();
                const isToday = dateKey(date) === dateKey(today);
                const isSelected = dateKey(date) === dateKey(selectedDate);
                const hasItems = hasPlannerItems(date, snapshot);
                const exactItemCount = getTasksForDate(date, snapshot)
                    .filter(({ task }) => getTaskDateKey(task) === dateKey(date)).length;
                cells.push(`
                    <button type="button" data-calendar-date="${dateKey(date)}"
                        class="${outside ? 'is-outside' : ''} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${hasItems ? 'has-items' : ''} ${exactItemCount ? 'has-exact-items' : ''}"
                        data-item-count="${exactItemCount}"
                        aria-label="${date.getMonth() + 1}월 ${date.getDate()}일${hasItems ? ', 일정 있음' : ''}"
                        ${isToday ? 'aria-current="date"' : ''}>
                        <span>${date.getDate()}</span>${hasItems ? '<i aria-hidden="true"></i>' : ''}
                    </button>
                `);
            }
            return compact ? cells.join('') : cells.join('');
        }

        function renderMiniCalendar() {
            document.getElementById('mini-calendar-month').textContent = new Intl.DateTimeFormat('ko-KR', {
                year: 'numeric', month: 'long'
            }).format(visibleMonth);
            document.getElementById('mini-calendar-grid').innerHTML = buildDateCells(visibleMonth, true);
        }

        function formatTaskMeta(task) {
            const pieces = [];
            if (task.scheduledStart) pieces.push(task.scheduledStart);
            if (task.durationMinutes) pieces.push(`약 ${task.durationMinutes}분`);
            return pieces.join(' · ');
        }

        function renderDetail() {
            const snapshot = getSnapshot();
            const scheduledItems = getTasksForDate(selectedDate, snapshot);
            const dayKey = scheduledItems[0]?.dayKey || getPlannerDayKey(selectedDate);
            const tasks = scheduledItems.map((item) => item.task);
            const pendingCount = tasks.filter((task) => !task.done).length;
            const formattedDate = new Intl.DateTimeFormat('ko-KR', {
                month: 'long', day: 'numeric', weekday: 'long'
            }).format(selectedDate);
            const taskMarkup = tasks.length
                ? tasks.map((task) => {
                    const summarizedTitle = window.PlannerCore?.summarizeScheduleTitle?.(task.text) || task.text;
                    return `
                    <li class="${task.done ? 'is-done' : ''}">
                        <span class="calendar-task-check" aria-hidden="true">${task.done ? '✓' : ''}</span>
                        <span><strong>${escapeHtml(summarizedTitle)}</strong>${formatTaskMeta(task) ? `<small>${escapeHtml(formatTaskMeta(task))}</small>` : ''}${task.displayDetail || task.details?.[0] ? `<em>${escapeHtml(task.displayDetail || task.details[0])}</em>` : ''}</span>
                    </li>
                `;
                }).join('')
                : '<li class="calendar-detail-empty"><span aria-hidden="true">☁</span><strong>등록된 일정이 없어요</strong><small>여유 시간으로 남겨두거나 새로운 계획을 추가해 보세요.</small></li>';

            document.getElementById('godplan-calendar-detail').innerHTML = `
                <div class="calendar-detail-date">
                    <span>${dayKeys[selectedDate.getDay()].toUpperCase()}</span>
                    <h3>${formattedDate}</h3>
                    <p>${tasks.length ? `남은 일정 ${pendingCount}개 · 완료 ${tasks.length - pendingCount}개` : '오늘의 리듬을 가볍게 설계해 보세요.'}</p>
                </div>
                <div class="calendar-sync-state ${snapshot.calendarConnected ? 'is-connected' : ''}">
                    <i aria-hidden="true"></i>${snapshot.calendarConnected ? 'Google 캘린더 연결됨' : '플래너 일정 기준'}
                </div>
                <ul class="calendar-task-list">${taskMarkup}</ul>
                ${dayKey ? `<button class="calendar-open-planner" type="button" data-calendar-open-planner="${dayKey}">${weekdayLabels[selectedDate.getDay()]}요일 플래너 열기 <span>→</span></button>` : ''}
            `;
        }

        function renderExpandedCalendar() {
            document.getElementById('godplan-calendar-month-title').textContent = new Intl.DateTimeFormat('ko-KR', {
                year: 'numeric', month: 'long'
            }).format(visibleMonth);
            document.getElementById('godplan-calendar-grid').innerHTML = buildDateCells(visibleMonth);
            renderDetail();
            renderMiniCalendar();
        }

        function openCalendar(date = selectedDate) {
            selectedDate = new Date(date);
            visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
            lastFocusedElement = document.activeElement;
            renderExpandedCalendar();
            backdrop.hidden = false;
            document.body.classList.add('godplan-calendar-open');
            window.requestAnimationFrame(() => backdrop.classList.add('is-open'));
            backdrop.querySelector('[data-calendar-close]')?.focus();
        }

        function closeCalendar() {
            backdrop.classList.remove('is-open');
            document.body.classList.remove('godplan-calendar-open');
            window.setTimeout(() => { backdrop.hidden = true; }, 180);
            lastFocusedElement?.focus?.();
        }

        shell.addEventListener('click', (event) => {
            const dateButton = event.target.closest('[data-calendar-date]');
            if (dateButton) {
                openCalendar(parseDateKey(dateButton.dataset.calendarDate));
                return;
            }
            if (event.target.closest('[data-mini-calendar-today]')) {
                openCalendar(today);
                return;
            }
            if (event.target.closest('[data-mini-calendar-open]')) openCalendar(selectedDate);
        });

        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop || event.target.closest('[data-calendar-close]')) {
                closeCalendar();
                return;
            }
            const monthButton = event.target.closest('[data-calendar-month]');
            if (monthButton) {
                visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + (monthButton.dataset.calendarMonth === 'next' ? 1 : -1), 1);
                renderExpandedCalendar();
                return;
            }
            const dateButton = event.target.closest('[data-calendar-date]');
            if (dateButton) {
                selectedDate = parseDateKey(dateButton.dataset.calendarDate);
                if (selectedDate.getMonth() !== visibleMonth.getMonth()) visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
                renderExpandedCalendar();
                return;
            }
            const plannerButton = event.target.closest('[data-calendar-open-planner]');
            if (plannerButton) {
                document.querySelector(`.day-button[data-day="${plannerButton.dataset.calendarOpenPlanner}"]`)?.click();
                closeCalendar();
                window.setTimeout(() => document.querySelector('.layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 220);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !backdrop.hidden) closeCalendar();
        });
        document.addEventListener('click', (event) => {
            if (event.target.closest('.day-button, #plan-panel, #quick-add-task')) window.setTimeout(renderMiniCalendar, 80);
        });
        window.addEventListener('godplan:planner-updated', (event) => {
            const latestDate = event.detail?.scheduledDates?.filter(Boolean)?.[0];
            if (/^20\d{2}-\d{2}-\d{2}$/.test(latestDate || '')) {
                selectedDate = parseDateKey(latestDate);
                visibleMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
            }
            window.setTimeout(() => {
                renderMiniCalendar();
                if (!backdrop.hidden) renderExpandedCalendar();
            }, 0);
        });
        window.addEventListener('godsaeng:workspace-state-restored', () => window.setTimeout(renderMiniCalendar, 0));

        renderMiniCalendar();
    }

    function initializeCardWorkspace() {
        initializeMiniCalendar();
        const legacyShell = document.getElementById('completion-legacy-shell');
        const topActions = document.querySelector('.top-actions');
        if (!legacyShell || !topActions || document.getElementById('card-folder-shell')) return;

        document.body.classList.add('card-workspace-variant');
        legacyShell.classList.add('is-open');

        const state = safeParseState();
        const registry = new Map();

        const folder = document.createElement('section');
        folder.className = 'card-folder-shell';
        folder.id = 'card-folder-shell';
        folder.setAttribute('aria-label', '기능 카드 보관함');
        folder.innerHTML = `
            <div class="card-folder-head">
                <div class="card-folder-title">
                    <span class="card-folder-glyph" aria-hidden="true"></span>
                    <span class="card-folder-copy">
                        <strong>기능 카드 보관함 <span id="card-folder-count"></span></strong>
                        <small>기능 이름만 보고 필요한 카드를 바로 꺼내세요</small>
                    </span>
                </div>
                <div class="card-folder-actions">
                    <button class="card-folder-action" id="card-edit-toggle" type="button" aria-pressed="false">카드 정리</button>
                    <button class="card-folder-action" id="card-reset-layout" type="button">초기 배치</button>
                </div>
            </div>
            <div class="card-folder-grid" id="card-folder-grid"></div>
        `;
        const launcher = document.createElement('section');
        launcher.className = 'card-launcher-grid';
        launcher.setAttribute('aria-label', '플래너 빠른 설정과 기능 카드');

        const launcherLeft = document.createElement('div');
        launcherLeft.className = 'card-launcher-left';

        const launcherRight = document.createElement('div');
        launcherRight.className = 'card-launcher-right';

        const weekMeta = document.getElementById('week-meta');
        const hero = document.querySelector('.hero');
        const actionButtons = topActions.querySelector('.top-action-buttons');
        const dayNav = document.getElementById('day-nav');
        const energyStrip = document.getElementById('energy-strip');
        const energySetup = document.createElement('div');
        energySetup.className = 'energy-setup-detail';
        const energyGuide = document.createElement('div');
        energyGuide.className = 'energy-setup-guide';
        energyGuide.id = 'energy-setup-guide';
        energyGuide.setAttribute('aria-live', 'polite');
        energyGuide.innerHTML = '<span aria-hidden="true">1</span><strong>먼저 오늘 컨디션을 선택해 주세요</strong>';
        const accountButton = document.getElementById('account-toggle');
        const completionOs = document.getElementById('completion-os');
        const agentState = document.createElement('div');
        agentState.id = 'godplan-agent-state';
        agentState.className = 'godplan-agent-state';
        agentState.dataset.phase = 'observing';
        agentState.innerHTML = '<span class="godplan-agent-pulse" aria-hidden="true"></span><span>갓플 관찰 중</span>';

        if (hero && weekMeta && actionButtons && dayNav && energyStrip && accountButton && completionOs) {
            completionOs.insertAdjacentElement('beforebegin', launcher);
            launcher.append(launcherLeft, launcherRight);
            energySetup.append(energyGuide, energyStrip);
            launcherLeft.append(hero, weekMeta, actionButtons, dayNav, energySetup);
            launcherRight.append(accountButton, folder);
            topActions.remove();
        } else {
            topActions.insertAdjacentElement('afterend', folder);
        }

        energyStrip?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-energy]');
            if (!button) return;
            const labels = { high: '최상', mid: '보통', low: '방전' };
            energyGuide.classList.add('is-complete');
            energyGuide.innerHTML = `<span aria-hidden="true">✓</span><strong>오늘 컨디션 ‘${labels[button.dataset.energy] || button.textContent.trim()}’을 반영합니다</strong>`;
        });

        const renderAgentState = (godPlan, modelRoute = '') => {
            if (!godPlan || typeof godPlan !== 'object') return;
            const agent = godPlan.agent || {};
            const actions = Array.isArray(godPlan.actions) ? godPlan.actions : [];
            const pending = Number(agent.pendingConfirmationCount) || 0;
            const phase = String(agent.phase || 'completed');
            let label = '갓플 준비 완료';
            if (godPlan.routingDestination === 'COGNITIVE_BRAIN' || modelRoute === 'high-reasoning') {
                label = '갓플 고도 추론 중';
            } else if (phase === 'awaiting_confirmation') {
                label = `갓플 승인 대기 ${pending}건`;
            } else if (phase === 'queued') {
                label = `갓플 실행 큐 ${Number(agent.queuedJobCount) || actions.length}건`;
            } else if (actions.length) {
                label = `갓플 계획 완료 ${actions.length}단계`;
            } else if (phase === 'awaiting_clarification') {
                label = '갓플 정보 확인 필요';
            }
            agentState.dataset.phase = phase;
            agentState.querySelector('span:last-child').textContent = label;
            agentState.title = [
                agent.summary || '',
                godPlan.userContextInterpretation?.detectedDomain
                    ? `감지 도메인: ${godPlan.userContextInterpretation.detectedDomain}`
                    : '',
                Number.isFinite(Number(godPlan.confidence))
                    ? `판단 신뢰도: ${Math.round(Number(godPlan.confidence) * 100)}%`
                    : ''
            ].filter(Boolean).join('\n');
        };

        if (!window.__godPlanFetchWrapped) {
            const originalFetch = window.fetch.bind(window);
            window.fetch = async (...args) => {
                const response = await originalFetch(...args);
                const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                if (/\/api\/(?:gemini-manage|assistant\/manage)(?:\?|$)/.test(requestUrl)) {
                    void response.clone().json().then((payload) => {
                        if (payload?.godPlan) renderAgentState(payload.godPlan, payload.modelRoute);
                    }).catch(() => {});
                }
                return response;
            };
            window.__godPlanFetchWrapped = true;
        }

        void fetch('/api/godplan/status', { cache: 'no-store' })
            .then((response) => response.json())
            .then((status) => {
                agentState.dataset.phase = status.parserReady ? 'completed' : 'awaiting_clarification';
                agentState.querySelector('span:last-child').textContent = status.parserReady
                    ? '갓플 준비 완료'
                    : '갓플 연결 확인 필요';
            })
            .catch(() => {
                agentState.dataset.phase = 'awaiting_clarification';
                agentState.querySelector('span:last-child').textContent = '갓플 서버 확인 필요';
            });

        const workspace = document.createElement('section');
        workspace.className = 'card-workspace-grid';
        workspace.id = 'card-workspace-grid';
        workspace.setAttribute('aria-label', '사용 중인 기능 카드');
        legacyShell.prepend(workspace);

        const parking = document.createElement('div');
        parking.id = 'card-storage-parking';
        parking.setAttribute('aria-hidden', 'true');
        legacyShell.append(parking);

        const waitingCard = document.createElement('section');
        waitingCard.className = 'planner-addon-card waiting-delegation-card';
        waitingCard.id = 'waiting-delegation-card';
        waitingCard.innerHTML = `
            <div class="planner-addon-card-head">
                <div>
                    <span class="planner-addon-eyebrow">WAITING DELEGATION</span>
                    <h3>답 올 때까지 맡기기</h3>
                    <p>답변·승인·배송처럼 기다려야 하는 일을 맡기면 확인할 시점과 지연 여부를 한곳에서 관리합니다.</p>
                </div>
                <span class="planner-addon-value-chip">확인 피로 절약</span>
            </div>
            <form class="waiting-delegation-form" id="waiting-delegation-form">
                <label>
                    <span>무엇을 기다리나요?</span>
                    <input id="waiting-delegation-title" maxlength="120" placeholder="예: 거래처 견적 승인" required>
                </label>
                <label>
                    <span>누구에게 기다리나요?</span>
                    <input id="waiting-delegation-person" maxlength="80" placeholder="예: 김 담당자">
                </label>
                <label>
                    <span>언제 다시 확인할까요?</span>
                    <input id="waiting-delegation-due" type="datetime-local" required>
                </label>
                <button class="planner-addon-primary" type="submit">이 일 맡기기</button>
            </form>
            <div class="waiting-delegation-summary" id="waiting-delegation-summary" aria-live="polite"></div>
            <div class="waiting-delegation-list" id="waiting-delegation-list"></div>
        `;

        const contactCard = document.createElement('section');
        contactCard.className = 'planner-addon-card context-contact-card';
        contactCard.id = 'context-contact-card';
        contactCard.innerHTML = `
            <div class="planner-addon-card-head">
                <div>
                    <span class="planner-addon-eyebrow">CONTEXT-AWARE CONTACT</span>
                    <h3>상황별 연락 준비</h3>
                    <p>상대와 목적, 기다린 시간과 일정 영향을 반영해 바로 보낼 수 있는 연락문을 AI 비서가 준비합니다.</p>
                </div>
                <span class="planner-addon-value-chip">연락 스트레스 절약</span>
            </div>
            <div class="context-contact-grid">
                <label>
                    <span>연락할 상대</span>
                    <input id="context-contact-person" maxlength="80" placeholder="예: 거래처 김 담당자">
                </label>
                <label>
                    <span>관계</span>
                    <select id="context-contact-relation">
                        <option value="업무 담당자">업무 담당자</option>
                        <option value="상사">상사</option>
                        <option value="동료">동료</option>
                        <option value="고객">고객</option>
                        <option value="선생님·교수">선생님·교수</option>
                        <option value="가족·지인">가족·지인</option>
                        <option value="기타">기타</option>
                    </select>
                </label>
                <label>
                    <span>말투</span>
                    <select id="context-contact-tone">
                        <option value="정중하고 간결하게">정중하고 간결하게</option>
                        <option value="부드럽고 배려 있게">부드럽고 배려 있게</option>
                        <option value="친근하고 자연스럽게">친근하고 자연스럽게</option>
                        <option value="단호하지만 예의 있게">단호하지만 예의 있게</option>
                    </select>
                </label>
                <label class="context-contact-wide">
                    <span>현재 상황</span>
                    <textarea id="context-contact-situation" rows="3" maxlength="600" placeholder="예: 어제까지 받기로 한 견적 답변이 아직 없고, 오늘 오후 일정 확정에 필요합니다."></textarea>
                </label>
                <label class="context-contact-wide">
                    <span>원하는 결과</span>
                    <input id="context-contact-goal" maxlength="180" placeholder="예: 오늘 오전 중 가능 여부와 회신 시각 확인">
                </label>
            </div>
            <div class="context-contact-actions">
                <span id="context-contact-status">입력한 내용은 이 기기에 임시 저장됩니다.</span>
                <button class="planner-addon-primary" id="context-contact-request" type="button">AI 비서에게 연락문 요청</button>
            </div>
        `;
        legacyShell.append(waitingCard, contactCard);

        function persist() {
            const active = [...workspace.querySelectorAll('.card-workspace-item')].map((item) => item.dataset.cardId);
            const sizes = {};
            registry.forEach((entry, id) => { sizes[id] = entry.wrapper.dataset.cardSize; });
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ active, sizes }));
        }

        function createControl(definition) {
            const control = document.createElement('div');
            control.className = 'card-workspace-control';
            control.setAttribute('aria-label', `${definition.label} 카드 크기와 보관 설정`);
            control.innerHTML = `
                <button type="button" data-card-size-choice="compact">작게</button>
                <button type="button" data-card-size-choice="standard">보통</button>
                <button type="button" data-card-size-choice="wide">넓게</button>
                <button class="card-store-button" type="button" data-card-store="true" aria-label="${definition.label} 카드를 보관함으로 보내기" title="보관함으로 보내기">보관함</button>
            `;
            return control;
        }

        function updateSizeButtons(entry) {
            entry.control.querySelectorAll('[data-card-size-choice]').forEach((button) => {
                button.classList.toggle('is-active', button.dataset.cardSizeChoice === entry.wrapper.dataset.cardSize);
            });
        }

        CARD_DEFINITIONS.forEach((definition) => {
            const element = document.querySelector(definition.selector);
            if (!element) return;
            const wrapper = document.createElement('div');
            const control = createControl(definition);
            wrapper.className = 'card-workspace-item';
            wrapper.dataset.cardId = definition.id;
            wrapper.dataset.cardSize = ['compact', 'standard', 'wide'].includes(state.sizes[definition.id])
                ? state.sizes[definition.id]
                : definition.size;
            element.insertAdjacentElement('beforebegin', wrapper);
            wrapper.append(element, control);
            registry.set(definition.id, { definition, element, wrapper, control });
            updateSizeButtons(registry.get(definition.id));
        });

        function renderFolder() {
            const grid = document.getElementById('card-folder-grid');
            const stored = CARD_DEFINITIONS.filter((definition) => {
                const entry = registry.get(definition.id);
                return entry && entry.wrapper.parentElement === parking;
            });
            document.getElementById('card-folder-count').textContent = `(${stored.length})`;
            grid.replaceChildren();
            if (!stored.length) {
                const empty = document.createElement('div');
                empty.className = 'card-folder-empty';
                empty.textContent = '모든 기능 카드가 화면에 나와 있습니다.';
                grid.append(empty);
                return;
            }
            stored.forEach((definition) => {
                const tile = document.createElement('button');
                tile.className = 'card-folder-tile';
                tile.type = 'button';
                tile.dataset.cardRestore = definition.id;
                tile.setAttribute('aria-label', `${definition.label} 카드를 화면으로 꺼내기`);
                tile.innerHTML = `
                    <span class="card-folder-mini-icon" aria-hidden="true">${definition.short}</span>
                    <span class="card-folder-mini-name">${definition.label}</span>
                `;
                grid.append(tile);
            });
        }

        function setCardActive(id, active, options = {}) {
            const entry = registry.get(id);
            if (!entry) return;
            if (active) {
                workspace.append(entry.wrapper);
                entry.wrapper.hidden = false;
                if (options.focus) {
                    window.requestAnimationFrame(() => {
                        entry.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        entry.element.setAttribute('tabindex', '-1');
                        window.setTimeout(() => entry.element.focus({ preventScroll: true }), 460);
                    });
                }
            } else {
                parking.append(entry.wrapper);
                entry.wrapper.hidden = true;
            }
            persist();
            renderFolder();
        }

        window.godsaengCardWorkspace = {
            showCard(id) {
                const entry = registry.get(id);
                if (!entry) return null;
                if (entry.wrapper.parentElement !== workspace || entry.wrapper.hidden) {
                    setCardActive(id, true);
                }
                return entry.wrapper;
            },
            getCard(id) {
                return registry.get(id)?.wrapper || null;
            }
        };

        let waitingItems = readStoredJson(WAITING_STORAGE_KEY, []);
        if (!Array.isArray(waitingItems)) waitingItems = [];

        const waitingForm = document.getElementById('waiting-delegation-form');
        const waitingTitle = document.getElementById('waiting-delegation-title');
        const waitingPerson = document.getElementById('waiting-delegation-person');
        const waitingDue = document.getElementById('waiting-delegation-due');
        const waitingSummary = document.getElementById('waiting-delegation-summary');
        const waitingList = document.getElementById('waiting-delegation-list');
        const contactPerson = document.getElementById('context-contact-person');
        const contactRelation = document.getElementById('context-contact-relation');
        const contactTone = document.getElementById('context-contact-tone');
        const contactSituation = document.getElementById('context-contact-situation');
        const contactGoal = document.getElementById('context-contact-goal');
        const contactStatus = document.getElementById('context-contact-status');
        let workspacePersistTimer = null;
        document.body.dataset.workspacePersistence = typeof window.persistPlannerState === 'function' ? 'server' : 'local';

        function queueWorkspaceServerPersist(reason) {
            window.clearTimeout(workspacePersistTimer);
            workspacePersistTimer = window.setTimeout(() => {
                if (typeof window.persistPlannerState === 'function') {
                    void window.persistPlannerState(reason);
                }
            }, 180);
        }

        function saveWaitingItems() {
            localStorage.setItem(WAITING_STORAGE_KEY, JSON.stringify(waitingItems));
            queueWorkspaceServerPersist('waiting-delegation');
        }

        function saveContactContext() {
            localStorage.setItem(CONTACT_STORAGE_KEY, JSON.stringify({
                person: contactPerson.value.trim(),
                relation: contactRelation.value,
                tone: contactTone.value,
                situation: contactSituation.value.trim(),
                goal: contactGoal.value.trim()
            }));
            queueWorkspaceServerPersist('context-contact');
        }

        function restoreContactContext() {
            const saved = readStoredJson(CONTACT_STORAGE_KEY, {});
            if (!saved || typeof saved !== 'object') return;
            contactPerson.value = String(saved.person || '');
            contactRelation.value = String(saved.relation || '업무 담당자');
            contactTone.value = String(saved.tone || '정중하고 간결하게');
            contactSituation.value = String(saved.situation || '');
            contactGoal.value = String(saved.goal || '');
        }

        function buildContactPrompt() {
            const person = contactPerson.value.trim() || '상대방';
            const situation = contactSituation.value.trim();
            const goal = contactGoal.value.trim();
            return [
                '다음 연락문을 바로 복사해 보낼 수 있도록 작성해 주세요.',
                `연락할 상대: ${person}`,
                `관계: ${contactRelation.value}`,
                `말투: ${contactTone.value}`,
                `현재 상황: ${situation}`,
                `원하는 결과: ${goal}`,
                '과장하거나 없는 사실을 만들지 말고, 제목 없이 완성된 연락문 1개와 더 짧은 대안 1개만 제시해 주세요.'
            ].join('\n');
        }

        function openContactForWaiting(item) {
            if (!item) return;
            contactPerson.value = item.person || '';
            contactRelation.value = '업무 담당자';
            contactSituation.value = `${item.title}에 대한 답변을 ${formatDueAt(item.dueAt)}까지 기다렸지만 아직 확인되지 않았습니다.`;
            contactGoal.value = '진행 상황과 회신 가능한 시각을 확인하고 싶습니다.';
            saveContactContext();
            const wrapper = window.godsaengCardWorkspace.showCard('contact');
            window.requestAnimationFrame(() => {
                wrapper?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                window.setTimeout(() => contactSituation.focus({ preventScroll: true }), 460);
            });
        }

        function renderWaitingItems() {
            const now = Date.now();
            const pending = waitingItems.filter((item) => item.status !== 'received');
            const overdue = pending.filter((item) => Date.parse(item.dueAt) <= now);
            waitingSummary.innerHTML = `
                <span><strong>${pending.length}건</strong> 확인 대기</span>
                <span class="${overdue.length ? 'is-overdue' : ''}"><strong>${overdue.length}건</strong> 확인 시각 경과</span>
                <span><strong>${waitingItems.filter((item) => item.status === 'received').length}건</strong> 답 도착</span>
            `;
            if (!waitingItems.length) {
                waitingList.innerHTML = '<div class="planner-addon-empty">기다리는 일을 등록하면 확인해야 할 시점과 후속 연락을 함께 관리할 수 있습니다.</div>';
                return;
            }
            waitingList.innerHTML = waitingItems
                .slice()
                .sort((a, b) => Number(a.status === 'received') - Number(b.status === 'received') || Date.parse(a.dueAt) - Date.parse(b.dueAt))
                .map((item) => {
                    const received = item.status === 'received';
                    const overdueItem = !received && Date.parse(item.dueAt) <= now;
                    const stateLabel = received ? '답 도착' : overdueItem ? '확인 필요' : '기다리는 중';
                    return `
                        <article class="waiting-delegation-item ${received ? 'is-received' : ''} ${overdueItem ? 'is-overdue' : ''}" data-waiting-id="${escapeHtml(item.id)}">
                            <div class="waiting-delegation-item-copy">
                                <div class="waiting-delegation-item-title">
                                    <span class="waiting-state-dot" aria-hidden="true"></span>
                                    <strong>${escapeHtml(item.title)}</strong>
                                    <span class="waiting-state-label">${stateLabel}</span>
                                </div>
                                <small>${escapeHtml(item.person || '상대 미지정')} · ${escapeHtml(formatDueAt(item.dueAt))}</small>
                            </div>
                            <div class="waiting-delegation-item-actions">
                                <button type="button" data-waiting-action="toggle">${received ? '다시 대기' : '답 도착'}</button>
                                ${received ? '' : '<button type="button" data-waiting-action="contact">연락 준비</button>'}
                                <button type="button" data-waiting-action="remove" aria-label="대기 항목 삭제">삭제</button>
                            </div>
                        </article>
                    `;
                }).join('');
        }

        waitingDue.value = toLocalDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
        restoreContactContext();
        renderWaitingItems();

        window.addEventListener('godsaeng:workspace-state-restored', () => {
            const restoredItems = readStoredJson(WAITING_STORAGE_KEY, []);
            waitingItems = Array.isArray(restoredItems) ? restoredItems : [];
            restoreContactContext();
            renderWaitingItems();
        });

        waitingForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const title = waitingTitle.value.trim();
            const dueAt = waitingDue.value;
            if (!title || !dueAt) return;
            waitingItems.push({
                id: createId('waiting'),
                title,
                person: waitingPerson.value.trim(),
                dueAt: new Date(dueAt).toISOString(),
                status: 'waiting',
                createdAt: new Date().toISOString()
            });
            saveWaitingItems();
            waitingForm.reset();
            waitingDue.value = toLocalDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
            renderWaitingItems();
            waitingTitle.focus();
        });

        waitingList.addEventListener('click', (event) => {
            const action = event.target.closest('[data-waiting-action]');
            const row = event.target.closest('[data-waiting-id]');
            if (!action || !row) return;
            const index = waitingItems.findIndex((item) => item.id === row.dataset.waitingId);
            if (index < 0) return;
            if (action.dataset.waitingAction === 'toggle') {
                waitingItems[index].status = waitingItems[index].status === 'received' ? 'waiting' : 'received';
                waitingItems[index].resolvedAt = waitingItems[index].status === 'received' ? new Date().toISOString() : '';
            } else if (action.dataset.waitingAction === 'contact') {
                openContactForWaiting(waitingItems[index]);
                return;
            } else if (action.dataset.waitingAction === 'remove') {
                waitingItems.splice(index, 1);
            }
            saveWaitingItems();
            renderWaitingItems();
        });

        [contactPerson, contactRelation, contactTone, contactSituation, contactGoal].forEach((field) => {
            field.addEventListener('input', saveContactContext);
            field.addEventListener('change', saveContactContext);
        });

        document.getElementById('context-contact-request').addEventListener('click', () => {
            if (!contactSituation.value.trim()) {
                contactStatus.textContent = '현재 상황을 먼저 입력해 주세요.';
                contactSituation.focus();
                return;
            }
            saveContactContext();
            const assistantWrapper = window.godsaengCardWorkspace.showCard('assistant');
            const requestInput = document.getElementById('agent-request');
            const conditionToggle = document.getElementById('assistant-condition-toggle');
            if (!assistantWrapper || !requestInput) {
                contactStatus.textContent = 'AI 비서 입력창을 찾지 못했습니다. 화면을 새로고침해 주세요.';
                return;
            }
            requestInput.value = buildContactPrompt();
            requestInput.dispatchEvent(new Event('input', { bubbles: true }));
            if (conditionToggle) conditionToggle.checked = false;
            contactStatus.textContent = 'AI 비서에게 연락문 작성을 요청하고 있습니다.';
            window.requestAnimationFrame(() => {
                assistantWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
                window.setTimeout(() => {
                    document.getElementById('generate-agent')?.click();
                    contactStatus.textContent = '연락문 요청을 보냈습니다. AI 비서 답변에서 확인해 주세요.';
                }, 520);
            });
        });

        window.setInterval(renderWaitingItems, 60 * 1000);

        CARD_DEFINITIONS.forEach((definition) => {
            const entry = registry.get(definition.id);
            if (!entry) return;
            if (state.active.includes(definition.id)) workspace.append(entry.wrapper);
            else {
                parking.append(entry.wrapper);
                entry.wrapper.hidden = true;
            }
        });

        folder.addEventListener('click', (event) => {
            const restore = event.target.closest('[data-card-restore]');
            if (restore) setCardActive(restore.dataset.cardRestore, true, { focus: true });
        });

        workspace.addEventListener('click', (event) => {
            const wrapper = event.target.closest('.card-workspace-item');
            if (!wrapper) return;
            const entry = registry.get(wrapper.dataset.cardId);
            if (!entry) return;
            const sizeButton = event.target.closest('[data-card-size-choice]');
            if (sizeButton) {
                wrapper.dataset.cardSize = sizeButton.dataset.cardSizeChoice;
                updateSizeButtons(entry);
                persist();
                return;
            }
            if (event.target.closest('[data-card-store]')) setCardActive(wrapper.dataset.cardId, false);
        });

        document.getElementById('card-edit-toggle').addEventListener('click', (event) => {
            const editing = !document.body.classList.contains('card-workspace-editing');
            document.body.classList.toggle('card-workspace-editing', editing);
            event.currentTarget.setAttribute('aria-pressed', String(editing));
            event.currentTarget.textContent = editing ? '정리 완료' : '카드 정리';
        });

        document.getElementById('card-reset-layout').addEventListener('click', () => {
            CARD_DEFINITIONS.forEach((definition) => {
                const entry = registry.get(definition.id);
                if (!entry) return;
                entry.wrapper.dataset.cardSize = definition.size;
                updateSizeButtons(entry);
                setCardActive(definition.id, DEFAULT_ACTIVE.includes(definition.id));
            });
            document.body.classList.remove('card-workspace-editing');
            const editButton = document.getElementById('card-edit-toggle');
            editButton.setAttribute('aria-pressed', 'false');
            editButton.textContent = '카드 정리';
            persist();
            renderFolder();
        });

        renderFolder();
        persist();

        const authResult = new URLSearchParams(window.location.search);
        const authState = authResult.get('auth');
        if (authState) {
            const providerNames = { google: 'Google', kakao: '카카오', naver: '네이버' };
            const providerName = providerNames[authResult.get('provider')] || '계정';
            const returnedMessage = authResult.get('message') || '';
            window.setTimeout(async () => {
                document.getElementById('auth-modal')?.classList.add('open');
                document.getElementById('auth-backdrop')?.classList.add('open');
                if (typeof window.refreshAuthState === 'function') {
                    await window.refreshAuthState();
                }
                const status = document.getElementById('auth-status');
                if (status) {
                    const authenticated = document.getElementById('auth-user-card')?.classList.contains('visible');
                    if (authState === 'success' && authenticated) {
                        status.textContent = `${providerName} 계정이 정상적으로 연결되었습니다.`;
                    } else if (authState === 'success') {
                        status.textContent = `${providerName} 로그인은 완료됐지만 로컬 세션을 확인하지 못했습니다. 다시 연결해 주세요.`;
                    } else {
                        status.textContent = returnedMessage || `${providerName} 계정 연결을 완료하지 못했습니다. 다시 시도해 주세요.`;
                    }
                }
                const cleanUrl = `${window.location.pathname}${window.location.hash}`;
                window.history.replaceState({}, document.title, cleanUrl);
            }, 80);
        }

        window.addEventListener('pageshow', () => {
            if (typeof window.refreshAuthState === 'function') {
                void window.refreshAuthState();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeCardWorkspace, { once: true });
    } else {
        initializeCardWorkspace();
    }
})();
