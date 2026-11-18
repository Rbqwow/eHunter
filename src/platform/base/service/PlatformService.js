// a service for crossing platform
/* eslint-disable no-undef */
import { imageLoadDiagnostics, diagnosticError } from '../../../../core/service/ImageLoadDiagnostics'

// hack for test
if (typeof chrome === 'undefined') {
    var chrome = { extension: null };
}

export default {
    storage: {
        get sync() {
            if (chrome && chrome.storage) {
                return chrome.storage.sync.QUOTA_BYTES ? chrome.storage.sync : chrome.storage.local;
            } else {
                return window.localStorage;
            }
        },
        local: window.localStorage
    },
    storageGet(key, defaultValue = null) {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(key, defaultValue);
            }
        } catch (e) {
        }
        try {
            let val = window.localStorage.getItem(key);
            return val === null ? defaultValue : val;
        } catch (e) {
            return defaultValue;
        }
    },
    storageSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
                return true;
            }
        } catch (e) {
        }
        try {
            let val = value;
            if (typeof value !== 'string') {
                val = JSON.stringify(value);
            }
            window.localStorage.setItem(key, val);
            return true;
        } catch (e) {
            return false;
        }
    },
    storageRemove(key) {
        try {
            if (typeof GM_deleteValue === 'function') {
                GM_deleteValue(key);
                return true;
            }
        } catch (e) {
        }
        try {
            window.localStorage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    },
    storageClear() {
        try {
            if (typeof GM_listValues === 'function' && typeof GM_deleteValue === 'function') {
                const keys = GM_listValues();
                if (Array.isArray(keys)) {
                    keys.forEach(key => {
                        try {
                            GM_deleteValue(key);
                        } catch (e) {
                        }
                    });
                }
            }
        } catch (e) {
        }
        try {
            window.localStorage.clear();
            return true;
        } catch (e) {
            return false;
        }
    },
    getExtension() {
        return chrome.extension;
    },
    fetch(url, option, diagnosticContext = {}) {
        /* eslint-disable camelcase */
        const isUserscript = typeof GM_info !== 'undefined' && GM_info.version
        const diagnosticEnabled = diagnosticContext?.diagnosticEnabled !== false
        const operation = diagnosticEnabled
            ? imageLoadDiagnostics.start('transport', {
                url, ...diagnosticContext, adapter: isUserscript ? 'GM_xmlhttpRequest' : 'fetch',
            })
            : undefined
        if (isUserscript) { // the ENV is Tampermonkey
            return new Promise((resolve, reject) => {
                try {
                    GM_xmlhttpRequest({
                        method: option.method,
                        url,
                        onload: x => {
                            if (operation) {
                                imageLoadDiagnostics.finish(operation, 'transport.response', {
                                    url, ...diagnosticContext, status: x.status,
                                    bodyLength: typeof x.responseText === 'string' ? x.responseText.length : 0,
                                    finalUrl: x.finalUrl,
                                })
                            }
                            let responseText = x.responseText;
                            x.text = async function() {
                                return responseText;
                            }
                            resolve(x);
                        },
                        onerror: e => {
                            if (operation) {
                                imageLoadDiagnostics.finish(operation, 'transport.error', {
                                    url, ...diagnosticContext, status: e.status,
                                }, 'error')
                            }
                            reject(`GM_xhr error, ${e.status}`);
                        },
                        onabort: () => operation && imageLoadDiagnostics.finish(operation, 'transport.abort', { url, ...diagnosticContext }, 'warn'),
                        ontimeout: () => operation && imageLoadDiagnostics.finish(operation, 'transport.timeout', { url, ...diagnosticContext }, 'warn'),
                    });
                } catch (error) {
                    if (operation) {
                        imageLoadDiagnostics.finish(operation, 'transport.error', {
                            url, ...diagnosticContext, error: diagnosticError(error),
                        }, 'error')
                    }
                    throw error
                }
            });
        } else { // the ENV is Chrome or Firefox
            try {
                return window.fetch(url, option).then(response => {
                    if (operation) {
                        imageLoadDiagnostics.finish(operation, 'transport.response', {
                            url, ...diagnosticContext, status: response.status, completion: 'headers',
                        })
                    }
                    return response
                }, error => {
                    if (operation) {
                        imageLoadDiagnostics.finish(operation, 'transport.error', {
                            url, ...diagnosticContext, error: diagnosticError(error),
                        }, 'error')
                    }
                    throw error
                })
            } catch (error) {
                if (operation) {
                    imageLoadDiagnostics.finish(operation, 'transport.error', {
                        url, ...diagnosticContext, error: diagnosticError(error),
                    }, 'error')
                }
                throw error
            }
        }
    }
};
