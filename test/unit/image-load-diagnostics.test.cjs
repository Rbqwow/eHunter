const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const idle = { page: 0, image: 0, request: 0, transport: 0 };

function harness({ storage = new Map(), denyStorage = false, firefox = false } = {}) {
    let time = 100000;
    let timerId = 0;
    const timers = new Map();
    const callbacks = [];
    const listeners = new Map();
    const modules = new Map();
    const cloneCalls = [];
    let storageWrites = 0;
    const schedule = (fn, delay, repeat = false, args = []) => {
        const id = ++timerId;
        timers.set(id, { fn, at: time + Number(delay), delay: Number(delay), repeat, args });
        return id;
    };
    const listen = (target, event, handler) => {
        const key = target + ':' + event;
        listeners.set(key, [...(listeners.get(key) || []), handler]);
    };
    const sandbox = {
        Promise,
        Date: class extends Date { static now() { return time; } },
        performance: { now: () => time },
        console: Object.fromEntries(['info', 'warn', 'error', 'log'].map(level => [level, () => {}])),
        document: { visibilityState: 'visible', querySelectorAll: () => [], addEventListener: (event, fn) => listen('document', event, fn) },
        location: { origin: 'https://e-hentai.org', pathname: '/s/token/1-32', protocol: 'https:', host: 'e-hentai.org' },
        setTimeout: (fn, delay, ...args) => schedule(fn, delay, false, args),
        clearTimeout: id => timers.delete(id),
        setInterval: (fn, delay) => schedule(fn, delay, true),
        clearInterval: id => timers.delete(id),
        GM_info: { version: 'test' },
        GM_xmlhttpRequest: details => callbacks.push(details),
        unsafeWindow: {},
    };
    sandbox.window = {
        innerHeight: 900,
        location: sandbox.location,
        addEventListener: (event, fn) => listen('window', event, fn),
        localStorage: {
            getItem: key => { if (denyStorage) throw new Error('storage denied'); return storage.get(key) || null; },
            setItem: (key, value) => { if (denyStorage) throw new Error('quota exceeded'); storageWrites++; storage.set(key, value); },
        },
        fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve('native body') }),
    };
    if (firefox) {
        sandbox.cloneInto = (value, scope, options) => {
            cloneCalls.push({ value, scope, options });
            return options?.cloneFunctions ? { ...value } : JSON.parse(JSON.stringify(value));
        };
    }
    const context = vm.createContext(sandbox);
    function load(filename) {
        const absolute = path.resolve(root, filename);
        const file = fs.existsSync(absolute) ? absolute : ['.ts', '.js'].map(ext => absolute + ext).find(candidate => fs.existsSync(candidate));
        if (!file) throw new Error('Module not found: ' + filename);
        if (modules.has(file)) return modules.get(file).exports;
        const module = { exports: {} };
        modules.set(file, module);
        const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
            fileName: file,
        }).outputText;
        const fn = vm.runInContext('(function(require,module,exports){' + code + '\n})', context, { filename: file });
        fn(specifier => load(path.resolve(path.dirname(file), specifier)), module, module.exports);
        return module.exports;
    }
    const diagnostics = load('core/service/ImageLoadDiagnostics.ts').imageLoadDiagnostics;
    const TextReq = load('src/platform/base/request/TextReq.ts').TextReq;
    const api = sandbox.unsafeWindow.__EHUNTER_DIAGNOSTICS__;
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    async function tick(ms) {
        const end = time + ms;
        await flush();
        for (;;) {
            const next = [...timers.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, task] = next;
            time = task.at;
            if (task.repeat) task.at += task.delay;
            else timers.delete(id);
            task.fn(...task.args);
            await flush();
        }
        time = end;
        await flush();
    }
    const snapshot = () => JSON.parse(JSON.stringify(api.snapshot()));
    const saved = () => JSON.parse(JSON.stringify(api.getLastFailure()));
    const fire = (target, event) => { for (const handler of listeners.get(target + ':' + event) || []) handler(); };
    return { diagnostics, TextReq, api, sandbox, callbacks, storage, cloneCalls, tick, flush, snapshot, saved, fire, writes: () => storageWrites };
}

test('GM success links the transport and completes without a later timeout', async () => {
    const h = harness();
    const pending = new h.TextReq('/s/token/1-32').request();
    h.callbacks[0].onload({ status: 200, responseText: 'GM body' });
    assert.equal(await pending, 'GM body');
    const request = h.snapshot().events.find(event => event.event === 'request.start');
    const response = h.snapshot().events.find(event => event.event === 'transport.response');
    assert.equal(response.data.requestId, request.operationId);
    await h.tick(60000);
    assert.deepEqual(h.snapshot().activeCounts, idle);
    assert.equal(h.snapshot().events.some(event => event.event === 'request.timeout'), false);
    assert.equal(h.saved(), null);
});

