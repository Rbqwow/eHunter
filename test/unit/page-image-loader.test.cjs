const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const vue = require('vue');

const root = path.resolve(__dirname, '../..');

function createLoaderHarness({
    readingMode = 1,
    pagesPerScreen = 2,
    isChangeOddEven = false,
    pageCount = 20,
    curViewIndex = 11,
    loadNum = 100,
} = {}) {
    const modules = new Map();
    const rafQueue = new Map();
    let nextRafId = 1;
    let nextTimerId = 1;
    const timers = new Map();

    const store = vue.reactive({
        readingMode,
        pagesPerScreen,
        isChangeOddEven,
        pageCount,
        curViewIndex,
        loadNum,
        autoRetryByOtherSource: true,
        imgPageInfos: Array.from({ length: pageCount }, (_, i) => ({
            id: i,
            index: i,
            pageUrl: `/s/mock/${i + 1}`,
            src: '',
            heightOfWidth: 1.4,
            preciseHeightOfWidth: 0,
        })),
    });

    const storeAction = {
        setImgPageInfoSrc(index, src) {
            if (store.imgPageInfos[index]) {
                store.imgPageInfos[index].src = src;
            }
        },
        setImgPageInfoPreciseHeightOfWidth(index, val) {
            if (store.imgPageInfos[index]) {
                store.imgPageInfos[index].preciseHeightOfWidth = val;
            }
        },
    };

    const sandbox = {
        Promise,
        Set,
        Map,
        Array,
        Error,
        Math,
        Boolean,
        Number,
        Object,
        Date,
        performance: { now: () => Date.now() },
        document: {
            readyState: 'complete',
            visibilityState: 'visible',
            addEventListener: () => {},
            removeEventListener: () => {},
        },
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            localStorage: { getItem: () => null, setItem: () => {} },
        },
        setTimeout: (fn, delay) => {
            const id = nextTimerId++;
            timers.set(id, { fn, delay });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: (fn) => {
            const id = nextRafId++;
            rafQueue.set(id, fn);
            return id;
        },
        cancelAnimationFrame: (id) => {
            rafQueue.delete(id);
        },
        console,
    };
    const context = vm.createContext(sandbox);

    function load(filename) {
        const absolute = path.resolve(root, filename);
        const file = fs.existsSync(absolute)
            ? absolute
            : ['.ts', '.js'].map(ext => `${absolute}${ext}`).find(candidate => fs.existsSync(candidate));
        if (!file) {
            throw new Error(`Module not found: ${filename}`);
        }
        if (modules.has(file)) {
            return modules.get(file).exports;
        }
        const module = { exports: {} };
        modules.set(file, module);

        if (file.endsWith(path.join('core', 'store', 'app.ts'))) {
            module.exports = { store, storeAction };
            return module.exports;
        }
        if (file.endsWith(path.join('core', 'store', 'i18n.ts'))) {
            module.exports = {
                i18n: vue.ref({
                    reload: 'reload',
                    loadingImgFailed: 'failed',
                    imgLoaded: 'loaded',
                    waiting: 'waiting',
                    loadingImg: 'loading',
                    noOriginalImg: 'no-origin',
                    loadingFailed: 'failed',
                }),
            };
            return module.exports;
        }

        const source = fs.readFileSync(file, 'utf8');
        const transpiled = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
            fileName: file,
        }).outputText;
        const fn = vm.runInContext(
            `(function(exports, require, module, __filename, __dirname) { ${transpiled}\n})`,
            context,
            { filename: file },
        );
        fn(module.exports, spec => {
            if (spec === 'vue') {
                return vue;
            }
            if (spec.startsWith('.')) {
                return load(path.resolve(path.dirname(file), spec));
            }
            throw new Error(`Unexpected external import in unit test: ${spec}`);
        }, module, file, path.dirname(file));
        return module.exports;
    }

    const loaderMod = load('core/components/composables/usePageImageLoader.ts');
    const modelMod = load('core/model/model.ts');

    const flushAll = async () => {
        for (let i = 0; i < 6; i++) {
            await vue.nextTick();
            await Promise.resolve();
        }
    };

    const runNextRaf = async () => {
        const entries = [...rafQueue.entries()];
        rafQueue.clear();
        for (const [, fn] of entries) {
            fn(16);
        }
        await flushAll();
    };

    const runTimers = async (maxDelayMs = 1000) => {
        const entries = [...timers.entries()].filter(([, item]) => item.delay <= maxDelayMs);
        for (const [id, item] of entries) {
            timers.delete(id);
            item.fn();
        }
        await flushAll();
    };

    return {
        ...loaderMod,
        ...modelMod,
        store,
        storeAction,
        rafQueue,
        flushAll,
        runNextRaf,
        runTimers,
    };
}

