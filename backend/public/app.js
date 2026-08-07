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
