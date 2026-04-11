type Span = {
    traceId: string;
    spanId: string;
    parentSpanId?: string | undefined;
    name: string;
    startTimeNs: number;
    durationNs: number;
    attributes: Record<string, any>;
    events?: { name: string; timeNs: number }[];
};

type Trace = {
    traceId: string;
    spans: Span[];
};

type BatchPayload = {
    sessionId: string;
    traces: Trace[];
};

type Config = {
    target: string;
};

class RumTracer {
    private config!: Config;
    private sessionId: string;

    private traces: Map<string, Span[]> = new Map();

    // 🔥 Active context
    private currentTraceId: string | null = null;
    private currentParentSpanId: string | null | undefined = null;

    private isPageLoading = true;
    private flushInterval = 10000;
    private timer: any;

    constructor() {
        this.sessionId = this.getOrCreateSessionId();
    }

    init(config: Config) {
        this.config = config;

        this.initPageLoadTrace();
        this.trackPageLoad();
        this.trackClicks();
        this.patchFetch();
        this.startBatching();
    }

    // ------------------------
    // PAGE LOAD TRACE
    // ------------------------

    private initPageLoadTrace() {
        const traceId = this.generateId(32);
        const rootSpanId = this.generateId(16);

        this.currentTraceId = traceId;
        this.currentParentSpanId = rootSpanId;

        this.traces.set(traceId, []);

        // root span (page load starts)
        this.addSpan(traceId, {
            traceId,
            spanId: rootSpanId,
            parentSpanId: undefined,
            name: "page_load",
            startTimeNs: performance.timeOrigin * 1e6,
            durationNs: 0, // will update later
            attributes: {
                url: location.href,
                userAgent: navigator.userAgent,
            },
        });
    }

    private trackPageLoad() {
        window.addEventListener("load", () => {
            const nav = performance.getEntriesByType(
                "navigation"
            )[0] as PerformanceNavigationTiming;

            const traceSpans = this.traces.get(this.currentTraceId!);

            // update root span duration
            if (traceSpans && traceSpans.length > 0 && traceSpans[0]) {
                traceSpans[0].durationNs = Math.floor(nav.duration * 1e6)

                Object.assign(traceSpans[0].attributes, {
                    ttfb: nav.responseStart,
                    domContentLoaded: nav.domContentLoadedEventEnd,
                    loadEvent: nav.loadEventEnd,
                });
            }

            // 🔥 after page load → clear context
            this.isPageLoading = false;
            this.currentTraceId = null;
            this.currentParentSpanId = null;
        });
    }

    // ------------------------
    // CLICK TRACE
    // ------------------------

    private endClickSpan(span: Span, startTime: number) {
        setTimeout(() => {
            const end = performance.now();
            span.durationNs = Math.floor((end - startTime) * 1e6);

            // reset context
            this.currentTraceId = null;
            this.currentParentSpanId = null;
        }, 300); // tweak: 300–1000ms
    }

    private trackClicks() {

        document.addEventListener("click", (e) => {
            const traceId = this.generateId(32);
            const spanId = this.generateId(16);

            const startTime = performance.now();
            const startNs = performance.timeOrigin * 1e6 + startTime * 1e6;

            const target = e.target as HTMLElement;

            const span: Span = {
                traceId,
                spanId,
                name: `Click on ${target.innerText || target.tagName}`,
                startTimeNs: startNs,
                durationNs: 0, // will update later
                attributes: {
                    x: e.clientX,
                    y: e.clientY,
                    viewport_width: window.innerWidth,
                    viewport_height: window.innerHeight,
                },
            };

            this.traces.set(traceId, [span]);

            this.currentTraceId = traceId;
            this.currentParentSpanId = spanId;

            // 🔥 end later (see below)
            this.endClickSpan(span, startTime);
        });
    }

    // ------------------------
    // FETCH
    // ------------------------

