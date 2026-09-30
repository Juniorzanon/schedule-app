const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

// ===================== //
// AUTENTICAÇÃO (login)   //
// ===================== //
// Logins. As senhas vêm de variáveis de ambiente para não ficarem no código.
// Defina JET_PASSWORD, ADMIN_PASSWORD e AUTH_SECRET no painel do Render (ou no
// ambiente local). Um usuário sem senha definida fica desativado (não loga).
const USERS = {
  Jet:   process.env.JET_PASSWORD   || "",
  Admin: process.env.ADMIN_PASSWORD || ""
};
const AUTH_SECRET = process.env.AUTH_SECRET || "change-me-set-AUTH_SECRET-in-env";
const AUTH_TTL_MS = 12 * 60 * 60 * 1000; // sessão dura 12 horas

function sign(value) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(value).digest("hex");
}
function makeToken(user) {
  const payload = encodeURIComponent(user) + "." + Date.now();
  return payload + "." + sign(payload);
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [user, ts, sig] = parts;
  if (sign(user + "." + ts) !== sig) return null;
  if (Date.now() - Number(ts) > AUTH_TTL_MS) return null;
  return decodeURIComponent(user);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return verifyToken(parseCookies(req).auth);
}
function authCookie(token) {
  return "auth=" + encodeURIComponent(token) +
    "; HttpOnly; Path=/; Max-Age=" + Math.floor(AUTH_TTL_MS / 1000) + "; SameSite=Lax";
}
function requireApiAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).send("Sessão expirada. Faça login novamente.");
  next();
}

const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const sessionData = {}; // { sessionId: { data, createdAt } }

// Limpa sessões expiradas a cada 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessionData)) {
    if (now - sessionData[id].createdAt > SESSION_TTL_MS) {
      delete sessionData[id];
    }
  }
}, 30 * 60 * 1000);

// Middlewares
app.use(cors()); // Habilita CORS para todas as rotas
app.use(express.json());

// ---- Rotas de autenticação (antes do static para poder proteger a dashboard) ----
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const expected = USERS[username];
  if (expected && password === expected) {
    res.setHeader("Set-Cookie", authCookie(makeToken(username)));
    return res.json({ success: true, user: username });
  }
  return res.status(401).json({ success: false, message: "Usuário ou senha inválidos." });
});

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  res.json({ success: true });
});

app.get("/me", (req, res) => {
  const user = isAuthed(req);
  res.json({ authenticated: !!user, user: user || null });
});

// Protege a dashboard: sem login válido, volta para a tela de login
app.get(["/dashboard", "/dashboard.html"], (req, res, next) => {
  if (!isAuthed(req)) return res.redirect("/login.html");
  next(); // autenticado: deixa o static servir o arquivo
});

app.use(express.static("public"));

// ===================== //
// UPLOAD E PROCESSAMENTO //
// ===================== //
app.post("/upload", requireApiAuth, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("Nenhum arquivo enviado.");
  }

  const originalName = req.file.originalname || "";
  if (path.extname(originalName).toLowerCase() !== ".pdf") {
    fs.unlink(req.file.path, () => {});
    return res.status(400).send("Apenas arquivos PDF são aceitos.");
  }

  const filePath = req.file.path;
  const sessionId = uuidv4();

  execFile(PYTHON_BIN, ["parser.py", filePath], (error, stdout, stderr) => {
    // Limpa o arquivo enviado após o processamento (ou falha)
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.error("Erro ao excluir o arquivo temporário de upload:", unlinkErr);
    });

    if (error) {
      console.error("Erro na execução do parser.py:", stderr || error);
      return res.status(500).send("Erro no processamento do arquivo: " + (stderr || error.message));
    }

    try {
      const parsed = JSON.parse(stdout);
      const extractedData = parsed.data || parsed;
      sessionData[sessionId] = { data: extractedData, createdAt: Date.now() };
      res.json({ success: true, sessionId: sessionId, count: extractedData.length });
    } catch (jsonError) {
      console.error("Erro ao fazer parse do JSON do parser.py:", jsonError, "Stdout:", stdout);
      return res.status(500).send("Erro ao processar a saída do parser.py. Verifique o formato JSON.");
    }
  });
});

// ===================== //
// GERAR DADOS FILTRADOS //
// ===================== //
app.post("/generate", requireApiAuth, (req, res) => {
  const { day, sessionId } = req.body;

  if (!sessionId || !sessionData[sessionId]) {
    return res.status(404).send("Sessão expirada ou inválida. Faça o upload novamente.");
  }

  const extractedData = sessionData[sessionId].data;

  const filtered = extractedData
    .filter(e => e.day === day)
    .sort((a, b) => a.start.localeCompare(b.start));

  res.json(filtered);
});

// ===================== //
// EXPORTAR PARA EXCEL //
// ===================== //
app.post("/export", requireApiAuth, async (req, res) => {
  const { data } = req.body;

  if (!data || !Array.isArray(data) || data.length === 0) {
    return res.status(400).send("Nenhum dado para exportar.");
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Schedule");

  sheet.columns = [
    { header: "Role", key: "role", width: 10 },
    { header: "Name", key: "name", width: 30 },
    { header: "Start", key: "start", width: 15 },
    { header: "End", key: "end", width: 15 },
    { header: "Break 30", key: "break30", width: 15 },
    { header: "Break 15", key: "break15", width: 15 }
  ];

  data.forEach(row => {
    const added = sheet.addRow({
      role: row.role || "",
      name: row.name,
      start: row.start,
      end: row.end,
      break30: row.break30 || "",
      break15: row.break15 || ""
    });
    // Highlight rows to match the printout: Shift = grey, Sick = soft red
    const role = row.role || "";
    let fillColor = null;
    if (role === "Shift") fillColor = "FFCFCFCF";
    else if (role === "Sick") fillColor = "FFF2C4C4";
    if (fillColor) {
      added.eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
      });
    }
  });

  try {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="schedule.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (writeError) {
    console.error("Erro ao escrever o arquivo Excel:", writeError);
    res.status(500).send("Erro ao gerar o arquivo Excel.");
  }
});

// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
