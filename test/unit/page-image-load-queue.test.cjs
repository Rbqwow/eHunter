const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function createHarness({ readyState = 'complete' } = {}) {
    let time = 10000;
    let timerId = 0;
    const timers = new Map();
    const listeners = new Map();
    const modules = new Map();
    const docState = { readyState };

    const schedule = (fn, delay) => {
        const id = ++timerId;
        timers.set(id, { fn, at: time + Number(delay) });
        return id;
    };
    const listen = (target, event, fn) => {
        const key = `${target}:${event}`;
        listeners.set(key, [...(listeners.get(key) || []), fn]);
    };
    const unlisten = (target, event, fn) => {
        const key = `${target}:${event}`;
        listeners.set(key, (listeners.get(key) || []).filter(item => item !== fn));
    };

    const documentObj = {
        get readyState() { return docState.readyState; },
        addEventListener: (event, fn) => listen('document', event, fn),
        removeEventListener: (event, fn) => unlisten('document', event, fn),
    };
    const windowObj = {
        addEventListener: (event, fn) => listen('window', event, fn),
        removeEventListener: (event, fn) => unlisten('window', event, fn),
    };

    const sandbox = {
        Promise,
        Date: class extends Date { static now() { return time; } },
        Set,
        Map,
        Array,
        Error,
        Math,
        Boolean,
        Number,
        Object,
        AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
        document: documentObj,
        window: windowObj,
        setTimeout: (fn, delay) => schedule(fn, delay),
        clearTimeout: id => timers.delete(id),
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
                return {
                    nextTick: () => Promise.resolve(),
                    reactive: value => value,
                };
            }
            if (spec.startsWith('.')) {
                return load(path.resolve(path.dirname(file), spec));
            }
            throw new Error(`Unexpected external import in unit test: ${spec}`);
        }, module, file, path.dirname(file));
        return module.exports;
    }

    const flushMicrotasks = async (rounds = 8) => {
        for (let i = 0; i < rounds; i++) {
            await Promise.resolve();
        }
    };

    const advanceBy = async (ms) => {
        const target = time + ms;
        while (true) {
            const next = [...timers.entries()]
                .filter(([, item]) => item.at <= target)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) {
                time = target;
                break;
            }
            const [id, item] = next;
            timers.delete(id);
            time = item.at;
            item.fn();
            await flushMicrotasks();
        }
    };

    const emitWindowLoad = async () => {
        docState.readyState = 'complete';
        for (const fn of [...(listeners.get('document:readystatechange') || [])]) {
            fn();
        }
        for (const fn of [...(listeners.get('window:load') || [])]) {
            fn();
        }
        await flushMicrotasks();
    };

    const { PageImageLoadQueue } = load('core/service/PageImageLoadQueue.ts');
    const { ImgSrcMode } = load('core/model/model.ts');
    return {
        PageImageLoadQueue,
        ImgSrcMode,
        flushMicrotasks,
        advanceBy,
        emitWindowLoad,
    };
}

function createFakeImages() {
    const created = [];
    const factory = () => {
        const img = {
            decoding: '',
            _src: '',
            complete: false,
            naturalWidth: 0,
            onload: null,
            onerror: null,
            removedAttributes: [],
            get src() { return this._src; },
            set src(value) { this._src = value; },
            removeAttribute(name) {
                this.removedAttributes.push(name);
                if (name === 'src') {
                    this._src = '';
                }
            },
            triggerLoad() {
                this.complete = true;
                this.naturalWidth = 1000;
                this.onload?.();
            },
            triggerError() {
                this.complete = true;
                this.naturalWidth = 0;
                this.onerror?.();
            },
        };
        created.push(img);
        return img;
    };
    return { created, factory };
}

