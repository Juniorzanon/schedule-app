const express = require("express");
const multer = require("multer");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require('uuid'); // Para gerar IDs únicos
const cors = require('cors'); // Para lidar com CORS

const app = express();

// Configuração do Multer para upload de arquivos
const upload = multer({ dest: "uploads/" });

// Cria a pasta 'uploads' se não existir
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Armazenamento temporário de dados por sessão (em um ambiente real, use um banco de dados ou sistema de sessão)
const sessionData = {}; // { sessionId: extractedData }

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

  const filePath = req.file.path;
  const sessionId = uuidv4(); // Gera um ID de sessão único para este upload

  execFile("python", ["parser.py", filePath], (error, stdout, stderr) => {
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
      sessionData[sessionId] = parsed.data || parsed; // Armazena os dados com o ID da sessão
      res.json({ success: true, sessionId: sessionId });
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
    return res.status(404).send("Dados da sessão não encontrados ou inválidos.");
  }

  const extractedData = sessionData[sessionId];

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
    { header: "Name", key: "name", width: 30 },
    { header: "Start", key: "start", width: 15 },
    { header: "End", key: "end", width: 15 },
    { header: "Break 30", key: "break30", width: 15 },
    { header: "Break 15", key: "break15", width: 15 }
  ];

  data.forEach(row => {
    sheet.addRow({
      name: row.name,
      start: row.start,
      end: row.end,
      break30: "", // Assumindo que estes campos são preenchidos posteriormente ou não são relevantes para a exportação atual
      break15: ""
    });
  });

  const fileName = `schedule-${uuidv4()}.xlsx`; // Nome de arquivo único
  const filePath = fileName;

  try {
    await workbook.xlsx.writeFile(filePath);
    res.download(filePath, "schedule.xlsx", (err) => {
      if (err) {
        console.error("Erro ao enviar o arquivo para download:", err);
        // Se o download falhar, o arquivo temporário ainda precisa ser limpo
      }
      // Limpa o arquivo temporário após o download (ou tentativa de download)
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error("Erro ao excluir o arquivo temporário de exportação:", unlinkErr);
      });
    });
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