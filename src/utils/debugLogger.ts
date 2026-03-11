/**
 * EchoMind Debug Logger
 * 
 * Toggleable logging system for monitoring execution flow.
 * Enable/disable via browser console:
 *   window.__ECHOMIND_DEBUG = true;   // Enable all logs
 *   window.__ECHOMIND_DEBUG = false;  // Disable all logs
 * 
 * Or enable specific categories:
 *   window.__ECHOMIND_DEBUG_CATEGORIES = ['flow', 'audio', 'praat', 'match'];
 * 
 * Categories:
 *   flow   — Overall execution flow, state transitions, connect/disconnect
 *   audio  — Audio buffering, chunk counts, AI ref audio saving
 *   praat  — Praat analysis triggers, results, API calls
 *   match  — Word matching, target word detection, recognition
 *   buffer — Buffer size, memory, push/flush/clear events
 *   error  — Errors and warnings (always enabled)
 */

export type DebugCategory = 'flow' | 'audio' | 'praat' | 'match' | 'buffer' | 'error';

declare global {
    interface Window {
        __ECHOMIND_DEBUG: boolean;
        __ECHOMIND_DEBUG_CATEGORIES: DebugCategory[];
        __echoDebug: {
            enable: () => void;
            disable: () => void;
            enableCategory: (...cats: DebugCategory[]) => void;
            status: () => void;
            snapshot: () => void;
            monitor: (intervalMs?: number) => void;
            monitorRef: (intervalMs?: number) => void;
        };
    }
}

const CATEGORY_STYLES: Record<DebugCategory, string> = {
    flow: 'color: #60a5fa; font-weight: bold',     // blue
    audio: 'color: #818cf8; font-weight: bold',      // indigo
    praat: 'color: #a78bfa; font-weight: bold',      // violet
    match: 'color: #34d399; font-weight: bold',      // emerald
    buffer: 'color: #fb923c; font-weight: bold',     // orange
    error: 'color: #f87171; font-weight: bold',      // red
};

const CATEGORY_ICONS: Record<DebugCategory, string> = {
    flow: '🔄',
    audio: '🔊',
    praat: '🔬',
    match: '🎯',
    buffer: '📦',
    error: '❌',
};

// Internal state tracker for snapshot
interface DebugState {
    sessionActive: boolean;
    aiTurnActive: boolean;
    isBuffering: boolean;
    isMuted: boolean;
    userChunkCount: number;
    aiChunkCount: number;
    targetWord: string | null;
    lastRefChunkCount: number;
    skipNextAnalysis: boolean;
    isPraatResponse: boolean;
    lastAnalysisTime: number | null;
    lastMatchResult: string | null;
    turnCount: number;
    analysisCount: number;
    errorCount: number;
    lastError: string | null;
    // Buffer monitoring
    bufferMemoryKB: number;
    bufferDurationSec: number;
    bufferPeakChunks: number;
    bufferFlushCount: number;
    bufferClearCount: number;
    praatDebounceActive: boolean;
    // AI Ref monitoring
    refSavedCount: number;
    refDiscardedCount: number;
    refKeptCount: number;
    refClearedByWordChange: number;
    lastRefAction: string | null;
    lastRefTimestamp: number | null;
}

const _state: DebugState = {
    sessionActive: false,
    aiTurnActive: false,
    isBuffering: false,
    isMuted: false,
    userChunkCount: 0,
    aiChunkCount: 0,
    targetWord: null,
    lastRefChunkCount: 0,
    skipNextAnalysis: false,
    isPraatResponse: false,
    lastAnalysisTime: null,
    lastMatchResult: null,
    turnCount: 0,
    analysisCount: 0,
    errorCount: 0,
    lastError: null,
    bufferMemoryKB: 0,
    bufferDurationSec: 0,
    bufferPeakChunks: 0,
    bufferFlushCount: 0,
    bufferClearCount: 0,
    praatDebounceActive: false,
    refSavedCount: 0,
    refDiscardedCount: 0,
    refKeptCount: 0,
    refClearedByWordChange: 0,
    lastRefAction: null,
    lastRefTimestamp: null,
};

function isEnabled(category: DebugCategory): boolean {
    if (category === 'error') return true; // errors always logged

    if (typeof window === 'undefined') return false;

    if (window.__ECHOMIND_DEBUG === true) return true;

    if (Array.isArray(window.__ECHOMIND_DEBUG_CATEGORIES)) {
        return window.__ECHOMIND_DEBUG_CATEGORIES.includes(category);
    }

    return false;
}