test('saved reports include late callbacks and retry completion after reload', async () => {
    const h = harness();
    const req = new h.TextReq('/s/token/1-89');
    req.setTimeOutTime(0.02); req.setRetryInterval(0.003);
    const pending = req.request();
    await h.tick(23);
    h.callbacks[0].onload({ status: 200, responseText: 'old body' });
    h.callbacks[1].onload({ status: 200, responseText: 'new body' });
    assert.equal(await pending, 'new body');
    await h.tick(2000);
    const restored = harness({ storage: h.storage }).saved();
    assert.equal(restored.events.filter(event => event.event === 'transport.response').length, 2);
    assert.ok(restored.events.some(event => event.event === 'request.complete'));
    assert.deepEqual(restored.activeCounts, idle);
    assert.equal(h.snapshot().events.filter(event => event.event === 'request.timeout').length, 1);
});

test('throttled writes retain the final failure without more incoming events', async () => {
    const h = harness();
    h.diagnostics.record('request.timeout', { page: 89 }, 'warn');
    await h.tick(1000);
    h.diagnostics.record('page.source-error', { page: 32 }, 'error');
    assert.equal(h.writes(), 1);
    await h.tick(1000);
    assert.equal(h.writes(), 2);
    assert.equal(h.saved().failure.event, 'page.source-error');
    assert.equal(h.saved().failure.data.page, 32);
    assert.equal(h.saved().events.length, 2);
});

test('pagehide and visibility changes flush the pending report before leaving', async () => {
    for (const event of ['pagehide', 'visibilitychange']) {
        const h = harness();
        h.diagnostics.record('request.timeout', {}, 'warn');
        await h.tick(1);
        h.diagnostics.record('transport.response', { attempt: 1 });
        if (event === 'visibilitychange') h.sandbox.document.visibilityState = 'hidden';
        h.fire(event === 'pagehide' ? 'window' : 'document', event);
        assert.ok(h.saved().events.some(entry => entry.event === 'transport.response'));
    }
});

test('healthy activity in a new session does not overwrite the old anomaly', async () => {
    const h = harness();
    h.diagnostics.record('image.error', { page: 32 }, 'error');
    const old = h.saved();
    const next = harness({ storage: h.storage });
    const operation = next.diagnostics.start('image', { page: 33 });
    next.diagnostics.finish(operation, 'image.loaded');
    await next.tick(10000);
    assert.deepEqual(next.saved(), old);
});

test('pending images produce a long-wait snapshot even after the source is ready', async () => {
    const h = harness();
    const page = h.diagnostics.start('page', { page: 32 });
    h.diagnostics.finish(page, 'page.source-ready', { hasSrc: true });
    const image = h.diagnostics.start('image', { page: 32, src: '/pending.png' });
    await h.tick(30000);
    assert.equal(h.saved().failure.event, 'pending.long-wait');
    assert.equal(h.saved().activeCounts.image, 1);
    h.diagnostics.finish(image, 'image.loaded');
    await h.tick(2000);
    assert.deepEqual(h.saved().activeCounts, idle);
    assert.ok(h.saved().events.some(event => event.event === 'image.loaded'));
});

test('cancelled images stop monitoring and do not create long-wait alerts', async () => {
    const h = harness();
    const image = h.diagnostics.start('image', { page: 32 });
    h.diagnostics.finish(image, 'image.cancelled');
    h.diagnostics.finish(image, 'image.cancelled');
    await h.tick(60000);
    assert.deepEqual(h.snapshot().activeCounts, idle);
    assert.equal(h.saved(), null);
});

test('native transport success and asynchronous failure retain their results', async () => {
    const h = harness();
    delete h.sandbox.GM_info;
    assert.equal(await new h.TextReq('/s/token/1-32').request(), 'native body');
    h.sandbox.window.fetch = () => Promise.reject(new Error('native failure'));
    const req = new h.TextReq('/s/token/1-33'); req.setRetryTimes(1);
    await assert.rejects(req.request(), /native failure/);
    assert.deepEqual(h.snapshot().activeCounts, idle);
});

test('synchronous transport errors close the request and cancel its deadline', async () => {
    const h = harness();
    delete h.sandbox.GM_info;
    h.sandbox.window.fetch = () => { throw new Error('synchronous failure'); };
    await assert.rejects(new h.TextReq('/s/token/1-32').request(), /synchronous failure/);
    await h.tick(40000);
    assert.deepEqual(h.snapshot().activeCounts, idle);
    assert.equal(h.snapshot().events.some(event => ['request.timeout', 'pending.long-wait'].includes(event.event)), false);
    assert.ok(h.snapshot().events.some(event => event.data.synchronous === true));
});

