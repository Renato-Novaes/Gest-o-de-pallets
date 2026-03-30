/* ═══════════════════════════════════════════════════════════
   Gestão de Pallets — Frontend (app.js)
   ═══════════════════════════════════════════════════════════ */

/* ── State ───────────────────────────────────────────────── */
let authToken = sessionStorage.getItem("authToken") || null;
let isAdmin = false;
let isOperator = false;
let data = { entries: [], shipments: [], freightByRegion: {} };
let ufChart, freightChart;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ── Init ────────────────────────────────────────────────── */
(async () => {
  setToday();
  bindNav();
  bindAuth();
  bindForms();
  bindFilters();
  await checkAuth();
  await fetchData();
  connectSSE();
})();

/* ── Real-time updates (SSE) ─────────────────────────────── */
function connectSSE() {
  const evtSource = new EventSource("/api/events");
  evtSource.onmessage = async (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "update") {
        await fetchData();
      }
    } catch {}
  };
  evtSource.onerror = () => {
    evtSource.close();
    setTimeout(connectSSE, 5000);
  };
}

/* ── Navigation ──────────────────────────────────────────── */
function bindNav() {
  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      $$(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $$(".page").forEach((p) => p.classList.remove("active"));
      $(`#page-${page}`).classList.add("active");
      // Close sidebar on mobile
      $("#sidebar").classList.remove("open");
    });
  });

  const menuBtn = $("#btn-menu");
  if (menuBtn) menuBtn.addEventListener("click", () => $("#sidebar").classList.toggle("open"));
}

function setToday() {
  const now = new Date();
  const formatted = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const badge = $("#today-badge");
  if (badge) badge.textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);

  const entryDate = $("#entry-date");
  const shipDate = $("#ship-date");
  const fcDate = $("#fc-previsao");
  if (entryDate) entryDate.valueAsDate = now;
  if (shipDate) shipDate.valueAsDate = now;
  if (fcDate) fcDate.valueAsDate = now;
}

/* ── Auth ─────────────────────────────────────────────────── */
function bindAuth() {
  $("#btn-show-login").addEventListener("click", openLogin);
  $("#btn-cancel-login").addEventListener("click", closeLogin);
  $("#login-overlay").addEventListener("click", (e) => { if (e.target === $("#login-overlay")) closeLogin(); });
  $("#login-form").addEventListener("submit", handleLogin);
}

function openLogin() {
  $("#login-overlay").classList.remove("hidden");
  $("#login-user").focus();
}

function closeLogin() {
  $("#login-overlay").classList.add("hidden");
  $("#login-error").classList.add("hidden");
  $("#login-form").reset();
}

async function handleLogin(e) {
  e.preventDefault();
  $("#login-error").classList.add("hidden");
  const res = await api("POST", "/api/login", { user: $("#login-user").value, pass: $("#login-pass").value });
  if (res.token) {
    authToken = res.token;
    sessionStorage.setItem("authToken", authToken);
    isAdmin = res.role === "admin";
    isOperator = res.role === "operator";
    closeLogin();
    applyRole();
    await fetchData();
  } else {
    $("#login-error").classList.remove("hidden");
  }
}

async function handleLogout() {
  await api("POST", "/api/logout");
  authToken = null;
  isAdmin = false;
  isOperator = false;
  sessionStorage.removeItem("authToken");
  applyRole();
}

async function checkAuth() {
  if (!authToken) { isAdmin = false; isOperator = false; applyRole(); return; }
  const res = await api("GET", "/api/me");
  isAdmin = res.admin === true;
  isOperator = res.operator === true;
  if (!isAdmin && !isOperator) { authToken = null; sessionStorage.removeItem("authToken"); }
  applyRole();
}

function applyRole() {
  const isLogged = isAdmin || isOperator;
  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  $$(".operator-only").forEach((el) => el.classList.toggle("hidden", !isOperator));
  const notice = $("#viewer-notice");
  if (notice) notice.classList.toggle("hidden", isLogged);

  const authArea = $("#auth-area");
  if (isAdmin) {
    authArea.innerHTML = `
      <span class="admin-badge">Admin</span>
      <button class="btn-logout-side" id="btn-logout">Sair</button>
    `;
    $("#btn-logout").addEventListener("click", handleLogout);
  } else if (isOperator) {
    authArea.innerHTML = `
      <span class="operator-badge">Operador</span>
      <button class="btn-logout-side" id="btn-logout">Sair</button>
    `;
    $("#btn-logout").addEventListener("click", handleLogout);
  } else {
    authArea.innerHTML = `<button id="btn-show-login" class="btn-login">Entrar</button>`;
    $("#btn-show-login").addEventListener("click", openLogin);
  }

  // Load operators list for admin
  if (isAdmin) loadOperatorsList();
}

