// a good resolution for poor network
import PlatformService from '../service/PlatformService'
import { imageLoadDiagnostics, diagnosticError, type DiagnosticOperation } from '../../../../core/service/ImageLoadDiagnostics'

export class TextReq {
    private url: string;
    private method = 'GET';
    private credentials = 'include';
    private retryTimes = 3;
    private timeoutTime = 15; // secs
    private curRetryTimes = 0;
    private retryInterval = 3; // secs
    private enabledLog = true;
    private fetchSetting = null;
    private noCache = false;
    private rejectError = true;
    private diagnosticEnabled = true;

    constructor(url: string, noCache = false, rejectError = true) {
        this.url = url;
        this.noCache = noCache;
        this.rejectError = rejectError;
    }

    setDiagnosticEnabled(enabled: boolean) {
        this.diagnosticEnabled = enabled;
        return this;
    }

    setMethod(method) {
        this.method = method;
        return this;
    }

    setCredentials(credential: string) {
        this.credentials = credential;
        return this;
    }

    setFetchSetting(setting: any) {
        this.fetchSetting = setting;
        return this;
    }

    setRetryTimes(times: number) {
        this.retryTimes = times;
    }

    setRetryInterval(secs: number) {
        this.retryInterval = secs;
    }

    setTimeOutTime(secs: number) {
        this.timeoutTime = secs;
    }

    request(): Promise<string> {
        const operation = this.diagnosticEnabled
            ? imageLoadDiagnostics.start('request', { url: this.url })
            : undefined
        return new Promise((resolve, reject) => {
            this._request(res => {
                if (operation) {
                    imageLoadDiagnostics.stage(operation, 'request.body-start', { url: this.url, status: res.status })
                }
                const body = res.text()
                body.then(text => {
                    if (operation) {
                        imageLoadDiagnostics.finish(operation, 'request.complete', { url: this.url, bodyLength: text.length })
                    }
                    resolve(text)
                })
                // Observe a rejected body read without changing the existing promise/retry behavior.
                body.catch(error => {
                    if (operation) {
                        imageLoadDiagnostics.stage(operation, 'request.body-error', {
                            url: this.url, error: diagnosticError(error),
                        }, 'error')
                    }
                })
            }, (err, isSynchronous = false) => {
                if (this.rejectError || isSynchronous) {
                    if (operation) {
                        imageLoadDiagnostics.finish(operation, 'request.failed', { url: this.url, error: diagnosticError(err) }, 'error')
                    }
                    reject(err);
                } else {
                    if (operation) {
                        imageLoadDiagnostics.stage(operation, 'request.failure-suppressed', { url: this.url, error: diagnosticError(err) }, 'error')
                    }
                    console.error(err);
                }
            }, operation);
        });
    }

    private printErrorLog(err) {
        console.error(`TextReq: request error in ${this.url}, retry:(${this.curRetryTimes}/${this.retryTimes}), error: ${err}`);
    }

    _request(successCallback, failureCallback, operation?: DiagnosticOperation) {
        this.curRetryTimes++;
        const attempt = this.curRetryTimes
        const attemptStartedAt = Date.now()
        const timeoutMs = this.timeoutTime * 1000 * attempt
        let attemptSettled = false
        let timeoutId: ReturnType<typeof setTimeout>
        let url = this.url.includes('http') ? this.url : `${window.location.protocol}//${window.location.host}${this.url}`;
        if (this.noCache) {
            url = `${url}?_t=${new Date().getTime()}`;
        }
        if (operation) {
            imageLoadDiagnostics.stage(operation, 'request.attempt-start', { url, attempt, timeoutMs })
        }
        let timeout = new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => {
                if (!attemptSettled && operation) {
                    imageLoadDiagnostics.stage(operation, 'request.timeout', {
                        url, attempt, timeoutMs, attemptElapsedMs: Date.now() - attemptStartedAt,
                    }, 'warn')
                }
                reject('request timed out')
            }, timeoutMs);
        });
        let req;
        try {
            req = PlatformService.fetch(url, this.fetchSetting ? this.fetchSetting : {
                method: this.method,
                credentials: this.credentials
            }, this.diagnosticEnabled ? { requestId: operation?.id, attempt } : { diagnosticEnabled: false });
        } catch (error) {
            attemptSettled = true
            clearTimeout(timeoutId)
            if (operation) {
                imageLoadDiagnostics.stage(operation, 'request.attempt-error', {
                    url, attempt, error: diagnosticError(error), synchronous: true,
                    attemptElapsedMs: Date.now() - attemptStartedAt,
                }, 'error')
            }
            failureCallback(error, true)
            return
        }
        Promise
            .race([timeout, req])
            .then(res => {
                attemptSettled = true
                clearTimeout(timeoutId)
                if (operation) {
                    imageLoadDiagnostics.stage(operation, 'request.attempt-response', {
                        url, attempt, status: res.status, attemptElapsedMs: Date.now() - attemptStartedAt,
                    })
                }
                if (res.status === 200) {
                    successCallback(res);
                } else {
                    throw new Error(`${url}: ${res.status}`);
                }
            })
            .catch(err => {
                attemptSettled = true
                clearTimeout(timeoutId)
                if (operation) {
                    imageLoadDiagnostics.stage(operation, 'request.attempt-error', {
                        url, attempt, error: diagnosticError(err), attemptElapsedMs: Date.now() - attemptStartedAt,
                    }, 'error')
                }
                this.printErrorLog(err);
                if (this.curRetryTimes < this.retryTimes) {
                    if (operation) {
                        imageLoadDiagnostics.stage(operation, 'request.retry-scheduled', { url, attempt, delayMs: this.retryInterval * 1000 })
                    }
                    setTimeout(() => {
                        this._request(successCallback, failureCallback, operation);
                    }, this.retryInterval * 1000);
                } else {
                    failureCallback(err);
                }
            });
    }
}