test('visible pages take priority over background preloads and respect concurrency limits', async () => {
    const { PageImageLoadQueue, flushMicrotasks } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    const pendingGetImgSrc = [];
    const startedIndices = [];
    const loadedSrcs = new Map();

    let currentIndex = 0;
    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: (index) => new Promise((resolve) => {
                startedIndices.push(index);
                pendingGetImgSrc.push({ index, resolve });
            }),
        },
        getCurrentIndex: () => currentIndex,
        getVisibleIndices: () => [0, 1],
        getPreloadIndices: () => [2, 3, 4],
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        onResolved: (idx, info) => loadedSrcs.set(idx, info.src),
        maxConcurrentUrlRequests: 2,
        maxConcurrentAssetPreloads: 2,
        createPreloadImage: fakeImages.factory,
    });

    queue.request(4, () => true);
    queue.request(1, () => true);
    queue.request(0, () => true);
    await flushMicrotasks();

    // Only visible pages (0, 1) start URL fetches first; background page 4 waits.
    assert.deepEqual(startedIndices, [0, 1]);
    assert.equal(fakeImages.created.length, 0);

    // Finish visible URL resolutions, then simulate visible DOM img loads.
    pendingGetImgSrc.splice(0).forEach(entry => {
        entry.resolve({ id: `p${entry.index}`, pageUrl: '', src: `https://img/${entry.index}.webp` });
    });
    queue.setVisibleImageLoading(0, true);
    await flushMicrotasks();

    // Background URLs & asset preloads remain paused while visible page 0 DOM <img> is loading.
    assert.deepEqual(startedIndices, [0, 1]);
    assert.equal(fakeImages.created.length, 0);

    // Once visible images finish, nearest preload URLs (2, 3) start within maxConcurrentUrlRequests = 2,
    // while page 4 waits until a slot opens.
    queue.markImageLoaded(0, 'https://img/0.webp');
    await flushMicrotasks();
    assert.deepEqual(startedIndices, [0, 1, 2, 3]);

    // Resolve page 2 -> page 4 takes the free URL slot and page 2 starts Image preload.
    pendingGetImgSrc.shift().resolve({ id: 'p2', pageUrl: '', src: 'https://img/2.webp' });
    await flushMicrotasks();
    assert.deepEqual(startedIndices, [0, 1, 2, 3, 4]);
    assert.deepEqual(fakeImages.created.map(i => i.src), ['https://img/2.webp']);
});

test('visible image loading preempts background asset preloads and resumes afterward', async () => {
    const { PageImageLoadQueue, flushMicrotasks } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    const loadedSrcs = new Map([
        [0, 'https://img/0.webp'],
        [1, 'https://img/1.webp'],
        [2, 'https://img/2.webp'],
    ]);

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: async (idx) => ({ id: `p${idx}`, pageUrl: '', src: loadedSrcs.get(idx) || '' }),
        },
        getCurrentIndex: () => 0,
        getVisibleIndices: () => [0],
        getPreloadIndices: () => [1, 2],
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        maxConcurrentAssetPreloads: 2,
        createPreloadImage: fakeImages.factory,
    });

    queue.refreshPriority();
    await flushMicrotasks();
    assert.equal(fakeImages.created.length, 2);
    const [img1, img2] = fakeImages.created;

    // Visible page 0 starts loading -> preempts active background Image preloads.
    queue.setVisibleImageLoading(0, true);
    await flushMicrotasks();
    assert.equal(img1.src, '');
    assert.equal(img2.src, '');

    // Page 0 finishes -> preempted background pages re-enqueue cleanly.
    queue.markImageLoaded(0, 'https://img/0.webp');
    await flushMicrotasks();
    assert.equal(fakeImages.created.length, 4);
    assert.deepEqual(fakeImages.created.slice(2).map(i => i.src), ['https://img/1.webp', 'https://img/2.webp']);
});

test('uses fetch preload instead of Image before window load and switches after document completes', async () => {
    const { PageImageLoadQueue, flushMicrotasks, advanceBy, emitWindowLoad } = createHarness({ readyState: 'interactive' });
    const fakeImages = createFakeImages();
    const fetchCalls = [];
    const loadedSrcs = new Map([
        [1, 'https://img/1.webp'],
        [2, 'https://img/2.webp'],
    ]);
    let preloadIndices = [1, 2];

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: async (idx) => ({ id: `p${idx}`, pageUrl: '', src: loadedSrcs.get(idx) || '' }),
        },
        getCurrentIndex: () => 0,
        getVisibleIndices: () => [0],
        getPreloadIndices: () => preloadIndices,
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        maxConcurrentAssetPreloads: 1,
        initialLoadGraceMs: 4000,
        createPreloadImage: fakeImages.factory,
        fetchPreload: async (src) => {
            fetchCalls.push(src);
            return true;
        },
    });

    queue.refreshPriority();
    await flushMicrotasks();
    // Before grace period elapses and before window.load, no background preload starts.
    assert.equal(fakeImages.created.length, 0);
    assert.equal(fetchCalls.length, 0);

    // After grace period elapses while still interactive: warms HTTP cache via fetch, never Image.
    await advanceBy(4000);
    assert.equal(fakeImages.created.length, 0);
    assert.deepEqual(fetchCalls, ['https://img/1.webp', 'https://img/2.webp']);
    assert.equal(queue.isAssetReady(1, 'https://img/1.webp'), true);
    assert.equal(queue.isAssetReady(2, 'https://img/2.webp'), true);

    // Once window.load completes on the same queue, subsequent preloads switch to Image subresources.
    loadedSrcs.set(3, 'https://img/3.webp');
    preloadIndices = [1, 2, 3];
    const beforeImages = fakeImages.created.length;
    await emitWindowLoad();
    queue.refreshPriority();
    await flushMicrotasks();
    assert.equal(fakeImages.created.length, beforeImages + 1);
    assert.equal(fakeImages.created[beforeImages].src, 'https://img/3.webp');
});