/* ── API ──────────────────────────────────────────────────── */
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (authToken) opts.headers["x-auth-token"] = authToken;
  if (body && !(body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (body instanceof FormData) {
    if (authToken) opts.headers["x-auth-token"] = authToken;
    opts.body = body;
  }
  try { const r = await fetch(url, opts); return await r.json(); }
  catch { return {}; }
}

/* ── Fetch ────────────────────────────────────────────────── */
async function fetchData() {
  data = await api("GET", "/api/data");
  if (!data.entries) data = { entries: [], shipments: [], stockCount: {}, freightByRegion: {} };
  if (!data.shipments) data.shipments = [];
  if (!data.stockCount) data.stockCount = {};
  if (!data.monthlyCosts) data.monthlyCosts = {};
  if (!data.forecasts) data.forecasts = [];
  populateStockForm();
  populateStockFormOp();
  populateMonthlyCostForm();
  refresh();
}

/* ── Forms ────────────────────────────────────────────────── */
function bindForms() {
  const entryType = $("#entry-type");
  const entryOp = $("#entry-operation");
  if (entryType) entryType.addEventListener("change", syncEntryFields);
  if (entryOp) entryOp.addEventListener("change", syncEntryFields);
  syncEntryFields();

  const entryForm = $("#entry-form");
  if (entryForm) entryForm.addEventListener("submit", handleAddEntry);

  const shipForm = $("#shipment-form");
  if (shipForm) shipForm.addEventListener("submit", handleAddShipment);

  const uploadSaida = $("#upload-form-saida");
  if (uploadSaida) uploadSaida.addEventListener("submit", (e) => handleUpload(e, "saida"));

  const uploadEntrada = $("#upload-form-entrada");
  if (uploadEntrada) uploadEntrada.addEventListener("submit", (e) => handleUpload(e, "entrada"));

  const stockForm = $("#stock-count-form");
  if (stockForm) stockForm.addEventListener("submit", handleStockCount);

  const btnMC = $("#btn-save-monthly-costs");
  if (btnMC) btnMC.addEventListener("click", handleSaveMonthlyCosts);

  const opForm = $("#op-form");
  if (opForm) opForm.addEventListener("submit", addOperator);

  const stockFormOp = $("#stock-count-form-op");
  if (stockFormOp) stockFormOp.addEventListener("submit", handleStockCountOp);

  const fcForm = $("#forecast-form");
  if (fcForm) fcForm.addEventListener("submit", handleAddForecast);

  const btnQr = $("#btn-generate-qr");
  if (btnQr) btnQr.addEventListener("click", handleGenerateQR);

  const btnCopy = $("#btn-copy-url");
  if (btnCopy) btnCopy.addEventListener("click", handleCopyUrl);
}

function syncEntryFields() {
  const type = ($("#entry-type") || {}).value;
  const op = $("#entry-operation");
  if (!op) return;
  if (type !== "PBR" && op.value === "retorno") op.value = "entrada";
  [...op.options].forEach((o) => { if (o.value === "retorno") o.disabled = type !== "PBR"; });
  const rf = $("#region-field");
  if (rf) rf.style.display = (type === "PBR" && op.value === "saida") ? "" : "none";
}

async function handleAddEntry(e) {
  e.preventDefault();
  const body = {
    date: $("#entry-date").value,
    type: $("#entry-type").value,
    operation: $("#entry-operation").value,
    qty: Number($("#entry-qty").value),
    region: $("#entry-region").value,
  };
  const res = await api("POST", "/api/entries", body);
  if (res.id) { $("#entry-qty").value = ""; $("#entry-operation").value = "entrada"; syncEntryFields(); await fetchData(); }
}

async function handleAddShipment(e) {
  e.preventDefault();
  const body = {
    direction: $("#ship-direction").value,
    documentoFaturamento: $("#ship-docfat").value,
    nf: $("#ship-nf").value,
    dataFaturamento: $("#ship-date").value,
    nomeMes: $("#ship-mes").value,
    codCliente: $("#ship-codcliente").value,
    nomeCliente: $("#ship-cliente").value,
    cidadeCliente: $("#ship-cidade").value,
    ufCliente: $("#ship-uf").value,
    rede: $("#ship-rede").value,
    dt: $("#ship-dt").value,
    nomeTransportador: $("#ship-transp").value,
    placa: $("#ship-placa").value,
    qtde: Number($("#ship-qty").value),
    qtdAvariados: Number($("#ship-avariados").value) || 0,
    qtdDescarte: Number($("#ship-descarte").value) || 0,
    nRomaneio: $("#ship-romaneio").value,
    type: $("#ship-type").value,
  };
  const res = await api("POST", "/api/shipments", body);
  if (res.id) {
    $("#shipment-form").reset();
    setToday();
    await fetchData();
  }
}

async function handleUpload(e, direction) {
  e.preventDefault();
  const suffix = direction === "entrada" ? "entrada" : "saida";
  const file = $(`#upload-file-${suffix}`).files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("type", $(`#upload-type-${suffix}`).value);
  fd.append("direction", direction);
  const res = await api("POST", "/api/shipments/upload", fd);
  const resultEl = $(`#upload-result-${suffix}`);
  if (res.imported !== undefined) {
    resultEl.textContent = `\u2705 ${res.imported} remessas de ${direction} importadas com sucesso (total: ${res.total}).`;
    $(`#upload-file-${suffix}`).value = "";
    await fetchData();
  } else {
    resultEl.textContent = `❌ Erro: ${res.error || "Falha na importação"}`;
  }
}

async function handleStockCount(e) {
  e.preventDefault();
  const body = {
    PBR: Number($("#stock-pbr").value) || 0,
    CHEP: Number($("#stock-chep").value) || 0,
    FUMIGADO: Number($("#stock-fumigado").value) || 0,
    QUEBRADOS: Number($("#stock-quebrados").value) || 0,
    REFORMADOS: Number($("#stock-reformados").value) || 0,
    TRIAR_PBR: Number($("#stock-triar-pbr").value) || 0,
    TRIAR_FUMIGADO: Number($("#stock-triar-fumigado").value) || 0,
  };
  const res = await api("PUT", "/api/stockcount", body);
  const resultEl = $("#stock-count-result");
  if (res.PBR !== undefined) {
    resultEl.textContent = "✅ Contagem de estoque salva com sucesso!";
    await fetchData();
  } else {
    resultEl.textContent = "❌ Erro ao salvar contagem.";
  }
}

function populateStockForm() {
  const sc = data.stockCount || {};
  const pbr = $("#stock-pbr");
  if (pbr) pbr.value = sc.PBR || 0;
  const chep = $("#stock-chep");
  if (chep) chep.value = sc.CHEP || 0;
  const fum = $("#stock-fumigado");
  if (fum) fum.value = sc.FUMIGADO || 0;
  const queb = $("#stock-quebrados");
  if (queb) queb.value = sc.QUEBRADOS || 0;
  const ref = $("#stock-reformados");
  if (ref) ref.value = sc.REFORMADOS || 0;
  const triPbr = $("#stock-triar-pbr");
  if (triPbr) triPbr.value = sc.TRIAR_PBR || 0;
  const triFum = $("#stock-triar-fumigado");
  if (triFum) triFum.value = sc.TRIAR_FUMIGADO || 0;
}

const MONTHS_LIST = [
  { key: "01", name: "Janeiro" }, { key: "02", name: "Fevereiro" }, { key: "03", name: "Março" },
  { key: "04", name: "Abril" }, { key: "05", name: "Maio" }, { key: "06", name: "Junho" },
  { key: "07", name: "Julho" }, { key: "08", name: "Agosto" }, { key: "09", name: "Setembro" },
  { key: "10", name: "Outubro" }, { key: "11", name: "Novembro" }, { key: "12", name: "Dezembro" },
];

const BP_MENSAL = 1036178.17;

function parseBR(str) {
  if (typeof str === "number") return str;
  // "1.206.909,09" → 1206909.09
  return Number(String(str).replace(/\./g, "").replace(",", ".")) || 0;
}

function populateMonthlyCostForm() {
  const body = $("#monthly-cost-form-body");
  if (!body) return;
  body.innerHTML = "";
  const mc = data.monthlyCosts || {};
  MONTHS_LIST.forEach(({ key, name }) => {
    const vals = mc[key] || { realizado: 0 };
    const displayVal = vals.realizado > 0 ? fmtNum(vals.realizado) : "0";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${name}</td>
      <td><input type="text" inputmode="decimal" placeholder="1.206.909,09" value="${displayVal}" data-month="${key}" data-field="realizado" /></td>
      <td class="text-right" style="padding:8px 12px;font-weight:600">${fmtNum(BP_MENSAL)}</td>
    `;
    body.appendChild(tr);
  });
}

async function handleSaveMonthlyCosts() {
  const body = {};
  $$("#monthly-cost-form-body input").forEach((inp) => {
    const month = inp.dataset.month;
    if (!body[month]) body[month] = {};
    body[month].realizado = parseBR(inp.value);
    body[month].bp = BP_MENSAL;
  });
  const res = await api("PUT", "/api/monthlycosts", body);
  const resultEl = $("#monthly-cost-result");
  if (res && typeof res === "object" && !res.error) {
    resultEl.textContent = "✅ Custos mensais salvos com sucesso!";
    await fetchData();
  } else {
    resultEl.textContent = "❌ Erro ao salvar custos mensais.";
  }
}

/* ── Delete helpers ──────────────────────────────────────── */
window.deleteEntry = async function (id) {
  if (!confirm("Excluir este lançamento?")) return;
  await api("DELETE", `/api/entries/${id}`);
  await fetchData();
};

window.deleteShipment = async function (id) {
  if (!confirm("Excluir esta remessa?")) return;
  await api("DELETE", `/api/shipments/${id}`);
  await fetchData();
};

window.showDuplicates = function () {
  if (!lastMetrics || !lastMetrics.base.duplicatesList.length) return;
  const dups = lastMetrics.base.duplicatesList;
  const lines = dups.slice(0, 50).map((s) =>
    `NF: ${s.nf} | ${s.direction === "entrada" ? "Entrada" : "Saída"} | ${s.nomeCliente} | ${s.dataFaturamento} | Qtde: ${s.qtde}`
  ).join("\n");
  const extra = dups.length > 50 ? `\n... e mais ${dups.length - 50} duplicata(s)` : "";
  alert(`Remessas com NF duplicada (${dups.length}):\n\n${lines}${extra}`);
};

/* ── Filters ─────────────────────────────────────────────── */
function bindFilters() {
  ["ship-filter-dir", "ship-filter-type", "ship-filter-uf", "ship-filter-mes", "ship-filter-search"].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("input", renderShipments);
  });
}

/* ── Refresh all ─────────────────────────────────────────── */
let lastMetrics = null;

function refresh() {
  const m = calcMetrics();
  lastMetrics = m;

  // KPIs (manual stock count)
  const sc = data.stockCount || {};
  $("#kpi-pbr-stock").textContent = fmtInt(sc.PBR);
  $("#kpi-chep-stock").textContent = fmtInt(sc.CHEP);
  $("#kpi-fumigado-stock").textContent = fmtInt(sc.FUMIGADO);
  $("#kpi-quebrados-stock").textContent = fmtInt(sc.QUEBRADOS);
  $("#kpi-reformados-stock").textContent = fmtInt(sc.REFORMADOS);
  // KPI: Triar PBR / Fumigado sub-fields
  $("#kpi-pbr-triar").textContent = fmtInt(sc.TRIAR_PBR);
  $("#kpi-fum-triar").textContent = fmtInt(sc.TRIAR_FUMIGADO);

  // KPI: sum of realizado for the year
  const mc = data.monthlyCosts || {};
  const totalRealizado = Object.values(mc).reduce((s, v) => s + (v.realizado || 0), 0);

  // Return by month table + cost year table
  renderReturnByMonth(m);
  renderCostYear();

  // Costs page
  $("#cost-pbr-out").textContent = fmtInt(m.pbr.outMonth);
  $("#cost-freight-total").textContent = fmtCur(m.pbr.freightCost);
  const avg = m.pbr.outMonth > 0 ? m.pbr.freightCost / m.pbr.outMonth : 0;
  $("#cost-avg").textContent = fmtCur(avg);

  renderFreight();
  renderHistory();
  renderShipments();
  renderCharts(m);
}

/* ── Metrics ─────────────────────────────────────────────── */
function calcMetrics() {
  const stock = { PBR: 0, CHEP: 0, FUMIGADO: 0 };
  const now = new Date();
  const cm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let outMonth = 0, returnMonth = 0, freightCost = 0;
  const freightByRegionMonth = {};

  (data.entries || []).forEach((e) => {
    const isCm = e.date.startsWith(cm);
    if (e.operation === "entrada" || e.operation === "retorno") stock[e.type] += e.qty;
    if (e.operation === "saida") stock[e.type] -= e.qty;
    if (e.type === "PBR" && isCm) {
      if (e.operation === "saida") {
        outMonth += e.qty;
        const cost = e.qty * (data.freightByRegion[e.region] || 0);
        freightCost += cost;
        freightByRegionMonth[e.region] = (freightByRegionMonth[e.region] || 0) + cost;
      }
      if (e.operation === "retorno") returnMonth += e.qty;
    }
  });

  const shipmentsMonth = (data.shipments || []).filter((s) => (s.dataFaturamento || "").startsWith(cm)).length;

  // Base saída vs entrada by month (from imported spreadsheets)
  // Detect duplicates: same NF + direction (NF must be non-empty)
  const monthOrder = ["JANEIRO","FEVEREIRO","MARÇO","ABRIL","MAIO","JUNHO","JULHO","AGOSTO","SETEMBRO","OUTUBRO","NOVEMBRO","DEZEMBRO"];
  const seenKeys = new Map(); // key -> first shipment id
  const duplicateIds = new Set();
  const duplicatesList = [];
  (data.shipments || []).forEach((s) => {
    const nf = (s.nf || "").trim();
    if (nf) {
      const key = `${nf}|${s.direction}`;
      if (seenKeys.has(key)) {
        duplicateIds.add(s.id);
        duplicatesList.push(s);
      } else {
        seenKeys.set(key, s.id);
      }
    }
  });

  const byMonth = {};
  let saidaTotal = 0, entradaTotal = 0;
  (data.shipments || []).forEach((s) => {
    const mes = (s.nomeMes || "SEM MÊS").toUpperCase().trim();
    const q = s.qtde || 0;
    if (!byMonth[mes]) byMonth[mes] = { saida: 0, entrada: 0 };
    if (s.direction === "entrada") { byMonth[mes].entrada += q; entradaTotal += q; }
    else { byMonth[mes].saida += q; saidaTotal += q; }
  });
  const returnPct = saidaTotal > 0 ? entradaTotal / saidaTotal : 0;
  // Sort months
  const sortedMonths = Object.keys(byMonth).sort((a, b) => {
    const ia = monthOrder.indexOf(a), ib = monthOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const returnByMonth = sortedMonths.map((mes) => {
    const d = byMonth[mes];
    return { mes, saida: d.saida, entrada: d.entrada, pct: d.saida > 0 ? d.entrada / d.saida : 0 };
  });

  // UF aggregation for chart (saida vs entrada), global + by month
  const ufSaida = {};
  const ufEntrada = {};
  const ufByMonth = {}; // { MES: { saida: {UF: n}, entrada: {UF: n} } }
  const ufMonths = new Set();
  (data.shipments || []).forEach((s) => {
    const uf = s.ufCliente || "?";
    const mes = (s.nomeMes || "SEM MÊS").toUpperCase().trim();
    ufMonths.add(mes);
    if (!ufByMonth[mes]) ufByMonth[mes] = { saida: {}, entrada: {} };
    if (s.direction === "entrada") {
      ufEntrada[uf] = (ufEntrada[uf] || 0) + (s.qtde || 0);
      ufByMonth[mes].entrada[uf] = (ufByMonth[mes].entrada[uf] || 0) + (s.qtde || 0);
    } else {
      ufSaida[uf] = (ufSaida[uf] || 0) + (s.qtde || 0);
      ufByMonth[mes].saida[uf] = (ufByMonth[mes].saida[uf] || 0) + (s.qtde || 0);
    }
  });
  const ufAllKeys = [...new Set([...Object.keys(ufSaida), ...Object.keys(ufEntrada)])];

  return {
    stock,
    base: { saidaTotal, entradaTotal, returnPct, returnByMonth, duplicatesList, duplicateCount: duplicateIds.size },
    pbr: {
      outMonth, returnMonth,
      pending: Math.max(outMonth - returnMonth, 0),
      returnRate: outMonth > 0 ? returnMonth / outMonth : 0,
      freightCost,
      freightByRegionMonth,
    },
    shipmentsMonth,
    ufSaida,
    ufEntrada,
    ufAllKeys,
    ufByMonth,
    ufMonths: [...ufMonths],
  };
}

/* ── Render: Return by Month ─────────────────────────────── */
function getMetaInfo(pctNum) {
  if (pctNum >= 98) return { label: "Excelente", color: "var(--green)", bg: "var(--green-light)", icon: "🟢" };
  if (pctNum >= 95) return { label: "Bom", color: "var(--blue)", bg: "#eff6ff", icon: "🔵" };
  if (pctNum >= 90) return { label: "Atenção", color: "var(--orange)", bg: "var(--orange-light)", icon: "🟡" };
  return { label: "Crítico", color: "var(--red)", bg: "var(--red-light)", icon: "🔴" };
}

function renderReturnByMonth(m) {
  const body = $("#return-month-body");
  if (!body) return;
  body.innerHTML = "";

  let hasWarning = false;
  m.base.returnByMonth.forEach((r) => {
    const pctNum = Math.round(r.pct * 100);
    const meta = getMetaInfo(pctNum);
    if (pctNum < 95 && r.saida > 0) hasWarning = true;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(r.mes)}</td>
      <td class="text-right">${fmtInt(r.saida)}</td>
      <td class="text-right">${fmtInt(r.entrada)}</td>
      <td style="font-weight:700;color:${meta.color}">${fmtPct(r.pct)}</td>
      <td><span class="meta-badge" style="background:${meta.bg};color:${meta.color}">${meta.icon} ${meta.label}</span></td>
    `;
    body.appendChild(tr);
  });

  const totalEl = $("#return-total-pct");
  const totalPct = Math.round(m.base.returnPct * 100);
  const totalMeta = getMetaInfo(totalPct);
  if (totalEl) totalEl.innerHTML = `<strong style="color:${totalMeta.color}">${fmtPct(m.base.returnPct)} ${totalMeta.icon}</strong>`;

  // Warning banner below 95%
  const warnEl = $("#return-warning");
  if (warnEl) {
    if (hasWarning) {
      const monthsBelow = m.base.returnByMonth.filter((r) => Math.round(r.pct * 100) < 95 && r.saida > 0);
      const monthNames = monthsBelow.map((r) => r.mes).join(", ");
      warnEl.innerHTML = `⚠️ <strong>ATENÇÃO:</strong> Meses com retorno abaixo de 95%: <strong>${esc(monthNames)}</strong>. Ação corretiva necessária!`;
      warnEl.classList.remove("hidden");
    } else {
      warnEl.classList.add("hidden");
    }
  }

  // Duplicate alert (admin only)
  const dupEl = $("#duplicate-alert");
  if (dupEl) {
    if (m.base.duplicateCount > 0 && isAdmin) {
      dupEl.innerHTML = `🔁 <strong>DUPLICATAS DETECTADAS:</strong> ${m.base.duplicateCount} remessa(s) com NF duplicada foram encontradas.
        <button class="btn-sm btn-ghost" onclick="showDuplicates()">Ver detalhes</button>`;
      dupEl.classList.remove("hidden");
    } else {
      dupEl.classList.add("hidden");
    }
  }
}

/* ── Render: Cost Year Table ──────────────────────────────── */
function renderCostYear() {
  const body = $("#cost-year-body");
  if (!body) return;
  body.innerHTML = "";

  const mc = data.monthlyCosts || {};
  let totalReal = 0, totalBp = 0;

  MONTHS_LIST.forEach(({ key, name }) => {
    const vals = mc[key] || { realizado: 0 };
    const real = vals.realizado || 0;
    const bp = BP_MENSAL;
    const diff = bp - real;
    totalReal += real;
    totalBp += bp;

    const diffColor = diff >= 0 ? "var(--green)" : "var(--red)";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${name}</td>
      <td class="text-right">${real > 0 ? fmtNum(real) : ""}</td>
      <td class="text-right">${fmtNum(bp)}</td>
      <td class="text-right" style="font-weight:700;color:${diffColor}">${real > 0 || bp > 0 ? fmtNum(diff) : ""}</td>
    `;
    body.appendChild(tr);
  });

  const totalDiff = totalBp - totalReal;
  const totalDiffColor = totalDiff >= 0 ? "var(--green)" : "var(--red)";
  $("#cost-year-total-real").innerHTML = `<strong>${fmtNum(totalReal)}</strong>`;
  $("#cost-year-total-bp").innerHTML = `<strong>${fmtNum(totalBp)}</strong>`;
  $("#cost-year-total-diff").innerHTML = `<strong style="color:${totalDiffColor}">${fmtNum(totalDiff)}</strong>`;
}

/* ── Render: Freight ─────────────────────────────────────── */
function renderFreight() {
  // View (costs page)
  const view = $("#freight-view");
  if (view) {
    view.innerHTML = "";
    Object.entries(data.freightByRegion || {}).forEach(([r, c]) => {
      view.innerHTML += `<p>${r}</p><strong>${fmtCur(c)} / pallet</strong>`;
    });
  }

  // Admin form
  if (!isAdmin) return;
  const form = $("#freight-form");
  if (!form) return;
  form.innerHTML = "";
  Object.entries(data.freightByRegion || {}).forEach(([r, c]) => {
    const lbl = document.createElement("label");
    lbl.innerHTML = `${r} (R$/pallet) <input type="number" min="0" step="0.01" value="${c}" data-region="${r}" />`;
    form.appendChild(lbl);
  });
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.className = "btn-primary";
  btn.textContent = "Salvar Custos";
  form.appendChild(btn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const costs = {};
    form.querySelectorAll("input[data-region]").forEach((i) => (costs[i.dataset.region] = Number(i.value) || 0));
    await api("PUT", "/api/freight", costs);
    await fetchData();
  };
}

/* ── Render: History ─────────────────────────────────────── */
function renderHistory() {
  const body = $("#history-body");
  if (!body) return;
  body.innerHTML = "";
  (data.entries || []).slice(0, 300).forEach((e) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(e.date)}</td><td>${e.type}</td><td>${e.operation}</td>
      <td>${fmtInt(e.qty)}</td><td>${e.region}</td>
      ${isAdmin ? `<td><button class="btn-del" onclick="deleteEntry('${e.id}')">Excluir</button></td>` : ""}
    `;
    body.appendChild(tr);
  });
}

/* ── Render: Shipments ───────────────────────────────────── */
function renderShipments() {
  const body = $("#shipments-body");
  if (!body) return;

  const fDir = ($("#ship-filter-dir") || {}).value || "";
  const fType = ($("#ship-filter-type") || {}).value || "";
  const fUf = ($("#ship-filter-uf") || {}).value.toUpperCase().trim();
  const fMes = ($("#ship-filter-mes") || {}).value.toUpperCase().trim();
  const fSearch = ($("#ship-filter-search") || {}).value.toLowerCase().trim();

  let filtered = (data.shipments || []);
  if (fDir) filtered = filtered.filter((s) => s.direction === fDir);
  if (fType) filtered = filtered.filter((s) => s.type === fType);
  if (fUf) filtered = filtered.filter((s) => s.ufCliente === fUf);
  if (fMes) filtered = filtered.filter((s) => (s.nomeMes || "").toUpperCase().includes(fMes));
  if (fSearch) filtered = filtered.filter((s) =>
    (s.nomeCliente || "").toLowerCase().includes(fSearch) ||
    (s.nomeTransportador || "").toLowerCase().includes(fSearch) ||
    (s.placa || "").toLowerCase().includes(fSearch) ||
    (s.rede || "").toLowerCase().includes(fSearch)
  );

  body.innerHTML = "";
  filtered.slice(0, 500).forEach((s) => {
    const tr = document.createElement("tr");
    const dirLabel = s.direction === "entrada" ? '📥 Entrada' : '📤 Saída';
    tr.innerHTML = `
      <td><span class="badge-${s.direction || 'saida'}">${dirLabel}</span></td>
      <td>${esc(s.documentoFaturamento)}</td>
      <td>${esc(s.nf)}</td>
      <td>${fmtDate(s.dataFaturamento)}</td>
      <td>${esc(s.nomeMes)}</td>
      <td>${esc(s.codCliente)}</td>
      <td>${esc(s.nomeCliente)}</td>
      <td>${esc(s.cidadeCliente)}</td>
      <td>${esc(s.ufCliente)}</td>
      <td>${esc(s.rede)}</td>
      <td>${esc(s.dt)}</td>
      <td>${esc(s.nomeTransportador)}</td>
      <td>${esc(s.placa)}</td>
      <td>${fmtInt(s.qtde)}</td>
      <td>${fmtInt(s.qtdAvariados)}</td>
      <td>${fmtInt(s.qtdDescarte)}</td>
      <td>${esc(s.nRomaneio)}</td>
      <td>${s.type}</td>
      ${isAdmin ? `<td><button class="btn-del" onclick="deleteShipment('${s.id}')">Excluir</button></td>` : ""}
    `;
    body.appendChild(tr);
  });

  const count = $("#ship-count");
  if (count) count.textContent = `Exibindo ${Math.min(filtered.length, 500)} de ${filtered.length} remessas`;
}

/* ── Charts ──────────────────────────────────────────────── */
function renderCharts(m) {
  if (ufChart) ufChart.destroy();
  if (freightChart) freightChart.destroy();

  const chartOpts = { responsive: true, plugins: { legend: { display: false } } };

  // Render forecasts table
  renderForecasts();

  // UF chart (Saída vs Entrada por estado, com filtro de mês)
  const monthOrder = ["JANEIRO","FEVEREIRO","MARÇO","ABRIL","MAIO","JUNHO","JULHO","AGOSTO","SETEMBRO","OUTUBRO","NOVEMBRO","DEZEMBRO"];
  const ufMonthSelect = $("#uf-month-filter");
  const currentVal = ufMonthSelect ? ufMonthSelect.value : "TODOS";
  if (ufMonthSelect) {
    const sortedMonths = m.ufMonths.sort((a, b) => {
      const ia = monthOrder.indexOf(a), ib = monthOrder.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    ufMonthSelect.innerHTML = '<option value="TODOS">Todos os meses</option>';
    sortedMonths.forEach((mes) => {
      const opt = document.createElement("option");
      opt.value = mes;
      opt.textContent = mes.charAt(0) + mes.slice(1).toLowerCase();
      ufMonthSelect.appendChild(opt);
    });
    ufMonthSelect.value = currentVal;
    ufMonthSelect.onchange = () => renderUfChart(m);
  }
  renderUfChart(m);

  // Freight by region chart
  const frLabels = Object.keys(m.pbr.freightByRegionMonth);
  const frData = frLabels.map((k) => m.pbr.freightByRegionMonth[k]);
  freightChart = new Chart($("#freightChart"), {
    type: "bar",
    data: {
      labels: frLabels.length ? frLabels : ["Nenhum dado"],
      datasets: [{ label: "Custo (R$)", data: frLabels.length ? frData : [0], backgroundColor: "#dc2626", borderRadius: 4 }],
    },
    options: chartOpts,
  });
}

/* ── UF Chart with month filter ──────────────────────────── */
function renderUfChart(m) {
  if (ufChart) ufChart.destroy();
  const sel = $("#uf-month-filter");
  const month = sel ? sel.value : "TODOS";

  let saidaObj, entradaObj;
  if (month === "TODOS") {
    saidaObj = m.ufSaida;
    entradaObj = m.ufEntrada;
  } else {
    const md = m.ufByMonth[month] || { saida: {}, entrada: {} };
    saidaObj = md.saida;
    entradaObj = md.entrada;
  }

  const allUfs = [...new Set([...Object.keys(saidaObj), ...Object.keys(entradaObj)])].sort();
  const ufSaidaData = allUfs.map((k) => saidaObj[k] || 0);
  const ufEntradaData = allUfs.map((k) => entradaObj[k] || 0);

  ufChart = new Chart($("#ufChart"), {
    type: "bar",
    data: {
      labels: allUfs.length ? allUfs : ["Sem dados"],
      datasets: [
        { label: "Saída", data: allUfs.length ? ufSaidaData : [0], backgroundColor: "#dc2626", borderRadius: 4 },
        { label: "Entrada", data: allUfs.length ? ufEntradaData : [0], backgroundColor: "#0d9488", borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: "top" } },
      indexAxis: allUfs.length > 8 ? "y" : "x",
      scales: { y: { beginAtZero: true } },
    },
  });
}

/* ── Formatters ──────────────────────────────────────────── */
function fmtCur(v) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0); }
function fmtNum(v) { return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0); }
function fmtInt(v) { return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(v || 0); }
function fmtPct(v) { return new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 }).format(v || 0); }
function fmtDate(v) { if (!v) return "-"; const [y, m, d] = v.split("-"); return `${d}/${m}/${y}`; }
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

