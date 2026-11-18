<template>
    <section :class="['album-book-view', `mode-${store.pageTurnAnimationMode}`, { 'page-turning': turningSpreads.size > 0 }]" @wheel="handleWheelFlipEvent" @click="onClickBg">
        <Transition
            v-for="spread in cachedBookSpreadList"
            :key="spread.spreadIndex"
            :name="bookTransitionName"
            :css="store.pageTurnAnimationMode !== 'none'"
            @before-enter="startPageTurn"
            @before-leave="startPageTurn"
            @after-enter="finishPageTurn"
            @after-leave="finishPageTurn"
            @enter-cancelled="finishPageTurn"
            @leave-cancelled="finishPageTurn">
        <div
            v-show="spread.spreadIndex === curSpreadIndex"
            :class="['book-spread', { 'is-inactive-spread': spread.spreadIndex !== curSpreadIndex }]"
            :style="spreadStyle(spread.spreadIndex)">
            <div class="book-page-container"
                v-for="i in spread.pageList"
                :key="`${spread.spreadIndex}-${i.pageIndex}`"
                :style="pageContainerStyle(i)">
                <BookPageView
                    :index="i.pageIndex"
                    :active="true"
                    :active-load="true" />
            </div>
        </div>
        </Transition>
        <transition name="center-horizontal-fade">
            <Pagination
                v-if="store.showBookPagination && spreadPageSum > 1"
                class="bottom-pagination"
                :cur-index="curSpreadIndex"
                :page-sum="spreadPageSum"
                @change="selectSpreadIndex" />
        </transition>
        <div class="action-panel">
            <div class="next"></div>
            <div class="setting"></div>
            <div class="pre"></div>
        </div>
    </section>
</template>

<script lang="ts" setup>
import BookPageView from './BookPageView.vue'
import Pagination from './widget/Pagination.vue'
import type { StyleValue } from 'vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { store, storeAction, computedAlbumViewportRatio, computedAlbumViewportHeight, computedAlbumViewportWidth } from '../store/app'
import { handleWheelFlipEvent } from '../store/event'
import { setLeavingBookPageIndices } from './composables/usePageImageLoader'
import {
    buildBookSpreads,
    findBookSpreadIndexByPage,
    pickBookSpreadAnchorPage,
    getBookCoverPlaceholderHeightOfWidth,
} from '../model/bookSpread'

interface BookPageDisplayParam {
    pageIndex: number,
    height: number,
    width: number,
    top: number,
    right: number,
}

const DOM_SPREAD_CACHE_RADIUS = 1
const MAX_RETAINED_BOOK_SPREADS = 6

const turningSpreads = ref(new Set<Element>())
const bookSpreads = computed(() => {
    return buildBookSpreads({
        pageCount: store.pageCount,
        pagesPerScreen: store.pagesPerScreen,
        isChangeOddEven: store.isChangeOddEven,
    })
})

const curSpreadIndex = computed(() => {
    return findBookSpreadIndexByPage(bookSpreads.value, store.curViewIndex)
})

const settledSpreadIndex = ref(curSpreadIndex.value)
const leavingSpreadIndex = ref<number | null>(null)
// Retain recently viewed spreads in display:none so back-and-forth flips avoid re-reading 20MB+ files from disk cache.
const recentSpreadIndices = ref<number[]>([curSpreadIndex.value])
let settleRafId = 0
let settleTimerId = 0

function touchRecentSpreads(spreadIndices: number[]) {
    const spreadCount = bookSpreads.value.length
    const valid = spreadIndices.filter(idx => idx >= 0 && idx < spreadCount)
    if (valid.length === 0) {
        return
    }
    const validSet = new Set(valid)
    const next = recentSpreadIndices.value.filter(idx => !validSet.has(idx) && idx >= 0 && idx < spreadCount)
    next.push(...valid)
    if (next.length > MAX_RETAINED_BOOK_SPREADS) {
        next.splice(0, next.length - MAX_RETAINED_BOOK_SPREADS)
    }
    recentSpreadIndices.value = next
}