test('retains bounded LRU preloaded images and evicts oldest references cleanly', async () => {
    const { PageImageLoadQueue, flushMicrotasks } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    const loadedSrcs = new Map([
        [1, 'https://img/1.webp'],
        [2, 'https://img/2.webp'],
        [3, 'https://img/3.webp'],
    ]);

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: async (idx) => ({ id: `p${idx}`, pageUrl: '', src: loadedSrcs.get(idx) || '' }),
        },
        getCurrentIndex: () => 0,
        getVisibleIndices: () => [0],
        getPreloadIndices: () => [1, 2, 3],
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        maxConcurrentAssetPreloads: 1,
        maxRetainedPreloadImages: 2,
        createPreloadImage: fakeImages.factory,
    });

    queue.refreshPriority();
    await flushMicrotasks();
    fakeImages.created[0].triggerLoad();
    await flushMicrotasks();
    fakeImages.created[1].triggerLoad();
    await flushMicrotasks();
    fakeImages.created[2].triggerLoad();
    await flushMicrotasks();

    assert.equal(fakeImages.created.length, 3);
    // Page 1 (oldest) evicted to respect maxRetainedPreloadImages = 2; pages 2 and 3 remain pinned.
    assert.equal(fakeImages.created[0].src, '');
    assert.equal(fakeImages.created[1].src, 'https://img/2.webp');
    assert.equal(fakeImages.created[2].src, 'https://img/3.webp');
});

test('stalled background preload falls back once to ChangeSource and avoids retry loops', async () => {
    const { PageImageLoadQueue, ImgSrcMode, flushMicrotasks, advanceBy } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    const calls = [];
    const resolved = [];
    const fallbackErrors = [];
    const loadedSrcs = new Map([[2, 'https://dead-peer/2.webp']]);

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: async (idx, mode, forceRefresh) => {
                calls.push({ idx, mode, forceRefresh: Boolean(forceRefresh) });
                if (mode === ImgSrcMode.ChangeSource) {
                    const nextInfo = { id: 'p2', pageUrl: '', src: 'https://healthy-peer/2.webp' };
                    loadedSrcs.set(idx, nextInfo.src);
                    return nextInfo;
                }
                return { id: 'p2', pageUrl: '', src: 'https://dead-peer/2.webp' };
            },
        },
        getCurrentIndex: () => 0,
        getVisibleIndices: () => [0],
        getPreloadIndices: () => [2],
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        onResolved: (idx, info, mode) => resolved.push({ idx, src: info.src, mode }),
        onFallbackError: (idx, err) => fallbackErrors.push({ idx, err }),
        canFallbackSource: () => true,
        assetPreloadTimeoutMs: 25000,
        createPreloadImage: fakeImages.factory,
    });

    queue.refreshPriority();
    await flushMicrotasks();
    assert.equal(fakeImages.created.length, 1);
    assert.equal(fakeImages.created[0].src, 'https://dead-peer/2.webp');

    // Stall for 25s -> abort dead image and run one background ChangeSource fallback.
    await advanceBy(25000);
    assert.equal(fakeImages.created[0].src, '');
    assert.deepEqual(calls, [{ idx: 2, mode: ImgSrcMode.ChangeSource, forceRefresh: true }]);
    assert.deepEqual(resolved, [{ idx: 2, src: 'https://healthy-peer/2.webp', mode: ImgSrcMode.ChangeSource }]);
    assert.equal(fakeImages.created.length, 2);
    assert.equal(fakeImages.created[1].src, 'https://healthy-peer/2.webp');

    // If the fallback URL also errors, do NOT trigger another ChangeSource call.
    fakeImages.created[1].triggerError();
    await flushMicrotasks();
    assert.equal(calls.length, 1);
    assert.equal(fallbackErrors.length, 0);

    // invalidateAsset resets retained/ready/fallback state so future loads start fresh.
    queue.invalidateAsset(2);
    assert.equal(queue.isAssetReady(2, 'https://healthy-peer/2.webp'), false);
});