/* ── Operators Management (admin) ────────────────────────── */
async function loadOperatorsList() {
  const body = $("#operators-body");
  if (!body) return;
  const ops = await api("GET", "/api/operators");
  if (!Array.isArray(ops)) return;
  body.innerHTML = "";
  ops.forEach((op) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(op.name)}</td>
      <td>${esc(op.user)}</td>
      <td>${esc(op.pass)}</td>
      <td>${op.createdAt ? fmtDate(op.createdAt.slice(0, 10)) : "-"}</td>
      <td><button class="btn-del" onclick="deleteOperator('${op.id}')">Excluir</button></td>
    `;
    body.appendChild(tr);
  });
}

async function addOperator(e) {
  e.preventDefault();
  const name = $("#op-name").value.trim();
  const user = $("#op-user").value.trim();
  const pass = $("#op-pass").value.trim();
  const resultEl = $("#op-result");
  resultEl.textContent = "";
  if (!name || !user || !pass) { resultEl.textContent = "❌ Preencha todos os campos."; return; }
  const res = await api("POST", "/api/operators", { name, user, pass });
  if (res.id) {
    resultEl.textContent = "✅ Operador cadastrado com sucesso!";
    $("#op-form").reset();
    loadOperatorsList();
  } else {
    resultEl.textContent = "❌ " + (res.error || "Erro ao cadastrar operador.");
  }
}

async function deleteOperator(id) {
  if (!confirm("Excluir este operador?")) return;
  await api("DELETE", `/api/operators/${id}`);
  loadOperatorsList();
}

/* ── Operator stock count ────────────────────────────────── */
async function handleStockCountOp(e) {
  e.preventDefault();
  const body = {
    PBR: Number($("#stock-pbr-op").value) || 0,
    CHEP: Number($("#stock-chep-op").value) || 0,
    FUMIGADO: Number($("#stock-fumigado-op").value) || 0,
    QUEBRADOS: Number($("#stock-quebrados-op").value) || 0,
    REFORMADOS: Number($("#stock-reformados-op").value) || 0,
    TRIAR_PBR: Number($("#stock-triar-pbr-op").value) || 0,
    TRIAR_FUMIGADO: Number($("#stock-triar-fumigado-op").value) || 0,
  };
  const res = await api("PUT", "/api/stockcount", body);
  const resultEl = $("#stock-count-result-op");
  if (res.PBR !== undefined) {
    resultEl.textContent = "✅ Contagem de estoque salva com sucesso!";
    await fetchData();
  } else {
    resultEl.textContent = "❌ Erro ao salvar contagem.";
  }
}

function populateStockFormOp() {
  const sc = data.stockCount || {};
  const fields = { "stock-pbr-op": "PBR", "stock-chep-op": "CHEP", "stock-fumigado-op": "FUMIGADO", "stock-quebrados-op": "QUEBRADOS", "stock-reformados-op": "REFORMADOS", "stock-triar-pbr-op": "TRIAR_PBR", "stock-triar-fumigado-op": "TRIAR_FUMIGADO" };
  for (const [id, key] of Object.entries(fields)) {
    const el = $(`#${id}`);
    if (el) el.value = sc[key] || 0;
  }
}

