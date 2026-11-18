export type DiagnosticData = Record<string, string | number | boolean | null | undefined>
type OperationKind = 'page' | 'image' | 'request' | 'transport'
type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticOperation {
    id: string
    kind: OperationKind
    startedAt: number
    closed: boolean
}

interface ActiveOperation {
    id: string
    kind: OperationKind
    startedAt: number
    phase: string
    data: DiagnosticData
}

interface DiagnosticEvent {
    timestamp: number
    event: string
    operationId?: string
    elapsedMs?: number
    level: DiagnosticLevel
    visibility: string
    active: Record<OperationKind, number>
    reader: DiagnosticData
    data: DiagnosticData
}

const MAX_EVENTS = 800
const MAX_ACTIVE = 1000
const FAILURE_STORAGE_KEY = 'ehunter:diagnostics:last-failure:v1'
const LONG_WAIT_MS = 30000
const PERSIST_INTERVAL_MS = 2000
const FAILURE_FOLLOWUP_WINDOW_MS = 30000

declare const unsafeWindow: Window | undefined
declare const cloneInto: (<T>(value: T, scope: object, options?: { cloneFunctions?: boolean }) => T) | undefined

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function diagnosticError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** Observes loading without controlling requests, retries, or reader state. */
export class ImageLoadDiagnostics {
    private events: DiagnosticEvent[] = []
    private eventCursor = 0
    private eventCount = 0
    private sequence = 0
    private active = new Map<string, ActiveOperation>()
    private counts: Record<OperationKind, number> = { page: 0, image: 0, request: 0, transport: 0 }
    private readerContext: () => DiagnosticData = () => ({})
    private watcher: ReturnType<typeof setInterval> | undefined
    private lastLongWaitAt = -Infinity
    private lastPersistAt = -Infinity
    private lastFailureAt = -Infinity
    private pendingFailure: DiagnosticEvent | undefined
    private persistenceTimer: ReturnType<typeof setTimeout> | undefined
    private persistenceDirty = false
    private sessionStartedAt = Date.now()