    private patchFetch() {
        const originalFetch = window.fetch;

        window.fetch = async (...args: Parameters<typeof fetch>) => {
            const start = performance.now();
            const startNs =
                performance.timeOrigin * 1e6 + start * 1e6;

            const url =
                typeof args[0] === "string"
                    ? args[0]
                    : args[0] instanceof URL
                        ? args[0].href
                        : args[0].url;

            const method = args[1]?.method || "GET";

            if (url.startsWith(this.config.target)) {
                return originalFetch(...args);
            }

            // 🔥 Decide trace + parent
            let traceId = this.currentTraceId;
            let parentSpanId = this.currentParentSpanId;

            // ❗ No active context → standalone fetch trace
            if (!traceId) {
                traceId = this.generateId(32);
                this.traces.set(traceId, []);
                parentSpanId = undefined;
            }

            const spanId = this.generateId(16);

            try {
                const res = await originalFetch(...args);

                const duration = performance.now() - start;
                const endNs = startNs + duration * 1e6;

                const entry = performance
                    .getEntriesByName(url)
                    .pop() as PerformanceResourceTiming;

                this.addSpan(traceId, {
                    traceId,
                    spanId,
                    parentSpanId: parentSpanId || undefined,
                    name: `HTTP ${method}`,
                    startTimeNs: startNs,
                    durationNs: Math.floor(duration * 1e6),
                    attributes: {
                        "http.method": method,
                        "http.url": url,
                        "http.status_code": res.status,

                        dns:
                            entry?.domainLookupEnd -
                            entry?.domainLookupStart,
                        tcp:
                            entry?.connectEnd -
                            entry?.connectStart,
                        ssl:
                            entry?.secureConnectionStart > 0
                                ? entry.connectEnd -
                                entry.secureConnectionStart
                                : 0,
                        ttfb:
                            entry?.responseStart -
                            entry?.requestStart,
                        download:
                            entry?.responseEnd -
                            entry?.responseStart,
                    },
                    events: [
                        { name: "fetchStart", timeNs: startNs },
                        { name: "responseEnd", timeNs: endNs },
                    ],
                });

                return res;
            } catch (err: any) {
                const duration = performance.now() - start;

                this.addSpan(traceId, {
                    traceId,
                    spanId,
                    parentSpanId: parentSpanId || undefined,
                    name: `HTTP ${method}`,
                    startTimeNs: startNs,
                    durationNs: Math.floor(duration * 1e6),
                    attributes: {
                        "http.method": method,
                        "http.url": url,
                        error: err.message,
                    },
                });

                throw err;
            }
        };
    }

    // ------------------------
    // CORE
    // ------------------------

    private addSpan(traceId: string, span: Span) {
        if (!this.traces.has(traceId)) {
            this.traces.set(traceId, []);
        }
        this.traces.get(traceId)!.push(span);
    }

    // ------------------------
    // BATCHING
    // ------------------------

    private startBatching() {
        this.timer = setInterval(() => {
            this.flush();
        }, this.flushInterval);

        window.addEventListener("beforeunload", () => {
            this.flush();
        });
    }

    private flush() {
        if (this.traces.size === 0) return;

        const traces: Trace[] = [];

        for (const [traceId, spans] of this.traces.entries()) {
            if (spans.length > 0) {
                traces.push({ traceId, spans });
            }
        }

        this.traces.clear();

        const payload: BatchPayload = {
            sessionId: this.sessionId,
            traces,
        };

        fetch(this.config.target, {
            method: "POST",
            body: JSON.stringify(payload),
            keepalive: true,
            headers: {
                "Content-Type": "application/json",
            },
        }).catch(() => { });
    }

    // ------------------------
    // UTILS
    // ------------------------

    private generateId(length: number) {
        return Array.from(crypto.getRandomValues(new Uint8Array(length)))
            .map((b) => {
                const hex = b.toString(16);
                return hex.length === 1 ? "0" + hex : hex;
            })
            .join("")
            .slice(0, length);
    }

    private getOrCreateSessionId() {
        const key = "rum_session_id";
        let id = localStorage.getItem(key);

        if (!id) {
            id = this.generateId(32);
            localStorage.setItem(key, id);
        }

        return id;
    }
}

const sdk = new RumTracer();

// (window as any).rumSdk = {
//   init: (config: Config) => sdk.init(config),
//   log: (msg: string, level?: LogLevel) => sdk.log(msg, level),
//   error: (err: any) => sdk.error(err),
// };

export const init = (config: Config) => sdk.init(config);
// export const log = (msg: string, level?: LogLevel) => sdk.log(msg, level);
// export const error = (err: any) => sdk.error(err);