const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const dns = require('dns');

// O Render não tem IPv6; força o Node a resolver nomes em IPv4 primeiro
// (evita "ENETUNREACH ...:465" ao conectar no SMTP do Gmail)
if (dns.setDefaultResultOrder) {
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

// ===================== //
// E-MAIL / RELATÓRIO     //
// ===================== //
// Configurado por variáveis de ambiente no Render:
//   BREVO_API_KEY = chave do Brevo (envio por HTTPS — recomendado no Render)
//   EMAIL_FROM    = e-mail remetente verificado no Brevo (ex: seunome@gmail.com)
//   REPORT_EMAILS = lista padrão de destinatários, separada por vírgula
//   (SMTP/Gmail como alternativa: EMAIL_USER + EMAIL_PASS; costuma ser bloqueado no Render)
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_HOST = process.env.EMAIL_HOST || "";   // opcional: SMTP genérico (padrão = Gmail)
const EMAIL_PORT = process.env.EMAIL_PORT || "";

const EMAIL_CONFIGURED = !!(BREVO_API_KEY && EMAIL_FROM) || !!(EMAIL_USER && EMAIL_PASS);

// Envio por HTTPS (Brevo) — funciona no Render, que bloqueia SMTP
async function sendViaBrevo({ from, to, subject, pdfBase64, filename }) {
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({
      sender: { email: from, name: "Online Schedule" },
      to: to.map(email => ({ email })),
      subject,
      textContent: "Schedule report attached.",
      attachment: [{ content: pdfBase64, name: filename }]
    })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const e = new Error("Brevo " + resp.status + ": " + body.slice(0, 300));
    e.brevoStatus = resp.status;
    throw e;
  }
}

function makeTransport() {
  // Fail fast instead of hanging; force IPv4 (Render has no IPv6)
  const timeouts = { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, family: 4 };
  if (EMAIL_HOST) {
    const port = Number(EMAIL_PORT) || 587;
    return nodemailer.createTransport({
      host: EMAIL_HOST, port, secure: port === 465,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS }, ...timeouts
    });
  }
  return nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_USER, pass: EMAIL_PASS }, ...timeouts });
}
const REPORT_EMAILS = (process.env.REPORT_EMAILS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
}

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
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sessão dura 7 dias (evita deslogar no meio do turno)

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
  if (!isAuthed(req)) return res.status(401).send("Session expired. Please log in again.");
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
  return res.status(401).json({ success: false, message: "Invalid username or password." });
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
    return res.status(400).send("No file uploaded.");
  }

  const originalName = req.file.originalname || "";
  if (path.extname(originalName).toLowerCase() !== ".pdf") {
    fs.unlink(req.file.path, () => {});
    return res.status(400).send("Only PDF files are accepted.");
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
      return res.status(500).send("Error processing the file: " + (stderr || error.message));
    }

    try {
      const parsed = JSON.parse(stdout);
      const extractedData = parsed.data || parsed;
      sessionData[sessionId] = { data: extractedData, createdAt: Date.now() };
      res.json({ success: true, sessionId: sessionId, count: extractedData.length });
    } catch (jsonError) {
      console.error("Erro ao fazer parse do JSON do parser.py:", jsonError, "Stdout:", stdout);
      return res.status(500).send("Error processing the parser output. Please check the JSON format.");
    }
  });
});

// ===================== //
// GERAR DADOS FILTRADOS //
// ===================== //
app.post("/generate", requireApiAuth, (req, res) => {
  const { day, sessionId } = req.body;

  if (!sessionId || !sessionData[sessionId]) {
    return res.status(404).send("Session expired or invalid. Please upload the file again.");
  }

  const extractedData = sessionData[sessionId].data;

  const filtered = extractedData
    .filter(e => e.day === day)
    .sort((a, b) => {
      const ka = shiftSortKey(a.start, a.end);
      const kb = shiftSortKey(b.start, b.end);
      return (ka.s - kb.s) || (ka.e - kb.e);
    });

  res.json(filtered);
});