function createMockImgElement(src, { complete = false, naturalWidth = 0, decode = () => Promise.resolve() } = {}) {
    return {
        _src: src,
        complete,
        naturalWidth,
        decode,
        removedAttributes: [],
        getAttribute(name) {
            return name === 'src' ? this._src : null;
        },
        removeAttribute(name) {
            this.removedAttributes.push(name);
            if (name === 'src') {
                this._src = null;
            }
        },
    };
}

test('detaches incomplete <img> src on hide and ignores stale @load/@error events', async () => {
    const {
        usePageImageLoader,
        ImgLoadStatus,
        store,
        flushAll,
    } = createLoaderHarness({ readingMode: 1, curViewIndex: 13 });

    const pageIndex = 13; // page 14
    const url = 'https://example.test/V2_009.webp';
    store.imgPageInfos[pageIndex].src = url;

    const imgRef = vue.ref(null);
    const activeRef = vue.ref(true);
    const albumService = {
        isSupportImgChangeSource: () => false,
        getImgSrc: async () => store.imgPageInfos[pageIndex],
    };

    const scope = vue.effectScope();
    const loader = scope.run(() => usePageImageLoader({
        index: pageIndex,
        albumService,
        imgPageInfo: vue.computed(() => store.imgPageInfos[pageIndex]),
        imgRef,
        isActive: () => activeRef.value,
        activeRef: vue.computed(() => activeRef.value),
        warmMagnifierSource: async () => {},
    }));

    const firstImg = createMockImgElement(url, { complete: false, naturalWidth: 0 });
    imgRef.value = firstImg;
    await flushAll();

    assert.equal(loader.shouldRenderImg.value, true);
    assert.equal(loader.curLoadStatus.value, ImgLoadStatus.Loading);

    // Flip away before the 20MB WebP finishes downloading -> shouldRenderImg becomes false.
    store.curViewIndex = 11;
    imgRef.value = null;
    await flushAll();

    assert.equal(loader.shouldRenderImg.value, false);
    assert.deepEqual(firstImg.removedAttributes, ['src']);

    // A late @load event from the detached element must be ignored and must not flip shouldRenderImg back to true.
    loader.loaded({ target: firstImg });
    await flushAll();

    assert.equal(loader.shouldRenderImg.value, false);
    assert.notEqual(loader.curLoadStatus.value, ImgLoadStatus.Loaded);

    scope.stop();
});

test('stops rAF first-frame probe once naturalWidth > 0 and recovers cleanly on re-render', async () => {
    const {
        usePageImageLoader,
        ImgLoadStatus,
        store,
        rafQueue,
        flushAll,
        runNextRaf,
        runTimers,
    } = createLoaderHarness({ readingMode: 1, curViewIndex: 11 });

    const pageIndex = 11; // page 12
    const url = 'https://example.test/V2_007.webp';
    store.imgPageInfos[pageIndex].src = url;

    const imgRef = vue.ref(null);
    const activeRef = vue.ref(true);
    const albumService = {
        isSupportImgChangeSource: () => false,
        getImgSrc: async () => store.imgPageInfos[pageIndex],
    };

    const scope = vue.effectScope();
    const loader = scope.run(() => usePageImageLoader({
        index: pageIndex,
        albumService,
        imgPageInfo: vue.computed(() => store.imgPageInfos[pageIndex]),
        imgRef,
        isActive: () => activeRef.value,
        activeRef: vue.computed(() => activeRef.value),
        warmMagnifierSource: async () => {},
    }));

    const imgEl = createMockImgElement(url, { complete: false, naturalWidth: 0 });
    imgRef.value = imgEl;
    await flushAll();

    assert.equal(loader.hasFirstFrame.value, false);
    assert.equal(rafQueue.size, 1);

    // Header / first frame arrives while full 20MB animated WebP is still downloading -> stop rAF loop immediately,
    // wait brief streaming threshold before lifting placeholder so fast static images finish atomically.
    imgEl.naturalWidth = 960;
    await runNextRaf();
    assert.equal(rafQueue.size, 0);
    assert.equal(loader.hasFirstFrame.value, false);
    await runTimers(500);
    assert.equal(loader.hasFirstFrame.value, true);

    // Complete load -> Loaded.
    imgEl.complete = true;
    loader.loaded({ target: imgEl });
    await flushAll();
    assert.equal(loader.curLoadStatus.value, ImgLoadStatus.Loaded);

    // Simulate activeRef toggling off and back on (e.g. DOM remount / scroll away & back) for the same src.
    activeRef.value = false;
    imgRef.value = null;
    await flushAll();
    assert.equal(loader.hasFirstFrame.value, false);

    activeRef.value = true;
    const secondImgEl = createMockImgElement(url, { complete: true, naturalWidth: 960 });
    imgRef.value = secondImgEl;
    await flushAll();

    assert.equal(loader.hasFirstFrame.value, true);
    assert.equal(loader.curLoadStatus.value, ImgLoadStatus.Loaded);

    scope.stop();
});