function syncLeavingBookPages(spreadIndex: number | null) {
    if (spreadIndex === null || spreadIndex < 0 || spreadIndex >= bookSpreads.value.length) {
        setLeavingBookPageIndices([])
        return
    }
    const pages = bookSpreads.value[spreadIndex].filter(idx => idx >= 0 && idx < store.pageCount)
    setLeavingBookPageIndices(pages)
}

function clearSettleTimers() {
    if (settleRafId) {
        window.cancelAnimationFrame(settleRafId)
        settleRafId = 0
    }
    if (settleTimerId) {
        window.clearTimeout(settleTimerId)
        settleTimerId = 0
    }
}

function startPageTurn(element: Element) {
    if (store.pageTurnAnimationMode === 'none') {
        return
    }
    turningSpreads.value.add(element)
}

function finishPageTurn(element: Element) {
    turningSpreads.value.delete(element)
    if (turningSpreads.value.size === 0 && store.pageTurnAnimationMode !== 'none') {
        clearSettleTimers()
        settledSpreadIndex.value = curSpreadIndex.value
        touchRecentSpreads([curSpreadIndex.value - 1, curSpreadIndex.value + 1, curSpreadIndex.value])
        leavingSpreadIndex.value = null
        syncLeavingBookPages(null)
    }
}

watch(curSpreadIndex, (nextIndex, prevIndex) => {
    clearSettleTimers()
    const hasAnim = store.pageTurnAnimationMode !== 'none'
    if (hasAnim && prevIndex !== undefined && prevIndex !== nextIndex) {
        leavingSpreadIndex.value = prevIndex
        syncLeavingBookPages(prevIndex)
    } else {
        leavingSpreadIndex.value = null
        syncLeavingBookPages(null)
    }
    // Defer neighbor spread mount/unmount until after back-and-forth flipping settles.
    const settleDelay = hasAnim ? 480 : 200
    settleRafId = window.requestAnimationFrame(() => {
        settleRafId = 0
        settleTimerId = window.setTimeout(() => {
            settleTimerId = 0
            settledSpreadIndex.value = nextIndex
            touchRecentSpreads([nextIndex - 1, nextIndex + 1, nextIndex])
            leavingSpreadIndex.value = null
            syncLeavingBookPages(null)
        }, settleDelay)
    })
})

watch([() => store.pagesPerScreen, () => store.isChangeOddEven, () => store.pageCount], () => {
    recentSpreadIndices.value = [curSpreadIndex.value]
})

watch(() => store.pageTurnAnimationMode, (mode) => {
    if (mode === 'none') {
        turningSpreads.value.clear()
        clearSettleTimers()
        settledSpreadIndex.value = curSpreadIndex.value
        leavingSpreadIndex.value = null
        syncLeavingBookPages(null)
    }
})

onBeforeUnmount(() => {
    clearSettleTimers()
    syncLeavingBookPages(null)
})

function pageContainerStyle(page: BookPageDisplayParam): StyleValue {
    return {
        width: page.width + 'px',
        height: page.height + 'px',
        top: page.top + 'px',
        right: page.right + 'px',
        zIndex: store.pageCount - page.pageIndex,
    }
}

function spreadStyle(spreadIndex: number): StyleValue {
    const isCurrent = spreadIndex === curSpreadIndex.value
    return {
        zIndex: isCurrent ? 2 : 1,
        pointerEvents: isCurrent ? 'auto' : 'none',
    }
}

function getPagePositionRight(pageWidth: number, pageScreenIndex: number): number {
    let rightPadding = (computedAlbumViewportWidth.value - pageWidth * store.pagesPerScreen) / 2
    let nums = pageScreenIndex
    if (store.bookDirection == 1) {
        nums = store.pagesPerScreen - nums - 1
    }
    return rightPadding + nums * pageWidth
}