/* ── Cargo Forecasts ─────────────────────────────────────── */
function renderForecasts() {
  const body = $("#forecast-body");
  const empty = $("#forecast-empty");
  if (!body) return;
  const forecasts = data.forecasts || [];
  body.innerHTML = "";
  if (forecasts.length === 0) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  const today = new Date().toISOString().slice(0, 10);
  forecasts.forEach((f) => {
    const tr = document.createElement("tr");
    const tipoLabel = f.tipo === "compra" ? "🟢 Pallets de Compra" : "🔵 Pallets Devolução";
    const isLate = f.previsao < today;
    const dateClass = isLate ? 'style="color:var(--red);font-weight:600"' : "";
    tr.innerHTML = `
      <td>${tipoLabel}</td>
      <td class="text-right"><strong>${fmtInt(f.qtde)}</strong></td>
      <td ${dateClass}>${fmtDate(f.previsao)}${isLate ? " ⚠️" : ""}</td>
      <td>${esc(f.obs || "-")}</td>
      ${isAdmin ? `<td><button class="btn-del" onclick="deleteForecast('${f.id}')">Excluir</button></td>` : ""}
    `;
    body.appendChild(tr);
  });
}

async function handleAddForecast(e) {
  e.preventDefault();
  const tipo = $("#fc-tipo").value;
  const qtde = Number($("#fc-qtde").value) || 0;
  const previsao = $("#fc-previsao").value;
  const obs = $("#fc-obs").value.trim();
  const resultEl = $("#fc-result");
  resultEl.textContent = "";
  const res = await api("POST", "/api/forecasts", { tipo, qtde, previsao, obs });
  if (res.id) {
    resultEl.textContent = "✅ Previsão cadastrada com sucesso!";
    $("#fc-qtde").value = "";
    $("#fc-obs").value = "";
    await fetchData();
  } else {
    resultEl.textContent = "❌ " + (res.error || "Erro ao cadastrar.");
  }
}