test('synchronous failures during a retry also settle the original request', async () => {
    const h = harness();
    delete h.sandbox.GM_info;
    let calls = 0;
    h.sandbox.window.fetch = () => {
        if (++calls === 1) return Promise.reject(new Error('first failure'));
        throw new Error('retry synchronous failure');
    };
    const req = new h.TextReq('/s/token/1-32'); req.setRetryInterval(0.001);
    const pending = assert.rejects(req.request(), /retry synchronous failure/);
    await h.tick(1); await pending; await h.tick(40000);
    assert.deepEqual(h.snapshot().activeCounts, idle);
    assert.equal(h.snapshot().events.some(event => event.event === 'request.timeout'), false);
});

test('synchronous rejection remains visible when asynchronous failures are suppressed', async () => {
    const h = harness();
    delete h.sandbox.GM_info;
    h.sandbox.window.fetch = () => { throw new Error('synchronous failure'); };
    await assert.rejects(new h.TextReq('/s/token/1-32', false, false).request(), /synchronous failure/);
    await h.tick(40000);
    assert.deepEqual(h.snapshot().activeCounts, idle);
    assert.equal(h.snapshot().events.some(event => event.event === 'pending.long-wait'), false);
});

test('terminal timeout keeps a late transport visible until its real callback', async () => {
    const h = harness();
    const req = new h.TextReq('/s/token/1-32'); req.setRetryTimes(1); req.setTimeOutTime(0.02);
    const rejected = req.request().then(() => null, error => error);
    await h.tick(20);
    assert.equal(await rejected, 'request timed out');
    assert.equal(h.snapshot().activeCounts.transport, 1);
    h.callbacks[0].onerror({ status: 0 }); await h.flush();
    assert.deepEqual(h.snapshot().activeCounts, idle);
});

test('GM abort events close only the actual transport before the logical deadline', async () => {
    const h = harness();
    const req = new h.TextReq('/s/token/1-32'); req.setRetryTimes(1); req.setTimeOutTime(0.02);
    const rejected = req.request().then(() => null, error => error);
    h.callbacks[0].onabort();
    assert.equal(h.snapshot().activeCounts.request, 1);
    assert.equal(h.snapshot().activeCounts.transport, 0);
    await h.tick(20);
    assert.equal(await rejected, 'request timed out');
});

test('storage denial preserves request results and in-memory export', async () => {
    const h = harness({ denyStorage: true });
    const req = new h.TextReq('/s/token/1-32'); req.setRetryTimes(1);
    const rejected = req.request().then(() => null, error => error);
    h.callbacks[0].onerror({ status: 403 });
    assert.equal(await rejected, 'GM_xhr error, 403');
    await h.tick(5000);
    assert.equal(h.saved(), null);
    assert.ok(JSON.parse(h.api.export()).current.events.some(event => event.event === 'request.failed'));
});

test('bounded records and detached API results include image operations', () => {
    const h = harness();
    const operations = Array.from({ length: 1200 }, (_, page) => h.diagnostics.start('image', { page, src: 'x'.repeat(3000) }));
    assert.equal(h.snapshot().events.length, 800);
    assert.equal(h.snapshot().active.length, 200);
    assert.equal(h.snapshot().activeCounts.image, 1200);
    const exposed = h.api.getLogs(); exposed[0].data.src = 'changed';
    assert.equal(h.snapshot().events[0].data.src.length, 1200);
    for (const op of operations) h.diagnostics.finish(op, 'image.cancelled');
    assert.deepEqual(h.snapshot().activeCounts, idle);
});

test('Firefox API and object return values are cloned into the page scope', () => {
    const h = harness({ firefox: true });
    assert.equal(h.cloneCalls[0].scope, h.sandbox.unsafeWindow);
    assert.equal(h.cloneCalls[0].options.cloneFunctions, true);
    const snapshot = h.api.snapshot();
    const logs = h.api.getLogs();
    h.diagnostics.record('image.error', { page: 32 }, 'error');
    const saved = h.api.getLastFailure();
    assert.ok(h.cloneCalls.length >= 4);
    assert.ok(h.cloneCalls.slice(1).every(call => call.scope === h.sandbox.unsafeWindow && call.options === undefined));
    assert.equal(snapshot.schemaVersion, 1); assert.ok(Array.isArray(logs)); assert.equal(saved.failure.event, 'image.error');
    assert.equal(typeof h.api.export(), 'string');
});
