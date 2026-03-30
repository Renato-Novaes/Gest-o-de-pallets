const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Admin credentials ──────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || "c2097142";
const ADMIN_PASS = process.env.ADMIN_PASS || "Re.96742581";

// ── Operators file ─────────────────────────────────────────────────────────
const OPERATORS_FILE = path.join(__dirname, "operators.json");

function loadOperators() {
  try {
    if (fs.existsSync(OPERATORS_FILE)) return JSON.parse(fs.readFileSync(OPERATORS_FILE, "utf-8"));
  } catch { /* fall through */ }
  return [];
}

function saveOperators(ops) {
  fs.writeFileSync(OPERATORS_FILE, JSON.stringify(ops, null, 2), "utf-8");
}

// ── Session store ──────────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

function createSession(role) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now(), role: role || "admin" });
  return token;
}

function isValidSession(token) {
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

function getSessionRole(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return null; }
  return s.role;
}

// ── Data persistence ───────────────────────────────────────────────────────
const defaultData = {
  entries: [],
  shipments: [],
  stockCount: { PBR: 0, CHEP: 0, FUMIGADO: 0, QUEBRADOS: 0, REFORMADOS: 0, TRIAR: 0, TRIAR_PBR: 0, TRIAR_FUMIGADO: 0 },
  monthlyCosts: {},
  forecasts: [],
  freightByRegion: {
    Sudeste: 12, Sul: 14, Nordeste: 18, Norte: 22, "Centro-Oeste": 16,
  },
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      const shipments = Array.isArray(parsed.shipments) ? parsed.shipments : [];
      // Normalize: fill empty nomeMes from dataFaturamento
      shipments.forEach((s) => {
        if (!s.nomeMes || !s.nomeMes.trim()) {
          s.nomeMes = monthNameFromDate(s.dataFaturamento);
        }
      });
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        shipments,
        stockCount: { ...defaultData.stockCount, ...(parsed.stockCount || {}) },
        monthlyCosts: parsed.monthlyCosts || {},
        forecasts: Array.isArray(parsed.forecasts) ? parsed.forecasts : [],
        freightByRegion: { ...defaultData.freightByRegion, ...(parsed.freightByRegion || {}) },
      };
    }
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(defaultData));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── SSE (real-time updates) ────────────────────────────────────────────────
const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("data: connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token || getSessionRole(token) !== "admin") return res.status(401).json({ error: "Nao autorizado" });
  next();
}

function requireAuth(req, res, next) {
  const token = req.headers["x-auth-token"];
  const role = getSessionRole(token);
  if (!role) return res.status(401).json({ error: "Nao autorizado" });
  req.userRole = role;
  next();
}

// ── Auth ────────────────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (typeof user === "string" && typeof pass === "string") {
    // Check admin
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
      return res.json({ token: createSession("admin"), role: "admin" });
    }
    // Check operators
    const ops = loadOperators();
    const op = ops.find((o) => o.user === user && o.pass === pass && o.active !== false);
    if (op) {
      return res.json({ token: createSession("operator"), role: "operator", name: op.name });
    }
  }
  return res.status(401).json({ error: "Credenciais invalidas" });
});

app.post("/api/logout", (req, res) => {
  const token = req.headers["x-auth-token"];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const token = req.headers["x-auth-token"];
  const role = getSessionRole(token);
  res.json({ admin: role === "admin", operator: role === "operator", role: role || "visitor" });
});

// ── Public read ─────────────────────────────────────────────────────────────
app.get("/api/data", (_req, res) => res.json(loadData()));

// ── Entries (movimentacao de pallets) ───────────────────────────────────────
app.post("/api/entries", requireAdmin, (req, res) => {
  const { date, type, operation, qty, region } = req.body;
  if (!date || !type || !operation || !qty) return res.status(400).json({ error: "Campos obrigatorios faltando" });

  const validTypes = ["PBR", "CHEP", "FUMIGADO"];
  const validOps = ["entrada", "saida", "retorno"];
  if (!validTypes.includes(type) || !validOps.includes(operation)) return res.status(400).json({ error: "Tipo ou operacao invalida" });
  if (operation === "retorno" && type !== "PBR") return res.status(400).json({ error: "Retorno somente para PBR" });

  const quantity = Math.max(1, Math.floor(Number(qty)));
  if (!Number.isFinite(quantity)) return res.status(400).json({ error: "Quantidade invalida" });

  const data = loadData();
  const entry = {
    id: crypto.randomUUID(),
    date: String(date).slice(0, 10),
    type, operation, qty: quantity,
    region: type === "PBR" && operation === "saida" ? String(region || "Sudeste") : "-",
  };
  data.entries.push(entry);
  data.entries.sort((a, b) => b.date.localeCompare(a.date));
  saveData(data);
  broadcast({ type: "update" });
  res.json(entry);
});

