<template>
    <div class="album-scroll-view">
        <!-- scroll view -->
        <awesome-scroll-view ref="scrollView" class="scroll-view" v-if="store.imgPageInfos && store.imgPageInfos.length > 0"
            :on-scroll-stopped="onScrollStopped" @topIn="storeAction.setTopBar(true)" :listen-scroll="true"
            @topLeave="storeAction.setTopBar(false)">
            <h1>{{ store.albumTitle }}</h1>
            <Pagination v-if="computedVolumeSum > 1" class="top-pagination" :cur-index="computedCurVolNo - 1"
                :page-sum="computedVolumeSum" @change="selectVol" />
            <div class="page-container" ref="pageContainers" v-for="i of computedVolPageIndexList"
                :key="i"
                :style="{ 'width': `${store.widthScale}%`, 'padding-bottom': `${store.widthScale * storeAction.getImgPageHeightOfWidth(i)}%`, 'margin': `${store.scrollPageMargin}px auto` }">
                <PageView :index="i" :active="nearbyIndexList.indexOf(i) > -1"/>
            </div>
            <Pagination v-if="computedVolumeSum > 1" class="bottom-pagination" :cur-index="computedCurVolNo - 1"
                :page-sum="computedVolumeSum" @change="selectVol" />
        </awesome-scroll-view>
    </div>
</template>

<script setup lang="ts">
import AwesomeScrollView from './widget/AwesomeScrollView.vue'
import Pagination from './widget/Pagination.vue'
import PageView from './PageView.vue'
import { store, storeAction, computedVolIndex, computedVolFirstIndex, computedVolPageIndexList, computedVolumeSum, computedCurVolNo } from '../store/app'
import { ref, computed, watch, inject, onMounted, nextTick, onUnmounted } from 'vue'

const updater = 'album_scroll_view'
const animationTime = 800
const scrollPosition = ref(0)
const scrollView: any = ref(null)
const pageContainers: any = ref(null)

function onScrollStopped(position: number) {
    scrollPosition.value = position
}

// watch scrollPosition to calculate curIndex
watch(scrollPosition, () => {
    if (!pageContainers.value || pageContainers.value.length === 0) {
        return
    }
    // sort a copy because changing volume size can leave template refs out-of-order
    const cons = [...pageContainers.value].sort((a, b) => a.offsetTop - b.offsetTop)
    let index
    if (scrollPosition.value !== 0) {
        // avoiding that in the top, page 1 and page 2 show at the same time, the index is 1
        const threshold = scrollPosition.value + window.innerHeight
        let result = -1
        for (let i = cons.length - 1; i >= 0; i--) {
            if (cons[i].offsetTop <= threshold) {
                result = i
                break
            }
        }
        const volIndex = result === -1 ? cons.length - 1 : result
        index = volIndex + computedVolFirstIndex.value
    } else {
        index = computedVolFirstIndex.value
    }
    if (index !== store.curViewIndex) {
        storeAction.setCurViewIndex(index, updater)
    }
})

async function scrollToCurIndex() {
    await nextTick()
    if (!pageContainers.value) {
        return
    }
    if (computedVolIndex.value == 0) {
        scrollView.value!.scrollTo(0, animationTime)
        return
    }
    const target = pageContainers.value[computedVolIndex.value]
    if (!target) {
        scrollView.value.scrollTo(0, animationTime)
        return
    }
    scrollView.value.scrollTo(
        target.offsetTop - 100,
        animationTime
    )
}

onMounted(() => {
    setTimeout(() => {
        scrollToCurIndex()
    }, 200)
})

// return a indexes array. the index is index of page, determining the show of pages.
const nearbyIndexList = computed(() => {
    let start = store.curViewIndex - store.loadNum
    if (start < 0) {
        start = 0
    }
    let end = store.curViewIndex + store.loadNum
    if (end > store.pageCount - 1) {
        end = store.pageCount - 1
    }
    let result: number[] = []
    for (let i = start; i <= end; i++) {
        result.push(i)
    }
    return result
})

watch(() => store.curViewIndex, (newVal, oldVal) => {
    // sync pagination
    if (store.curViewIndexUpdater !== updater) {
        scrollToCurIndex()
    }
})

function selectVol(volIndex: number) {
    storeAction.setCurViewIndex(volIndex * store.volumeSize, 'scroll_view_vol')
}
</script>

<style lang="scss" scoped>
@import '../style/_responsive';
@import '../style/_variables';

.album-scroll-view {
    position: relative;
    flex-direction: column;
    align-items: center;
    height: 100%;
    width: 100%;

    >.scroll-view {
        height: 100%;
        width: 100%;

        h1 {
            color: #c9cacf;
            padding: 10px 20px;
            font-size: 18px;
            text-align: center;
            margin-top: 60px;
        }

        >.top-pagination {
            margin-top: 15px;
            margin-bottom: 15px;
        }

        >.bottom-pagination {
            margin-top: 15px;
            margin-bottom: 30px;
        }

        .page-container {
            transition: width 0.3s ease, padding-bottom 0.3s ease, margin 0.3s ease;
            contain: layout style;
            height: 0;
            position: relative;

            &:first-of-type {
                margin-top: 35px;
            }

            &:last-of-type {
                margin-bottom: 35px;
            }
        }
    }
}
</style>