async function deleteForecast(id) {
  if (!confirm("Excluir esta previsão de carga?")) return;
  await api("DELETE", `/api/forecasts/${id}`);
  await fetchData();
}

/* ── Share / QR Code ─────────────────────────────────────── */
async function handleGenerateQR() {
  const btn = $("#btn-generate-qr");
  const content = $("#share-content");
  const hint = $("#share-hint");
  if (btn) btn.textContent = "Gerando...";
  try {
    const res = await api("GET", "/api/share-qr");
    if (res.error) throw new Error(res.error);
    const urlInput = $("#share-url");
    const qrImg = $("#share-qr-img");
    if (urlInput) urlInput.value = res.url;
    if (qrImg) qrImg.src = res.qr;
    if (content) content.classList.remove("hidden");
    if (hint) hint.textContent = "Qualquer pessoa com este link pode visualizar o dashboard (somente leitura).";
    if (btn) btn.textContent = "🔄 Atualizar Link";
  } catch (err) {
    if (hint) { hint.textContent = "❌ Erro ao gerar QR Code."; hint.style.color = "var(--red)"; }
    if (btn) btn.textContent = "Gerar Link e QR Code";
  }
}

function handleCopyUrl() {
  const urlInput = $("#share-url");
  if (!urlInput) return;
  navigator.clipboard.writeText(urlInput.value).then(() => {
    const btn = $("#btn-copy-url");
    if (btn) { btn.textContent = "✅ Copiado!"; setTimeout(() => { btn.textContent = "📋 Copiar"; }, 2000); }
  });
}