app.delete("/api/entries/:id", requireAdmin, (req, res) => {
  const data = loadData();
  const idx = data.entries.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Nao encontrado" });
  data.entries.splice(idx, 1);
  saveData(data);
  broadcast({ type: "update" });
  res.json({ ok: true });
});

// ── Stock count (contagem manual diária) ───────────────────────────────────
app.put("/api/stockcount", requireAuth, (req, res) => {
  const counts = req.body;
  if (!counts || typeof counts !== "object") return res.status(400).json({ error: "Dados invalidos" });
  const data = loadData();
  const validKeys = ["PBR", "CHEP", "FUMIGADO", "QUEBRADOS", "REFORMADOS", "TRIAR", "TRIAR_PBR", "TRIAR_FUMIGADO"];
  for (const [key, value] of Object.entries(counts)) {
    if (validKeys.includes(key)) data.stockCount[key] = Math.max(0, Math.floor(Number(value) || 0));
  }
  saveData(data);
  broadcast({ type: "update" });
  res.json(data.stockCount);
});

// ── Monthly costs (custo mensal Realizado + BP) ────────────────────────────
const VALID_MONTHS = ["01","02","03","04","05","06","07","08","09","10","11","12"];
app.put("/api/monthlycosts", requireAdmin, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Dados invalidos" });
  const data = loadData();
  for (const [month, values] of Object.entries(body)) {
    if (!VALID_MONTHS.includes(month)) continue;
    if (!data.monthlyCosts[month]) data.monthlyCosts[month] = { realizado: 0, bp: 0 };
    if (values.realizado !== undefined) data.monthlyCosts[month].realizado = Math.max(0, Number(values.realizado) || 0);
    if (values.bp !== undefined) data.monthlyCosts[month].bp = Math.max(0, Number(values.bp) || 0);
  }
  saveData(data);
  broadcast({ type: "update" });
  res.json(data.monthlyCosts);
});

// ── Freight costs ──────────────────────────────────────────────────────────
app.put("/api/freight", requireAdmin, (req, res) => {
  const costs = req.body;
  if (!costs || typeof costs !== "object") return res.status(400).json({ error: "Dados invalidos" });
  const data = loadData();
  for (const [region, value] of Object.entries(costs)) {
    if (region in data.freightByRegion) data.freightByRegion[region] = Math.max(0, Number(value) || 0);
  }
  saveData(data);
  broadcast({ type: "update" });
  res.json(data.freightByRegion);
});

// ── Shipments (remessas / base de clientes) ────────────────────────────────
// Helper: derive Portuguese month name from a YYYY-MM-DD date string
const MONTH_NAMES_PT = ["JANEIRO","FEVEREIRO","MARÇO","ABRIL","MAIO","JUNHO","JULHO","AGOSTO","SETEMBRO","OUTUBRO","NOVEMBRO","DEZEMBRO"];
function monthNameFromDate(dateStr) {
  if (!dateStr) return "";
  const m = Number(String(dateStr).slice(5, 7));
  return (m >= 1 && m <= 12) ? MONTH_NAMES_PT[m - 1] : "";
}

function buildShipment(raw) {
  const dataFat = String(raw.dataFaturamento || new Date().toISOString().slice(0, 10)).slice(0, 10);
  let nomeMes = String(raw.nomeMes || "").trim();
  if (!nomeMes) nomeMes = monthNameFromDate(dataFat);
  return {
    id: crypto.randomUUID(),
    direction: raw.direction === "entrada" ? "entrada" : "saida",
    documentoFaturamento: String(raw.documentoFaturamento || "").slice(0, 30),
    nf: String(raw.nf || "").slice(0, 20),
    dataFaturamento: dataFat,
    nomeMes: nomeMes.slice(0, 20),
    codCliente: String(raw.codCliente || "").slice(0, 30),
    nomeCliente: String(raw.nomeCliente || "").slice(0, 200),
    cidadeCliente: String(raw.cidadeCliente || "").slice(0, 100),
    ufCliente: String(raw.ufCliente || "").slice(0, 2).toUpperCase(),
    rede: String(raw.rede || "").slice(0, 200),
    dt: String(raw.dt || "").slice(0, 30),
    nomeTransportador: String(raw.nomeTransportador || "").slice(0, 200),
    placa: String(raw.placa || "").slice(0, 10).toUpperCase(),
    qtde: Math.max(0, Math.floor(Number(raw.qtde) || 0)),
    qtdAvariados: Math.max(0, Math.floor(Number(raw.qtdAvariados) || 0)),
    qtdDescarte: Math.max(0, Math.floor(Number(raw.qtdDescarte) || 0)),
    nRomaneio: String(raw.nRomaneio || "").slice(0, 30),
    type: ["PBR", "CHEP", "FUMIGADO"].includes(raw.type) ? raw.type : "PBR",
  };
}