export function dbg(category: DebugCategory, message: string, ...args: any[]) {
    if (!isEnabled(category)) return;

    const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const icon = CATEGORY_ICONS[category];
    const style = CATEGORY_STYLES[category];
    const prefix = `[${timestamp}] ${icon} [${category.toUpperCase()}]`;

    if (args.length > 0) {
        console.log(`%c${prefix} ${message}`, style, ...args);
    } else {
        console.log(`%c${prefix} ${message}`, style);
    }
}

// State update helpers
export function dbgUpdateState(updates: Partial<DebugState>) {
    Object.assign(_state, updates);
}

export function dbgGetState(): Readonly<DebugState> {
    return { ..._state };
}

// Convenience: log state transition
export function dbgStateTransition(category: DebugCategory, from: string, to: string, context?: string) {
    dbg(category, `STATE: ${from} → ${to}${context ? ` (${context})` : ''}`);
}

// Convenience: log with timing
export function dbgTimed(category: DebugCategory, label: string): () => void {
    const t0 = performance.now();
    dbg(category, `⏱️ START: ${label}`);
    return () => {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        dbg(category, `⏱️ END: ${label} (${elapsed}s)`);
    };
}

// ═══════════════════════════════════════════════
// Buffer monitor — periodic buffer status reporter
// ═══════════════════════════════════════════════
let _bufferMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startBufferMonitor(intervalMs: number = 5000) {
    stopBufferMonitor();
    console.log(`%c📦 Buffer Monitor: STARTED (every ${intervalMs / 1000}s)`, 'color: #fb923c; font-weight: bold; font-size: 14px');
    _bufferMonitorInterval = setInterval(() => {
        if (!_state.sessionActive) return;
        const s = _state;
        const bar = '█'.repeat(Math.min(50, Math.round(s.userChunkCount / 2))) + '░'.repeat(Math.max(0, 50 - Math.round(s.userChunkCount / 2)));
        console.log(
            `%c📦 [BUFFER] ${bar} ${s.userChunkCount} chunks (${s.bufferDurationSec.toFixed(1)}s, ${s.bufferMemoryKB.toFixed(0)}KB) | ` +
            `buffering=${s.isBuffering ? '🟢ON' : '🔴OFF'} muted=${s.isMuted ? '🔇' : '🔊'} | ` +
            `target="${s.targetWord || '-'}" | peak=${s.bufferPeakChunks} | flush#${s.bufferFlushCount} clear#${s.bufferClearCount}` +
            `${s.praatDebounceActive ? ' | ⏳DEBOUNCE' : ''}`,
            'color: #fb923c; font-size: 11px'
        );
    }, intervalMs);
}

export function stopBufferMonitor() {
    if (_bufferMonitorInterval) {
        clearInterval(_bufferMonitorInterval);
        _bufferMonitorInterval = null;
        console.log(`%c📦 Buffer Monitor: STOPPED`, 'color: #fb923c; font-weight: bold');
    }
}

// ═══════════════════════════════════════════════
// AI Ref monitor — tracks AI reference audio lifecycle
// ═══════════════════════════════════════════════
let _refMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startRefMonitor(intervalMs: number = 3000) {
    stopRefMonitor();
    console.log(`%c🎙️ AI Ref Monitor: STARTED (every ${intervalMs / 1000}s)`, 'color: #818cf8; font-weight: bold; font-size: 14px');
    console.log(`%c   Tracks: ref SAVED / DISCARDED / KEPT / CLEARED events`, 'color: #818cf8; font-style: italic');
    _refMonitorInterval = setInterval(() => {
        if (!_state.sessionActive) return;
        const s = _state;
        const refDurSec = (s.lastRefChunkCount * 0.04).toFixed(1);
        const timeSinceRef = s.lastRefTimestamp ? `${((Date.now() - s.lastRefTimestamp) / 1000).toFixed(0)}s ago` : 'never';
        const actionEmoji = {
            'SAVED': '💾',
            'DISCARDED': '🗑️',
            'KEPT': '⏭️',
            'CLEARED': '🧹',
        }[s.lastRefAction?.split(':')[0] || ''] || '—';

        console.log(
            `%c🎙️ [AI REF] ` +
            `${s.lastRefChunkCount > 0 ? '🟢' : '🔴'} ${s.lastRefChunkCount} chunks (~${refDurSec}s) | ` +
            `target="${s.targetWord || '-'}" | ` +
            `isPraatResp=${s.isPraatResponse ? '⚠️YES' : 'no'} skip=${s.skipNextAnalysis ? '⚠️YES' : 'no'} | ` +
            `last: ${actionEmoji} ${s.lastRefAction || '(none)'} (${timeSinceRef}) | ` +
            `saved#${s.refSavedCount} disc#${s.refDiscardedCount} kept#${s.refKeptCount} cleared#${s.refClearedByWordChange}`,
            'color: #818cf8; font-size: 11px'
        );
    }, intervalMs);
}