// Ordena por início (asc) e depois por fim (asc), tratando turnos que passam da meia-noite
function timeToMinutes(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function shiftSortKey(startStr, endStr) {
  const NO_TIME = 100000;
  const s = timeToMinutes(startStr);
  let e = timeToMinutes(endStr);
  if (s === null) return { s: NO_TIME, e: NO_TIME };
  if (e !== null && e <= s) e += 24 * 60;
  return { s, e: e === null ? NO_TIME : e };
}

// ===================== //
// EXPORTAR PARA EXCEL //
// ===================== //
app.post("/export", requireApiAuth, async (req, res) => {
  const { data } = req.body;

  if (!data || !Array.isArray(data) || data.length === 0) {
    return res.status(400).send("No data to export.");
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
    // Highlight rows to match the printout: Shift = grey, Sick = soft red, Delivery = light blue
    const role = row.role || "";
    let fillColor = null;
    if (role === "Shift") fillColor = "FFCFCFCF";
    else if (role === "Sick" || role === "N/S") fillColor = "FFF2C4C4";
    else if (role === "Delivery") fillColor = "FFD4E4FB";
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
    res.status(500).send("Error generating the Excel file.");
  }
});

// ===================== //
// RELATÓRIO POR E-MAIL   //
// ===================== //
// Lista padrão de destinatários (vinda do Render) + se o envio está configurado
app.get("/report-emails", requireApiAuth, (req, res) => {
  res.json({ emails: REPORT_EMAILS, configured: EMAIL_CONFIGURED });
});

// Recebe o PDF (gerado no navegador) e envia por e-mail como anexo
app.post("/report", requireApiAuth, async (req, res) => {
  if (!EMAIL_CONFIGURED) {
    return res.status(500).send("Email is not configured on the server yet.");
  }
  const { pdfBase64, to, subject, filename } = req.body || {};
  const recipients = (Array.isArray(to) ? to : [])
    .map(e => String(e).trim()).filter(isValidEmail);

  if (!recipients.length) return res.status(400).send("Add at least one valid recipient email.");
  if (!pdfBase64)         return res.status(400).send("No report to send.");

  const subj = subject || "Schedule report";
  const fname = filename || "schedule-report.pdf";

  try {
    if (BREVO_API_KEY && EMAIL_FROM) {
      // Envio por HTTPS (recomendado no Render)
      await sendViaBrevo({ from: EMAIL_FROM, to: recipients, subject: subj, pdfBase64, filename: fname });
    } else {
      // Alternativa SMTP (Gmail) — costuma ser bloqueada no Render
      const transporter = makeTransport();
      await transporter.sendMail({
        from: EMAIL_FROM || EMAIL_USER,
        to: recipients.join(", "),
        subject: subj,
        text: "Schedule report attached.",
        attachments: [{ filename: fname, content: Buffer.from(pdfBase64, "base64"), contentType: "application/pdf" }]
      });
    }
    res.json({ success: true, sentTo: recipients });
  } catch (err) {
    console.error("Erro ao enviar e-mail:", err);
    let msg;
    if (err.brevoStatus === 401) {
      msg = "Email service rejected the API key. Check BREVO_API_KEY.";
    } else if (err.brevoStatus === 400) {
      msg = "Email rejected: " + (err.message || "") + " (is the sender EMAIL_FROM verified in Brevo?)";
    } else if (err.code === "EAUTH") {
      msg = "Login to the email account failed. Check EMAIL_USER and the Gmail App Password (EMAIL_PASS).";
    } else if (["ETIMEDOUT", "ESOCKET", "ECONNECTION", "EDNS"].includes(err.code) || /timeout|timed out/i.test(err.message || "")) {
      msg = "Could not reach the email server (connection blocked or timed out). The host may block SMTP — use a web email service (Brevo).";
    } else {
      msg = "Could not send the email: " + (err.message || "unknown error");
    }
    res.status(500).send(msg);
  }
});

// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
