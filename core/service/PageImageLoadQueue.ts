import { nextTick, reactive } from 'vue'
import { ImgSrcMode, type ImgPageInfo } from '../model/model'
import type { AlbumService } from './AlbumService'

type LoadResult = ImgPageInfo | Error | undefined

export interface PreloadImageLike {
    decoding: string
    src: string
    complete: boolean
    naturalWidth: number
    onload: ((this: unknown, ev?: unknown) => unknown) | null
    onerror: ((this: unknown, ev?: unknown) => unknown) | null
    removeAttribute?: (qualifiedName: string) => void
}

export interface PageImageLoadQueueOptions {
    albumService: AlbumService
    getCurrentIndex: () => number
    getVisibleIndices?: () => number[]
    getPreloadIndices?: () => number[]
    getLoadedSrc?: (index: number) => string
    onResolved?: (index: number, info: ImgPageInfo, mode: ImgSrcMode) => void
    onFallbackError?: (index: number, error: unknown) => void
    canFallbackSource?: (index: number) => boolean
    maxConcurrentUrlRequests?: number
    maxConcurrentAssetPreloads?: number
    maxBufferedAssetUrls?: number | (() => number)
    maxRetainedPreloadImages?: number | (() => number)
    assetPreloadTimeoutMs?: number
    initialLoadGraceMs?: number
    backgroundCooldownMs?: number
    createPreloadImage?: () => PreloadImageLike | null
    isDocumentComplete?: () => boolean
    fetchPreload?: (src: string, signal?: AbortSignal) => Promise<boolean>
}

interface PageLoadTask {
    index: number
    mode?: ImgSrcMode
    forceRefresh?: boolean
    isActive: Array<() => boolean>
    promise: Promise<LoadResult>
    resolve: (result: LoadResult) => void
    reject: (error: unknown) => void
}

interface ActiveAssetLoad {
    index: number
    src: string
    cleanup: () => void
    cancel: () => void
}

export class PageImageLoadQueue {
    private albumService: AlbumService
    private getCurrentIndex: () => number
    private getVisibleIndices: () => number[]
    private getPreloadIndices: () => number[]
    private getLoadedSrc: (index: number) => string
    private onResolved?: (index: number, info: ImgPageInfo, mode: ImgSrcMode) => void
    private onFallbackError?: (index: number, error: unknown) => void
    private canFallbackSource: (index: number) => boolean
    private maxConcurrentUrlRequests: number
    private maxConcurrentAssetPreloads: number
    private maxBufferedAssetUrlsOption: number | (() => number)
    private maxRetainedPreloadImagesOption: number | (() => number)
    private assetPreloadTimeoutMs: number
    private backgroundCooldownMs: number
    private createPreloadImage: () => PreloadImageLike | null
    private isDocumentComplete: () => boolean
    private fetchPreload: (src: string, signal?: AbortSignal) => Promise<boolean>

    private requests = new Map<number, PageLoadTask>()
    private pendingUrl = new Map<number, PageLoadTask>()
    private inFlightUrls = new Set<number>()
    private urlLoadingCount = 0
    private scheduled = false

    private visibleImageLoading = new Set<number>()
    private assetReadySrc = reactive(new Map<number, string>())
    private failedAssetSrc = new Map<number, string>()
    private fallbackAttempted = new Set<number>()
    private pendingAsset = new Map<number, { index: number; src: string }>()
    private activeAssetLoads = new Map<number, ActiveAssetLoad>()
    private retainedImages = new Map<number, { src: string; img: PreloadImageLike }>()

    private documentComplete = true
    private initialGraceElapsed = true
    private initialGraceTimer: ReturnType<typeof setTimeout> | null = null
    private cleanupInitialListeners: (() => void) | null = null
    private lastObservedCurrentIndex: number | null = null
    private backgroundPausedUntil = 0
    private cooldownTimer: ReturnType<typeof setTimeout> | null = null

