(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GodPlanWakePhrase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const aliases = [
        '헤이갓플', '해이갓플', '에이갓플', '헤이갇플', '헤이갓풀',
        '헤이갓불', '헤이갓블', '헤이갓벌', '헤이각플', '헤이갓프',
        '헤이갓플아', '헤이갓플이', '헤이가스플', '헤이갓플러'
    ];
    const sensitiveAliases = ['헤갓플', '해갓플', '에갓플'];

    function normalize(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function compact(value) {
        return normalize(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
    }

    function editDistance(left, right) {
        const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
        for (let row = 1; row <= left.length; row += 1) {
            let diagonal = previous[0];
            previous[0] = row;
            for (let column = 1; column <= right.length; column += 1) {
                const above = previous[column];
                previous[column] = Math.min(
                    previous[column] + 1,
                    previous[column - 1] + 1,
                    diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
                );
                diagonal = above;
            }
        }
        return previous[right.length];
    }

    function matchWakePhrase(value, options = {}) {
        const transcript = normalize(value);
        const direct = transcript.match(/^(?:저기\s*)?(?:헤이|해이|에이)\s*(?:갓|갇|갔|가스)\s*(?:플|풀|불|플이|플아|플러)[\s,，.!?]*/i);
        if (direct) return { matched: true, command: transcript.slice(direct[0].length).trim(), confidence: 1 };
        if (options.sensitive) {
            const quietVoice = transcript.match(/^(?:저기\s*)?(?:헤이|해이|에이|헤|해|에)\s*(?:갓|갇|갔|각|가스)\s*(?:플|풀|불|블|벌|뾔|프|플러)[\s,，.!?]*/i);
            if (quietVoice) return { matched: true, command: transcript.slice(quietVoice[0].length).trim(), confidence: 0.86 };
        }
        const english = transcript.match(/^(?:hey)\s*(?:god\s*plan|godplan|got\s*plan|godple)[\s,，.!?]*/i);
        if (english) return { matched: true, command: transcript.slice(english[0].length).trim(), confidence: 0.94 };
        const normalized = compact(transcript);
        if (!normalized || !/^(?:헤|해|에|hey)/.test(normalized)) return { matched: false, command: '', confidence: 0 };

        let best = null;
        const activeAliases = options.sensitive ? [...aliases, ...sensitiveAliases] : aliases;
        activeAliases.forEach((alias) => {
            for (let length = Math.max(3, alias.length - 1); length <= Math.min(normalized.length, alias.length + 1); length += 1) {
                const distance = editDistance(normalized.slice(0, length), alias);
                const threshold = alias.length <= 4 ? 1 : (options.sensitive ? 3 : 2);
                if (distance <= threshold && (!best || distance < best.distance)) best = { distance, length, alias };
            }
        });
        if (!best) return { matched: false, command: '', confidence: 0 };
        return {
            matched: true,
            command: normalized.slice(best.length).trim(),
            confidence: Math.max(0.7, 1 - best.distance / best.alias.length)
        };
    }

    return { aliases: [...aliases], sensitiveAliases: [...sensitiveAliases], editDistance, matchWakePhrase };
});