test('book mode preload targets pages after the entire current spread', async () => {
    const requestedIndices = [];
    const {
        usePageImageLoader,
        store,
        flushAll,
    } = createLoaderHarness({ readingMode: 1, pagesPerScreen: 2, curViewIndex: 11, loadNum: 100 });

    // Mark current spread pages (11 and 12) as already having srcs and loaded.
    store.imgPageInfos[11].src = 'https://example.test/12.webp';
    store.imgPageInfos[12].src = 'https://example.test/13.webp';

    const albumService = {
        isSupportImgChangeSource: () => false,
        getImgSrc: async (idx) => {
            requestedIndices.push(idx);
            return {
                ...store.imgPageInfos[idx],
                src: `https://example.test/${idx + 1}.webp`,
            };
        },
    };

    const imgRef11 = vue.ref(null);
    const scope = vue.effectScope();
    const loader11 = scope.run(() => usePageImageLoader({
        index: 11,
        albumService,
        imgPageInfo: vue.computed(() => store.imgPageInfos[11]),
        imgRef: imgRef11,
        isActive: () => true,
        activeRef: vue.computed(() => true),
        warmMagnifierSource: async () => {},
    }));

    imgRef11.value = createMockImgElement('https://example.test/12.webp', { complete: true, naturalWidth: 960 });
    await flushAll();
    // Spread 6 is [11, 12]; next spread is [13, 14]. Both 13 and 14 should be queued for preload.
    assert.equal(requestedIndices.includes(13), true);
    assert.equal(requestedIndices.includes(14), true);
    assert.equal(loader11.curLoadStatus.value, 3);

    scope.stop();
});

test('preload honors configured loadNum beyond 2-3 pages and awaits img.decode before marking decoded', async () => {
    const requestedIndices = [];
    const {
        usePageImageLoader,
        store,
        flushAll,
    } = createLoaderHarness({ readingMode: 1, pagesPerScreen: 2, curViewIndex: 1, loadNum: 8, pageCount: 20 });

    store.imgPageInfos[1].src = 'https://example.test/2.jpg';
    store.imgPageInfos[2].src = 'https://example.test/3.jpg';

    let resolveDecode;
    const decodePromise = new Promise(resolve => {
        resolveDecode = resolve;
    });

    const albumService = {
        isSupportImgChangeSource: () => false,
        getImgSrc: async (idx) => {
            requestedIndices.push(idx);
            return {
                ...store.imgPageInfos[idx],
                src: `https://example.test/${idx + 1}.jpg`,
            };
        },
    };

    const imgRef1 = vue.ref(null);
    const scope = vue.effectScope();
    const loader1 = scope.run(() => usePageImageLoader({
        index: 1,
        albumService,
        imgPageInfo: vue.computed(() => store.imgPageInfos[1]),
        imgRef: imgRef1,
        isActive: () => true,
        activeRef: vue.computed(() => true),
        warmMagnifierSource: async () => {},
    }));

    const imgEl = createMockImgElement('https://example.test/2.jpg', {
        complete: true,
        naturalWidth: 1200,
        decode: () => decodePromise,
    });
    imgRef1.value = imgEl;
    await flushAll();

    // curLoadStatus is Loaded immediately, while preview remains until img.decode() resolves.
    assert.equal(loader1.curLoadStatus.value, 3);
    assert.equal(loader1.isImageDecoded.value, false);

    resolveDecode();
    await flushAll();
    assert.equal(loader1.isImageDecoded.value, true);

    // Current spread is [1, 2], loadNum = 8 -> pages 3..10 (8 forward pages) and backward page 0 should be requested.
    for (let idx = 3; idx <= 10; idx++) {
        assert.equal(requestedIndices.includes(idx), true, `expected page index ${idx} to be preloaded`);
    }
    assert.equal(requestedIndices.includes(0), true);

    scope.stop();
});

test('AlbumBookView hides inactive spreads via v-show without 2px sliver opacity hacks', () => {
    const source = fs.readFileSync(path.resolve(root, 'core/components/AlbumBookView.vue'), 'utf8');
    assert.equal(source.includes('v-show="spread.spreadIndex === curSpreadIndex"'), true);
    assert.equal(source.includes('translate3d(calc(100% - 2px)'), false);
    assert.equal(source.includes('opacity: 0.01'), false);
});
