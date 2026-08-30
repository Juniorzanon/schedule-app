const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

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
app.use(express.static("public"));
app.use(express.json());

// ===================== //
// UPLOAD E PROCESSAMENTO //
// ===================== //
app.post("/upload", upload.single("file"), (req, res) => {
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
app.post("/generate", (req, res) => {
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
app.post("/export", async (req, res) => {
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
    // Highlight Shift Manager rows in grey to match the printout
    if ((row.role || "") === "SH") {
      added.eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFCFCFCF" } };
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