function calcScreenPageSize(screen: number[]): BookPageDisplayParam[] {
    let result: BookPageDisplayParam[] = []
    if (screen.length === 0) {
        return result
    }
    // calculate page size per screen
    let maxPageRatio = screen.reduce((max, index) => {
        let val = index >= 0 && index < store.pageCount
            ? storeAction.getImgPageHeightOfWidth(index)
            : getBookCoverPlaceholderHeightOfWidth()
        if (val > max) {
            return val
        }
        return max
    }, 0)
    let pagesRatio = maxPageRatio / screen.length // assume all the widths of each page are 1
    let width = 0
    if (pagesRatio >= computedAlbumViewportRatio.value) {
        width = computedAlbumViewportHeight.value / maxPageRatio
    } else {
        width = computedAlbumViewportWidth.value / screen.length
    }
    for (let i = 0; i < screen.length; i++) {
        let pageIndex = <number>screen[i]
        let heightOfWidth = pageIndex >= 0 && pageIndex < store.pageCount
            ? storeAction.getImgPageHeightOfWidth(pageIndex)
            : getBookCoverPlaceholderHeightOfWidth()
        let height = width * heightOfWidth
        let top = computedAlbumViewportHeight.value / 2 - height / 2
        if (store.showTopBar) {
            top += store.topBarHeight
        }
            result.push({
                pageIndex: pageIndex,
            height: height,
            width: width,
            top: top,
            right: getPagePositionRight(width, i),
        })
    }
    return result
}

const spreadPageLists = computed(() => {
    return bookSpreads.value.map(spread => calcScreenPageSize(spread))
})

const cachedBookSpreadList = computed(() => {
    const spreads = bookSpreads.value
    const pageLists = spreadPageLists.value
    if (spreads.length === 0) {
        return []
    }
    const currentSpreadIndex = Math.max(0, Math.min(spreads.length - 1, curSpreadIndex.value))
    const settledIndex = Math.max(0, Math.min(spreads.length - 1, settledSpreadIndex.value))
    const minSpreadIndex = Math.max(0, settledIndex - DOM_SPREAD_CACHE_RADIUS)
    const maxSpreadIndex = Math.min(spreads.length - 1, settledIndex + DOM_SPREAD_CACHE_RADIUS)

    const included = new Set<number>()
    for (const spreadIndex of recentSpreadIndices.value) {
        if (spreadIndex >= 0 && spreadIndex < spreads.length) {
            included.add(spreadIndex)
        }
    }
    for (let spreadIndex = minSpreadIndex; spreadIndex <= maxSpreadIndex; spreadIndex++) {
        included.add(spreadIndex)
    }
    included.add(currentSpreadIndex)
    if (leavingSpreadIndex.value !== null && leavingSpreadIndex.value >= 0 && leavingSpreadIndex.value < spreads.length) {
        included.add(leavingSpreadIndex.value)
    }

    return Array.from(included)
        .sort((a, b) => a - b)
        .map(spreadIndex => ({
            spreadIndex,
            pageList: pageLists[spreadIndex],
        }))
})

const spreadPageSum = computed(() => {
    return bookSpreads.value.length
})

function selectSpreadIndex(spreadIndex: number) {
    const targetSpread = bookSpreads.value[spreadIndex]
    const targetPageIndex = pickBookSpreadAnchorPage(targetSpread, store.curViewIndex)
    storeAction.setCurViewIndex(targetPageIndex, 'book-pagination')
}

const bookTransitionName = computed(() => {
    if (store.pageTurnAnimationMode === 'none') {
        return 'screen-none'
    }
    if (store.pageTurnAnimationMode === 'slide') {
        return store.flipDirection == 0 ? 'screen-slide-next' : 'screen-slide-prev'
    }
    return store.flipDirection == 0 ? 'screen-flip' : 'screen-flip-reverse'
})

