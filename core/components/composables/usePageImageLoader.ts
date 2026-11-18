import { computed, nextTick, onBeforeUnmount, reactive, ref, toRaw, watch, type ComputedRef, type Ref } from 'vue'
import type { AlbumService } from '../../service/AlbumService'
import { ImgSrcMode, type ImgPageInfo } from '../../model/model'
import { i18n } from '../../store/i18n'
import { store, storeAction } from '../../store/app'
import Utils from '../../utils/Utils'
import Logger from '../../utils/logger'
import { buildRetryQueueAfterFailure as buildImageRetryQueueAfterFailure } from '../../service/imageRetryPolicy'
import { PageImageLoadQueue } from '../../service/PageImageLoadQueue'
import { buildBookSpreads, findBookSpreadIndexByPage } from '../../model/bookSpread'
import { imageLoadDiagnostics, diagnosticError, type DiagnosticOperation } from '../../service/ImageLoadDiagnostics'

interface QueueContext {
    queue: PageImageLoadQueue
    visibleScrollPages: Set<number>
}

const queueContexts = new WeakMap<AlbumService, QueueContext>()

const leavingBookPageIndices = ref<number[]>([])

export function setLeavingBookPageIndices(indices: number[]) {
    leavingBookPageIndices.value = indices.slice()
}

const visibleBookPageIndices = computed(() => {
    if (store.readingMode !== 1) {
        return [store.curViewIndex]
    }
    const spreads = buildBookSpreads({
        pageCount: store.pageCount,
        pagesPerScreen: store.pagesPerScreen,
        isChangeOddEven: store.isChangeOddEven,
    })
    return spreads[findBookSpreadIndexByPage(spreads, store.curViewIndex)]
        .filter(index => index >= 0 && index < store.pageCount)
})

function buildPreloadIndices(visibleScrollPages?: Set<number>): number[] {
    const pageCount = store.pageCount
    if (pageCount <= 0) {
        return []
    }
    const cur = Math.max(0, Math.min(pageCount - 1, store.curViewIndex))
    const loadNum = Math.max(1, store.loadNum || 1)
    const result: number[] = []
    const seen = new Set<number>()
    const pushIndex = (idx: number) => {
        if (idx >= 0 && idx < pageCount && !seen.has(idx)) {
            seen.add(idx)
            result.push(idx)
        }
    }

    const isBookMode = store.readingMode === 1
    const forwardAnchor = isBookMode && visibleBookPageIndices.value.length > 0
        ? Math.max(cur, ...visibleBookPageIndices.value)
        : (visibleScrollPages && visibleScrollPages.size > 0
            ? Math.max(cur, ...visibleScrollPages)
            : cur)
    const maxForward = Math.min(pageCount - 1, forwardAnchor + loadNum)
    const immediateForward = Math.min(maxForward, forwardAnchor + Math.max(2, store.pagesPerScreen))
    for (let i = forwardAnchor + 1; i <= immediateForward; i++) {
        pushIndex(i)
    }

    const backRadius = isBookMode
        ? Math.min(loadNum, Math.max(1, store.pagesPerScreen))
        : Math.min(loadNum, 2)
    const minBackward = Math.max(0, cur - backRadius)
    for (let i = cur - 1; i >= minBackward; i--) {
        pushIndex(i)
    }

    for (let i = immediateForward + 1; i <= maxForward; i++) {
        pushIndex(i)
    }

    return result
}