test('invalidateAsset releases retained LRU image and clears ready state', async () => {
    const { PageImageLoadQueue, flushMicrotasks } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    const loadedSrcs = new Map([[1, 'https://img/1.webp']]);

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: async () => ({ id: 'p1', pageUrl: '', src: 'https://img/1.webp' }),
        },
        getCurrentIndex: () => 0,
        getVisibleIndices: () => [0],
        getPreloadIndices: () => [1],
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        maxRetainedPreloadImages: 4,
        createPreloadImage: fakeImages.factory,
    });

    queue.refreshPriority();
    await flushMicrotasks();
    fakeImages.created[0].triggerLoad();
    await flushMicrotasks();
    assert.equal(queue.isAssetReady(1, 'https://img/1.webp'), true);
    assert.equal(fakeImages.created[0].src, 'https://img/1.webp');

    queue.invalidateAsset(1);
    assert.equal(queue.isAssetReady(1, 'https://img/1.webp'), false);
    assert.equal(fakeImages.created[0].src, '');
});

test('defers background preloads across navigation cooldown and prunes retained images outside window', async () => {
    const { PageImageLoadQueue, flushMicrotasks, advanceBy } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    const loadedSrcs = new Map([
        [0, 'https://img/0.webp'],
        [1, 'https://img/1.webp'],
        [2, 'https://img/2.webp'],
        [10, 'https://img/10.webp'],
        [11, 'https://img/11.webp'],
    ]);
    let curIndex = 0;
    let preloadIndices = [1, 2];

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: async (idx) => ({ id: `p${idx}`, pageUrl: '', src: loadedSrcs.get(idx) || '' }),
        },
        getCurrentIndex: () => curIndex,
        getVisibleIndices: () => [curIndex],
        getPreloadIndices: () => preloadIndices,
        getLoadedSrc: idx => loadedSrcs.get(idx) || '',
        maxConcurrentAssetPreloads: 1,
        maxRetainedPreloadImages: 6,
        backgroundCooldownMs: 350,
        createPreloadImage: fakeImages.factory,
    });

    // Initial load has no navigation cooldown -> preloads page 1 immediately.
    queue.refreshPriority();
    await flushMicrotasks();
    assert.equal(fakeImages.created.length, 1);
    assert.equal(fakeImages.created[0].src, 'https://img/1.webp');
    fakeImages.created[0].triggerLoad();
    await flushMicrotasks();
    assert.equal(fakeImages.created[0].src, 'https://img/1.webp');

    // Navigating far ahead prunes out-of-window retained page 1 and defers background preload during cooldown.
    curIndex = 10;
    preloadIndices = [11];
    queue.refreshPriority();
    await flushMicrotasks();
    assert.equal(fakeImages.created[0].src, '');
    assert.equal(fakeImages.created.filter(i => i.src === 'https://img/11.webp').length, 0);

    // Once cooldown expires, background preload starts for page 11.
    await advanceBy(350);
    assert.equal(fakeImages.created.filter(i => i.src === 'https://img/11.webp').length, 1);
});

test('resolves inactive pending URL requests as undefined even while background preloads are paused', async () => {
    const { PageImageLoadQueue, flushMicrotasks } = createHarness({ readyState: 'complete' });
    const fakeImages = createFakeImages();
    let keepPage10Active = true;

    const queue = new PageImageLoadQueue({
        albumService: {
            getImgSrc: () => new Promise(() => {}),
        },
        getCurrentIndex: () => 0,
        getVisibleIndices: () => [0],
        getPreloadIndices: () => [1, 2],
        createPreloadImage: fakeImages.factory,
    });

    // Simulate page 0 still loading its visible image so allowBackground is false.
    queue.setVisibleImageLoading(0, true);
    const inactivePromise = queue.request(10, () => keepPage10Active);
    await flushMicrotasks();

    // Unmount / deactivate page 10 while background is still paused.
    keepPage10Active = false;
    queue.refreshPriority();
    await flushMicrotasks();

    const settled = await inactivePromise;
    assert.equal(settled, undefined);
});
