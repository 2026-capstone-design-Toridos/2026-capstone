const page = document.body.dataset.page || "";
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
