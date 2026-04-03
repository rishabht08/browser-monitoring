type Config = {
    serviceName: string;
    projectName: string;
    target: string;
    defaultAttributes?: Record<string, any>;
};

type LogLevel = "info" | "warn" | "error";

type Event = {
    timestamp: number;
    level: LogLevel;
    message: string;
    attributes?: Record<string, any>;
};

class RumSdk {
    private config!: Config;
    private queue: Event[] = [];
    private flushInterval: number = 10000; // 10 sec
    private timer: any = null;
    private sessionId: string;

    constructor() {
        this.sessionId = this.generateSessionId();
    }

    init(config: Config) {
        this.config = config;

        this.patchConsole();
        this.setupGlobalErrorHandler();
        this.startBatching();
        this.patchFetch()
        this.trackLCP();          
        this.trackCLS();
    }

    // ---------------------------
    // Public APIs
    // ---------------------------

    log(message: string, level: LogLevel = "info") {
        const event = this.createEvent(message, level);
        this.enqueue(event);
    }

    error(err: any) {
        const event = this.createEvent(err?.message || String(err), "error", {
            stack: err?.stack,
        });
        this.enqueue(event);
    }

    // ---------------------------
    // Core Logic
    // ---------------------------

    private enqueue(event: Event) {
        this.queue.push(event);
    }

    private flush() {
        if (this.queue.length === 0) return;

        const batch = [...this.queue];
        this.queue = [];

        const payload = {
            serviceName: this.config.serviceName,
            projectName: this.config.projectName,
            sessionId: this.sessionId,
            events: batch,
        };

        // send using sendBeacon (best effort)
        const blob = new Blob([JSON.stringify(payload)], {
            type: "application/json",
        });

        fetch(this.config.target, {
            method: "POST",
            body: JSON.stringify(payload),
            keepalive: true,
            headers: {
                "Content-Type": "application/json",
            },
        }).catch(() => {
            // silently fail (for now)
        });
        // if (!navigator.sendBeacon(this.config.target, blob)) {
        //   }
        // fallback
    }

    private startBatching() {
        this.timer = setInterval(() => {
            this.flush();
        }, this.flushInterval);

        // flush on page unload
        window.addEventListener("beforeunload", () => {
            this.flush();
        });
    }

    private createEvent(
        message: string,
        level: LogLevel,
        extra: Record<string, any> = {}
    ): Event {
        return {
            timestamp: Date.now(),
            level,
            message,
            attributes: {
                url: window.location.href,
                userAgent: navigator.userAgent,
                ...this.config.defaultAttributes,
                ...extra,
            },
        };
    }

    // ---------------------------
    // Instrumentation
    // ---------------------------

    private patchConsole() {
        ["log", "warn", "error"].forEach((level) => {
            const original = console[level as keyof Console];

            console[level as keyof Console] = (...args: any[]) => {
                try {
                    this.enqueue(
                        this.createEvent(args.join(" "), level as LogLevel)
                    );
                } catch { }

                original.apply(console, args);
            };
        });
    }

    private setupGlobalErrorHandler() {
        window.onerror = (msg, url, line, col, error) => {
            this.error(error || new Error(String(msg)));
        };

        window.onunhandledrejection = (event: PromiseRejectionEvent) => {
            this.error(event.reason);
        };
    }

    // ---------------------------
    // Utils
    // ---------------------------

    private generateSessionId() {
        return Math.random().toString(36).substring(2) + Date.now();
    }


    //Network


    private patchFetch() {
        const originalFetch = window.fetch;

        window.fetch = async (...args: Parameters<typeof fetch>) => {
            const start = performance.now();
            const url : string = args[0] as string;
            if(url.startsWith(this.config.target)) {
                return originalFetch(...args);
            }
            try {
                const response = await originalFetch(...args);

                const duration = performance.now() - start;

                this.enqueue(
                    this.createEvent("network request", "info", {
                        type: "network",
                        url: args[0],
                        method: args[1]?.method || "GET",
                        status: response.status,
                        duration,
                        success: true,
                    })
                );

                return response;
            } catch (err: any) {
                const duration = performance.now() - start;

                this.enqueue(
                    this.createEvent("network error", "error", {
                        type: "network",
                        url: args[0],
                        method: args[1]?.method || "GET",
                        duration,
                        success: false,
                        error: err.message,
                    })
                );

                throw err;
            }
        };
    }


    // Web Vitals

    private trackLCP() {
        const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const lastEntry = entries[entries.length - 1];

            this.enqueue(
                this.createEvent("LCP", "info", {
                    type: "web_vital",
                    name: "LCP",
                    value: lastEntry?.startTime,
                })
            );
        });

        observer.observe({ type: "largest-contentful-paint", buffered: true });
    }

    private trackCLS() {
        let cls = 0;

        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as any) {
                if (!entry.hadRecentInput) {
                    cls += entry.value;
                }
            }
        });

        observer.observe({ type: "layout-shift", buffered: true });

        window.addEventListener("beforeunload", () => {
            this.enqueue(
                this.createEvent("CLS", "info", {
                    type: "web_vital",
                    name: "CLS",
                    value: cls,
                })
            );
        });
    }
}


const sdk = new RumSdk();

// (window as any).rumSdk = {
//   init: (config: Config) => sdk.init(config),
//   log: (msg: string, level?: LogLevel) => sdk.log(msg, level),
//   error: (err: any) => sdk.error(err),
// };

export const init = (config: Config) => sdk.init(config);
export const log = (msg: string, level?: LogLevel) => sdk.log(msg, level);
export const error = (err: any) => sdk.error(err);