function onClickBg(e: any) {
    let y = e.clientY
    switch(true) {
        case y >= 0 && y < store.viewportHeight * 0.3:
            storeAction.setCurViewIndex(store.curViewIndex - store.pagesPerScreen, 'click')
            break
        case y >= store.viewportHeight * 0.3 && y <= store.viewportHeight * 0.7:
            break
        case y >= store.viewportHeight * 0.7 && y <= store.viewportHeight:
            storeAction.setCurViewIndex(store.curViewIndex + store.pagesPerScreen, 'click')
            break
    }
}

</script>

<style lang="scss" scoped>
@import '../style/_responsive';
@import '../style/_variables';

.album-book-view {
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    height: 100%;
    width: 100%;
    // transition: all 0.5s ease;
    
    > .book-spread {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;

        &.is-inactive-spread {
            pointer-events: none !important;

            * {
                pointer-events: none !important;
            }
        }

        > .book-page-container {
            user-select: none;
            position: absolute;
            box-sizing: border-box;
            box-shadow: 0px 19px 10px -8px rgba(0,0,0,0.35);
            overflow: visible;

            &:hover {
                z-index: 13050 !important;
            }
        }
    }

    > .book-page-container {
        user-select: none;
        position: absolute;
        // transition: all 0.5s ease-in-out;
        box-sizing: border-box;
        box-shadow: 0px 19px 10px -8px rgba(0,0,0,0.35);
    }

    &.mode-realistic {
        perspective-origin: 50% 50%;

        &.page-turning {
            perspective: 1800px;

            > .book-spread {
                overflow: visible;
                --curl-before-opacity: 0;
                --curl-after-opacity: 0;
                --curl-before-transform: translateX(0) scaleX(1);
                --curl-after-transform: translateX(0) scaleX(1);

                &::before,
                &::after {
                    content: '';
                    position: absolute;
                    inset: -2% -1%;
                    pointer-events: none;
                    opacity: var(--curl-before-opacity);
                    transition: opacity .42s ease, transform .42s cubic-bezier(0.22, 0.61, 0.36, 1);
                }

                // page curl highlight
                &::before {
                    background: radial-gradient(
                        120% 85% at 52% 50%,
                        rgba(255, 255, 255, 0.24) 0%,
                        rgba(255, 255, 255, 0.09) 26%,
                        rgba(255, 255, 255, 0.02) 62%,
                        rgba(255, 255, 255, 0) 100%
                    );
                    transform: var(--curl-before-transform);
                }

                // inner fold shadow near spine
                &::after {
                    background: linear-gradient(
                        90deg,
                        rgba(0, 0, 0, 0.34) 0%,
                        rgba(0, 0, 0, 0.16) 14%,
                        rgba(0, 0, 0, 0.06) 30%,
                        rgba(0, 0, 0, 0) 55%
                    );
                    opacity: var(--curl-after-opacity);
                    transform: var(--curl-after-transform);
                }

                > .book-page-container {
                    overflow: visible;

                    &::after {
                        content: '';
                        position: absolute;
                        inset: 0;
                        pointer-events: none;
                        background: linear-gradient(
                            90deg,
                            rgba(0, 0, 0, 0.16) 0%,
                            rgba(0, 0, 0, 0.04) 18%,
                            rgba(255, 255, 255, 0) 60%
                        );
                        opacity: 0.35;
                    }
                }
            }
        }
    }

    &.mode-slide {
        > .book-spread {
            box-shadow: 0 16px 26px -14px rgba(0, 0, 0, 0.38);
        }
    }

    > .bottom-pagination {
        position: absolute;
        bottom: 5%;
        left: 50%;
        transform: translateX(-50%) translateZ(0);
        contain: layout paint style;
        background: rgba($book_view_pagination_bg, 0.5);
        border-radius: 3px;
        box-shadow: 1px 1px 5px 1px rgba(0, 0, 0, 0.1);
        z-index: 12000;

        &:hover {
            background: $book_view_pagination_bg;
        }
    }
}