function getOrCreateQueueContext(albumService: AlbumService): QueueContext {
    const existing = queueContexts.get(albumService)
    if (existing) {
        return existing
    }

    const visibleScrollPages = reactive(new Set<number>())
    const queue = new PageImageLoadQueue({
        albumService,
        getCurrentIndex: () => store.curViewIndex,
        getVisibleIndices: () => {
            if (store.readingMode === 1) {
                return visibleBookPageIndices.value
            }
            const indices = new Set<number>(visibleScrollPages)
            indices.add(store.curViewIndex)
            return Array.from(indices)
        },
        getPreloadIndices: () => buildPreloadIndices(visibleScrollPages),
        getLoadedSrc: (index) => store.imgPageInfos[index]?.src || '',
        onResolved: (index, resp, mode = ImgSrcMode.Default) => {
            const info = store.imgPageInfos[index]
            if (!info) {
                return
            }
            if (resp.src && info.src !== resp.src) {
                storeAction.setImgPageInfoSrc(index, resp.src)
                imageLoadDiagnostics.record('page.src-assigned', { page: index + 1, mode, hasSrc: true })
            }
            if (resp.preciseHeightOfWidth && info.preciseHeightOfWidth !== resp.preciseHeightOfWidth) {
                storeAction.setImgPageInfoPreciseHeightOfWidth(index, resp.preciseHeightOfWidth)
            }
        },
        canFallbackSource: () => store.autoRetryByOtherSource && albumService.isSupportImgChangeSource(),
        maxConcurrentUrlRequests: 3,
        maxConcurrentAssetPreloads: 2,
        maxBufferedAssetUrls: () => Math.max(8, (store.loadNum || 1) + 4),
        maxRetainedPreloadImages: () => Math.min(30, Math.max(8, (store.loadNum || 1) + 4)),
        backgroundCooldownMs: 80,
    })

    // Single shared watcher per AlbumService instead of one watcher per PageView.
    watch([
        () => store.curViewIndex,
        () => store.readingMode,
        () => store.pagesPerScreen,
        () => store.isChangeOddEven,
        () => store.loadNum,
    ], () => {
        queue.refreshPriority()
    }, { flush: 'post' })

    const context: QueueContext = { queue, visibleScrollPages }
    queueContexts.set(albumService, context)
    return context
}

imageLoadDiagnostics.setReaderContext(() => ({
    currentPage: store.curViewIndex + 1,
    readingMode: store.readingMode === 1 ? 'book' : 'scroll',
    loadNum: store.loadNum,
    pagesPerScreen: store.pagesPerScreen,
    pageCount: store.pageCount,
    currentHasSrc: !!store.imgPageInfos[store.curViewIndex]?.src,
}))

export enum ImgLoadStatus {
    Waiting = 0,
    Loading = 1,
    Error = 2,
    Loaded = 3,
}

interface UsePageImageLoaderOptions {
    index: number
    albumService: AlbumService
    imgPageInfo: ComputedRef<any>
    imgRef: Ref<HTMLImageElement | null>
    isActive: () => boolean
    activeRef: ComputedRef<boolean>
    isInViewport?: Ref<boolean>
    isNearViewport?: Ref<boolean>
    warmMagnifierSource: (src: string) => Promise<void>
}

