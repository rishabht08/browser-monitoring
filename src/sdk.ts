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
      } catch {}

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