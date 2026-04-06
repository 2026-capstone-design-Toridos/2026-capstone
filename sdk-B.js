// sdk-B.js
// 역할:
// - 클릭 / 입력 / 포커스 / 붙여넣기 / 탭 이탈·복귀 / hover dwell
// - raw 이벤트만 감지해서 handleRawEvent(eventType, data)로 전달
// - session_id, seq, timestamp, 파생 이벤트 생성은 A가 담당

let isInitialized = false;

const state = {
  clickCount: 0,
  tabExitCount: 0,
  hoverStartMap: new WeakMap(),
  fieldFocusCountMap: new WeakMap(),
  tabHiddenAt: null,
};

export function initB(handleRawEvent) {
  if (isInitialized) return;
  if (typeof handleRawEvent !== "function") {
    throw new Error("initB requires handleRawEvent function");
  }

  isInitialized = true;

  trackClicks(handleRawEvent);
  trackInputs(handleRawEvent);
  trackFocusAndBlur(handleRawEvent);
  trackPaste(handleRawEvent);
  trackTabVisibility(handleRawEvent);
  trackHoverDwell(handleRawEvent);

  console.log("[GhostTracker] sdk-B initialized");
}

/* =========================
   공통 유틸
========================= */

function isFormElement(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function getTrackableTarget(element) {
  if (!(element instanceof Element)) return null;

  return (
    element.closest(
      [
        "[data-ghost-role]",
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "label",
        "[role='button']",
      ].join(",")
    ) || element
  );
}

function getElementLabel(element) {
  if (!(element instanceof Element)) return "unknown";

  const tag = element.tagName ? element.tagName.toLowerCase() : "unknown";
  const id = element.id ? `#${element.id}` : "";

  let className = "";
  if (typeof element.className === "string" && element.className.trim()) {
    className =
      "." + element.className.trim().split(/\s+/).slice(0, 3).join(".");
  }

  return `${tag}${id}${className}`;
}

function getElementText(element, maxLength = 80) {
  if (!element) return "";

  const raw =
    typeof element.innerText === "string"
      ? element.innerText
      : typeof element.value === "string"
      ? element.value
      : "";

  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function getFormValueLength(target) {
  if (!isFormElement(target)) return 0;
  if (typeof target.value !== "string") return 0;
  return target.value.length;
}

function getFormMeta(target) {
  if (!isFormElement(target)) {
    return {
      input_target: "unknown",
      input_name: null,
      input_type: null,
      ghost_role: null,
    };
  }

  return {
    input_target: getElementLabel(target),
    input_name: target.name || null,
    input_type: target.type || target.tagName.toLowerCase(),
    ghost_role: target.dataset?.ghostRole || null,
  };
}

/* =========================
   클릭
========================= */

function trackClicks(handleRawEvent) {
  document.addEventListener("click", (e) => {
    const target = getTrackableTarget(e.target);

    state.clickCount += 1;

    handleRawEvent("click", {
      click_count: state.clickCount,
      click_target: getElementLabel(target),
      click_text: getElementText(target, 100),
      click_position: {
        x: e.clientX,
        y: e.clientY,
      },
      tag_name: target?.tagName?.toLowerCase() || null,
      ghost_role: target?.dataset?.ghostRole || null,
    });
  });
}

/* =========================
   입력
========================= */

function trackInputs(handleRawEvent) {
  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!isFormElement(target)) return;

    handleRawEvent("input_change", {
      ...getFormMeta(target),
      input_length: getFormValueLength(target),
    });
  });
}

/* =========================
   포커스 / 블러
========================= */

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
        field_refocus_count: Math.max(0, nextCount - 1),
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
        input_length: valueLength,
      });

      if (valueLength === 0) {
        handleRawEvent("input_abandon", {
          ...getFormMeta(target),
        });
      }
    },
    true
  );
}

/* =========================
   붙여넣기
========================= */

function trackPaste(handleRawEvent) {
  document.addEventListener("paste", (e) => {
    const target = e.target;
    if (!isFormElement(target)) return;

    handleRawEvent("paste_event", {
      ...getFormMeta(target),
    });
  });
}

/* =========================
   탭 이탈 / 복귀
========================= */

function trackTabVisibility(handleRawEvent) {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      state.tabHiddenAt = Date.now();
      state.tabExitCount += 1;

      handleRawEvent("tab_exit", {
        tab_exit_count: state.tabExitCount,
      });
      return;
    }

    const duration =
      typeof state.tabHiddenAt === "number"
        ? Date.now() - state.tabHiddenAt
        : null;

    handleRawEvent("tab_return", {
      tab_exit_duration_ms: duration,
    });

    state.tabHiddenAt = null;
  });
}

/* =========================
   Hover dwell
========================= */

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

      // 너무 짧은 hover는 노이즈로 간주
      if (dwellTime < 300) return;

      handleRawEvent("hover_dwell", {
        hover_target: getElementLabel(target),
        hover_text: getElementText(target, 100),
        hover_dwell_time_ms: dwellTime,
        ghost_role: target.dataset?.ghostRole || null,
      });
    },
    true
  );
}

/* index에서의 방식
import { initA, handleRawEvent } from "./sdk-A.js";
import { initB } from "./sdk-B.js";
import { initC } from "./sdk-C.js";

function init(config = {}) {
  initA(config);
  initB(handleRawEvent);
  initC(handleRawEvent);
}

window.GhostTracker = {
  init,
};
 */

/* a에서 받는 예시
// sdk-A.js
import { getSessionId } from "./core/sessionManager.js";
import { processEvent } from "./core/eventProcessor.js";
import { sendEvent } from "./core/sender.js";

let seq = 0;

export function initA(config = {}) {
  console.log("[GhostTracker] A initialized", config);
}

export function handleRawEvent(eventType, data) {
  const rawEvent = {
    session_id: getSessionId(),
    event_type: eventType,
    timestamp: Date.now(),
    seq: ++seq,
    data,
  };

  const processed = processEvent(rawEvent);

  if (Array.isArray(processed)) {
    processed.forEach(sendEvent);
  } else {
    sendEvent(processed);
  }
}
*/