export function usePageImageLoader(options: UsePageImageLoaderOptions) {
    const {
        index,
        albumService,
        imgPageInfo,
        imgRef,
        isActive,
        activeRef,
        isInViewport,
        isNearViewport,
        warmMagnifierSource,
    } = options
    const { queue: pageLoadQueue, visibleScrollPages } = getOrCreateQueueContext(albumService)

    const VISIBLE_IMAGE_STALL_TIMEOUT_MS = 30000
    const STREAMING_FIRST_FRAME_DELAY_MS = 400
    const reloadTimes = ref(0)
    const message = ref('')
    const curLoadStatus = ref(ImgLoadStatus.Waiting)
    const lastLoadMode = ref(ImgSrcMode.Default)
    const autoRetryQueue = ref<ImgSrcMode[]>([])
    const isAutoRetryRunning = ref(false)
    const isAutoRetryExhausted = ref(false)
    const forceRenderImg = ref(false)
    const hasFirstFrame = ref(false)
    const isImageDecoded = ref(false)
    let imageOperation: DiagnosticOperation | undefined
    let isDisposed = false
    let loadedSrc = ''
    let activeImgElement: HTMLImageElement | null = null
    let hasStartedAutoRetryCycle = false
    let visibleStallTimer: ReturnType<typeof setTimeout> | null = null
    let firstFrameProbeRaf = 0
    let firstFrameProbeTimer: ReturnType<typeof setInterval> | null = null
    let streamingFirstFrameTimer: ReturnType<typeof setTimeout> | null = null

    function detachImageElement(image: HTMLImageElement | null | undefined) {
        if (!image) {
            return
        }
        try {
            // Clear src on detached/hidden <img> elements so incomplete downloads abort
            // immediately and stale detached elements never fire late @load/@error callbacks.
            if (typeof image.removeAttribute === 'function') {
                image.removeAttribute('src')
            } else {
                image.src = ''
            }
        } catch {
            // Ignore cleanup errors on synthetic image instances.
        }
    }

    function stopFirstFrameProbe(clearStreamingTimer = true) {
        if (firstFrameProbeRaf && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(firstFrameProbeRaf)
        }
        firstFrameProbeRaf = 0
        if (firstFrameProbeTimer !== null) {
            clearInterval(firstFrameProbeTimer)
            firstFrameProbeTimer = null
        }
        if (clearStreamingTimer && streamingFirstFrameTimer !== null) {
            clearTimeout(streamingFirstFrameTimer)
            streamingFirstFrameTimer = null
        }
    }

    function startFirstFrameProbe(image: HTMLImageElement, expectedSrc: string) {
        stopFirstFrameProbe()
        const checkFirstFrame = () => {
            const curImg = imgRef.value
            const curSrc = shouldRenderImg.value ? imgPageInfo.value?.src : ''
            if (isDisposed || !curImg || curImg !== image || curSrc !== expectedSrc) {
                stopFirstFrameProbe()
                return true
            }
            if (curImg.complete) {
                if (curImg.naturalWidth > 0) {
                    loaded()
                }
                stopFirstFrameProbe()
                return true
            }
            if (curImg.naturalWidth > 0) {
                // Stop continuous rAF polling immediately once dimensions arrive; wait briefly
                // before uncovering streaming content so fast static images finish atomically.
                stopFirstFrameProbe(false)
                if (streamingFirstFrameTimer === null) {
                    streamingFirstFrameTimer = setTimeout(() => {
                        streamingFirstFrameTimer = null
                        const latestImg = imgRef.value
                        const latestSrc = shouldRenderImg.value ? imgPageInfo.value?.src : ''
                        if (!isDisposed && latestImg === image && latestSrc === expectedSrc && latestImg.naturalWidth > 0) {
                            hasFirstFrame.value = true
                            if (latestImg.complete) {
                                loaded()
                            }
                        }
                    }, STREAMING_FIRST_FRAME_DELAY_MS)
                }
                return true
            }
            if (curLoadStatus.value === ImgLoadStatus.Loaded || curLoadStatus.value === ImgLoadStatus.Error) {
                stopFirstFrameProbe()
                return true
            }
            return false
        }
        if (checkFirstFrame()) {
            return
        }
        if (typeof requestAnimationFrame === 'function') {
            const probe = () => {
                firstFrameProbeRaf = 0
                if (!checkFirstFrame()) {
                    firstFrameProbeRaf = requestAnimationFrame(probe)
                }
            }
            firstFrameProbeRaf = requestAnimationFrame(probe)
        }
        // Fallback poll in case compositor stalls rAF during heavy image decoding.
        firstFrameProbeTimer = setInterval(() => {
            checkFirstFrame()
        }, 60)
    }

    function clearVisibleStallTimer() {
        if (visibleStallTimer !== null) {
            clearTimeout(visibleStallTimer)
            visibleStallTimer = null
        }
    }

    function hasRemainingAutoRetry(): boolean {
        if (isAutoRetryExhausted.value) {
            return false
        }
        if (hasStartedAutoRetryCycle) {
            return autoRetryQueue.value.length > 0
        }
        return buildRetryQueueAfterFailure(lastLoadMode.value).length > 0
    }

    function syncVisibleStallTimer() {
        clearVisibleStallTimer()
        const image = imgRef.value
        const src = shouldRenderImg.value ? imgPageInfo.value?.src : ''
        if (
            isDisposed
            || !isActive()
            || !isVisiblePage.value
            || !image
            || !src
            || image.getAttribute('src') !== src
            || image.complete
            || curLoadStatus.value === ImgLoadStatus.Loaded
            || curLoadStatus.value === ImgLoadStatus.Error
            || !hasRemainingAutoRetry()
        ) {
            return
        }
        visibleStallTimer = setTimeout(() => {
            visibleStallTimer = null
            const currentImage = imgRef.value
            const currentSrc = shouldRenderImg.value ? imgPageInfo.value?.src : ''
            if (
                isDisposed
                || !isActive()
                || !isVisiblePage.value
                || !currentImage
                || !currentSrc
                || currentImage.getAttribute('src') !== currentSrc
                || currentImage.complete
                || !hasRemainingAutoRetry()
            ) {
                return
            }
            imageLoadDiagnostics.record('image.stall-timeout', {
                page: index + 1,
                mode: lastLoadMode.value,
                src: currentSrc,
            }, 'warn')
            handleImageLoadFailure()
        }, VISIBLE_IMAGE_STALL_TIMEOUT_MS)
    }

    const isVisiblePage = computed(() => {
        if (store.readingMode === 1) {
            return visibleBookPageIndices.value.includes(index)
        }
        return Boolean(isInViewport?.value) || Math.abs(index - store.curViewIndex) <= 1
    })

    const isNearViewportPage = computed(() => {
        if (store.readingMode === 1) {
            return true
        }
        return Boolean(isNearViewport?.value) || Math.abs(index - store.curViewIndex) <= 2
    })

    const isLeavingBookPage = computed(() => {
        return store.readingMode === 1 && leavingBookPageIndices.value.includes(index)
    })

    const shouldRenderImg = computed(() => {
        const src = imgPageInfo.value?.src
        if (!activeRef.value || !src) {
            return false
        }
        if (store.readingMode === 1) {
            return isVisiblePage.value || isLeavingBookPage.value || forceRenderImg.value || pageLoadQueue.isAssetReady(index, src)
        }
        if (!isNearViewportPage.value) {
            return false
        }
        if (isVisiblePage.value || forceRenderImg.value) {
            return true
        }
        return pageLoadQueue.isAssetReady(index, src)
    })

    if (isInViewport) {
        watch([() => store.readingMode, isInViewport, activeRef], ([mode, inView, active]) => {
            if (mode === 0 && active && inView) {
                if (!visibleScrollPages.has(index)) {
                    visibleScrollPages.add(index)
                    pageLoadQueue.refreshPriority()
                }
            } else if (visibleScrollPages.delete(index)) {
                pageLoadQueue.refreshPriority()
            }
        }, { immediate: true })
    }

    function finishImageObservation(event: string, level: 'info' | 'error' = 'info') {
        const data = { page: index + 1, mode: lastLoadMode.value, hasSrc: !!imgPageInfo.value?.src }
        if (imageOperation && !imageOperation.closed) {
            imageLoadDiagnostics.finish(imageOperation, event, data, level)
        } else if (event !== 'image.cancelled') {
            imageLoadDiagnostics.record(event, data, level)
        }
    }

    watch([() => shouldRenderImg.value, () => imgPageInfo.value?.src], ([render, src]) => {
        if (!render || !src) {
            hasFirstFrame.value = false
            isImageDecoded.value = false
            loadedSrc = ''
            if (activeImgElement && activeImgElement !== imgRef.value) {
                detachImageElement(activeImgElement)
                activeImgElement = null
            }
            return
        }
        if (loadedSrc !== src && curLoadStatus.value === ImgLoadStatus.Waiting) {
            curLoadStatus.value = ImgLoadStatus.Loading
        }
    }, { immediate: true })

    // Observe the rendered element, including cached sources that bypass getImgSrc.
    watch([() => imgRef.value, () => shouldRenderImg.value ? imgPageInfo.value?.src : ''], ([image, src]) => {
        clearVisibleStallTimer()
        stopFirstFrameProbe()
        finishImageObservation('image.cancelled')
        imageOperation = undefined
        if (activeImgElement && activeImgElement !== image) {
            detachImageElement(activeImgElement)
            activeImgElement = null
        }
        if (!image || !src || image.getAttribute('src') !== src) {
            hasFirstFrame.value = false
            isImageDecoded.value = false
            loadedSrc = ''
            pageLoadQueue.setVisibleImageLoading(index, false)
            return
        }
        activeImgElement = image
        if (loadedSrc !== src) {
            loadedSrc = ''
            isImageDecoded.value = false
            hasFirstFrame.value = false
            if (curLoadStatus.value === ImgLoadStatus.Waiting || curLoadStatus.value === ImgLoadStatus.Loaded) {
                curLoadStatus.value = ImgLoadStatus.Loading
            }
        }
        if (image.complete) {
            if (image.naturalWidth > 0) {
                hasFirstFrame.value = true
                if (curLoadStatus.value !== ImgLoadStatus.Loaded || loadedSrc !== src) {
                    imageOperation = imageLoadDiagnostics.start('image', { page: index + 1, mode: lastLoadMode.value, src })
                    loaded()
                }
            } else {
                hasFirstFrame.value = false
                imageOperation = imageLoadDiagnostics.start('image', { page: index + 1, mode: lastLoadMode.value, src })
                finishImageObservation('image.error', 'error')
                pageLoadQueue.setVisibleImageLoading(index, false)
            }
            return
        }
        imageOperation = imageLoadDiagnostics.start('image', { page: index + 1, mode: lastLoadMode.value, src })
        pageLoadQueue.setVisibleImageLoading(index, isVisiblePage.value)
        syncVisibleStallTimer()
        if (isVisiblePage.value && !hasFirstFrame.value) {
            startFirstFrameProbe(image, src)
        }
    }, { flush: 'post' })

    watch(isVisiblePage, (visible) => {
        const image = imgRef.value
        const src = shouldRenderImg.value ? imgPageInfo.value?.src : ''
        if (visible && image && src) {
            if (image.complete) {
                pageLoadQueue.setVisibleImageLoading(index, false)
                if (image.naturalWidth > 0 && (curLoadStatus.value !== ImgLoadStatus.Loaded || !hasFirstFrame.value)) {
                    loaded()
                }
            } else {
                pageLoadQueue.setVisibleImageLoading(index, true)
                if (image.naturalWidth > 0) {
                    hasFirstFrame.value = true
                } else if (!hasFirstFrame.value) {
                    startFirstFrameProbe(image, src)
                }
            }
        } else {
            pageLoadQueue.setVisibleImageLoading(index, false)
            if (!visible) {
                stopFirstFrameProbe()
            }
        }
        syncVisibleStallTimer()
    }, { flush: 'post' })

    onBeforeUnmount(() => {
        isDisposed = true
        clearVisibleStallTimer()
        stopFirstFrameProbe()
        visibleScrollPages.delete(index)
        pageLoadQueue.setVisibleImageLoading(index, false)
        finishImageObservation('image.cancelled')
        detachImageElement(activeImgElement || imgRef.value)
        activeImgElement = null
        pageLoadQueue.refreshPriority()
    })

    const loadingInfo = computed(() => {
        const reloadInfo = reloadTimes.value ? `[${i18n.value.reload}-${reloadTimes.value}] ` : ''
        if (message.value) {
            return reloadInfo + message.value
        }
        switch (curLoadStatus.value) {
            case ImgLoadStatus.Error:
                return reloadInfo + i18n.value.loadingImgFailed
            case ImgLoadStatus.Loaded:
                return reloadInfo + i18n.value.imgLoaded
            case ImgLoadStatus.Waiting:
                return reloadInfo + i18n.value.waiting
            default:
                return reloadInfo + i18n.value.loadingImg
        }
    })

    function getRetryPolicyOptions() {
        return {
            autoRetryByOtherSource: store.autoRetryByOtherSource,
            supportChangeSource: albumService.isSupportImgChangeSource(),
        }
    }

    function buildRetryQueueAfterFailure(failedMode: ImgSrcMode): ImgSrcMode[] {
        return buildImageRetryQueueAfterFailure(failedMode, getRetryPolicyOptions())
    }

    async function observeImgSrc(
        mode: ImgSrcMode,
        request: () => Promise<ImgPageInfo | Error | undefined>,
        isAutoRetry = false,
    ) {
        const operation = imageLoadDiagnostics.start('page', {
            page: index + 1, pageUrl: imgPageInfo.value?.pageUrl, mode, isAutoRetry,
        })
        try {
            const resp = await request()
            if (!resp) {
                imageLoadDiagnostics.finish(operation, 'page.skipped', { page: index + 1, mode })
            } else if (resp instanceof Error) {
                imageLoadDiagnostics.finish(operation, 'page.source-error', {
                    page: index + 1, mode, error: resp.message,
                }, 'error')
            } else {
                imageLoadDiagnostics.finish(operation, 'page.source-ready', {
                    page: index + 1, mode, hasSrc: !!resp.src, src: resp.src,
                }, resp.src ? 'info' : 'warn')
            }
            return resp
        } catch (error) {
            imageLoadDiagnostics.finish(operation, 'page.rejected', {
                page: index + 1, mode, error: diagnosticError(error),
            }, 'error')
            throw error
        }
    }

    async function loadImgSrc(mode: ImgSrcMode) {
        lastLoadMode.value = mode
        isAutoRetryExhausted.value = false
        hasStartedAutoRetryCycle = false
        const resp = await observeImgSrc(mode, () => mode === ImgSrcMode.Default
            ? pageLoadQueue.request(index, isActive)
            : albumService.getImgSrc(index, mode))
        if (!resp || isDisposed) {
            return
        }
        if (resp instanceof Error) {
            if (mode === ImgSrcMode.Default && isActive()) {
                autoRetryQueue.value = buildRetryQueueAfterFailure(mode)
                hasStartedAutoRetryCycle = true
                await runAutoRetryQueue()
            }
            return
        }
        if (imgPageInfo.value.src !== resp.src) {
            storeAction.setImgPageInfoSrc(index, resp.src)
            imageLoadDiagnostics.record('page.src-assigned', { page: index + 1, mode, hasSrc: !!resp.src })
        }
        if (resp.preciseHeightOfWidth && imgPageInfo.value.preciseHeightOfWidth !== resp.preciseHeightOfWidth) {
            storeAction.setImgPageInfoPreciseHeightOfWidth(index, resp.preciseHeightOfWidth)
        }
    }

    async function runAutoRetryQueue() {
        if (isAutoRetryRunning.value) {
            return
        }
        isAutoRetryRunning.value = true
        try {
            while (autoRetryQueue.value.length > 0 && isActive() && !isDisposed) {
                const mode = autoRetryQueue.value.shift()
                if (mode === undefined) {
                    break
                }
                const loadedOk = await getNewImgSrc(mode, true)
                if (loadedOk) {
                    return
                }
            }
            if (isActive() && !isDisposed) {
                isAutoRetryExhausted.value = true
            }
        } finally {
            isAutoRetryRunning.value = false
        }
    }

    async function getNewImgSrc(mode: ImgSrcMode, isAutoRetry = false): Promise<boolean> {
        clearVisibleStallTimer()
        stopFirstFrameProbe()
        hasFirstFrame.value = false
        isImageDecoded.value = false
        loadedSrc = ''
        if (!isAutoRetry) {
            autoRetryQueue.value = []
            hasStartedAutoRetryCycle = false
        }
        isAutoRetryExhausted.value = false
        reloadTimes.value++
        message.value = ''
        forceRenderImg.value = true
        pageLoadQueue.invalidateAsset(index)
        storeAction.setImgPageInfoSrc(index, '')
        curLoadStatus.value = ImgLoadStatus.Loading
        lastLoadMode.value = mode
        const resp = await observeImgSrc(mode, () => albumService.getImgSrc(index, mode, true), isAutoRetry)
        if (isDisposed) {
            return false
        }
        if (resp instanceof Error) {
            switch (resp.message) {
                case 'ERROR_NO_ORIGIN':
                    message.value = i18n.value.noOriginalImg
                    break
                default:
                    message.value = i18n.value.loadingFailed
            }
            if (isAutoRetry || !isActive()) {
                return false
            }
            autoRetryQueue.value = buildRetryQueueAfterFailure(mode)
            hasStartedAutoRetryCycle = true
            await runAutoRetryQueue()
            return false
        }
        await nextTick()
        await Utils.timeout(300)
        if (isDisposed) {
            return false
        }
        if (imgPageInfo.value.src !== resp.src) {
            storeAction.setImgPageInfoSrc(index, resp.src)
            imageLoadDiagnostics.record('page.src-assigned', { page: index + 1, mode, hasSrc: !!resp.src })
        }
        if (resp.preciseHeightOfWidth && imgPageInfo.value.preciseHeightOfWidth !== resp.preciseHeightOfWidth) {
            storeAction.setImgPageInfoPreciseHeightOfWidth(index, resp.preciseHeightOfWidth)
        }
        return true
    }

    function handleImageLoadFailure() {
        if (isDisposed) {
            return
        }
        clearVisibleStallTimer()
        stopFirstFrameProbe()
        hasFirstFrame.value = false
        isImageDecoded.value = false
        loadedSrc = ''
        pageLoadQueue.setVisibleImageLoading(index, false)
        finishImageObservation('image.error', 'error')
        if (imgPageInfo.value.src && isActive()) {
            curLoadStatus.value = ImgLoadStatus.Error
            Logger.logText('LOADING', 'loading image failed')
            if (!hasStartedAutoRetryCycle && !isAutoRetryExhausted.value && autoRetryQueue.value.length === 0) {
                autoRetryQueue.value = buildRetryQueueAfterFailure(lastLoadMode.value)
                hasStartedAutoRetryCycle = true
            }
            if (autoRetryQueue.value.length > 0) {
                Logger.logText('LOADING', 'reloading image')
                void runAutoRetryQueue()
            } else if (hasStartedAutoRetryCycle) {
                isAutoRetryExhausted.value = true
            }
        }
    }

    function isEventForActiveImg(e?: Event): boolean {
        if (!shouldRenderImg.value || !imgRef.value) {
            return false
        }
        if (e?.target && toRaw(e.target) !== toRaw(imgRef.value)) {
            return false
        }
        return true
    }

    function failLoad(e: Event) {
        e.preventDefault()
        if (!isEventForActiveImg(e)) {
            return
        }
        handleImageLoadFailure()
    }

    function scheduleImageDecode(image: HTMLImageElement, expectedSrc: string) {
        if (typeof image.decode !== 'function') {
            isImageDecoded.value = true
            hasFirstFrame.value = true
            return
        }
        void image.decode().catch(() => {}).then(() => {
            const curImg = imgRef.value
            const curSrc = shouldRenderImg.value ? (imgPageInfo.value?.src || '') : ''
            if (!isDisposed && curImg === image && curSrc === expectedSrc && loadedSrc === expectedSrc) {
                isImageDecoded.value = true
                hasFirstFrame.value = true
            }
        })
    }

    function loaded(e?: Event) {
        if (isDisposed || !isEventForActiveImg(e)) {
            return
        }
        const currentSrc = imgPageInfo.value?.src || ''
        if (curLoadStatus.value === ImgLoadStatus.Loaded && currentSrc && loadedSrc === currentSrc) {
            return
        }
        clearVisibleStallTimer()
        stopFirstFrameProbe()
        loadedSrc = currentSrc
        curLoadStatus.value = ImgLoadStatus.Loaded
        forceRenderImg.value = false
        if (imgRef.value && currentSrc) {
            scheduleImageDecode(imgRef.value, currentSrc)
        } else {
            isImageDecoded.value = true
            hasFirstFrame.value = true
        }
        finishImageObservation('image.loaded')
        pageLoadQueue.markImageLoaded(index, currentSrc)
        autoRetryQueue.value = []
        hasStartedAutoRetryCycle = false
        isAutoRetryExhausted.value = false
        if (currentSrc) {
            void warmMagnifierSource(currentSrc)
        }
    }

    return {
        curLoadStatus,
        hasFirstFrame,
        isImageDecoded,
        loadingInfo,
        shouldRenderImg,
        loadImgSrc,
        getNewImgSrc,
        failLoad,
        loaded,
    }
}