.action-panel {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 10000;
    opacity: 0.5;
    display: none;
    background-color: black;
    pointer-events: none;

    .next {
        position: absolute;
        left: 0;
        right: 0;
        height: 30%;
        bottom: 0;
        background-color: red;
        pointer-events: none;

    }
    .pre {
        position: absolute;
        left: 0;
        right: 0;
        height: 30%;
        top: 0;
        background-color: green;
        pointer-events: none;

    }
    .setting {
        position: absolute;
        left: 0;
        right: 0;
        height: 40%;
        top: 50%;
        transform: translateY(-50%);
        background-color: purple;
        pointer-events: none;
    }
}

// transition styles
.screen-flip-enter-active,
.screen-flip-leave-active,
.screen-flip-reverse-enter-active,
.screen-flip-reverse-leave-active {
  transform-style: preserve-3d;
  backface-visibility: hidden;
  will-change: transform, opacity;
  transition: transform .46s cubic-bezier(0.22, 0.61, 0.36, 1), opacity .46s ease;
}
.screen-flip-enter-from {
    transform-origin: right center;
    transform: translate3d(10%, 0, 0) rotateY(66deg) rotateX(3.2deg) skewY(-2.4deg) scale(0.95, 0.98);
    opacity: 0.64;
    --curl-before-opacity: 0.62;
    --curl-after-opacity: 0.72;
    --curl-before-transform: translateX(-3.2%) scaleX(0.9);
    --curl-after-transform: translateX(-2.2%) scaleX(1.12);
}

.screen-flip-leave-to {
  transform-origin: left center;
  transform: translate3d(-16%, 0, 0) rotateY(-80deg) rotateX(-2.8deg) skewY(2.6deg) scale(0.91, 0.97);
  opacity: 0;
    --curl-before-opacity: 0.78;
    --curl-after-opacity: 0.82;
    --curl-before-transform: translateX(5.2%) scaleX(1.16);
    --curl-after-transform: translateX(3.8%) scaleX(1.24);
}

.screen-flip-reverse-enter-from {
    transform-origin: left center;
    transform: translate3d(-10%, 0, 0) rotateY(-66deg) rotateX(-3.2deg) skewY(2.4deg) scale(0.95, 0.98);
    opacity: 0.64;
    --curl-before-opacity: 0.62;
    --curl-after-opacity: 0.72;
    --curl-before-transform: translateX(3.2%) scaleX(-0.9);
    --curl-after-transform: translateX(2.2%) scaleX(-1.12);
}

.screen-flip-reverse-leave-to {
  transform-origin: right center;
  transform: translate3d(16%, 0, 0) rotateY(80deg) rotateX(2.8deg) skewY(-2.6deg) scale(0.91, 0.97);
  opacity: 0;
    --curl-before-opacity: 0.78;
    --curl-after-opacity: 0.82;
    --curl-before-transform: translateX(-5.2%) scaleX(-1.16);
    --curl-after-transform: translateX(-3.8%) scaleX(-1.24);
}

.screen-slide-next-enter-active,
.screen-slide-next-leave-active,
.screen-slide-prev-enter-active,
.screen-slide-prev-leave-active {
    backface-visibility: hidden;
    will-change: transform, opacity;
    transition: transform .44s cubic-bezier(0.22, 0.74, 0.2, 1), opacity .44s ease;
}

.screen-slide-next-enter-from {
    transform: translate3d(0, 102%, 0);
    opacity: 0.95;
}

.screen-slide-next-leave-to {
    transform: translate3d(0, -102%, 0);
    opacity: 0;
}

.screen-slide-prev-enter-from {
    transform: translate3d(0, -102%, 0);
    opacity: 0.95;
}

.screen-slide-prev-leave-to {
    transform: translate3d(0, 102%, 0);
    opacity: 0;
}

.screen-none-enter-active,
.screen-none-leave-active {
    transition-duration: 0s;
}

.screen-none-enter-from,
.screen-none-leave-to {
    opacity: 1;
    transform: none;
}

</style>