export function stopRefMonitor() {
    if (_refMonitorInterval) {
        clearInterval(_refMonitorInterval);
        _refMonitorInterval = null;
        console.log(`%c🎙️ AI Ref Monitor: STOPPED`, 'color: #818cf8; font-weight: bold');
    }
}

// Setup window helpers (call once on app mount)
export function setupDebugHelpers() {
    if (typeof window === 'undefined') return;

    window.__echoDebug = {
        enable: () => {
            window.__ECHOMIND_DEBUG = true;
            startBufferMonitor(5000);
            startRefMonitor(3000);
            console.log('%c🔧 EchoMind Debug: ALL ON (logs + buffer monitor + ref monitor)', 'color: #34d399; font-weight: bold; font-size: 14px');
            console.log('  Disable: window.__echoDebug.disable()');
        },
        disable: () => {
            window.__ECHOMIND_DEBUG = false;
            window.__ECHOMIND_DEBUG_CATEGORIES = [];
            stopBufferMonitor();
            stopRefMonitor();
            console.log('%c🔧 EchoMind Debug: ALL OFF (errors still shown)', 'color: #f59e0b; font-weight: bold; font-size: 14px');
        },
        enableCategory: (...cats: DebugCategory[]) => {
            window.__ECHOMIND_DEBUG = false;
            window.__ECHOMIND_DEBUG_CATEGORIES = cats;
            console.log(`%c🔧 EchoMind Debug: Enabled categories: [${cats.join(', ')}]`, 'color: #34d399; font-weight: bold');
        },
        status: () => {
            const enabled = window.__ECHOMIND_DEBUG;
            const cats = window.__ECHOMIND_DEBUG_CATEGORIES || [];
            console.log('%c🔧 EchoMind Debug Status:', 'font-weight: bold; font-size: 14px');
            console.log(`  All logs: ${enabled ? '✅ ENABLED' : '❌ DISABLED'}`);
            console.log(`  Categories: ${cats.length > 0 ? cats.join(', ') : '(none)'}`);
            console.log(`  Session: ${_state.sessionActive ? '✅ Connected' : '❌ Disconnected'}`);
            console.log(`  AI Turn: ${_state.aiTurnActive ? '🗣️ Active' : '🔇 Inactive'}`);
            console.log(`  Buffering: ${_state.isBuffering ? '🟢 ON' : '🔴 OFF'} | Muted: ${_state.isMuted ? '🔇 Yes' : '🔊 No'}`);
            console.log(`  Buffer: ${_state.userChunkCount} chunks (${_state.bufferDurationSec.toFixed(1)}s, ${_state.bufferMemoryKB.toFixed(0)}KB) | Peak: ${_state.bufferPeakChunks}`);
            console.log(`  Target Word: ${_state.targetWord || '(none)'}`);
            console.log(`  Praat Debounce: ${_state.praatDebounceActive ? '⏳ Active' : '— Inactive'}`);
            console.log(`  Flushes: ${_state.bufferFlushCount} | Clears: ${_state.bufferClearCount}`);
            console.log(`  Turns: ${_state.turnCount} | Analyses: ${_state.analysisCount} | Errors: ${_state.errorCount}`);
        },
        snapshot: () => {
            console.log('%c📸 EchoMind State Snapshot:', 'font-weight: bold; font-size: 14px');
            console.table(_state);
        },
        monitor: (intervalMs: number = 5000) => {
            if (_bufferMonitorInterval) {
                stopBufferMonitor();
            } else {
                startBufferMonitor(intervalMs);
            }
        },
        monitorRef: (intervalMs: number = 3000) => {
            if (_refMonitorInterval) {
                stopRefMonitor();
            } else {
                startRefMonitor(intervalMs);
            }
        },
    };

    // Print help on load
    console.log(
        '%c🔧 EchoMind Debug available. Commands:\n' +
        '  window.__echoDebug.enable()           — Enable all logs\n' +
        '  window.__echoDebug.enableCategory("buffer") — Enable specific category\n' +
        '  window.__echoDebug.monitor()           — Toggle buffer monitor (5s interval)\n' +
        '  window.__echoDebug.monitor(2000)       — Buffer monitor with custom interval\n' +
        '  window.__echoDebug.monitorRef()        — Toggle AI ref monitor (3s interval)\n' +
        '  window.__echoDebug.monitorRef(1000)    — AI ref monitor with custom interval\n' +
        '  window.__echoDebug.snapshot()          — Show full state snapshot\n' +
        '  window.__echoDebug.status()            — Show quick status',
        'color: #a78bfa; font-style: italic'
    );
}