    constructor(
        optionsOrService: PageImageLoadQueueOptions | AlbumService,
        getCurrentIndexArg?: () => number,
        maxConcurrentArg = 3,
        getVisibleIndicesArg?: () => number[],
    ) {
        const options: PageImageLoadQueueOptions = typeof (optionsOrService as AlbumService).getImgSrc === 'function'
            ? {
                albumService: optionsOrService as AlbumService,
                getCurrentIndex: getCurrentIndexArg!,
                maxConcurrentUrlRequests: maxConcurrentArg,
                getVisibleIndices: getVisibleIndicesArg,
            }
            : (optionsOrService as PageImageLoadQueueOptions)

        this.albumService = options.albumService
        this.getCurrentIndex = options.getCurrentIndex
        this.getVisibleIndices = options.getVisibleIndices || (() => [this.getCurrentIndex()])
        this.getPreloadIndices = options.getPreloadIndices || (() => [])
        this.getLoadedSrc = options.getLoadedSrc || (() => '')
        this.onResolved = options.onResolved
        this.onFallbackError = options.onFallbackError
        this.canFallbackSource = options.canFallbackSource || (() => false)
        this.maxConcurrentUrlRequests = Math.max(1, options.maxConcurrentUrlRequests ?? 3)
        this.maxConcurrentAssetPreloads = Math.max(1, options.maxConcurrentAssetPreloads ?? 2)
        this.maxBufferedAssetUrlsOption = options.maxBufferedAssetUrls ?? 6
        this.maxRetainedPreloadImagesOption = options.maxRetainedPreloadImages ?? 8
        this.assetPreloadTimeoutMs = Math.max(1000, options.assetPreloadTimeoutMs ?? 25000)
        this.backgroundCooldownMs = Math.max(0, options.backgroundCooldownMs ?? 0)
        this.createPreloadImage = options.createPreloadImage || (() => {
            if (typeof Image === 'undefined') {
                return null
            }
            return new Image() as unknown as PreloadImageLike
        })
        this.isDocumentComplete = options.isDocumentComplete || (() => {
            if (typeof document === 'undefined') {
                return true
            }
            return document.readyState === 'complete'
        })
        this.fetchPreload = options.fetchPreload || ((src, signal) => this.defaultFetchPreload(src, signal))

        const initialGraceMs = Math.max(0, options.initialLoadGraceMs ?? 1500)
        if (!this.isDocumentComplete()) {
            this.documentComplete = false
            this.initialGraceElapsed = false
            const onReadyStateChange = () => {
                if (this.documentComplete || !this.isDocumentComplete()) {
                    return
                }
                this.documentComplete = true
                this.initialGraceElapsed = true
                this.clearInitialLoadWaiters()
                this.schedule()
            }
            const onWindowLoad = () => {
                if (this.documentComplete) {
                    return
                }
                this.documentComplete = true
                this.initialGraceElapsed = true
                this.clearInitialLoadWaiters()
                this.schedule()
            }
            if (typeof window !== 'undefined') {
                window.addEventListener('load', onWindowLoad, { once: true })
            }
            if (typeof document !== 'undefined') {
                document.addEventListener('readystatechange', onReadyStateChange)
            }
            this.cleanupInitialListeners = () => {
                if (typeof window !== 'undefined') {
                    window.removeEventListener('load', onWindowLoad)
                }
                if (typeof document !== 'undefined') {
                    document.removeEventListener('readystatechange', onReadyStateChange)
                }
            }
            this.initialGraceTimer = setTimeout(() => {
                this.initialGraceTimer = null
                if (!this.initialGraceElapsed) {
                    this.initialGraceElapsed = true
                    this.schedule()
                }
            }, initialGraceMs)
        }
    }

    request(index: number, isActive: () => boolean): Promise<LoadResult> {
        const existing = this.requests.get(index)
        if (existing) {
            existing.isActive.push(isActive)
            this.refreshPriority()
            return existing.promise
        }

        let resolve!: PageLoadTask['resolve']
        let reject!: PageLoadTask['reject']
        const promise = new Promise<LoadResult>((resolveResult, rejectResult) => {
            resolve = resolveResult
            reject = rejectResult
        })
        const task: PageLoadTask = { index, isActive: [isActive], promise, resolve, reject }
        this.requests.set(index, task)
        this.pendingUrl.set(index, task)
        this.schedule()
        return promise
    }

    refreshPriority() {
        this.schedule()
    }

    isAssetReady(index: number, src: string | undefined): boolean {
        if (!src) {
            return false
        }
        return this.assetReadySrc.get(index) === src
    }

