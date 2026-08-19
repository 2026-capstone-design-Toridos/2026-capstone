const page = document.body.dataset.page || "";
const fileName = window.location.pathname.split("/").pop() || "";
const isDemoPage = fileName.startsWith("demo-") && fileName.endsWith(".html");

if (isDemoPage) {
  document.body.classList.add("demo-page");
  document.title = `데모 | ${document.title}`;

  const main = document.querySelector(".app-main, .public-main");
  if (main) {
    const banner = document.createElement("div");
    banner.className = "demo-banner";
    banner.innerHTML = "<strong>목업 데이터로 보는 데모 화면입니다.</strong><span>실제 쇼핑몰 데이터가 아니며, 화면 구성과 사용자 흐름을 확인하기 위한 예시입니다.</span>";
    main.prepend(banner);
  }

  document.querySelectorAll(".live").forEach((status) => {
    status.classList.add("demo-status");
    status.textContent = "목업 데이터";
  });

  document.querySelectorAll('a[href^="/api/"]').forEach((link) => {
    link.removeAttribute("href");
    link.setAttribute("role", "button");
    link.addEventListener("click", () => {
      window.alert("데모 화면에서는 실제 데이터나 파일을 요청하지 않습니다.");
    });
  });
}

document.querySelectorAll("[data-nav]").forEach((link) => {
  if (link.dataset.nav === page) link.classList.add("active");
});
document.querySelectorAll("[data-menu]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(button.dataset.menu);
    if (target) target.classList.toggle("open");
  });
});
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.querySelector(button.dataset.copy);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      const original = button.textContent;
      button.textContent = "복사했어요";
      setTimeout(() => { button.textContent = original; }, 1500);
    } catch { button.textContent = "직접 복사해주세요"; }
  });
});
document.querySelectorAll("[data-demo-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const message = button.dataset.demoAction;
    if (message) window.alert(message);
  });
});

if (page === "guide" && document.querySelector(".guide-card")) {
  const steps = [
    { title: "디자인 메뉴를 선택하세요", description: "왼쪽 메뉴에서 <b>디자인(PC/모바일)</b>을 클릭하면 디자인 보관함으로 이동할 수 있어요.", action: "디자인 메뉴 클릭" },
    { title: "사용 중인 디자인을 편집하세요", description: "대표 디자인 행의 <b>디자인 편집</b> 버튼을 누르세요. 실제 쇼핑몰 화면의 HTML을 수정하는 편집기가 열립니다.", action: "디자인 편집 클릭" },
    { title: "공통 레이아웃 파일을 여세요", description: "파일 목록에서 <b>쇼핑몰 메인 (layout.html)</b>을 선택하세요. 모든 쇼핑몰 페이지에 공통으로 적용되는 파일입니다.", action: "layout.html 열기" },
    { title: "추적 코드를 붙여넣으세요", description: "코드를 복사해 <b>&lt;/body&gt; 바로 윗줄</b>에 붙여넣으세요. 그러면 GhostTracker가 고객 행동을 수집할 수 있습니다.", action: "코드 삽입" },
    { title: "모두저장하면 설치 완료!", description: "오른쪽 위 <b>모두저장</b> 버튼을 누르면 변경 사항이 쇼핑몰에 반영됩니다. 이제 GhostTracker에서 수집 상태를 확인하세요.", action: "모두저장" }
  ];
  let current = 0;
  const card = document.querySelector(".guide-card");
  const dim = document.querySelector(".guide-dim");
  const title = document.querySelector("#guide-title");
  const description = document.querySelector("#guide-description");
  const count = document.querySelector("#guide-count");
  const bar = document.querySelector("#guide-bar");
  const prev = document.querySelector("#guide-prev");
  const next = document.querySelector("#guide-next");
  const code = document.querySelector("#guide-code");
  const admin = document.querySelector("#admin-view");
  const editor = document.querySelector("#editor-view");

  function positionCard(target) {
    if (window.innerWidth <= 800) return;
    const rect = target.getBoundingClientRect();
    const width = card.offsetWidth || 410;
    let left = rect.right + 28;
    if (left + width > window.innerWidth - 18) left = Math.max(18, rect.left - width - 28);
    let top = Math.max(18, Math.min(rect.top - 12, window.innerHeight - card.offsetHeight - 18));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function showStep(index) {
    current = Math.max(0, Math.min(steps.length - 1, index));
    const inEditor = current >= 2;
    admin.hidden = inEditor;
    editor.hidden = !inEditor;
    document.querySelector("#design-submenu").classList.toggle("open", current === 1);
    document.querySelectorAll(".guide-focus").forEach((el) => el.classList.remove("guide-focus"));
    const target = document.querySelector(`[data-guide-target="${current}"]`);
    target.classList.add("guide-focus");
    target.scrollIntoView({ block: "center", inline: "center" });
    title.textContent = steps[current].title;
    description.innerHTML = steps[current].description;
    count.textContent = `${current + 1} / ${steps.length}`;
    bar.style.width = `${((current + 1) / steps.length) * 100}%`;
    prev.disabled = current === 0;
    next.textContent = current === steps.length - 1 ? "설치 완료" : steps[current].action;
    code.hidden = current !== 3;
    code.style.display = current === 3 ? "flex" : "none";
    // 코드 삽입 단계부터 실제 편집 결과가 </body> 바로 위에 보이게 한다.
    document.querySelector("#inserted-code").hidden = current < 3;
    requestAnimationFrame(() => positionCard(target));
  }

  function finishGuide() {
    document.body.classList.add("guide-finished");
    document.querySelectorAll(".guide-focus").forEach((el) => el.classList.remove("guide-focus"));
    document.querySelector("#guide-restart").hidden = false;
  }

  next.addEventListener("click", () => current === steps.length - 1 ? finishGuide() : showStep(current + 1));
  prev.addEventListener("click", () => showStep(current - 1));
  document.querySelector("#guide-close").addEventListener("click", finishGuide);
  dim.addEventListener("click", finishGuide);
  document.querySelector("#guide-restart").addEventListener("click", () => {
    document.body.classList.remove("guide-finished");
    document.querySelector("#guide-restart").hidden = true;
    showStep(0);
  });
  document.querySelectorAll("[data-guide-target]").forEach((target) => target.addEventListener("click", () => {
    if (Number(target.dataset.guideTarget) === current) next.click();
  }));
  document.querySelector("#guide-copy").addEventListener("click", async (event) => {
    const value = document.querySelector("#guide-code code").textContent;
    try { await navigator.clipboard.writeText(value); event.currentTarget.textContent = "복사됨"; }
    catch { event.currentTarget.textContent = "선택 후 복사"; }
  });
  window.addEventListener("resize", () => {
    const target = document.querySelector(`[data-guide-target="${current}"]`);
    if (target) positionCard(target);
  });
  showStep(0);
}