    constructor() {
        if (typeof window === 'undefined') {
            return
        }
        try {
            const host = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
            const share = <T>(value: T): T => typeof cloneInto === 'function' && value !== null && typeof value === 'object'
                ? cloneInto(value, host) : value
            const api = {
                snapshot: () => share(this.snapshot()),
                getLogs: () => share(this.recentEvents()),
                getLastFailure: () => share(this.lastFailure()),
                export: () => {
                    this.flushFailureSnapshot()
                    return JSON.stringify({ current: this.snapshot(), lastFailure: this.lastFailure() }, null, 2)
                },
            }
            const sharedApi = typeof cloneInto === 'function' ? cloneInto(api, host, { cloneFunctions: true }) : api
            ;(host as Window & { __EHUNTER_DIAGNOSTICS__?: typeof api }).__EHUNTER_DIAGNOSTICS__ = sharedApi
            console.info('[EHunter Diagnostics] 自动记录已启用；报告：__EHUNTER_DIAGNOSTICS__.export()')
        } catch {
            // A restricted window must not prevent the reader from loading.
        }
        window.addEventListener('pagehide', () => this.flushFailureSnapshot())
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.flushFailureSnapshot()
            }
        })
    }

    setReaderContext(provider: () => DiagnosticData): void {
        this.readerContext = provider
    }

    start(kind: OperationKind, data: DiagnosticData): DiagnosticOperation {
        const operation = { id: `${kind}-${++this.sequence}`, kind, startedAt: now(), closed: false }
        this.counts[kind]++
        if (this.active.size >= MAX_ACTIVE) {
            this.active.delete(this.active.keys().next().value)
        }
        this.active.set(operation.id, { ...operation, phase: `${kind}.start`, data: this.clean(data) })
        this.record(`${kind}.start`, data, 'info', operation)
        if (!this.watcher) {
            this.watcher = setInterval(() => this.checkLongWait(), 10000)
        }
        return operation
    }

    stage(operation: DiagnosticOperation, event: string, data: DiagnosticData = {}, level: DiagnosticLevel = 'info'): void {
        const active = this.active.get(operation.id)
        if (active) {
            active.phase = event
            active.data = { ...active.data, ...this.clean(data) }
        }
        this.record(event, data, level, operation)
    }

    finish(operation: DiagnosticOperation, event: string, data: DiagnosticData = {}, level: DiagnosticLevel = 'info'): void {
        if (operation.closed) {
            return
        }
        operation.closed = true
        this.active.delete(operation.id)
        this.counts[operation.kind]--
        this.record(event, data, level, operation)
        if (Object.values(this.counts).every(count => count === 0) && this.watcher) {
            clearInterval(this.watcher)
            this.watcher = undefined
        }
    }

    record(event: string, data: DiagnosticData = {}, level: DiagnosticLevel = 'info', operation?: DiagnosticOperation): void {
        const entry: DiagnosticEvent = {
            timestamp: Date.now(), event, level,
            operationId: operation?.id,
            elapsedMs: operation ? Math.round(now() - operation.startedAt) : undefined,
            visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
            active: { ...this.counts }, reader: this.context(), data: this.clean(data),
        }
        this.events[this.eventCursor] = entry
        this.eventCursor = (this.eventCursor + 1) % MAX_EVENTS
        this.eventCount++
        // Healthy requests stay in the bounded buffer instead of flooding Console.
        if (level !== 'info') {
            try {
                console[level]('[EHunter Diagnostics]', JSON.stringify(entry))
            } catch {
                // Diagnostics must remain harmless when Console is unavailable.
            }
            this.pendingFailure = entry
            this.lastFailureAt = now()
        }
        if (this.pendingFailure && (level !== 'info' || now() - this.lastFailureAt <= FAILURE_FOLLOWUP_WINDOW_MS)) {
            // Include late callbacks and completion events within a bounded window after an anomaly.
            this.persistenceDirty = true
            this.scheduleFailureSnapshot()
        }
    }

    snapshot(eventLimit = MAX_EVENTS, activeLimit = 200) {
        const active = Array.from(this.active.values()).slice(0, activeLimit).map(item => ({
            id: item.id, kind: item.kind, phase: item.phase,
            elapsedMs: Math.round(now() - item.startedAt), data: { ...item.data },
        }))
        return {
            schemaVersion: 1, sessionStartedAt: this.sessionStartedAt, timestamp: Date.now(),
            path: typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`,
            visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
            reader: this.context(), activeCounts: { ...this.counts }, active,
            activeOmitted: Object.values(this.counts).reduce((sum, count) => sum + count, 0) - active.length,
            events: this.recentEvents().slice(-eventLimit),
            eventsOmitted: Math.max(0, this.eventCount - Math.min(eventLimit, this.events.length)),
            pages: this.pageSnapshot(),
        }
    }

    private clean(data: DiagnosticData): DiagnosticData {
        const result: DiagnosticData = {}
        for (const [key, value] of Object.entries(data)) {
            result[key] = typeof value === 'string' ? value.slice(0, 1200) : value
        }
        return result
    }

    private context(): DiagnosticData {
        try {
            return this.clean(this.readerContext())
        } catch {
            return {}
        }
    }

    private recentEvents(): DiagnosticEvent[] {
        const events = this.events.length < MAX_EVENTS ? this.events : this.events.slice(this.eventCursor).concat(this.events.slice(0, this.eventCursor))
        // Return detached values so Console callers cannot mutate the live buffer.
        return events.map(event => ({ ...event, active: { ...event.active }, reader: { ...event.reader }, data: { ...event.data } }))
    }

    private checkLongWait(): void {
        const current = now()
        if (current - this.lastLongWaitAt < LONG_WAIT_MS) {
            return
        }
        const waiting = Array.from(this.active.values()).filter(item => current - item.startedAt >= LONG_WAIT_MS)
        if (waiting.length > 0) {
            this.lastLongWaitAt = current
            this.record('pending.long-wait', {
                count: waiting.length, oldestMs: Math.round(current - waiting[0].startedAt),
            }, 'warn')
        }
    }

    private pageSnapshot() {
        const pages: Array<Record<string, string | number | boolean | null>> = []
        if (typeof document === 'undefined') {
            return pages
        }
        try {
            for (const page of document.querySelectorAll<HTMLElement>('#ehunter-app .page-view')) {
                if (page.closest<HTMLElement>('.book-spread')?.style.display === 'none' || page.closest('.preload')) {
                    continue
                }
                const rect = page.getBoundingClientRect()
                if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
                    continue
                }
                const img = page.querySelector<HTMLImageElement>('img.album-item')
                pages.push({
                    page: page.querySelector('.index')?.textContent || '',
                    status: page.querySelector('.loading-info .text')?.textContent || '',
                    hasImg: !!img, hasSrc: !!img?.getAttribute('src'),
                    complete: img?.complete ?? null, naturalWidth: img?.naturalWidth ?? null,
                })
                if (pages.length >= 8) {
                    break
                }
            }
        } catch {
            // The host page may be navigating while an error is recorded.
        }
        return pages
    }

    private scheduleFailureSnapshot(): void {
        const remaining = PERSIST_INTERVAL_MS - (now() - this.lastPersistAt)
        if (remaining <= 0) {
            this.flushFailureSnapshot()
            return
        }
        if (this.persistenceTimer === undefined) {
            this.persistenceTimer = setTimeout(() => {
                this.persistenceTimer = undefined
                this.flushFailureSnapshot()
            }, remaining)
        }
    }

    private flushFailureSnapshot(): void {
        if (this.persistenceTimer !== undefined) {
            clearTimeout(this.persistenceTimer)
            this.persistenceTimer = undefined
        }
        if (typeof window === 'undefined' || !this.pendingFailure || !this.persistenceDirty) {
            return
        }
        this.lastPersistAt = now()
        this.persistenceDirty = false
        try {
            window.localStorage.setItem(FAILURE_STORAGE_KEY, JSON.stringify({
                failure: this.pendingFailure, ...this.snapshot(),
            }))
        } catch {
            // Storage denial/quota must not change request results.
        }
    }

    private lastFailure(): unknown {
        try {
            return JSON.parse(window.localStorage.getItem(FAILURE_STORAGE_KEY) || 'null')
        } catch {
            return null
        }
    }
}

export const imageLoadDiagnostics = new ImageLoadDiagnostics()
