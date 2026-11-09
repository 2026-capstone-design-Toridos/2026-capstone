/* Production-only revenue opportunity UI. Every displayed metric comes from the authenticated API. */
(() => {
  const live = { payload: null, origin: "", loading: false };
  const money = (value) => value === null || value === undefined ? "—" : `${Number(value).toLocaleString("ko-KR")}원`;
  const lossMoney = (value) => value === null || value === undefined ? "가격 데이터 미연결" : `−${Number(value).toLocaleString("ko-KR")}원`;
  const empty = (message) => `<div class="empty">${escapeHtml(message)}</div>`;

  function clearOperationalInsights(message) {
    live.payload = null;
    $("ra-loss").textContent = "—";
    $("ra-loss-summary").textContent = message;
    ["ra-people", "ra-strong", "ra-price-rate", "ra-cart-count", "ra-wish-count"].forEach((id) => $(id).textContent = "—");
    $("ra-loss-top5").innerHTML = empty(message);
    $("ra-stage-list").innerHTML = empty(message);
    $("ra-reasons").innerHTML = empty(message);
    $("ra-products").innerHTML = `<tr><td colspan="7">${empty(message)}</td></tr>`;
    $("ov-information").innerHTML = empty(message);
    $("ov-observations").innerHTML = empty(message);
    $("ra-report-loss").textContent = "—";
    $("ra-report-people").textContent = "—";
    $("ra-report-strong").textContent = "—";
    $("ra-report-note").textContent = message;
    renderRecovery();
  }

  function stageText(product) {
    const parts = [];
    if (product.view) parts.push(`조회 ${fmt(product.view)}`);
    if (product.wish) parts.push(`찜 ${fmt(product.wish)}`);
    if (product.cart) parts.push(`장바구니 ${fmt(product.cart)}`);
    return parts.join(" · ") || "관심 단계 없음";
  }

  function renderTopProducts(payload) {
    const rows = (payload.products || []).slice(0, 5);
    $("ra-loss-top5").innerHTML = rows.length ? rows.map((product) => `
      <div class="ra-top5-row"><div><strong>${escapeHtml(product.name)}</strong><span>상품 ${escapeHtml(product.id)} · ${stageText(product)}</span></div><div class="ra-money">${product.amount === null ? "가격 미연결" : money(product.amount)}</div></div>`).join("") : empty("오늘 구매 없이 종료된 상품 방문이 없습니다.");
  }

  function filteredProducts() {
    const payload = live.payload;
    if (!payload) return [];
    const query = $("ra-search").value.trim().toLowerCase();
    const filter = $("ra-filter").value;
    const sort = $("ra-sort").value;
    const rows = (payload.products || []).filter((product) => {
      if (query && !`${product.name} ${product.id}`.toLowerCase().includes(query)) return false;
      if (filter === "strong" && !(product.wish + product.cart)) return false;
      if (filter === "unmatched" && product.price !== null) return false;
      return true;
    });
    rows.sort((a, b) => sort === "people" ? b.total - a.total : sort === "price" ? (b.price ?? -1) - (a.price ?? -1) : (b.amount ?? -1) - (a.amount ?? -1));
    return rows;
  }

  function renderProductTable() {
    const rows = filteredProducts();
    $("ra-products").innerHTML = rows.length ? rows.map((product) => `<tr>
      <td><b>${escapeHtml(product.name)}</b><div class="ra-note">상품 ${escapeHtml(product.id)} · ${escapeHtml(product.price_source || "가격 데이터 미연결")}</div></td>
      <td class="ra-num">${product.price === null ? "—" : money(product.price)}</td><td class="ra-num">${fmt(product.view)}</td><td class="ra-num">${fmt(product.wish)}</td><td class="ra-num">${fmt(product.cart)}</td><td class="ra-num">${fmt(product.total)}</td><td class="ra-num ra-money">${product.amount === null ? "—" : money(product.amount)}</td>
    </tr>`).join("") : `<tr><td colspan="7">${empty("조건에 맞는 실제 상품 데이터가 없습니다.")}</td></tr>`;
  }

  function renderInformation(payload) {
    const areas = payload.information || [];
    const maxEntries = Math.max(1, ...areas.map((row) => row.entries));
    $("ov-information").innerHTML = areas.some((row) => row.entries) ? areas.map((row) => `<div class="ov-info-row"><div><strong>${escapeHtml(row.label)}</strong><span>${fmt(row.visits)}개 방문에서 확인</span></div><div class="ov-info-value">${fmt(row.entries)}회</div><div class="ov-info-bar"><i style="width:${Math.round(row.entries / maxEntries * 100)}%"></i></div></div>`).join("") : empty("오늘 수집된 정보 구역 진입 이벤트가 없습니다.");
    const signals = areas.flatMap((row) => [
      row.repeated ? { label: `${row.label} 반복 확인`, count: row.repeated, detail: "같은 방문에서 해당 정보 구역을 다시 확인했습니다." } : null,
      row.ending ? { label: `${row.label} 확인 후 종료`, count: row.ending, detail: "해당 구역을 확인한 뒤 구매 완료 신호 없이 방문이 종료됐습니다." } : null,
    ]).filter(Boolean).sort((a, b) => b.count - a.count);
    $("ov-observations").innerHTML = signals.length ? signals.slice(0, 4).map((item) => `<div class="ov-info-observation"><span class="ra-badge warn">점검 신호</span><strong>${escapeHtml(item.label)} · ${fmt(item.count)}개 방문</strong><p>${escapeHtml(item.detail)} 원인으로 단정하지 않고 화면 안내를 점검하세요.</p></div>`).join("") : empty("오늘 반복 확인 또는 확인 후 종료 신호가 없습니다.");
  }

  function renderRecovery() {
    const rate = Number($("ra-rate").value || 10);
    $("ra-rate-label").textContent = `${rate}%`;
    // 조회 단계에서만 종료된 방문도 실제 판매가가 연결되어 있다면
    // 대시보드의 추정 손실에 포함된다. 시뮬레이션 역시 같은 기준을 써야
    // 손실 금액은 있는데 회복 금액만 항상 0원이 되는 모순이 생기지 않는다.
    const base = live.payload?.totals?.loss;
    $("ra-recovery").textContent = base === null || base === undefined ? "계산 불가" : money(Math.round(base * rate / 100));
    $("ra-recovery-note").textContent = base === null || base === undefined ? "구매 없이 종료된 관심 상품의 실제 판매가가 수집되어야 계산할 수 있습니다." : `실제 예측값이 아니라 추정 손실 금액 ${money(base)}에 ${rate}%를 적용한 단순 가정입니다.`;
  }

  function renderOperationalInsights(payload) {
    live.payload = payload;
    const totals = payload.totals || {};
    const products = payload.products || [];
    const cart = products.reduce((sum, product) => sum + product.cart, 0);
    const wish = products.reduce((sum, product) => sum + product.wish, 0);
    const view = products.reduce((sum, product) => sum + product.view, 0);
    const rate = totals.people ? Math.round(totals.matched / totals.people * 100) : 0;
    $("ra-loss").textContent = lossMoney(totals.loss);
    $("ra-loss-heading").textContent = totals.loss === null ? "추정 손실 금액" : `${money(totals.loss)}`;
    $("ra-loss-summary").textContent = totals.people ? `${fmt(totals.people)}개 종료 방문 중 ${fmt(totals.matched)}개는 실제 판매가와 연결됐고 ${fmt(totals.unmatched)}개는 가격 미연결로 금액에서 제외했습니다.` : "오늘 기준 구매 없이 종료된 상품 관심 방문이 없습니다.";
    $("ra-people").textContent = `${fmt(totals.people)}개`;
    $("ra-strong").textContent = `${fmt(totals.strong)}개`;
    $("ra-price-rate").textContent = totals.people ? `${rate}%` : "—";
    $("ra-cart-count").textContent = `${fmt(cart)}개`;
    $("ra-wish-count").textContent = `${fmt(wish)}개`;
    $("ra-loss-caution").textContent = payload.truncated ? "조회 한도를 초과해 합계 금액을 표시하지 않습니다." : "판매가와 KRW 통화가 이벤트에 함께 수집된 상품만 금액에 포함합니다.";
    $("ra-action-advice").textContent = cart ? "장바구니까지 간 방문이 있습니다. 배송비·도착 예정일·최종 결제 금액을 먼저 점검하세요." : wish ? "찜한 뒤 종료된 방문이 있습니다. 관심 상품 재진입과 재고·혜택 안내를 점검하세요." : view ? "상품 조회 후 종료가 많습니다. 후기·사이즈·배송 정보를 구매 버튼 가까이에서 찾기 쉬운지 점검하세요." : "오늘 분석할 상품 관심 행동이 아직 없습니다.";
    $("ra-stage-list").innerHTML = [["조회 후 종료", view], ["찜 후 종료", wish], ["장바구니 후 종료", cart]].map(([label, count]) => `<div class="ra-stage"><span>${label}</span><strong>${fmt(count)}개 방문</strong><p>대표 관심 단계 기준</p></div>`).join("");
    $("ra-formula").textContent = totals.loss === null ? "판매가가 수집된 상품이 없어 금액을 계산하지 않았습니다. 방문 수 자체는 실제 행동 기준으로 표시합니다." : `상품별 실제 판매가 × 구매 없이 종료된 대표 관심 방문 = ${money(totals.loss)}. 가격 미연결 방문은 합계에서 제외했습니다.`;
    $("ra-reasons").innerHTML = (payload.notes || []).map((note) => `<div class="ra-reason-row">${escapeHtml(note)}</div>`).join("");
    $("loss-updated").textContent = `마지막 집계 ${new Date(payload.generated_at).toLocaleTimeString("ko-KR")}`;
    $("ra-products-note").textContent = `${fmt(totals.people)}개 종료 방문을 대표 관심 상품 1개 기준으로 집계했습니다. 가격 미연결 ${fmt(totals.unmatched)}개 방문은 금액에서 제외했습니다.`;
    $("ra-report-loss").textContent = lossMoney(totals.loss);
    $("ra-report-people").textContent = `${fmt(totals.people)}개`;
    $("ra-report-strong").textContent = money(totals.strong_money);
    $("ra-report-note").textContent = totals.people ? `오늘 실제 수집값 기준이며, ${fmt(totals.unmatched)}개 가격 미연결 방문은 금액에서 제외했습니다.` : "오늘 구매 없이 종료된 상품 관심 방문이 없습니다.";
    $("ra-csv").disabled = !products.length;
    renderTopProducts(payload);
    renderProductTable();
    renderInformation(payload);
    renderRecovery();
  }

  async function loadOperationalInsights(force = false) {
    const origin = state.origin;
    if (!origin) { clearOperationalInsights("분석할 쇼핑몰을 선택해주세요."); return; }
    if (live.loading || (!force && live.origin === origin && live.payload)) return;
    live.loading = true;
    const requestedOrigin = origin;
    try {
      const payload = await api(`/api/logs/operator-insights?origin=${encodeURIComponent(origin)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (state.origin !== requestedOrigin) return;
      live.origin = origin;
      renderOperationalInsights(payload);
    } catch (error) {
      if (state.origin === requestedOrigin) clearOperationalInsights(`운영 지표를 불러오지 못했습니다: ${error.message}`);
    } finally { live.loading = false; }
  }

  window.loadSelectedProductInsights = async (sessionId) => {
    const requested = sessionId;
    $("ra-customer-detail").innerHTML = empty("선택 고객의 상품 행동을 불러오는 중입니다.");
    try {
      const payload = await api(`/api/logs/operator-insights?origin=${encodeURIComponent(state.origin)}&session_id=${encodeURIComponent(sessionId)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (state.selectedSessionId !== requested) return;
      const products = payload.selection?.products || [];
      $("ra-customer-detail").innerHTML = products.length ? `<div class="ra-customer-list">${products.map((product) => `<div class="ra-customer-item"><div><b>${escapeHtml(product.name)}</b><div class="ra-note">상품 ${escapeHtml(product.id)} · ${product.stage === "cart" ? "장바구니" : product.stage === "wish" ? "찜" : "조회"}</div></div><div>${product.price === null ? "가격 미연결" : money(product.price)}</div></div>`).join("")}</div>` : empty("이 방문에서 상품 ID와 연결된 행동이 수집되지 않았습니다.");
    } catch (error) {
      if (state.selectedSessionId === requested) $("ra-customer-detail").innerHTML = empty(`상품 행동을 불러오지 못했습니다: ${error.message}`);
    }
  };

  function exportCsv() {
    const rows = filteredProducts();
    if (!rows.length) return;
    const csv = [["상품ID","상품명","판매가","조회 후 종료","찜 후 종료","장바구니 후 종료","미구매 방문","추정 금액"], ...rows.map((p) => [p.id,p.name,p.price ?? "",p.view,p.wish,p.cart,p.total,p.amount ?? ""])].map((row) => row.map((cell) => `"${String(cell).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `seer-product-opportunities-${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  $("ra-rate").addEventListener("input", renderRecovery);
  ["ra-search", "ra-filter", "ra-sort"].forEach((id) => $(id).addEventListener(id === "ra-search" ? "input" : "change", renderProductTable));
  $("ra-csv").addEventListener("click", exportCsv);
  $("ra-print").addEventListener("click", () => window.print());
  $("site-filter").addEventListener("change", () => { live.origin = ""; clearOperationalInsights("새 사이트의 실제 데이터를 불러오는 중입니다."); setTimeout(() => loadOperationalInsights(true), 0); });
  setTimeout(() => loadOperationalInsights(true), 500);
  setInterval(() => loadOperationalInsights(true), 60000);
})();