app.post("/api/shipments", requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.nomeCliente) return res.status(400).json({ error: "NomeCliente obrigatorio" });

  const data = loadData();
  const shipment = buildShipment(b);
  data.shipments.push(shipment);
  data.shipments.sort((a, b) => b.dataFaturamento.localeCompare(a.dataFaturamento));
  saveData(data);
  broadcast({ type: "update" });
  res.json(shipment);
});

app.delete("/api/shipments/:id", requireAdmin, (req, res) => {
  const data = loadData();
  const idx = data.shipments.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Nao encontrado" });
  data.shipments.splice(idx, 1);
  saveData(data);
  broadcast({ type: "update" });
  res.json({ ok: true });
});

// ── Excel upload ───────────────────────────────────────────────────────────
// Helper: pick first truthy value from row by possible column names
function pick(row, ...keys) {
  for (const k of keys) { if (row[k] !== undefined && row[k] !== "") return row[k]; }
  return "";
}

function parseExcelDate(val) {
  if (!val) return new Date().toISOString().slice(0, 10);
  if (typeof val === "number") {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const s = String(val).trim();
  // DD/MM/YYYY (Brazilian)
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  // M/D/YY (xlsx formatted US short)
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) {
    const y = Number(m2[3]) + 2000;
    return `${y}-${m2[1].padStart(2,"0")}-${m2[2].padStart(2,"0")}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

// Parse CSV manually preserving DD/MM/YYYY dates (xlsx auto-converts using US locale)
function parseCsvRows(buffer) {
  const text = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = (vals[i] || "").trim()));
    return row;
  });
}

function readXlsxRows(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const ref = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const headers = [];
  for (let c = ref.s.c; c <= ref.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: ref.s.r, c })];
    headers.push(cell ? String(cell.v ?? "") : "");
  }
  const rows = [];
  for (let r = ref.s.r + 1; r <= ref.e.r; r++) {
    const row = {};
    let hasData = false;
    for (let c = ref.s.c; c <= ref.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      row[headers[c]] = cell ? cell.v ?? "" : "";
      if (row[headers[c]] !== "") hasData = true;
    }
    if (hasData) rows.push(row);
  }
  return rows;
}

function rowsToShipments(rows, palletType, direction) {
  const results = [];
  for (const row of rows) {
    const nome = String(pick(row, "NomeCliente", "nomeCliente", "NOMECLIENTE", "Nome Cliente")).trim();
    if (!nome) continue;
    results.push(buildShipment({
      direction,
      documentoFaturamento: String(pick(row, "DocumentoFaturamento", "documentoFaturamento", "DOCUMENTOFATURAMENTO", "Documento Faturamento")).trim(),
      nf: String(pick(row, "NF", "nf", "Nf")).trim(),
      dataFaturamento: parseExcelDate(pick(row, "DataFaturamento", "dataFaturamento", "DATAFATURAMENTO", "Data Faturamento")),
      nomeMes: String(pick(row, "NomeMes", "nomeMes", "NOMEMES", "Nome Mes", "NomeMês")).trim(),
      codCliente: String(pick(row, "CodCliente", "codCliente", "CODCLIENTE", "Cod Cliente")).trim(),
      nomeCliente: nome,
      cidadeCliente: String(pick(row, "CidadeCliente", "cidadeCliente", "CIDADECLIENTE", "Cidade Cliente", "Cidade")).trim(),
      ufCliente: String(pick(row, "UFCliente", "ufCliente", "UFCLIENTE", "UF Cliente", "UF")).trim(),
      rede: String(pick(row, "Rede", "rede", "REDE")).trim(),
      dt: String(pick(row, "DT", "dt", "Dt")).trim(),
      nomeTransportador: String(pick(row, "NomeTransportador", "nomeTransportador", "NOMETRANSPORTADOR", "Nome Transportador", "Transportador", "Transportadora")).trim(),
      placa: String(pick(row, "Placa", "placa", "PLACA")).trim(),
      qtde: Number(pick(row, "Qtde", "qtde", "QTDE", "Quantidade", "quantidade") || 0),
      qtdAvariados: Number(pick(row, "QtdAvaridos", "qtdAvariados", "QTDAVARIDOS", "QtdAvariados", "Qtd Avariados") || 0),
      qtdDescarte: Number(pick(row, "QtdDescarte", "qtdDescarte", "QTDDESCARTE", "Qtd Descarte") || 0),
      nRomaneio: String(pick(row, "NRomaneio", "nRomaneio", "NROMANEIO", "N Romaneio", "Romaneio")).trim(),
      type: palletType,
    }));
  }
  return results;
}

app.post("/api/shipments/upload", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

  try {
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    const rows = ext === ".csv" ? parseCsvRows(req.file.buffer) : readXlsxRows(req.file.buffer);
    const palletType = req.body.type || "PBR";
    const direction = req.body.direction === "entrada" ? "entrada" : "saida";
    const shipments = rowsToShipments(rows, palletType, direction);

    const data = loadData();

    // Determine which months/direction/type are in the new data
    const newMonthKeys = new Set();
    shipments.forEach((s) => {
      const key = `${(s.nomeMes || "").toUpperCase().trim()}|${s.direction}|${s.type}`;
      newMonthKeys.add(key);
    });

    // Remove existing shipments that match those same month+direction+type combos
    data.shipments = data.shipments.filter((s) => {
      const key = `${(s.nomeMes || "").toUpperCase().trim()}|${s.direction}|${s.type}`;
      return !newMonthKeys.has(key);
    });

    data.shipments.push(...shipments);
    data.shipments.sort((a, b) => b.dataFaturamento.localeCompare(a.dataFaturamento));
    saveData(data);
    broadcast({ type: "update" });
    res.json({ imported: shipments.length, total: data.shipments.length });
  } catch (err) {
    res.status(400).json({ error: "Erro ao processar planilha: " + err.message });
  }
});

// ── Operators management (admin only) ──────────────────────────────────────

// ── Cargo Forecasts (previsão de cargas) ───────────────────────────────────
app.get("/api/forecasts", (_req, res) => {
  const data = loadData();
  res.json(data.forecasts || []);
});

app.post("/api/forecasts", requireAdmin, (req, res) => {
  const { tipo, qtde, previsao, obs } = req.body || {};
  if (!tipo || !qtde || !previsao) return res.status(400).json({ error: "Tipo, quantidade e previsão são obrigatórios" });
  const validTipos = ["compra", "devolucao"];
  if (!validTipos.includes(tipo)) return res.status(400).json({ error: "Tipo invalido" });
  const data = loadData();
  const forecast = {
    id: crypto.randomUUID(),
    tipo,
    qtde: Math.max(1, Math.floor(Number(qtde) || 0)),
    previsao: String(previsao).slice(0, 10),
    obs: String(obs || "").slice(0, 200),
    createdAt: new Date().toISOString(),
  };
  data.forecasts.push(forecast);
  data.forecasts.sort((a, b) => a.previsao.localeCompare(b.previsao));
  saveData(data);
  broadcast({ type: "update" });
  res.json(forecast);
});

app.delete("/api/forecasts/:id", requireAdmin, (req, res) => {
  const data = loadData();
  const idx = data.forecasts.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Não encontrado" });
  data.forecasts.splice(idx, 1);
  saveData(data);
  broadcast({ type: "update" });
  res.json({ ok: true });
});

app.get("/api/operators", requireAdmin, (_req, res) => {
  res.json(loadOperators());
});

app.post("/api/operators", requireAdmin, (req, res) => {
  const { name, user, pass } = req.body || {};
  if (!name || !user || !pass) return res.status(400).json({ error: "Nome, usuario e senha sao obrigatorios" });
  const ops = loadOperators();
  if (ops.some((o) => o.user === user)) return res.status(400).json({ error: "Usuario ja existe" });
  const op = { id: crypto.randomUUID(), name: String(name).slice(0, 100), user: String(user).slice(0, 50), pass: String(pass).slice(0, 100), active: true, createdAt: new Date().toISOString() };
  ops.push(op);
  saveOperators(ops);
  res.json(op);
});

app.delete("/api/operators/:id", requireAdmin, (req, res) => {
  const ops = loadOperators();
  const idx = ops.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Operador nao encontrado" });
  ops.splice(idx, 1);
  saveOperators(ops);
  res.json({ ok: true });
});

// ── Share / QR Code ────────────────────────────────────────────────────────
function getPublicUrl(req) {
  // Codespaces: use CODESPACE_NAME + domain env vars
  const csName = process.env.CODESPACE_NAME;
  const csDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (csName && csDomain) {
    return `https://${csName}-${PORT}.${csDomain}`;
  }
  // Fallback: use forwarded headers or host
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

app.get("/api/share-url", (req, res) => {
  res.json({ url: getPublicUrl(req) });
});

app.get("/api/share-qr", async (req, res) => {
  try {
    const publicUrl = getPublicUrl(req);
    const qrDataUrl = await QRCode.toDataURL(publicUrl, { width: 400, margin: 2, color: { dark: "#1e293b", light: "#ffffff" } });
    res.json({ url: publicUrl, qr: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: "Erro ao gerar QR code" });
  }
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Admin: ${ADMIN_USER} / ${ADMIN_PASS}`);
});