    setVisibleImageLoading(index: number, isLoading: boolean) {
        const had = this.visibleImageLoading.has(index)
        if (isLoading) {
            this.visibleImageLoading.add(index)
            if (!had) {
                this.schedule()
            }
            return
        }
        if (had) {
            this.visibleImageLoading.delete(index)
            this.schedule()
        }
    }

    markImageLoaded(index: number, src: string) {
        this.visibleImageLoading.delete(index)
        if (src) {
            this.failedAssetSrc.delete(index)
            this.fallbackAttempted.delete(index)
            this.assetReadySrc.set(index, src)
            this.pendingAsset.delete(index)
            const active = this.activeAssetLoads.get(index)
            if (active && active.src === src) {
                active.cleanup()
                this.activeAssetLoads.delete(index)
            }
        }
        this.schedule()
    }

    invalidateAsset(index: number) {
        this.assetReadySrc.delete(index)
        this.failedAssetSrc.delete(index)
        this.fallbackAttempted.delete(index)
        this.pendingAsset.delete(index)
        this.visibleImageLoading.delete(index)
        const retained = this.retainedImages.get(index)
        if (retained) {
            this.retainedImages.delete(index)
            this.releaseImageElement(retained.img)
        }
        const active = this.activeAssetLoads.get(index)
        if (active) {
            active.cancel()
        }
    }

    private getMaxBufferedAssetUrls(): number {
        const raw = typeof this.maxBufferedAssetUrlsOption === 'function'
            ? this.maxBufferedAssetUrlsOption()
            : this.maxBufferedAssetUrlsOption
        return Math.max(2, raw)
    }

    private getMaxRetainedPreloadImages(): number {
        const raw = typeof this.maxRetainedPreloadImagesOption === 'function'
            ? this.maxRetainedPreloadImagesOption()
            : this.maxRetainedPreloadImagesOption
        return Math.max(0, raw)
    }

    private clearInitialLoadWaiters() {
        if (this.initialGraceTimer !== null) {
            clearTimeout(this.initialGraceTimer)
            this.initialGraceTimer = null
        }
        if (this.cleanupInitialListeners) {
            this.cleanupInitialListeners()
            this.cleanupInitialListeners = null
        }
    }

    private hasInitialWaitSettled(): boolean {
        if (!this.documentComplete && this.isDocumentComplete()) {
            this.documentComplete = true
            this.initialGraceElapsed = true
            this.clearInitialLoadWaiters()
        }
        return this.documentComplete || this.initialGraceElapsed
    }

    private schedule() {
        if (this.scheduled) {
            return
        }
        this.scheduled = true
        // Collect requests from all mounted/updated pages before choosing priority order.
        void nextTick().then(() => {
            this.scheduled = false
            this.drain()
        })
    }

    private canStartBackgroundPreload(visibleSet: Set<number>): boolean {
        if (!this.hasInitialWaitSettled()) {
            return false
        }
        if (this.backgroundCooldownMs > 0 && Date.now() < this.backgroundPausedUntil) {
            return false
        }
        if (this.visibleImageLoading.size > 0) {
            return false
        }
        for (const index of visibleSet) {
            if (this.pendingUrl.has(index) || this.inFlightUrls.has(index)) {
                return false
            }
        }
        return true
    }

