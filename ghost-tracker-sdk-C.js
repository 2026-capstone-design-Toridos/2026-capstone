(function () {
  "use strict";

  function send(eventType, payload) {
    console.log("[C]", eventType, payload); // 👉 A 없이 테스트용
  }

  // -----------------------------
  // 🔹 SCROLL TRACKING
  // -----------------------------
  let ticking = false;
  let lastDepth = -1;

  let lastY = 0;
  let lastDirection = null;

  let lastTime = Date.now();
  let scrollTimeout;
  let isFirstScroll = true;

  const milestones = [25, 50, 75, 100];
  const reached = new Set();

  function getScrollDepth() {
    const scrollTop = window.scrollY;
    const docHeight = document.body.scrollHeight - window.innerHeight;

    if (docHeight < 100) return 0; // ⭐ 보정

    return Math.round((scrollTop / docHeight) * 100);
  }

  function detectDirection() {
    const currentY = window.scrollY;
    const direction = currentY > lastY ? "down" : "up";

    if (lastDirection && direction !== lastDirection) {
      send("scroll_direction_change", {
        from: lastDirection,
        to: direction
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

      send("scroll_speed", {
        speed: Number(speed.toFixed(3))
      });
    }

    lastTime = now;
  }

  function handleScroll() {
    const depth = getScrollDepth();

    // ⭐ 초기 상태 무시
    if (isFirstScroll) {
      isFirstScroll = false;
      lastDepth = depth;
      return;
    }

    if (Math.abs(depth - lastDepth) >= 5) {
      lastDepth = depth;

      send("scroll_depth", {
        depth_pct: depth
      });
    }

    milestones.forEach((m) => {
      if (depth >= m && !reached.has(m)) {
        reached.add(m);

        send("scroll_milestone", {
          milestone: m
        });
      }
    });

    detectDirection();
    detectSpeed();
  }

  window.addEventListener("scroll", () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        handleScroll();
        ticking = false;
      });
      ticking = true;
    }

    // ⭐ scroll stop
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      send("scroll_stop", {
        position: window.scrollY
      });
    }, 300);
  });

  // -----------------------------
  // 🔹 SECTION TRACKING (독립)
  // -----------------------------
  const activeSections = new Set();
  const visitCount = {};
  let lastSection = null;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const id = entry.target.dataset.section;
      if (!id) return;

      // ENTER
      if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
        if (!activeSections.has(id)) {
          activeSections.add(id);

          send("section_enter", { section: id });

          // ⭐ revisit
          visitCount[id] = (visitCount[id] || 0) + 1;

          if (visitCount[id] > 1) {
            send("section_revisit", {
              section: id,
              count: visitCount[id]
            });
          }

          // ⭐ transition
          if (lastSection && lastSection !== id) {
            send("section_transition", {
              from: lastSection,
              to: id
            });
          }

          lastSection = id;
        }
      }

      // EXIT
      else if (!entry.isIntersecting) {
        if (activeSections.has(id)) {
          activeSections.delete(id);

          send("section_exit", { section: id });
        }
      }
    });
  }, { threshold: [0.3] });

  function initObserver() {
    document.querySelectorAll("[data-section]").forEach((el) => {
      observer.observe(el);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initObserver);
  } else {
    initObserver();
  }

})();