var GhostTracker = (() => {
  // core/sessionManager.js
  var SESSION_ID_KEY = "gt_sid";
  var SESSION_TS_KEY = "gt_sid_ts";
  var SESSION_CNT_KEY = "gt_sid_cnt";
  var SESSION_TTL_MS = 60 * 1e3;
  var _pageContext = null;
  function initSession() {
    const now = Date.now();
    const storedId = localStorage.getItem(SESSION_ID_KEY);
    const storedTs = Number(localStorage.getItem(SESSION_TS_KEY) || "0");
    const storedCnt = Number(localStorage.getItem(SESSION_CNT_KEY) || "0");
    let session_id;
    let is_new_session;
    if (storedId && now - storedTs < SESSION_TTL_MS) {
      session_id = storedId;
      is_new_session = false;
    } else {
      session_id = crypto.randomUUID();
      is_new_session = true;
      localStorage.setItem(SESSION_ID_KEY, session_id);
      localStorage.setItem(SESSION_CNT_KEY, String(storedCnt + 1));
    }
    localStorage.setItem(SESSION_TS_KEY, String(now));
    const utm = _parseUTM();
    return {
      session_id,
      is_new_session,
      // 이번 페이지 로드에서 새로 발급됐는지
      // is_returning: 새 세션을 발급받을 때 AND 이전에 완료된 세션이 있을 때만 true.
      // 기존 세션을 재사용(is_new_session=false)하는 경우는 동일 세션 유지이므로 false.
      is_returning: is_new_session && storedCnt > 0,
      session_count: storedCnt + (is_new_session ? 1 : 0),
      page_url: window.location.href,
      pathname: window.location.pathname,
      referrer: document.referrer || "",
      utm_source: utm.utm_source,
      utm_campaign: utm.utm_campaign,
      visit_time: now
    };
  }
  function touchSessionTimestamp() {
    localStorage.setItem(SESSION_TS_KEY, String(Date.now()));
  }
  function setPageContext(ctx) {
    _pageContext = { ...ctx };
  }
  function updatePageUrl() {
    if (_pageContext) {
      const utm = _parseUTM();
      _pageContext.page_url = window.location.href;
      _pageContext.pathname = window.location.pathname;
      _pageContext.utm_source = utm.utm_source;
      _pageContext.utm_campaign = utm.utm_campaign;
    }
  }
  function getPageContext() {
    return _pageContext || {};
  }
  function getSessionId() {
    return localStorage.getItem(SESSION_ID_KEY) || "";
  }
  function _parseUTM() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get("utm_source") || "",
      utm_campaign: params.get("utm_campaign") || ""
    };
  }

  // core/timeTracker.js
  var INACTIVITY_THRESHOLD_MS = 1e4;
  var _pageEnterTime = null;
  var _firstClickTime = null;
  var _lastEventTime = null;
  var _inactivityTimer = null;
  var _inactivityStartTime = null;
  var _onInactiveCallback = null;
  function recordPageEnter() {
    _pageEnterTime = Date.now();
    _lastEventTime = _pageEnterTime;
    _firstClickTime = null;
    _inactivityStartTime = null;
    _resetInactivityTimer();
  }
  function resetPageTimers() {
    recordPageEnter();
  }
  function recordActivity() {
    const now = Date.now();
    if (_inactivityStartTime !== null) {
      const inactivity_duration = now - _inactivityStartTime;
      if (_onInactiveCallback) {
        _onInactiveCallback({
          inactivity_start_time: _inactivityStartTime,
          inactivity_duration
        });
      }
      _inactivityStartTime = null;
    }
    _lastEventTime = now;
    _resetInactivityTimer();
  }
  function recordFirstClick() {
    if (_firstClickTime !== null) return null;
    _firstClickTime = Date.now();
    return _firstClickTime - _pageEnterTime;
  }
  function getPageDwellTime() {
    if (_pageEnterTime === null) return 0;
    return Date.now() - _pageEnterTime;
  }
  function getLastEventTime() {
    return _lastEventTime;
  }
  function getPendingInactivity() {
    if (_inactivityStartTime === null) return null;
    return {
      inactivity_start_time: _inactivityStartTime,
      inactivity_duration: Date.now() - _inactivityStartTime
    };
  }
  function onInactive(callback) {
    _onInactiveCallback = callback;
  }
  function _resetInactivityTimer() {
    clearTimeout(_inactivityTimer);
    _inactivityTimer = setTimeout(() => {
      _inactivityStartTime = Date.now();
    }, INACTIVITY_THRESHOLD_MS);
  }

  // core/sender.js
  var COLLECT_URL = "https://two026-capstone.onrender.com/collect";
  var FLUSH_INTERVAL = 5e3;
  var MAX_BUFFER_SIZE = 30;
  var _buffer = [];
  var _flushTimer = null;
  function configureSender({ collectUrl, flushInterval, maxBufferSize } = {}) {
    if (typeof collectUrl === "string" && collectUrl.trim()) {
      COLLECT_URL = collectUrl.trim();
    }
    if (Number.isFinite(flushInterval) && flushInterval > 0) {
      FLUSH_INTERVAL = flushInterval;
    }
    if (Number.isFinite(maxBufferSize) && maxBufferSize > 0) {
      MAX_BUFFER_SIZE = maxBufferSize;
    }
  }
  function send(event) {
    _buffer.push(event);
    if (_buffer.length >= MAX_BUFFER_SIZE) {
      flush(false);
      return;
    }
    if (_flushTimer === null) {
      _flushTimer = setTimeout(() => flush(false), FLUSH_INTERVAL);
    }
  }
  function flush(isUnload = false) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
    if (_buffer.length === 0) return;
    const payload = JSON.stringify({ events: _buffer });
    _buffer = [];
    if (isUnload) {
      _sendBeaconOrFetch(payload);
    } else {
      _sendFetch(payload);
    }
  }
  function _sendFetch(payload) {
    fetch(COLLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    }).catch(() => {
    });
  }
  function _sendBeaconOrFetch(payload) {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(COLLECT_URL, blob)) return;
    }
    fetch(COLLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true
    }).catch(() => {
    });
  }

  // core/eventProcessor.js
  var EVENT_VOCAB = Object.freeze({
    // Session / Page (A)
    session_start: 1,
    session_end: 2,
    navigation: 3,
    bounce: 4,
    // Click (B)
    click: 10,
    rage_click: 11,
    // A 파생
    // Mouse / Hover (B)
    mouse_move: 20,
    // B: 2초 주기 누적 이동거리 + jitter
    hover_dwell: 21,
    // B: 300ms 이상 hover
    // Tab (B)
    tab_exit: 30,
    tab_return: 31,
    // Form (B)
    input_change: 40,
    field_focus: 41,
    field_blur: 42,
    input_abandon: 43,
    paste_event: 44,
    search_use: 45,
    // B: 검색 입력 감지
    // Media (B)
    image_slide: 50,
    image_zoom: 51,
    video_play: 52,
    video_watch_pct: 53,
    // B: 10% 단위 영상 시청 진척
    // Scroll (C)
    scroll_depth: 60,
    scroll_milestone: 61,
    scroll_stop: 62,
    scroll_direction_change: 63,
    scroll_speed: 64,
    // Section (C)
    section_enter: 70,
    section_exit: 71,
    section_revisit: 72,
    section_transition: 73,
    subsection_enter: 74,
    subsection_exit: 75,
    subsection_revisit: 76,
    // C: 동일 서브섹션 재진입
    // Ecommerce (C)
    product_click: 80,
    option_select: 81,
    add_to_cart: 82,
    remove_from_cart: 83,
    purchase_click: 84,
    cart_abandon_flag: 85,
    // A 파생
    quantity_change: 86,
    // C: 수량 변경
    option_change: 87,
    // C: 동일 옵션 반복 변경
    // Review (C)
    review_click: 94,
    // C: 리뷰 아이템 클릭
    review_page_change: 95,
    // C: 리뷰 페이지 넘기기 (페이지네이션 / 더보기)
    review_scroll: 96,
    // C: 리뷰 섹션 가시 상태에서 페이지 스크롤
    review_area_scroll: 97,
    // C: 리뷰 전용 스크롤 영역(모달/패널) 내 스크롤
    review_image_click: 98,
    // C: 리뷰 내 이미지 클릭
    // A 파생 / A 전용
    inactivity: 90,
    time_to_first_click: 91,
    // A 파생
    subsection_dwell: 92,
    // C 계산 후 emit
    screen_resize: 93
    // A 전용
  });
  var _seq = 0;
  var _lastTimestamp = null;
  var _activityCallback = null;
  function setActivityCallback(cb) {
    _activityCallback = cb;
  }
  var RAGE_CLICK_WINDOW_MS = 500;
  var RAGE_CLICK_THRESHOLD = 3;
  var RAGE_CLICK_RADIUS_PX = 20;
  var RAGE_CLICK_COOLDOWN_MS = 1e3;
  var _recentClicks = [];
  var _rageClickLastFiredAt = null;
  var _cartItemCount = 0;
  function emit(eventType, data = {}) {
    console.log("[EMIT]", eventType, data);
    const now = Date.now();
    if (eventType !== "inactivity") {
      recordActivity();
      touchSessionTimestamp();
      if (_activityCallback) _activityCallback();
    }
    if (eventType === "add_to_cart") {
      _cartItemCount += 1;
    } else if (eventType === "remove_from_cart") {
      _cartItemCount = Math.max(0, _cartItemCount - 1);
    } else if (eventType === "purchase_click") {
      _cartItemCount = 0;
    }
    const event_seq = _dispatch(eventType, data, now);
    if (eventType === "click") {
      const ttfc = recordFirstClick();
      if (ttfc !== null) {
        _dispatch("time_to_first_click", { duration_ms: ttfc, derived_from_seq: event_seq }, now);
      }
      _checkRageClick(data, now);
    }
  }
  function emitSessionEnd(exitData = {}) {
    const now = Date.now();
    const pending = getPendingInactivity();
    if (pending) {
      _dispatch("inactivity", pending, now);
    }
    if (_cartItemCount > 0) {
      _dispatch("cart_abandon_flag", {
        cart_abandon_flag: true,
        cart_item_count: _cartItemCount
      }, now);
    }
    _dispatch("session_end", exitData, now);
  }
  function _dispatch(eventType, data, timestamp) {
    if (!(eventType in EVENT_VOCAB)) {
      console.warn(`[GhostTracker] Unknown event type: "${eventType}"`);
    }
    const inter_event_gap = _lastTimestamp !== null ? timestamp - _lastTimestamp : 0;
    _lastTimestamp = timestamp;
    _seq += 1;
    const event = {
      session_id: getSessionId(),
      event_type: eventType,
      timestamp,
      event_seq: _seq,
      event_token: EVENT_VOCAB[eventType] ?? 0,
      inter_event_gap,
      ...getPageContext(),
      // page_url, pathname, referrer, utm_*, device_type 등 자동 부여
      data
    };
    send(event);
    return _seq;
  }
  function _checkRageClick(data, now) {
    const pos = data.click_position;
    const x = pos?.x ?? data.x ?? 0;
    const y = pos?.y ?? data.y ?? 0;
    const target = data.click_target ?? data.target ?? "";
    if (_rageClickLastFiredAt !== null && now - _rageClickLastFiredAt < RAGE_CLICK_COOLDOWN_MS) {
      _recentClicks = [];
      return;
    }
    _recentClicks = _recentClicks.filter((c) => now - c.timestamp < RAGE_CLICK_WINDOW_MS);
    const isNearby = _recentClicks.every(
      (c) => Math.abs(c.x - x) <= RAGE_CLICK_RADIUS_PX && Math.abs(c.y - y) <= RAGE_CLICK_RADIUS_PX
    );
    if (!isNearby) {
      _recentClicks = [];
    }
    _recentClicks.push({ x, y, target, timestamp: now });
    if (_recentClicks.length >= RAGE_CLICK_THRESHOLD) {
      _rageClickLastFiredAt = now;
      _dispatch("rage_click", { x, y, click_target: target, click_count: _recentClicks.length }, now);
      _recentClicks = [];
    }
  }

  // sdk-A.js
  var _initialized = false;
  var _navigationPath = [];
  var _sessionEnded = false;
  var _hasInteracted = false;
  var _subsectionEnterTimes = {};
  var _resizeTimer = null;
  var _lastNavPathname = null;
  var _lastNavTimestamp = 0;
  var SESSION_TTL_MS2 = 30 * 60 * 1e3;
  var _sessionTTLTimer = null;
  function initA(options = {}) {
    if (_initialized) return;
    _initialized = true;
    if (options.sender) {
      configureSender(options.sender);
    }
    const sessionCtx = initSession();
    const envInfo = _collectEnv();
    setPageContext({
      page_url: sessionCtx.page_url,
      pathname: sessionCtx.pathname,
      referrer: sessionCtx.referrer,
      utm_source: sessionCtx.utm_source,
      utm_campaign: sessionCtx.utm_campaign,
      ...envInfo
    });
    recordPageEnter();
    _navigationPath.push(window.location.pathname);
    emit("session_start", {
      session_id: sessionCtx.session_id,
      is_new_session: sessionCtx.is_new_session,
      is_returning: sessionCtx.is_returning,
      session_count: sessionCtx.session_count,
      visit_time: sessionCtx.visit_time,
      referrer: sessionCtx.referrer
    });
    _setupNavigationTracking();
    _setupSessionEnd();
    _setupInactivityTracking();
    _setupInteractionTracking();
    _setupScreenResize();
    _setupGTBridge();
    setActivityCallback(_onUserActivity);
    _resetSessionTTLTimer();
  }
  function _collectEnv() {
    const ua = navigator.userAgent;
    return {
      device_type: _getDeviceType(ua),
      screen_width: window.innerWidth,
      os_type: _getOS(ua),
      browser_type: _getBrowser(ua)
    };
  }
  function _getDeviceType(ua) {
    if (/Tablet|iPad/i.test(ua)) return "tablet";
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
    return "desktop";
  }
  function _getOS(ua) {
    if (/Windows/i.test(ua)) return "windows";
    if (/Mac OS X/i.test(ua)) return "macos";
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
    if (/Linux/i.test(ua)) return "linux";
    return "unknown";
  }
  function _getBrowser(ua) {
    if (/Edg\//i.test(ua)) return "edge";
    if (/OPR\//i.test(ua)) return "opera";
    if (/Chrome\//i.test(ua)) return "chrome";
    if (/Firefox\//i.test(ua)) return "firefox";
    if (/Safari\//i.test(ua)) return "safari";
    return "unknown";
  }
  function _setupNavigationTracking() {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function(...args) {
      const prevPathname = window.location.pathname;
      origPush(...args);
      _onNavigation("push", prevPathname);
    };
    history.replaceState = function(...args) {
      const prevPathname = window.location.pathname;
      origReplace(...args);
      _onNavigation("replace", prevPathname);
    };
    window.addEventListener("popstate", () => _onNavigation("pop", null));
  }
  function _onNavigation(trigger, prevPathname = null) {
    const pathname = window.location.pathname;
    const now = Date.now();
    if (pathname === _lastNavPathname && now - _lastNavTimestamp < 100) return;
    _lastNavPathname = pathname;
    _lastNavTimestamp = now;
    _navigationPath.push(pathname);
    updatePageUrl();
    resetPageTimers();
    _hasInteracted = false;
    _subsectionEnterTimes = {};
    emit("navigation", {
      navigation_path: [..._navigationPath],
      page_depth: _navigationPath.length,
      current_pathname: pathname,
      prev_pathname: prevPathname,
      nav_trigger: trigger
    });
  }
  function _setupSessionEnd() {
    const _buildExitPayload = () => ({
      exit_page: window.location.pathname,
      page_dwell_time: getPageDwellTime(),
      last_event_time: getLastEventTime(),
      bounce_flag: _navigationPath.length === 1 && !_hasInteracted,
      last_viewport_scrollY: window.scrollY,
      navigation_path: [..._navigationPath],
      page_depth: _navigationPath.length
    });
    const handleSessionEnd = () => {
      if (_sessionEnded) return;
      _sessionEnded = true;
      touchSessionTimestamp();
      emitSessionEnd(_buildExitPayload());
      flush(true);
    };
    window.addEventListener("beforeunload", handleSessionEnd);
    window.addEventListener("pagehide", handleSessionEnd);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && !_sessionEnded) {
        flush(true);
      }
    });
  }
  function _setupInactivityTracking() {
    onInactive(({ inactivity_start_time, inactivity_duration }) => {
      emit("inactivity", {
        inactivity_start_time,
        inactivity_duration
      });
    });
  }
  function _setupInteractionTracking() {
    const markInteracted = () => {
      _hasInteracted = true;
    };
    document.addEventListener("click", markInteracted, { once: true, passive: true });
    document.addEventListener("touchstart", markInteracted, { once: true, passive: true });
  }
  function _setupScreenResize() {
    window.addEventListener("resize", () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        emit("screen_resize", {
          screen_width: window.innerWidth,
          screen_height: window.innerHeight
        });
      }, 500);
    });
  }
  function _setupGTBridge() {
    if (!window.__GT) window.__GT = {};
    Object.assign(window.__GT, {
      // C(IIFE)의 로컬 send()를 이것으로 교체하면 A 코어와 연결됨
      //   function send(eventType, payload) { window.__GT?.emit(eventType, payload); }
      emit,
      // subsection dwell: C의 IntersectionObserver가 진입/이탈 시 호출
      subsectionEnter: (subsection_id) => {
        if (!subsection_id) return;
        _subsectionEnterTimes[subsection_id] = Date.now();
        emit("subsection_enter", { subsection_id });
      },
      subsectionExit: (subsection_id) => {
        if (!subsection_id) return;
        const enterTime = _subsectionEnterTimes[subsection_id];
        if (!enterTime) return;
        const dwell_ms = Date.now() - enterTime;
        delete _subsectionEnterTimes[subsection_id];
        emit("subsection_exit", { subsection_id });
        emit("subsection_dwell", { subsection_id, dwell_ms });
      },
      // 디버깅용
      getState: () => ({
        navigationPath: [..._navigationPath],
        hasInteracted: _hasInteracted,
        sessionEnded: _sessionEnded
      })
    });
  }
  function _resetSessionTTLTimer() {
    clearTimeout(_sessionTTLTimer);
    _sessionTTLTimer = setTimeout(_onSessionTTLExpired, SESSION_TTL_MS2);
  }
  function _onUserActivity() {
    if (_sessionEnded) {
      _restartSession();
    }
    _resetSessionTTLTimer();
  }
  function _onSessionTTLExpired() {
    if (_sessionEnded) return;
    _sessionEnded = true;
    emitSessionEnd({
      exit_page: window.location.pathname,
      page_dwell_time: getPageDwellTime(),
      last_event_time: getLastEventTime(),
      bounce_flag: _navigationPath.length === 1 && !_hasInteracted,
      exit_reason: "timeout",
      navigation_path: [..._navigationPath],
      page_depth: _navigationPath.length
    });
    flush(true);
    localStorage.removeItem("gt_sid");
    localStorage.removeItem("gt_sid_ts");
  }
  function _restartSession() {
    _sessionEnded = false;
    _hasInteracted = false;
    _subsectionEnterTimes = {};
    _navigationPath = [window.location.pathname];
    const sessionCtx = initSession();
    const envInfo = _collectEnv();
    setPageContext({
      page_url: sessionCtx.page_url,
      pathname: sessionCtx.pathname,
      referrer: sessionCtx.referrer,
      utm_source: sessionCtx.utm_source,
      utm_campaign: sessionCtx.utm_campaign,
      ...envInfo
    });
    recordPageEnter();
    emit("session_start", {
      session_id: sessionCtx.session_id,
      is_new_session: sessionCtx.is_new_session,
      is_returning: sessionCtx.is_returning,
      session_count: sessionCtx.session_count,
      visit_time: sessionCtx.visit_time,
      referrer: sessionCtx.referrer
    });
  }

  // sdk-B.js
  var isInitialized = false;
  var state = {
    clickCount: 0,
    tabExitCount: 0,
    hoverStartMap: /* @__PURE__ */ new WeakMap(),
    fieldFocusCountMap: /* @__PURE__ */ new WeakMap(),
    tabHiddenAt: null,
    // mouse_move: 2초 주기 누적
    mouseLastX: null,
    mouseLastY: null,
    mouseTotalDistance: 0,
    mouseJitterCount: 0,
    mouseLastDir: null,
    // 방향 변화 횟수
    mouseTimer: null,
    // video watch pct
    videoWatchedPct: /* @__PURE__ */ new WeakMap()
    // HTMLVideoElement → Set<number>
  };
  function initB(handleRawEvent) {
    if (isInitialized) return;
    if (typeof handleRawEvent !== "function") {
      throw new Error("initB requires handleRawEvent function");
    }
    isInitialized = true;
    trackClicks(handleRawEvent);
    trackMouseMovement(handleRawEvent);
    trackInputs(handleRawEvent);
    trackFocusAndBlur(handleRawEvent);
    trackPaste(handleRawEvent);
    trackTabVisibility(handleRawEvent);
    trackHoverDwell(handleRawEvent);
    trackMedia(handleRawEvent);
    trackSearch(handleRawEvent);
    console.log("[GhostTracker] sdk-B initialized");
  }
  function isFormElement(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  }
  function getTrackableTarget(element) {
    if (!(element instanceof Element)) return null;
    return element.closest(
      [
        "[data-ghost-role]",
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "label",
        "[role='button']"
      ].join(",")
    ) || element;
  }
  function getElementLabel(element) {
    if (!(element instanceof Element)) return "unknown";
    const tag = element.tagName ? element.tagName.toLowerCase() : "unknown";
    const id = element.id ? `#${element.id}` : "";
    let className = "";
    if (typeof element.className === "string" && element.className.trim()) {
      className = "." + element.className.trim().split(/\s+/).slice(0, 3).join(".");
    }
    return `${tag}${id}${className}`;
  }
  function getElementText(element, maxLength = 80) {
    if (!element) return "";
    const raw = typeof element.innerText === "string" ? element.innerText : typeof element.value === "string" ? element.value : "";
    return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
  }
  function getFormValueLength(target) {
    if (!isFormElement(target)) return 0;
    if (typeof target.value !== "string") return 0;
    return target.value.length;
  }
  function getFormMeta(target) {
    if (!isFormElement(target)) {
      return { input_target: "unknown", input_name: null, input_type: null, ghost_role: null };
    }
    return {
      input_target: getElementLabel(target),
      input_name: target.name || null,
      input_type: target.type || target.tagName.toLowerCase(),
      ghost_role: target.dataset?.ghostRole || null
    };
  }
  function trackClicks(handleRawEvent) {
    document.addEventListener("click", (e) => {
      console.log("[B] \uD074\uB9AD \uAC10\uC9C0\uB428");
      const target = getTrackableTarget(e.target);
      state.clickCount += 1;
      handleRawEvent("click", {
        click_count: state.clickCount,
        click_target: getElementLabel(target),
        click_text: getElementText(target, 100),
        click_position: { x: e.clientX, y: e.clientY },
        tag_name: target?.tagName?.toLowerCase() || null,
        ghost_role: target?.dataset?.ghostRole || null
      });
    });
  }
  function trackMouseMovement(handleRawEvent) {
    document.addEventListener("mousemove", (e) => {
      const x = e.clientX;
      const y = e.clientY;
      if (state.mouseLastX !== null && state.mouseLastY !== null) {
        const dx = x - state.mouseLastX;
        const dy = y - state.mouseLastY;
        state.mouseTotalDistance += Math.sqrt(dx * dx + dy * dy);
        const dirX = dx > 0 ? "r" : dx < 0 ? "l" : null;
        const dirY = dy > 0 ? "d" : dy < 0 ? "u" : null;
        const dir = `${dirX}${dirY}`;
        if (state.mouseLastDir && dir !== state.mouseLastDir) {
          state.mouseJitterCount += 1;
        }
        state.mouseLastDir = dir;
      }
      state.mouseLastX = x;
      state.mouseLastY = y;
      if (!state.mouseTimer) {
        state.mouseTimer = setTimeout(() => {
          const dist = Math.round(state.mouseTotalDistance);
          const jitter = state.mouseJitterCount;
          if (dist > 0) {
            handleRawEvent("mouse_move", {
              distance_px: dist,
              jitter_count: jitter
            });
          }
          state.mouseTotalDistance = 0;
          state.mouseJitterCount = 0;
          state.mouseTimer = null;
        }, 2e3);
      }
    });
  }
  function trackInputs(handleRawEvent) {
    document.addEventListener("input", (e) => {
      const target = e.target;
      if (!isFormElement(target)) return;
      handleRawEvent("input_change", {
        ...getFormMeta(target),
        input_length: getFormValueLength(target)
      });
    });
  }
  function trackFocusAndBlur(handleRawEvent) {
    document.addEventListener(
      "focus",
      (e) => {
        const target = e.target;
        if (!isFormElement(target)) return;
        const prevCount = state.fieldFocusCountMap.get(target) || 0;
        const nextCount = prevCount + 1;
        state.fieldFocusCountMap.set(target, nextCount);
        handleRawEvent("field_focus", {
          ...getFormMeta(target),
          field_refocus_count: Math.max(0, nextCount - 1)
        });
      },
      true
    );
    document.addEventListener(
      "blur",
      (e) => {
        const target = e.target;
        if (!isFormElement(target)) return;
        const valueLength = getFormValueLength(target);
        handleRawEvent("field_blur", {
          ...getFormMeta(target),
          input_length: valueLength
        });
        if (valueLength === 0) {
          handleRawEvent("input_abandon", { ...getFormMeta(target) });
        }
      },
      true
    );
  }
  function trackPaste(handleRawEvent) {
    document.addEventListener("paste", (e) => {
      const target = e.target;
      if (!isFormElement(target)) return;
      handleRawEvent("paste_event", { ...getFormMeta(target) });
    });
  }
  function trackTabVisibility(handleRawEvent) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        state.tabHiddenAt = Date.now();
        state.tabExitCount += 1;
        handleRawEvent("tab_exit", { tab_exit_count: state.tabExitCount });
        return;
      }
      const duration = typeof state.tabHiddenAt === "number" ? Date.now() - state.tabHiddenAt : null;
      handleRawEvent("tab_return", { tab_exit_duration_ms: duration });
      state.tabHiddenAt = null;
    });
  }
  function trackHoverDwell(handleRawEvent) {
    document.addEventListener(
      "mouseover",
      (e) => {
        const target = getTrackableTarget(e.target);
        if (!(target instanceof Element)) return;
        state.hoverStartMap.set(target, Date.now());
      },
      true
    );
    document.addEventListener(
      "mouseout",
      (e) => {
        const target = getTrackableTarget(e.target);
        if (!(target instanceof Element)) return;
        const startTime = state.hoverStartMap.get(target);
        if (!startTime) return;
        state.hoverStartMap.delete(target);
        const dwellTime = Date.now() - startTime;
        if (dwellTime < 300) return;
        handleRawEvent("hover_dwell", {
          hover_target: getElementLabel(target),
          hover_text: getElementText(target, 100),
          hover_dwell_time_ms: dwellTime,
          ghost_role: target.dataset?.ghostRole || null
        });
      },
      true
    );
  }
  function trackMedia(handleRawEvent) {
    document.addEventListener("click", (e) => {
      const role = e.target?.dataset?.ghostRole || e.target?.closest("[data-ghost-role]")?.dataset?.ghostRole;
      if (role === "slide-prev" || role === "slide-next") {
        handleRawEvent("image_slide", {
          direction: role === "slide-prev" ? "prev" : "next",
          slide_target: getElementLabel(e.target)
        });
      }
    });
    let _zoomTimer = null;
    let _zoomLastDir = null;
    document.addEventListener("wheel", (e) => {
      const img = e.target?.closest("img") || (e.target?.tagName === "IMG" ? e.target : null);
      if (!img) return;
      _zoomLastDir = e.deltaY < 0 ? "in" : "out";
      clearTimeout(_zoomTimer);
      _zoomTimer = setTimeout(() => {
        handleRawEvent("image_zoom", {
          zoom_direction: _zoomLastDir,
          image_src: img.src?.split("?")[0]?.split("/").pop() || "unknown"
        });
        _zoomLastDir = null;
      }, 200);
    }, { passive: true });
    document.addEventListener(
      "play",
      (e) => {
        if (!(e.target instanceof HTMLVideoElement)) return;
        handleRawEvent("video_play", {
          video_src: e.target.src?.split("?")[0]?.split("/").pop() || "unknown",
          video_duration: Math.round(e.target.duration) || null,
          current_time: Math.round(e.target.currentTime)
        });
      },
      true
    );
    document.addEventListener(
      "timeupdate",
      (e) => {
        const video = e.target;
        if (!(video instanceof HTMLVideoElement)) return;
        if (!video.duration) return;
        const pct = Math.floor(video.currentTime / video.duration * 10) * 10;
        if (pct <= 0) return;
        let watched = state.videoWatchedPct.get(video);
        if (!watched) {
          watched = /* @__PURE__ */ new Set();
          state.videoWatchedPct.set(video, watched);
        }
        if (!watched.has(pct)) {
          watched.add(pct);
          handleRawEvent("video_watch_pct", {
            watch_pct: pct,
            video_src: video.src?.split("?")[0]?.split("/").pop() || "unknown",
            video_duration: Math.round(video.duration)
          });
        }
      },
      true
    );
  }
  function trackSearch(handleRawEvent) {
    const DEBOUNCE_MS = 300;
    const timers = /* @__PURE__ */ new WeakMap();
    const SEARCH_SELECTOR = [
      'input[type="search"]',
      'input[role="searchbox"]',
      '[role="searchbox"]',
      '[data-ghost-role="search-input"]',
      // name 기반 (표준 검색 파라미터)
      'input[name="q"]',
      'input[name="s"]',
      'input[name="search"]',
      'input[name="keyword"]',
      'input[name="query"]',
      // placeholder/aria-label 기반
      'input[placeholder*="\uAC80\uC0C9" i]',
      'input[placeholder*="search" i]',
      'input[placeholder*="\uCC3E\uAE30" i]',
      'input[placeholder*="find" i]',
      'input[aria-label*="\uAC80\uC0C9" i]',
      'input[aria-label*="search" i]'
    ].join(",");
    function isSearchHeuristic(el) {
      if (!(el instanceof HTMLInputElement)) return false;
      if (el.type && el.type !== "text") return false;
      const id = (el.id || "").toLowerCase();
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      const formAction = (el.closest("form")?.getAttribute("action") || "").toLowerCase();
      return id.includes("search") || cls.split(/\s+/).some((c) => c.includes("search")) || formAction.includes("search");
    }
    document.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const isExplicit = target.matches(SEARCH_SELECTOR);
      const isInferred = !isExplicit && isSearchHeuristic(target);
      if (!isExplicit && !isInferred) return;
      const capturedValue = typeof target.value === "string" ? target.value : "";
      const capturedLength = capturedValue.length;
      if (capturedLength === 0) return;
      if (timers.has(target)) clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(() => {
          timers.delete(target);
          handleRawEvent("search_use", {
            search_query: capturedValue,
            search_length: capturedLength,
            input_name: target.name || null,
            ghost_role: target.dataset?.ghostRole || null,
            ...isInferred && { inferred: true }
          });
        }, DEBOUNCE_MS)
      );
    });
  }

  // sdk-C.js
  function initC(handleRawEvent) {
    if (typeof handleRawEvent !== "function") {
      throw new Error("initC requires handleRawEvent function");
    }
    _initScrollTracking(handleRawEvent);
    _initSectionTracking(handleRawEvent);
    _initSubsectionTracking(handleRawEvent);
    _initEcommerceTracking(handleRawEvent);
    _initReviewTracking(handleRawEvent);
    console.log("[GhostTracker] sdk-C initialized");
  }
  function _initScrollTracking(handleRawEvent) {
    let ticking = false;
    let lastDepth = -1;
    let lastY = 0;
    let lastDirection = null;
    let lastTime = Date.now();
    let scrollTimeout = null;
    let isFirstScroll = true;
    const milestones = [25, 50, 75, 100];
    const reached = /* @__PURE__ */ new Set();
    function getScrollDepth() {
      const scrollTop = window.scrollY;
      const docHeight = document.body.scrollHeight - window.innerHeight;
      if (docHeight < 100) return 0;
      return Math.round(scrollTop / docHeight * 100);
    }
    function detectDirection(depth) {
      const currentY = window.scrollY;
      const direction = currentY > lastY ? "down" : "up";
      if (lastDirection && direction !== lastDirection) {
        handleRawEvent("scroll_direction_change", {
          from: lastDirection,
          to: direction,
          depth_pct: depth
        });
      }
      lastDirection = direction;
      lastY = currentY;
    }
    function detectSpeed() {
      const now = Date.now();
      const dy = Math.abs(window.scrollY - lastY);
      const dt = now - lastTime;
      if (dt > 0) {
        const speed = dy / dt;
        handleRawEvent("scroll_speed", { speed: Number(speed.toFixed(3)) });
      }
      lastTime = now;
    }
    function handleScroll() {
      const depth = getScrollDepth();
      if (isFirstScroll) {
        isFirstScroll = false;
        lastDepth = depth;
        return;
      }
      if (Math.abs(depth - lastDepth) >= 5) {
        lastDepth = depth;
        handleRawEvent("scroll_depth", { depth_pct: depth });
      }
      milestones.forEach((m) => {
        if (depth >= m && !reached.has(m)) {
          reached.add(m);
          handleRawEvent("scroll_milestone", { milestone: m });
        }
      });
      detectSpeed();
      detectDirection(depth);
    }
    window.addEventListener("scroll", () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        handleRawEvent("scroll_stop", { position: window.scrollY });
      }, 300);
    });
  }
  function _initSectionTracking(handleRawEvent) {
    const activeSections = /* @__PURE__ */ new Set();
    const visitCount = {};
    let lastSection = null;
    let autoIndex = 0;
    function inferSectionName(el) {
      const tag = el.tagName.toLowerCase();
      if (["header", "nav", "main", "footer", "aside"].includes(tag)) return tag;
      const heading = el.querySelector("h1,h2,h3,h4,h5,h6");
      if (heading?.textContent?.trim()) {
        return heading.textContent.trim().slice(0, 40).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_가-힣]/g, "");
      }
      return `${tag}_${autoIndex++}`;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          const id = el.dataset.section || el.dataset.ghostSectionInferred;
          const isInferred = !el.dataset.section && !!el.dataset.ghostSectionInferred;
          if (!id) return;
          if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
            if (!activeSections.has(id)) {
              activeSections.add(id);
              handleRawEvent("section_enter", {
                section: id,
                ...isInferred && { inferred: true }
              });
              visitCount[id] = (visitCount[id] || 0) + 1;
              if (visitCount[id] > 1) {
                handleRawEvent("section_revisit", {
                  section: id,
                  count: visitCount[id],
                  ...isInferred && { inferred: true }
                });
              }
              if (lastSection && lastSection !== id) {
                handleRawEvent("section_transition", { from: lastSection, to: id });
              }
              lastSection = id;
            }
          } else if (!entry.isIntersecting) {
            if (activeSections.has(id)) {
              activeSections.delete(id);
              handleRawEvent("section_exit", {
                section: id,
                ...isInferred && { inferred: true }
              });
            }
          }
        });
      },
      { threshold: [0.3] }
    );
    function initSectionObserver() {
      document.querySelectorAll("[data-section]").forEach((el) => observer.observe(el));
      const SEMANTIC_TAGS = ["header", "nav", "main", "section", "article", "aside", "footer"];
      document.querySelectorAll(SEMANTIC_TAGS.join(",")).forEach((el) => {
        if (el.dataset.section) return;
        el.dataset.ghostSectionInferred = inferSectionName(el);
        observer.observe(el);
      });
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initSectionObserver);
    } else {
      initSectionObserver();
    }
  }
  function _initSubsectionTracking(handleRawEvent) {
    const visitCount = {};
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = entry.target.dataset.subsection;
          if (!id) return;
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
            window.__GT?.subsectionEnter?.(id);
            visitCount[id] = (visitCount[id] || 0) + 1;
            if (visitCount[id] > 1) {
              handleRawEvent("subsection_revisit", { subsection_id: id, count: visitCount[id] });
            }
          } else if (!entry.isIntersecting) {
            window.__GT?.subsectionExit?.(id);
          }
        });
      },
      { threshold: [0.5] }
    );
    function initSubsectionObserver() {
      document.querySelectorAll("[data-subsection]").forEach((el) => observer.observe(el));
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initSubsectionObserver);
    } else {
      initSubsectionObserver();
    }
  }
  function _initEcommerceTracking(handleRawEvent) {
    const optionChangeCounts = /* @__PURE__ */ new WeakMap();
    const ADD_TO_CART_TEXT = [
      /add\s*to\s*cart/i,
      /add\s*to\s*bag/i,
      /add\s*to\s*basket/i,
      /장바구니/i,
      /담기/i,
      /카트에?\s*추가/i
    ];
    const REMOVE_EXPLICIT_TEXT = [
      /remove\s*from\s*(cart|bag|basket)/i,
      /delete\s*from\s*(cart|bag|basket)/i,
      /장바구니.*(삭제|제거)/i,
      /카트.*(삭제|제거)/i,
      /담은\s*상품?\s*(삭제|제거)/i
    ];
    const REMOVE_EXPLICIT_CLASS = [
      "cart-remove",
      "remove-from-cart",
      "delete-from-cart",
      "cart-item-remove",
      "cart-item-delete",
      "cart-delete",
      "basket-remove",
      "bag-remove"
    ];
    const REMOVE_EXPLICIT_ARIA = [
      /remove\s*(item\s*)?from\s*(cart|bag|basket)/i,
      /장바구니.*(삭제|제거)/i,
      /delete\s*(item\s*)?from\s*(cart|bag|basket)/i
    ];
    const CART_ITEM_SELECTOR = [
      '[class*="cart-item"]',
      '[class*="cart_item"]',
      '[class*="cart-product"]',
      '[class*="cart_product"]',
      '[class*="basket-item"]',
      '[class*="basket_item"]',
      '[class*="bag-item"]',
      '[class*="bag_item"]',
      '[class*="order-item"]',
      '[class*="order_item"]',
      '[class*="line-item"]',
      '[class*="lineitem"]',
      "[data-cart-item]",
      "[data-item-id]"
    ].join(",");
    const REMOVE_GENERIC_TEXT = [
      /^(삭제|제거|지우기)$/,
      /^(remove|delete)$/i
    ];
    const REMOVE_GENERIC_CLASS = [
      "remove-btn",
      "remove-item",
      "delete-item",
      "btn-remove",
      "delete-btn",
      "btn-delete",
      "item-remove",
      "item-delete",
      "close-item",
      "item-close"
    ];
    const REMOVE_GENERIC_ARIA = [
      /^(삭제|제거|remove|delete)$/i,
      /상품\s*(삭제|제거)/i,
      /아이템?\s*(삭제|제거)/i
    ];
    const X_ICON_RE = /^[×✕✖✗]$|^x$/i;
    function isRemoveFromCart(el) {
      const ariaLabel = el.getAttribute?.("aria-label") || "";
      if (REMOVE_EXPLICIT_TEXT.some((p) => p.test(textOf(el)) || p.test(ariaLabel)) || hasClass(el, REMOVE_EXPLICIT_CLASS) || REMOVE_EXPLICIT_ARIA.some((p) => p.test(ariaLabel))) return true;
      const inCartCtx = !!el.closest(CART_ITEM_SELECTOR);
      if (!inCartCtx) return false;
      const t = textOf(el).trim();
      if (REMOVE_GENERIC_TEXT.some((p) => p.test(t))) return true;
      if (X_ICON_RE.test(t)) return true;
      if (hasClass(el, REMOVE_GENERIC_CLASS)) return true;
      if (REMOVE_GENERIC_ARIA.some((p) => p.test(ariaLabel))) return true;
      const hasSvg = !!el.querySelector("svg");
      const svgTitle = el.querySelector("svg title")?.textContent || "";
      if (hasSvg && t === "" && (hasClass(el, [...REMOVE_GENERIC_CLASS, "close", "dismiss", "clear", "trash"]) || /delete|remove|삭제|제거|trash/i.test(svgTitle))) return true;
      return false;
    }
    const PURCHASE_TEXT = [
      /buy\s*now/i,
      /checkout/i,
      /place\s*order/i,
      /proceed\s*to\s*checkout/i,
      /구매하기/i,
      /주문하기/i,
      /결제하기/i,
      /^결제$/i,
      /주문\s*완료/i
    ];
    const PURCHASE_HREF = ["/checkout", "/order", "/purchase", "/pay"];
    const PRODUCT_HREF = /\/(?:product|p|item|goods|shop)\/([^/?#]+)/i;
    const _preClickText = /* @__PURE__ */ new WeakMap();
    const ECOMMERCE_SELECTOR = 'a, button, form, input, select, textarea, label, [role="button"]';
    document.addEventListener("click", (e) => {
      const el = e.target?.closest?.(ECOMMERCE_SELECTOR) || e.target;
      if (el instanceof Element) {
        _preClickText.set(el, el.textContent?.trim() || "");
      }
    }, { capture: true });
    function textOf(el) {
      return _preClickText.get(el) || (el?.textContent || el?.innerText || "").trim();
    }
    function matchesPatterns(el, patterns) {
      const text = textOf(el);
      const label = el?.getAttribute?.("aria-label") || "";
      return patterns.some((p) => p.test(text) || p.test(label));
    }
    function hasClass(el, keywords) {
      const cls = (typeof el?.className === "string" ? el.className : "").toLowerCase();
      return keywords.some((k) => cls.includes(k));
    }
    function inferProductId(el) {
      const fromParent = el?.closest?.("[data-product-id]")?.dataset?.productId;
      if (fromParent) return fromParent;
      const match = window.location.pathname.match(PRODUCT_HREF);
      if (match) return match[1];
      const params = new URLSearchParams(window.location.search);
      return params.get("product_id") || params.get("id") || null;
    }
    function inferEcommerceEvent(target) {
      if (!(target instanceof Element)) return null;
      const el = target.closest('a, button, form, input, select, textarea, label, [role="button"]') || target;
      const href = el.getAttribute?.("href") || "";
      if (matchesPatterns(el, ADD_TO_CART_TEXT) || hasClass(el, ["add-to-cart", "add_to_cart", "addtocart", "btn-cart", "cart-add"])) {
        const nameEl = el.closest("[data-product-name]")?.dataset.productName || el.closest("section,article,div")?.querySelector("h1,h2,h3,h4")?.textContent?.trim() || document.querySelector("h1")?.textContent?.trim() || null;
        return {
          type: "add_to_cart",
          data: { product_id: inferProductId(el), product_name: nameEl ? String(nameEl).slice(0, 80) : null, quantity: 1, inferred: true }
        };
      }
      if (isRemoveFromCart(el)) {
        return {
          type: "remove_from_cart",
          data: { product_id: inferProductId(el), quantity: 1, inferred: true }
        };
      }
      if (matchesPatterns(el, PURCHASE_TEXT) || PURCHASE_HREF.some((p) => href.includes(p))) {
        return {
          type: "purchase_click",
          data: { product_id: inferProductId(el), inferred: true }
        };
      }
      if (el.tagName === "A" && PRODUCT_HREF.test(href)) {
        const m = href.match(PRODUCT_HREF);
        const nameEl = el.querySelector("h1,h2,h3,h4,h5,h6,p");
        const productName = (nameEl?.textContent?.trim() || textOf(el)).slice(0, 80) || null;
        return {
          type: "product_click",
          data: {
            product_id: m ? m[1] : null,
            product_name: productName,
            ghost_role: "inferred_link",
            inferred: true
          }
        };
      }
      const card = el.closest(
        '[itemtype*="Product"], [class*="product-card"], [class*="product-item"], [class*="ProductCard"]'
      );
      if (card) {
        return {
          type: "product_click",
          data: {
            product_id: inferProductId(el),
            product_name: (card.querySelector('[itemprop="name"]')?.textContent?.trim() || card.querySelector("h2,h3,h4")?.textContent?.trim() || null)?.slice(0, 80),
            ghost_role: "inferred_card",
            inferred: true
          }
        };
      }
      return null;
    }
    document.addEventListener("click", (e) => {
      const el = e.target?.closest("[data-ghost-role]");
      if (el) {
        const role = el.dataset.ghostRole;
        const productId = el.dataset.productId || el.closest("[data-product-id]")?.dataset.productId || null;
        switch (role) {
          case "product-card":
          case "product-link":
            handleRawEvent("product_click", {
              product_id: productId,
              product_name: el.dataset.productName || el.textContent?.trim().slice(0, 80) || null,
              ghost_role: role
            });
            return;
          case "add-to-cart":
            handleRawEvent("add_to_cart", {
              product_id: productId,
              product_name: el.dataset.productName || null,
              quantity: Number(el.dataset.quantity) || 1
            });
            return;
          case "remove-from-cart":
            handleRawEvent("remove_from_cart", {
              product_id: productId,
              quantity: Number(el.dataset.quantity) || 1
            });
            return;
          case "purchase-btn":
            handleRawEvent("purchase_click", { product_id: productId });
            return;
        }
      }
      const inferred = inferEcommerceEvent(e.target);
      if (inferred) {
        handleRawEvent(inferred.type, inferred.data);
      }
    });
    document.addEventListener("change", (e) => {
      const el = e.target?.closest("[data-ghost-role]");
      if (!el) return;
      const role = el.dataset.ghostRole;
      const productId = el.dataset.productId || el.closest("[data-product-id]")?.dataset.productId || null;
      if (role === "option-select") {
        handleRawEvent("option_select", {
          product_id: productId,
          option_name: el.name || el.dataset.optionName || null,
          option_value: el.value
        });
        const prev = optionChangeCounts.get(el) || { count: 0, lastValue: null };
        if (prev.lastValue !== null && prev.lastValue !== el.value) {
          prev.count += 1;
          handleRawEvent("option_change", {
            product_id: productId,
            option_name: el.name || el.dataset.optionName || null,
            option_value: el.value,
            change_count: prev.count
          });
        }
        optionChangeCounts.set(el, { count: prev.count, lastValue: el.value });
      }
      if (role === "quantity-input") {
        handleRawEvent("quantity_change", {
          product_id: productId,
          quantity: Number(el.value) || 0,
          prev_quantity: Number(el.dataset.prevQuantity) || null
        });
        el.dataset.prevQuantity = el.value;
      }
    });
  }
  function _initReviewTracking(handleRawEvent) {
    const REVIEW_CONTAINER_SEL = [
      '[data-ghost-role="review-section"]',
      '[data-section="review"]',
      '[data-section="reviews"]',
      '[id*="review"]',
      '[id*="Review"]',
      '[id*="\uD6C4\uAE30"]',
      '[id*="\uB9AC\uBDF0"]',
      '[class*="review-section"]',
      '[class*="review_section"]',
      '[class*="review-list"]',
      '[class*="review_list"]',
      '[class*="review-wrap"]',
      '[class*="review_wrap"]',
      '[class*="review-area"]',
      '[class*="review_area"]',
      '[class*="\uD6C4\uAE30-wrap"]',
      '[class*="\uD6C4\uAE30_wrap"]',
      '[class*="\uB9AC\uBDF0-wrap"]',
      '[class*="\uB9AC\uBDF0_wrap"]',
      '[class*="product-review"]',
      '[class*="product_review"]',
      '[class*="user-review"]',
      '[class*="user_review"]',
      '[class*="customer-review"]'
    ].join(",");
    const REVIEW_ITEM_SEL = [
      '[data-ghost-role="review-item"]',
      '[class*="review-item"]',
      '[class*="review_item"]',
      '[class*="review-card"]',
      '[class*="review_card"]',
      '[class*="review-content"]',
      '[class*="review_content"]',
      '[class*="review-row"]',
      '[class*="review_row"]',
      '[class*="\uD6C4\uAE30-item"]',
      '[class*="\uD6C4\uAE30_item"]',
      '[class*="\uB9AC\uBDF0-item"]',
      '[class*="\uB9AC\uBDF0_item"]'
    ].join(",");
    const PAGINATION_CTX_SEL = [
      '[class*="pagination"]',
      '[class*="paging"]',
      '[role="navigation"]',
      '[aria-label*="\uD398\uC774\uC9C0"]',
      '[aria-label*="pagination"]'
    ].join(",");
    const LOAD_MORE_RE = /더\s*보기|더\s*불러오기|load\s*more|show\s*more|see\s*more/i;
    const PREV_NEXT_RE = /^(이전|다음|prev(ious)?|next|◀|▶|‹|›|«|»|←|→|<|>)$/i;
    function inReviewContainer(el) {
      return !!el?.closest?.(REVIEW_CONTAINER_SEL);
    }
    function extractRating(el) {
      const item = el?.closest?.(REVIEW_ITEM_SEL) || el?.closest?.(REVIEW_CONTAINER_SEL);
      if (!item) return null;
      const ratingEl = item.querySelector(
        '[class*="star"], [class*="rating"], [class*="score"], [aria-label*="stars"], [aria-label*="\uC810"], [data-rating]'
      );
      if (!ratingEl) return null;
      return ratingEl.dataset.rating || ratingEl.getAttribute("aria-label") || ratingEl.textContent?.trim() || null;
    }
    let _reviewInViewport = false;
    function observeReviewContainers() {
      const containers = document.querySelectorAll(REVIEW_CONTAINER_SEL);
      if (!containers.length) return;
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) _reviewInViewport = true;
          });
          if (!entries.some((e) => e.isIntersecting)) {
            _reviewInViewport = [...document.querySelectorAll(REVIEW_CONTAINER_SEL)].some(
              (el) => {
                const r = el.getBoundingClientRect();
                return r.top < window.innerHeight && r.bottom > 0;
              }
            );
          }
        },
        { threshold: [0.05] }
        // 5% 이상 보이면 활성
      );
      containers.forEach((el) => io.observe(el));
    }
    document.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!inReviewContainer(target)) return;
      const btnText = (target.textContent || "").trim();
      const isImgEl = target.tagName === "IMG" || target.tagName === "PICTURE";
      const imgWrapper = !isImgEl && target.closest(
        'figure, [class*="photo"], [class*="image"], [class*="thumb"], [class*="gallery"]'
      );
      const wrappedImg = imgWrapper?.querySelector("img");
      if (isImgEl || wrappedImg) {
        const img = isImgEl ? target : wrappedImg;
        handleRawEvent("review_image_click", {
          src: (img?.getAttribute("src") || "").slice(0, 200) || null,
          alt: (img?.getAttribute("alt") || "").slice(0, 80) || null,
          inferred: true
        });
        return;
      }
      const inPaginationCtx = !!target.closest(PAGINATION_CTX_SEL);
      const isNumericPage = /^\d+$/.test(btnText) && inPaginationCtx;
      if (inPaginationCtx || isNumericPage || LOAD_MORE_RE.test(btnText) || PREV_NEXT_RE.test(btnText)) {
        let page_number = null;
        let direction = null;
        if (/^\d+$/.test(btnText)) page_number = Number(btnText);
        else if (/이전|prev|◀|‹|«|←|</i.test(btnText)) direction = "prev";
        else if (/다음|next|▶|›|»|→|>/i.test(btnText)) direction = "next";
        else direction = "more";
        handleRawEvent("review_page_change", {
          page_number,
          direction,
          btn_text: btnText.slice(0, 20) || null,
          inferred: true
        });
        return;
      }
      const reviewItem = target.closest(REVIEW_ITEM_SEL);
      if (reviewItem) {
        handleRawEvent("review_click", {
          rating: extractRating(target),
          inferred: true
        });
      }
    });
    let _reviewScrollTimer = null;
    let _reviewScrollLastDepth = -1;
    window.addEventListener("scroll", () => {
      if (!_reviewInViewport) return;
      clearTimeout(_reviewScrollTimer);
      _reviewScrollTimer = setTimeout(() => {
        const docH = document.body.scrollHeight - window.innerHeight;
        const depth = docH > 0 ? Math.round(window.scrollY / docH * 100) : 0;
        if (Math.abs(depth - _reviewScrollLastDepth) >= 5) {
          _reviewScrollLastDepth = depth;
          handleRawEvent("review_scroll", {
            scroll_y: window.scrollY,
            depth_pct: depth,
            inferred: true
          });
        }
      }, 100);
    }, { passive: true });
    function attachAreaScrollListeners() {
      document.querySelectorAll(REVIEW_CONTAINER_SEL).forEach((el) => {
        const style = window.getComputedStyle(el);
        const isScrollable = ["auto", "scroll"].includes(style.overflow) || ["auto", "scroll"].includes(style.overflowY);
        if (!isScrollable || el.scrollHeight <= el.clientHeight + 10) return;
        let _areaTimer = null;
        let _lastScrollTop = el.scrollTop;
        el.addEventListener("scroll", () => {
          clearTimeout(_areaTimer);
          _areaTimer = setTimeout(() => {
            const scrollH = el.scrollHeight - el.clientHeight;
            const pct = scrollH > 0 ? Math.round(el.scrollTop / scrollH * 100) : 0;
            handleRawEvent("review_area_scroll", {
              scroll_top: el.scrollTop,
              depth_pct: pct,
              direction: el.scrollTop > _lastScrollTop ? "down" : "up",
              inferred: true
            });
            _lastScrollTop = el.scrollTop;
          }, 150);
        }, { passive: true });
      });
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        observeReviewContainers();
        attachAreaScrollListeners();
      });
    } else {
      observeReviewContainers();
      attachAreaScrollListeners();
    }
  }

  // index.js
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
  function _init() {
    initA();
    initB(emit);
    initC(emit);
  }
})();