    private trackNavigationCooldown(currentIndex: number) {
        if (this.lastObservedCurrentIndex === null) {
            this.lastObservedCurrentIndex = currentIndex
            return
        }
        if (currentIndex === this.lastObservedCurrentIndex) {
            return
        }
        this.lastObservedCurrentIndex = currentIndex
        if (this.backgroundCooldownMs <= 0) {
            return
        }
        this.backgroundPausedUntil = Date.now() + this.backgroundCooldownMs
        if (this.cooldownTimer !== null) {
            clearTimeout(this.cooldownTimer)
        }
        this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = null
            this.schedule()
        }, this.backgroundCooldownMs)
    }

    private drain() {
        const currentIndex = this.getCurrentIndex()
        this.trackNavigationCooldown(currentIndex)
        const visibleSet = new Set(this.getVisibleIndices())
        visibleSet.add(currentIndex)

        const preloadList = this.getPreloadIndices()
        const preloadRank = new Map<number, number>()
        for (let i = 0; i < preloadList.length; i++) {
            const idx = preloadList[i]
            if (!preloadRank.has(idx)) {
                preloadRank.set(idx, i)
            }
        }
        const preloadSet = new Set(preloadList)
        const keepSet = new Set<number>([...visibleSet, ...preloadSet])

        for (const [index, entry] of this.retainedImages) {
            if (!keepSet.has(index) && !this.isCurrentlyVisible(index)) {
                this.retainedImages.delete(index)
                this.releaseImageElement(entry.img)
            }
        }

        const getPriority = (index: number) => {
            if (index === currentIndex) {
                return 0
            }
            if (visibleSet.has(index)) {
                return 1
            }
            const rank = preloadRank.get(index)
            if (rank !== undefined) {
                return 2 + rank
            }
            return 100000 + Math.abs(index - currentIndex)
        }

        const allowBackground = this.canStartBackgroundPreload(visibleSet)

        // Preempt background asset preloads whenever visible pages need bandwidth,
        // become directly managed by a visible <img>, or fall outside the preload window.
        for (const [index, active] of this.activeAssetLoads) {
            if (!keepSet.has(index) || !allowBackground || visibleSet.has(index)) {
                active.cancel()
                if (!visibleSet.has(index) && keepSet.has(index) && !this.isAssetReady(index, active.src)) {
                    this.pendingAsset.set(index, { index, src: active.src })
                }
            }
        }

        for (const index of this.pendingAsset.keys()) {
            if (!keepSet.has(index)) {
                this.pendingAsset.delete(index)
            }
        }

        const maxBufferedAssetUrls = this.getMaxBufferedAssetUrls()

        // Enqueue preload URL fetches once visible pages and document load have settled.
        if (allowBackground) {
            let queuedBackgroundUrls = this.pendingAsset.size + this.activeAssetLoads.size + this.pendingUrl.size + this.inFlightUrls.size
            for (const idx of preloadList) {
                if (visibleSet.has(idx)) {
                    continue
                }
                const existingSrc = this.getLoadedSrc(idx)
                if (existingSrc) {
                    if (!this.isAssetReady(idx, existingSrc) && this.failedAssetSrc.get(idx) !== existingSrc && !this.activeAssetLoads.has(idx) && !this.pendingAsset.has(idx)) {
                        this.pendingAsset.set(idx, { index: idx, src: existingSrc })
                        queuedBackgroundUrls++
                    }
                    continue
                }
                if (!this.requests.has(idx) && queuedBackgroundUrls < maxBufferedAssetUrls) {
                    let resolve!: PageLoadTask['resolve']
                    let reject!: PageLoadTask['reject']
                    const promise = new Promise<LoadResult>((resolveResult, rejectResult) => {
                        resolve = resolveResult
                        reject = rejectResult
                    })
                    const task: PageLoadTask = {
                        index: idx,
                        mode: ImgSrcMode.Default,
                        forceRefresh: false,
                        isActive: [() => false],
                        promise,
                        resolve,
                        reject,
                    }
                    this.requests.set(idx, task)
                    this.pendingUrl.set(idx, task)
                    queuedBackgroundUrls++
                }
            }
        }

        const tasks = Array.from(this.pendingUrl.values()).sort((a, b) => {
            return getPriority(a.index) - getPriority(b.index)
                || Math.abs(a.index - currentIndex) - Math.abs(b.index - currentIndex)
        })

        const isTaskKeepAlive = (idx: number) => {
            if (keepSet.has(idx)) {
                return true
            }
            const req = this.requests.get(idx)
            return req ? req.isActive.some(fn => fn()) : false
        }

        for (const task of tasks) {
            if (!isTaskKeepAlive(task.index)) {
                this.pendingUrl.delete(task.index)
                this.requests.delete(task.index)
                task.resolve(undefined)
                continue
            }
            const isVisible = visibleSet.has(task.index)
            if (!isVisible) {
                if (this.urlLoadingCount >= this.maxConcurrentUrlRequests) {
                    break
                }
                if (!allowBackground) {
                    continue
                }
                if (preloadSet.size > 0 && !preloadSet.has(task.index)) {
                    continue
                }
                if ((this.pendingAsset.size + this.activeAssetLoads.size) >= maxBufferedAssetUrls) {
                    continue
                }
            }
            this.pendingUrl.delete(task.index)
            this.urlLoadingCount++
            this.inFlightUrls.add(task.index)
            void this.loadUrl(task, keepSet)
        }

        this.drainAssets(visibleSet, keepSet, getPriority)
    }

    private isCurrentlyVisible(index: number): boolean {
        if (index === this.getCurrentIndex()) {
            return true
        }
        return this.getVisibleIndices().includes(index)
    }

    private async loadUrl(task: PageLoadTask, keepSet: Set<number>) {
        const mode = task.mode ?? ImgSrcMode.Default
        const forceRefresh = task.forceRefresh ?? false
        try {
            const result = await this.albumService.getImgSrc(task.index, mode, forceRefresh)
            if (result instanceof Error) {
                if (mode === ImgSrcMode.ChangeSource) {
                    this.onFallbackError?.(task.index, result)
                }
            } else if (result) {
                this.onResolved?.(task.index, result, mode)
                if (
                    result.src
                    && !this.isCurrentlyVisible(task.index)
                    && (keepSet.has(task.index) || this.getPreloadIndices().includes(task.index))
                    && !this.isAssetReady(task.index, result.src)
                    && this.failedAssetSrc.get(task.index) !== result.src
                ) {
                    this.pendingAsset.set(task.index, { index: task.index, src: result.src })
                }
            }
            task.resolve(result)
        } catch (error) {
            if (mode === ImgSrcMode.ChangeSource) {
                this.onFallbackError?.(task.index, error)
            }
            task.reject(error)
        } finally {
            this.requests.delete(task.index)
            this.inFlightUrls.delete(task.index)
            this.urlLoadingCount--
            this.schedule()
        }
    }

    private drainAssets(
        visibleSet: Set<number>,
        keepSet: Set<number>,
        getPriority: (index: number) => number,
    ) {
        if (!this.canStartBackgroundPreload(visibleSet)) {
            return
        }
        if (this.activeAssetLoads.size >= this.maxConcurrentAssetPreloads) {
            return
        }

        const candidates = Array.from(this.pendingAsset.values()).sort((a, b) => {
            return getPriority(a.index) - getPriority(b.index)
        })

        for (const item of candidates) {
            if (this.activeAssetLoads.size >= this.maxConcurrentAssetPreloads) {
                break
            }
            this.pendingAsset.delete(item.index)
            if (!keepSet.has(item.index) || visibleSet.has(item.index)) {
                continue
            }
            if (this.isAssetReady(item.index, item.src) || this.activeAssetLoads.has(item.index)) {
                continue
            }
            if (this.failedAssetSrc.get(item.index) === item.src) {
                continue
            }
            this.startAssetPreload(item.index, item.src)
        }
    }

    private handleAssetPreloadFailure(index: number, src: string) {
        this.failedAssetSrc.set(index, src)
        if (!this.fallbackAttempted.has(index) && this.canFallbackSource(index)) {
            this.enqueueFallbackUrl(index)
        }
        this.schedule()
    }

    private enqueueFallbackUrl(index: number) {
        if (this.fallbackAttempted.has(index) || this.requests.has(index) || this.inFlightUrls.has(index)) {
            return
        }
        this.fallbackAttempted.add(index)
        let resolve!: PageLoadTask['resolve']
        let reject!: PageLoadTask['reject']
        const promise = new Promise<LoadResult>((resolveResult, rejectResult) => {
            resolve = resolveResult
            reject = rejectResult
        })
        promise.catch(() => {})
        const task: PageLoadTask = {
            index,
            mode: ImgSrcMode.ChangeSource,
            forceRefresh: true,
            isActive: [() => false],
            promise,
            resolve,
            reject,
        }
        this.requests.set(index, task)
        this.pendingUrl.set(index, task)
    }

    private retainPreloadImage(index: number, src: string, img: PreloadImageLike) {
        const maxRetained = this.getMaxRetainedPreloadImages()
        if (maxRetained <= 0) {
            this.releaseImageElement(img)
            return
        }
        const existing = this.retainedImages.get(index)
        if (existing) {
            this.retainedImages.delete(index)
            if (existing.img !== img) {
                this.releaseImageElement(existing.img)
            }
        }
        this.retainedImages.set(index, { src, img })
        while (this.retainedImages.size > maxRetained) {
            const oldest = this.retainedImages.entries().next().value
            if (!oldest) {
                break
            }
            this.retainedImages.delete(oldest[0])
            this.releaseImageElement(oldest[1].img)
        }
    }

    private releaseImageElement(img: PreloadImageLike) {
        img.onload = null
        img.onerror = null
        try {
            if (typeof img.removeAttribute === 'function') {
                img.removeAttribute('src')
            } else {
                img.src = ''
            }
        } catch {
            // Ignore cleanup errors on synthetic image instances.
        }
    }

    private defaultFetchPreload(src: string, signal?: AbortSignal): Promise<boolean> {
        if (typeof fetch !== 'function') {
            return Promise.resolve(false)
        }
        return fetch(src, {
            mode: 'no-cors',
            credentials: 'omit',
            signal,
        }).then(async response => {
            try {
                await response.blob()
            } catch {
                // Ignore opaque body read issues once the network fetch completes.
            }
            return true
        })
    }

    private startAssetPreload(index: number, src: string) {
        // Avoid spawning offscreen Image subresources before document.readyState === 'complete',
        // which would otherwise keep the browser tab spinner running.
        if (!this.documentComplete && !this.isDocumentComplete()) {
            this.startFetchPreload(index, src)
            return
        }
        this.documentComplete = true
        this.startImagePreload(index, src)
    }

    private startFetchPreload(index: number, src: string) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        let settled = false
        let timerId: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
            if (timerId !== null) {
                clearTimeout(timerId)
                timerId = null
            }
        }

        const finish = (success: boolean) => {
            if (settled) {
                return
            }
            settled = true
            cleanup()
            this.activeAssetLoads.delete(index)
            if (success) {
                this.failedAssetSrc.delete(index)
                this.assetReadySrc.set(index, src)
                this.schedule()
            } else {
                this.handleAssetPreloadFailure(index, src)
            }
        }

        const cancel = () => {
            if (settled) {
                return
            }
            settled = true
            cleanup()
            this.activeAssetLoads.delete(index)
            controller?.abort()
        }

        this.activeAssetLoads.set(index, { index, src, cleanup, cancel })
        timerId = setTimeout(() => {
            if (settled) {
                return
            }
            cancel()
            this.handleAssetPreloadFailure(index, src)
        }, this.assetPreloadTimeoutMs)

        void this.fetchPreload(src, controller?.signal).then(
            ok => finish(Boolean(ok)),
            () => finish(false),
        )
    }

    private startImagePreload(index: number, src: string) {
        const img = this.createPreloadImage()
        if (!img) {
            this.assetReadySrc.set(index, src)
            return
        }

        img.decoding = 'async'
        let settled = false
        let timerId: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
            if (timerId !== null) {
                clearTimeout(timerId)
                timerId = null
            }
            img.onload = null
            img.onerror = null
        }

        const finish = (success: boolean) => {
            if (settled) {
                return
            }
            settled = true
            cleanup()
            this.activeAssetLoads.delete(index)
            if (success) {
                this.failedAssetSrc.delete(index)
                this.retainPreloadImage(index, src, img)
                this.assetReadySrc.set(index, src)
                this.schedule()
            } else {
                this.releaseImageElement(img)
                this.handleAssetPreloadFailure(index, src)
            }
        }

        const cancel = () => {
            if (settled) {
                return
            }
            settled = true
            cleanup()
            this.activeAssetLoads.delete(index)
            this.releaseImageElement(img)
        }

        this.activeAssetLoads.set(index, { index, src, cleanup, cancel })

        img.onload = () => finish(true)
        img.onerror = () => finish(false)
        timerId = setTimeout(() => {
            if (settled) {
                return
            }
            cancel()
            this.handleAssetPreloadFailure(index, src)
        }, this.assetPreloadTimeoutMs)

        img.src = src
        if (img.complete && img.naturalWidth > 0) {
            finish(true)
        }
    }
}
