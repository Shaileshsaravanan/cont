(function contBootstrap() {
  "use strict";

  const GEMINI_API_KEY = "";

  if (window.__cont?.active) {
    console.log('%ccont is already running. Type: you = "/exit" to quit.', "color:#1a73ff;font-weight:bold");
    return window.__cont;
  }

  const STYLES = {
    brand: "color:#1a73ff;font-weight:bold",
    bot: "color:#a8e6cf",
    user: "color:#88c0d0",
    system: "color:#ebcb8b",
    error: "color:#bf616a;font-weight:bold",
    dim: "color:#6b7280",
    trace: "color:#7dd3fc",
  };

  const STATE = {
    active: false,
    apiKey: null,
    awaitingApiKey: false,
    history: [],
    streaming: false,
    originalConsoleLog: console.log.bind(console),
    abortController: null,
    geminiProxy: null,
  };
  const INITIAL_CONT_PROXY =
    typeof window.CONT_PROXY === "string" && window.CONT_PROXY.trim()
      ? window.CONT_PROXY.trim().replace(/\/$/, "")
      : null;

  const DEFAULT_PROXIES = ["http://localhost:8080", "http://localhost:8000"];

  function getGeminiProxies() {
    const custom = (STATE.geminiProxy || window.__CONT_PROXY || "")
      .trim()
      .replace(/\/$/, "");
    if (custom) return [custom];
    return DEFAULT_PROXIES;
  }

  function trace(event, details) {
    const suffix = details ? " " + details : "";
    STATE.originalConsoleLog(`%c↺ api%c ${event}${suffix}`, STYLES.brand, STYLES.trace);
  }

  function isCspFetchError(err) {
    const msg = String(err?.message || err || "");
    return /content security policy|csp|refused to connect/i.test(msg);
  }

  function isRetryableFetchError(err) {
    const msg = String(err?.message || err || "");
    return /failed to fetch|load failed|networkerror|network error|refused to connect|content security policy|csp/i.test(msg);
  }

  function geminiStreamUrls() {
    const path =
      `/v1beta/models/gemini-2.5-flash:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(STATE.apiKey)}`;
    return getGeminiProxies().map((base) => `${base}${path}`);
  }

  async function fetchGeminiStream(contents, signal) {
    const body = JSON.stringify({ contents });
    const urls = geminiStreamUrls();
    let lastErr;

    trace("request.prepare", `messages=${contents.length} bytes=${body.length} proxyOnly=true`);

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      trace("request.start", `attempt=${i + 1}/${urls.length} viaProxy=true url=${url}`);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body,
        });
        trace("request.response", `attempt=${i + 1} status=${res.status} ok=${res.ok}`);
        if (res.ok) return res;
        if (res.status >= 500 && i < urls.length - 1) {
          trace("request.retry", `attempt=${i + 1} reason=http_${res.status}`);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        const canRetry = i < urls.length - 1 && isRetryableFetchError(err);
        trace("request.error", `attempt=${i + 1} retry=${canRetry} message=${err.message || String(err)}`);
        if (!canRetry) break;
        if (isCspFetchError(err)) {
          log(
            "system",
            "This proxy endpoint is blocked here — retrying via " + urls[i + 1].split("/v1beta")[0] + "…"
          );
          trace("request.fallback", `to=${urls[i + 1].split("/v1beta")[0]}`);
        } else {
          log("system", "Proxy request failed — retrying via " + urls[i + 1].split("/v1beta")[0] + "…");
          trace("request.fallback", `to=${urls[i + 1].split("/v1beta")[0]}`);
        }
      }
    }

    if (isCspFetchError(lastErr)) {
      trace("request.fail", "blocked_by_csp");
      throw new Error(
        "All configured proxy endpoints are blocked by this page CSP. Set CONT_PROXY to an allowed relay or use one of the allowed localhost ports."
      );
    }
    trace("request.fail", lastErr?.message || "Gemini request failed");
    throw lastErr || new Error("Gemini request failed");
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    return String(value).replace(/([^\w-])/g, "\\$1");
  }

  function getSelector(el) {
    if (!el || el === document.body) return "body";
    if (el.id) return `#${cssEscape(el.id)}`;
    if (el.dataset?.contId) return `[data-cont-id="${el.dataset.contId}"]`;

    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute("name");
    if (name) return `${tag}[name="${cssEscape(name)}"]`;

    const aria = el.getAttribute("aria-label");
    if (aria) return `${tag}[aria-label="${cssEscape(aria)}"]`;

    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${cssEscape(testId)}"]`;

    const parent = el.parentElement;
    if (!parent) return tag;
    const siblings = [...parent.children].filter((c) => c.tagName === el.tagName);
    const idx = siblings.indexOf(el);
    const nth = siblings.length > 1 ? `:nth-of-type(${idx + 1})` : "";
    return `${getSelector(parent)} > ${tag}${nth}`;
  }

  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "link", "meta", "head"]);
  const MAX_ELEMENTS = 500;

  function isContUI(el) {
    return el?.closest?.("#cont-root");
  }

  function shouldTagElement(el) {
    if (!el || el.nodeType !== 1 || isContUI(el)) return false;
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return false;
    return isVisible(el);
  }

  function tagPageElements() {
    let n = 0;
    document.querySelectorAll("body *").forEach((el) => {
      if (!el.dataset.contId && shouldTagElement(el)) {
        el.dataset.contId = `c-${++n}`;
      }
    });
    return n;
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const text =
      visibleText(el, 80) ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      "";

    const entry = {
      id: el.dataset.contId,
      tag,
      selector: `[data-cont-id="${el.dataset.contId}"]`,
    };

    if (text) entry.text = text;
    const role = el.getAttribute("role");
    if (role) entry.role = role;
    const type = el.getAttribute("type");
    if (type) entry.type = type;
    if (el.href) entry.href = el.href;
    if (el.name) entry.name = el.name;
    if (el.id) entry.domId = el.id;

    return entry;
  }

  function isVisible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function visibleText(el, max = 120) {
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  function capturePageContext() {
    const totalTagged = tagPageElements();
    const allTagged = [...document.querySelectorAll("[data-cont-id]")].filter((el) => !isContUI(el));
    const truncated = allTagged.length > MAX_ELEMENTS;
    const elements = allTagged.slice(0, MAX_ELEMENTS).map(describeElement);

    const active = document.activeElement;
    const selection = window.getSelection?.()?.toString?.()?.trim?.() || "";

    return {
      url: location.href,
      title: document.title,
      hostname: location.hostname,
      pathname: location.pathname,
      viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY) },
      metaDescription: document.querySelector("meta[name='description']")?.content || "",
      elementCount: totalTagged,
      elementsTruncated: truncated,
      elements,
      activeElement: active && active !== document.body && !isContUI(active) ? {
        id: active.dataset.contId || undefined,
        tag: active.tagName?.toLowerCase(),
        text: visibleText(active, 80),
        selector: active.dataset.contId
          ? `[data-cont-id="${active.dataset.contId}"]`
          : getSelector(active),
      } : null,
      selectedText: selection || null,
      bodyPreview: visibleText(document.body, 2000),
    };
  }

  const UI = {
    root: null,
    panel: null,
    statusEl: null,
    cursor: null,
    ring: null,
    bubble: null,
    logEl: null,
    form: null,
    input: null,
    sendBtn: null,
  };

  const CURSOR_TRACK = {
    targetEl: null,
    label: null,
    rafId: null,
    resizeObserver: null,
    cleanup: [],
  };

  function injectStyles() {
    if (document.getElementById("cont-styles")) return;
    const style = document.createElement("style");
    style.id = "cont-styles";
    style.textContent = `
      #cont-root {
        --cont-accent: #f0f6fc;
        --cont-bg: rgba(24, 24, 27, 0.98);
        --cont-bg-2: rgba(31, 31, 35, 0.98);
        --cont-surface: rgba(39, 39, 42, 0.92);
        --cont-surface-2: rgba(44, 44, 48, 0.96);
        --cont-border: rgba(255, 255, 255, 0.08);
        --cont-text: #f3f4f6;
        --cont-muted: #a1a1aa;
        --cont-user: rgba(52, 52, 56, 0.96);
        --cont-user-border: rgba(255, 255, 255, 0.04);
        --cont-system: rgba(63, 63, 70, 0.75);
        font-family: Inter, "SF Pro Text", ui-sans-serif, system-ui, sans-serif;
        pointer-events: none;
        position: fixed;
        inset: 0;
        z-index: 2147483646;
      }
      #cont-panel {
        pointer-events: auto;
        position: fixed;
        bottom: 16px;
        right: 16px;
        width: min(440px, calc(100vw - 24px));
        max-height: min(74vh, 720px);
        background: linear-gradient(180deg, var(--cont-bg), var(--cont-bg-2));
        border: 1px solid var(--cont-border);
        border-radius: 22px;
        box-shadow: 0 18px 60px rgba(0,0,0,0.38);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        backdrop-filter: blur(20px);
      }
      #cont-panel header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--cont-border);
        color: var(--cont-text);
      }
      #cont-title {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      #cont-panel button.cont-close {
        pointer-events: auto;
        background: transparent;
        border: none;
        color: var(--cont-muted);
        cursor: pointer;
        width: 30px;
        height: 30px;
        font-size: 17px;
        line-height: 1;
        padding: 0;
        border-radius: 999px;
      }
      #cont-panel button.cont-close:hover { color: var(--cont-text); background: rgba(255,255,255,0.06); }
      #cont-status {
        margin: 12px 16px 10px;
        padding: 9px 11px;
        border-radius: 14px;
        font-size: 11px;
        line-height: 1.35;
        color: var(--cont-muted);
        background: var(--cont-surface);
        border: 1px solid var(--cont-border);
      }
      #cont-status.ready {
        color: #d4d4d8;
        background: var(--cont-surface);
        border-color: var(--cont-border);
      }
      #cont-status.waiting {
        color: #d4d4d8;
        background: var(--cont-surface);
        border-color: var(--cont-border);
      }
      #cont-status.busy {
        color: #f4f4f5;
        background: var(--cont-surface-2);
        border-color: rgba(255,255,255,0.11);
      }
      #cont-log {
        flex: 1;
        overflow-y: auto;
        padding: 2px 16px 12px;
        font-size: 13px;
        line-height: 1.6;
        color: var(--cont-text);
      }
      #cont-log .cont-msg {
        margin-bottom: 12px;
        max-width: 88%;
        padding: 12px 14px;
        border-radius: 18px;
        white-space: pre-wrap;
        word-break: break-word;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
      }
      #cont-log .cont-msg.user {
        margin-left: auto;
        background: var(--cont-user);
        border: 1px solid var(--cont-user-border);
        color: #e6edf3;
        border-bottom-right-radius: 8px;
      }
      #cont-log .cont-msg.bot {
        background: var(--cont-surface);
        border: 1px solid var(--cont-border);
        color: #e6edf3;
        border-bottom-left-radius: 8px;
      }
      #cont-log .cont-msg.system {
        max-width: 100%;
        background: var(--cont-system);
        border: 1px solid var(--cont-border);
        color: #c9d1d9;
        font-size: 11px;
        border-radius: 14px;
      }
      #cont-log .cont-msg.streaming::after {
        content: "▋";
        animation: cont-blink 1s step-end infinite;
        color: var(--cont-accent);
        margin-left: 2px;
      }
      #cont-composer {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        padding: 12px 16px 12px;
        border-top: 1px solid var(--cont-border);
        background: rgba(24, 24, 27, 0.86);
      }
      #cont-input {
        flex: 1;
        resize: none;
        min-height: 48px;
        max-height: 140px;
        padding: 13px 15px;
        border: 1px solid var(--cont-border);
        border-radius: 16px;
        background: var(--cont-surface);
        color: var(--cont-text);
        font: inherit;
        line-height: 1.4;
        outline: none;
      }
      #cont-input::placeholder { color: #71717a; }
      #cont-input:focus {
        border-color: rgba(255,255,255,0.14);
        box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
      }
      #cont-send {
        align-self: flex-end;
        min-width: 78px;
        height: 48px;
        border: none;
        border-radius: 16px;
        background: #f4f4f5;
        color: #18181b;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        padding: 0 16px;
        box-shadow: none;
      }
      #cont-send:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      #cont-send:hover:not(:disabled) {
        background: #ffffff;
      }
      @keyframes cont-blink { 50% { opacity: 0; } }
      #cont-hint {
        padding: 0 16px 14px;
        font-size: 10px;
        color: var(--cont-muted);
      }
      #aiCursor {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: left 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                    top 0.55s cubic-bezier(0.22, 1, 0.36, 1);
        transform: translate(-50%, -50%);
      }
      #aiCursor.cont-animate {
        transition: left 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                    top 0.55s cubic-bezier(0.22, 1, 0.36, 1);
      }
      #cont-ring.cont-animate {
        transition: left 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                    top 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                    opacity 0.25s;
      }
      #aiCursor.cont-tracking,
      #cont-ring.cont-tracking {
        transition: none;
      }
      #aiCursor .cs {
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: #fafafa;
        box-shadow:
          0 0 0 4px rgba(255,255,255,0.08),
          0 6px 20px rgba(0, 0, 0, 0.24);
      }
      #aiCursor .cn {
        font-size: 10px;
        font-weight: 600;
        color: #fafafa;
        background: rgba(24, 24, 27, 0.95);
        border: 1px solid var(--cont-border);
        padding: 4px 8px;
        border-radius: 999px;
        white-space: nowrap;
        letter-spacing: 0;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
      }
      #cont-ring {
        position: fixed;
        width: 56px;
        height: 56px;
        border: 1.5px solid rgba(255,255,255,0.75);
        border-radius: 16px;
        pointer-events: none;
        z-index: 2147483646;
        transform: translate(-50%, -50%);
        opacity: 0;
        transition: left 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                    top 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                    opacity 0.25s;
      }
      #cont-ring.cont-show { opacity: 1; animation: cont-pulse 1.4s ease-out infinite; }
      @keyframes cont-pulse {
        0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.14); }
        70% { box-shadow: 0 0 0 16px rgba(255,255,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
      }
      #cont-bubble {
        position: fixed;
        max-width: 280px;
        background: rgba(24, 24, 27, 0.96);
        border: 1px solid var(--cont-border);
        color: var(--cont-text);
        font-size: 12px;
        padding: 10px 12px;
        border-radius: 16px;
        pointer-events: none;
        z-index: 2147483647;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.2s, transform 0.2s;
        box-shadow: 0 14px 34px rgba(0,0,0,0.35);
      }
      #cont-bubble.cont-show { opacity: 1; transform: translateY(0); }
      .cont-highlight {
        outline: 2px solid rgba(255,255,255,0.88) !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 6px rgba(255,255,255,0.08) !important;
        transition: outline 0.2s, box-shadow 0.2s;
      }
      @media (max-width: 640px) {
        #cont-panel {
          left: 12px;
          right: 12px;
          bottom: 12px;
          width: auto;
          max-height: 68vh;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureBody(cb) {
    if (document.body) {
      cb();
      return;
    }
    const tick = () => {
      if (document.body) cb();
      else requestAnimationFrame(tick);
    };
    tick();
  }

  function mountUI() {
    injectStyles();
    if (UI.root) return;

    UI.root = document.createElement("div");
    UI.root.id = "cont-root";
    UI.root.innerHTML = `
      <div id="cont-panel">
        <header>
          <div id="cont-title">cont</div>
          <button class="cont-close" title="Exit (you = '/exit')">×</button>
        </header>
        <div id="cont-status" class="waiting">Waiting for Gemini API key</div>
        <div id="cont-log"></div>
        <form id="cont-composer">
          <textarea id="cont-input" rows="2" placeholder="Ask about this page..."></textarea>
          <button id="cont-send" type="submit">Send</button>
        </form>
        <div id="cont-hint">Enter to send · Shift+Enter for a new line · /stop · /exit</div>
      </div>
      <div id="cont-ring"></div>
      <div id="aiCursor" style="top: 100px; left: 100px;">
        <div class="cs"></div>
        <div class="cn">cont</div>
      </div>
      <div id="cont-bubble"></div>
    `;
    document.body.appendChild(UI.root);

    UI.panel = UI.root.querySelector("#cont-panel");
    UI.statusEl = UI.root.querySelector("#cont-status");
    UI.logEl = UI.root.querySelector("#cont-log");
    UI.cursor = UI.root.querySelector("#aiCursor");
    UI.ring = UI.root.querySelector("#cont-ring");
    UI.bubble = UI.root.querySelector("#cont-bubble");
    UI.form = UI.root.querySelector("#cont-composer");
    UI.input = UI.root.querySelector("#cont-input");
    UI.sendBtn = UI.root.querySelector("#cont-send");

    UI.panel.querySelector(".cont-close").addEventListener("click", () => shutdown());
    UI.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (STATE.streaming) {
        STATE.abortController?.abort();
        return;
      }
      const message = UI.input.value;
      UI.input.value = "";
      handleInput(message);
    });
    UI.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        UI.form.requestSubmit();
      }
    });
  }

  function unmountUI() {
    document.querySelectorAll(".cont-highlight").forEach((el) => el.classList.remove("cont-highlight"));
    UI.root?.remove();
    UI.root = null;
    document.getElementById("cont-styles")?.remove();
  }

  function panelLog(role, text, streaming = false) {
    if (!UI.logEl) return null;
    const div = document.createElement("div");
    div.className = `cont-msg ${role}${streaming ? " streaming" : ""}`;
    div.textContent = text;
    UI.logEl.appendChild(div);
    UI.logEl.scrollTop = UI.logEl.scrollHeight;
    return div;
  }

  function setStatus(text, tone) {
    if (!UI.statusEl) return;
    UI.statusEl.textContent = text;
    UI.statusEl.className = tone ? tone : "";
    UI.statusEl.id = "cont-status";
  }

  function syncComposer() {
    if (!UI.input || !UI.sendBtn) return;
    UI.input.disabled = false;
    UI.sendBtn.disabled = false;
    UI.sendBtn.textContent = STATE.streaming ? "Stop" : "Send";
    UI.input.placeholder = STATE.apiKey ? "Ask about this page..." : "Paste your Gemini API key here...";
    if (STATE.streaming) {
      setStatus("Thinking and streaming response...", "busy");
    } else if (STATE.apiKey) {
      setStatus("Ready", "ready");
    } else {
      setStatus("Waiting for Gemini API key", "waiting");
    }
  }

  function storeApiKey(value) {
    STATE.apiKey = String(value || "").trim() || null;
    STATE.awaitingApiKey = !STATE.apiKey;
    log("system", STATE.apiKey ? "Gemini API key saved from chat/config for this tab." : "API key cleared.");
    syncComposer();
  }

  function promptForApiKey() {
    STATE.awaitingApiKey = true;
    log("system", "Paste your Gemini API key into the chat to continue.");
  }

  function resolveTarget(target) {
    if (target instanceof Element) return target;
    if (typeof target !== "string") return null;

    const trimmed = target.trim();
    if (/^c-\d+$/.test(trimmed)) {
      return document.querySelector(`[data-cont-id="${trimmed}"]`);
    }

    try {
      return document.querySelector(trimmed);
    } catch {
      return null;
    }
  }

  function stopCursorTracking() {
    if (CURSOR_TRACK.rafId) cancelAnimationFrame(CURSOR_TRACK.rafId);
    CURSOR_TRACK.rafId = null;
    CURSOR_TRACK.targetEl = null;
    CURSOR_TRACK.label = null;
    CURSOR_TRACK.resizeObserver?.disconnect();
    CURSOR_TRACK.resizeObserver = null;
    for (const { target, type, fn, opts } of CURSOR_TRACK.cleanup) {
      target.removeEventListener(type, fn, opts);
    }
    CURSOR_TRACK.cleanup = [];
    UI.cursor?.classList.remove("cont-tracking", "cont-animate");
    UI.ring?.classList.remove("cont-tracking", "cont-animate");
  }

  function positionAssistCursorOnElement(el, label, animate) {
    if (!el?.getBoundingClientRect) return false;

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const ringWidth = Math.min(Math.max(rect.width + 18, 56), 220);
    const ringHeight = Math.min(Math.max(rect.height + 18, 56), 140);

    UI.cursor.classList.toggle("cont-animate", animate);
    UI.cursor.classList.toggle("cont-tracking", !animate);
    UI.ring.classList.toggle("cont-animate", animate);
    UI.ring.classList.toggle("cont-tracking", !animate);

    UI.cursor.style.left = `${x}px`;
    UI.cursor.style.top = `${Math.max(y - ringHeight / 2 - 18, 16)}px`;
    UI.ring.style.width = `${ringWidth}px`;
    UI.ring.style.height = `${ringHeight}px`;
    UI.ring.style.left = `${x}px`;
    UI.ring.style.top = `${y}px`;
    UI.ring.classList.add("cont-show");

    if (label) {
      UI.bubble.textContent = label;
      UI.bubble.style.left = `${Math.min(Math.max(x - ringWidth / 2, 12), innerWidth - 292)}px`;
      UI.bubble.style.top = `${Math.max(y + ringHeight / 2 + 12, 12)}px`;
      UI.bubble.classList.add("cont-show");
    }

    return true;
  }

  function tickCursorTracking() {
    const el = CURSOR_TRACK.targetEl;
    if (!el?.isConnected || !isVisible(el)) {
      hideAssistCursor();
      return;
    }
    positionAssistCursorOnElement(el, CURSOR_TRACK.label, false);
    CURSOR_TRACK.rafId = requestAnimationFrame(tickCursorTracking);
  }

  function startCursorTracking(el, label) {
    stopCursorTracking();
    CURSOR_TRACK.targetEl = el;
    CURSOR_TRACK.label = label;

    const reposition = () => {
      if (CURSOR_TRACK.targetEl) {
        positionAssistCursorOnElement(CURSOR_TRACK.targetEl, CURSOR_TRACK.label, false);
      }
    };

    const addListener = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      CURSOR_TRACK.cleanup.push({ target, type, fn, opts });
    };

    addListener(window, "scroll", reposition, { capture: true, passive: true });
    addListener(window, "resize", reposition, { passive: true });
    addListener(document, "scroll", reposition, { capture: true, passive: true });

    if (typeof ResizeObserver !== "undefined") {
      CURSOR_TRACK.resizeObserver = new ResizeObserver(reposition);
      CURSOR_TRACK.resizeObserver.observe(el);
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        CURSOR_TRACK.resizeObserver.observe(parent);
        parent = parent.parentElement;
      }
    }

    CURSOR_TRACK.rafId = requestAnimationFrame(tickCursorTracking);
  }

  function moveAssistCursor(target, label) {
    trace("action.point", `target=${target} label=${label || ""}`.trim());
    const el = resolveTarget(target);
    if (!el || !isVisible(el)) {
      panelLog("system", `Could not find element: ${target}`);
      trace("action.point.miss", `target=${target}`);
      return false;
    }

    document.querySelectorAll(".cont-highlight").forEach((n) => n.classList.remove("cont-highlight"));
    el.classList.add("cont-highlight");
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

    positionAssistCursorOnElement(el, label, true);
    startCursorTracking(el, label);

    return true;
  }

  function hideAssistCursor() {
    trace("action.clear", "hide cursor/highlight");
    stopCursorTracking();
    UI.ring?.classList.remove("cont-show");
    UI.bubble?.classList.remove("cont-show");
    document.querySelectorAll(".cont-highlight").forEach((el) => el.classList.remove("cont-highlight"));
  }

  const ACTION_RE = /\[\[ACTION:(\w+):(.*?)\]\]/g;

  function parseActions(text) {
    const actions = [];
    let match;
    while ((match = ACTION_RE.exec(text)) !== null) {
      const [, type, raw] = match;
      const parts = raw.split("|").map((s) => s.trim());
      actions.push({ type: type.toLowerCase(), args: parts });
    }
    return actions;
  }

  function stripActions(text) {
    return text.replace(ACTION_RE, "").trim();
  }

  function runActions(actions) {
    const hasVisualGuide = actions.some((action) => action.type === "point" || action.type === "highlight");
    const effectiveActions =
      hasVisualGuide && actions.length > 1
        ? actions.filter((action) => action.type !== "clear")
        : actions;

    trace("action.batch", `count=${actions.length} effective=${effectiveActions.length}`);
    for (const action of effectiveActions) {
      const [primary, secondary] = action.args;
      trace("action.run", `type=${action.type} target=${primary || ""} label=${secondary || ""}`.trim());
      switch (action.type) {
        case "point":
        case "highlight":
          moveAssistCursor(primary, secondary || "here");
          break;
        case "scroll":
          try {
            document.querySelector(primary)?.scrollIntoView({ behavior: "smooth", block: "center" });
            trace("action.scroll", `target=${primary}`);
          } catch {}
          break;
        case "clear":
          hideAssistCursor();
          break;
        default:
          panelLog("system", `Unknown action: ${action.type}`);
          trace("action.unknown", `type=${action.type}`);
      }
    }
  }

  const SYSTEM_PROMPT = `You are cont, an agentic on-page assistant embedded in the user's browser via the devtools console.

You receive a JSON snapshot of the current page including a list of visible HTML elements. Each element has:
- id: stable element id (e.g. "c-42")
- tag, text, role, and other attributes when available
- selector: always use this exact form → [data-cont-id="c-N"]

Your job:
- Answer questions about what is on screen and how to accomplish tasks on this site.
- Be concise, practical, and step-by-step when guiding UI actions.
- Pick the best matching element from the provided elements list by its id/selector — never invent selectors or use coordinates.

AGENT ACTIONS — when pointing the user somewhere, emit machine-readable actions on their own line:
[[ACTION:point:[data-cont-id="c-N"]|short label]]
[[ACTION:highlight:[data-cont-id="c-N"]|optional label]]
[[ACTION:scroll:[data-cont-id="c-N"]]]
[[ACTION:clear]]

Rules for actions:
- SELECTOR must be exactly [data-cont-id="c-N"] from the elements list in page context.
- The cursor tracks the live DOM element (scroll/resize safe) — coordinates are not supported.
- Use point/highlight when directing attention.
- Only use clear in a later response when you want to remove a previous pointer.
- Never emit clear in the same response as point, highlight, or scroll.
- Only emit actions when visually guiding — not for every message.
- Keep conversational text separate from action tags.

Do not claim you clicked anything. You can only point, highlight, and scroll.`;

  async function streamGemini(userMessage, options = {}) {
    const silentUser = Boolean(options.silentUser);

    if (!STATE.apiKey) {
      promptForApiKey();
      trace("request.skip", "missing_api_key");
      syncComposer();
      return;
    }
    if (STATE.streaming) {
      log("system", 'Still responding — wait or type: you = "/stop"');
      trace("request.skip", "already_streaming");
      syncComposer();
      return;
    }

    STATE.streaming = true;
    syncComposer();
    STATE.abortController = new AbortController();
    trace("request.queue", `messageLength=${userMessage.length}`);

    const pageContext = capturePageContext();
    const contextBlock = JSON.stringify(pageContext, null, 0);
    trace(
      "context.capture",
      `elements=${pageContext.elements.length} truncated=${pageContext.elementsTruncated} url=${pageContext.url}`
    );

    if (!silentUser) {
      STATE.history.push({ role: "user", text: userMessage });
      log("user", userMessage);
      panelLog("user", userMessage);
    }

    const panelNode = panelLog("bot", "", true);
    let fullText = "";

    const contents = [
      {
        role: "user",
        parts: [{ text: `${SYSTEM_PROMPT}\n\n--- PAGE CONTEXT ---\n${contextBlock}` }],
      },
      {
        role: "model",
        parts: [{ text: "Understood. I have the page context and will guide using ACTION tags when helpful." }],
      },
      ...(silentUser ? [{ role: "user", parts: [{ text: userMessage }] }] : []),
      ...STATE.history.slice(-12).map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }],
      })),
    ];

    try {
      const res = await fetchGeminiStream(contents, STATE.abortController.signal);
      trace("stream.open", `status=${res.status}`);

      if (!res.ok) {
        const errBody = await res.text();
        trace("stream.bad_response", `status=${res.status} bodyLength=${errBody.length}`);
        throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;

          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }

          const chunk = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (!chunk) continue;

          chunkCount += 1;
          fullText += chunk;
          trace("stream.chunk", `index=${chunkCount} chars=${chunk.length} total=${fullText.length}`);
          if (panelNode) {
            panelNode.textContent = stripActions(fullText);
            panelNode.classList.add("streaming");
            UI.logEl.scrollTop = UI.logEl.scrollHeight;
          }
        }
      }
      trace("stream.complete", `chunks=${chunkCount} chars=${fullText.length}`);

      const clean = stripActions(fullText);
      if (panelNode) {
        panelNode.textContent = clean;
        panelNode.classList.remove("streaming");
      }

      const actions = parseActions(fullText);
      trace("actions.parsed", `count=${actions.length}`);
      if (actions.length) runActions(actions);

      STATE.history.push({ role: "model", text: clean });
      log("bot", clean);
    } catch (err) {
      if (err.name === "AbortError") {
        trace("request.abort", "user_stopped");
        log("system", "Stopped.");
      } else {
        trace("request.exception", err.message || String(err));
        log("error", err.message || String(err));
        if (panelNode) {
          panelNode.textContent = err.message || "Request failed";
          panelNode.classList.remove("streaming");
        }
      }
    } finally {
      trace("request.done", `history=${STATE.history.length}`);
      STATE.streaming = false;
      STATE.abortController = null;
      syncComposer();
      UI.input?.focus();
    }
  }

  function log(kind, ...args) {
    const style = STYLES[kind] || STYLES.dim;
    const prefix = kind === "bot" ? "◆ cont" : kind === "user" ? "▸ you" : kind === "error" ? "✖" : "•";
    const text = args.join(" ");
    STATE.originalConsoleLog(`%c${prefix}%c ${text}`, STYLES.brand, style);
    if (kind === "system" || kind === "error") {
      panelLog(kind === "error" ? "system" : kind, text);
    }
  }

  function handleInput(raw) {
    const message = String(raw ?? "").trim();
    if (!message) return;

    if (message === "/exit" || message === "/quit") {
      shutdown();
      return;
    }
    if (message === "/stop") {
      STATE.abortController?.abort();
      return;
    }
    if (message === "/context") {
      const ctx = capturePageContext();
      log("system", "Page context refreshed (" + ctx.elements.length + " elements" + (ctx.elementsTruncated ? ", truncated" : "") + ")");
      console.dir(ctx);
      return;
    }
    if (message === "/help") {
      log("system", [
        'you = "your question"',
        'console.log(">> question")',
        'you = "/exit" · you = "/stop" · you = "/context" · you = "/help"',
        'GEMINI_KEY = "key" to set API key',
        'CONT_PROXY = "http://localhost:8080" or another allowed localhost relay',
      ].join(" | "));
      return;
    }
    if (!STATE.apiKey) {
      storeApiKey(message);
      return;
    }

    streamGemini(message);
  }

  function hookConsole() {
    console.log = function patchedConsoleLog(...args) {
      const first = args[0];
      if (typeof first === "string" && first.startsWith(">>")) {
        const msg = first.replace(/^>>\s*/, "").trim();
        if (msg) {
          handleInput(msg);
          return;
        }
      }
      return STATE.originalConsoleLog(...args);
    };
  }

  function unhookConsole() {
    console.log = STATE.originalConsoleLog;
  }

  function start(apiKey) {
    if (apiKey) STATE.apiKey = apiKey;

    ensureBody(() => {
      mountUI();
      hookConsole();
      STATE.active = true;

      Object.defineProperty(window, "you", {
        configurable: true,
        enumerable: true,
        set(value) {
          handleInput(value);
        },
        get() {
          return '(type: you = "your message here")';
        },
      });

      Object.defineProperty(window, "GEMINI_KEY", {
        configurable: true,
        enumerable: true,
        set(value) {
          storeApiKey(value);
        },
        get() {
          return STATE.apiKey ? "••••••••" + STATE.apiKey.slice(-4) : "(not set)";
        },
      });

      Object.defineProperty(window, "CONT_PROXY", {
        configurable: true,
        enumerable: true,
        set(value) {
          STATE.geminiProxy = String(value || "").trim().replace(/\/$/, "") || null;
          log("system", STATE.geminiProxy ? "Gemini proxy: " + STATE.geminiProxy : "Gemini proxy cleared.");
        },
        get() {
          return STATE.geminiProxy || window.__CONT_PROXY || DEFAULT_PROXIES[0];
        },
      });

      syncComposer();
      UI.input?.focus();

      if (!STATE.apiKey) {
        panelLog("bot", "Hi. Paste your Gemini API key to get started.");
      } else {
        streamGemini(
          "I just activated cont on this page. Briefly greet me and summarize what you see in 2-3 sentences.",
          { silentUser: true }
        );
      }
    });
  }

  function shutdown() {
    STATE.abortController?.abort();
    stopCursorTracking();
    STATE.active = false;
    unhookConsole();
    unmountUI();

    try {
      delete window.you;
    } catch {
      window.you = undefined;
    }

    log("system", "cont exited.");
  }

  window.__cont = {
    active: true,
    start,
    exit: shutdown,
    point: moveAssistCursor,
    context: capturePageContext,
    get apiKey() {
      return STATE.apiKey;
    },
    set apiKey(v) {
      STATE.apiKey = v;
    },
  };

  const initialKey = GEMINI_API_KEY.trim() || window.__CONT_KEY || null;
  if (INITIAL_CONT_PROXY) STATE.geminiProxy = INITIAL_CONT_PROXY;
  start(initialKey);
})();
