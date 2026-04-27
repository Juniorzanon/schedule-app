const express = require("express");
const multer = require("multer");
const fs = require("fs");
const ExcelJS = require("exceljs");
const pdf = require("pdf-parse");
const path = require("path");

const app = express();

// =====================
// UPLOAD CONFIG
// =====================
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const upload = multer({ dest: "uploads/" });

// =====================
// MIDDLEWARE
// =====================
app.use(express.static("."));
app.use(express.json());

// =====================
// DATA GLOBAL
// =====================
let extractedData = [];

// =====================
// UPLOAD + PARSER
// =====================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdf(dataBuffer);

    let text = data.text;

    console.log("===== RAW TEXT START =====");
    console.log(text);
    console.log("===== RAW TEXT END =====");

    extractedData = [];

    // Normalização básica preservando linhas
    text = text.replace(/\r\n/g, "\n");

    // Identificar blocos de dias
    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const dayMap = {
      Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", 
      Friday: "Fri", Saturday: "Sat", Sunday: "Sun"
    };

    // Encontrar posições de cada dia no texto
    let dayPositions = [];
    dayNames.forEach(day => {
      const regex = new RegExp(day, "gi");
      let match;
      while ((match = regex.exec(text)) !== null) {
        dayPositions.push({ day: dayMap[day] || day.slice(0, 3), index: match.index });
      }
    });

    // Ordenar posições por índice
    dayPositions.sort((a, b) => a.index - b.index);

    if (dayPositions.length === 0) {
      // Se não achar dias, tenta processar o texto todo como segunda
      parseRobust(text, "Mon");
    } else {
      for (let i = 0; i < dayPositions.length; i++) {
        const start = dayPositions[i].index;
        const end = dayPositions[i + 1] ? dayPositions[i + 1].index : text.length;
        const block = text.slice(start, end);
        parseRobust(block, dayPositions[i].day);
      }
    }

    // Remover duplicatas exatas (nome, dia, inicio, fim)
    extractedData = extractedData.filter((v, i, a) => 
      a.findIndex(t => (t.name === v.name && t.day === v.day && t.start === v.start && t.end === v.end)) === i
    );

    console.log(`===== TOTAL EXTRACTED: ${extractedData.length} entries =====`);

    fs.unlinkSync(req.file.path);
    res.json({ success: true, count: extractedData.length });

  } catch (err) {
    console.error("PARSE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function parseRobust(textBlock, day) {
  // Dividir por linhas e limpar
  const lines = textBlock.split("\n").map(l => l.trim()).filter(l => l.length > 5);

  lines.forEach(line => {
    // 1. Procurar por horários no formato HH:MM ou HHMM
    // Captura sequências de 4 dígitos ou dígitos com dois pontos
    const timeRegex = /(\d{2}[:\s]?\d{2})/g;
    const timesFound = line.match(timeRegex);

    if (timesFound && timesFound.length >= 2) {
      // Limpar os horários encontrados (remover espaços, adicionar : se necessário)
      const cleanTimes = timesFound.map(t => {
        let clean = t.replace(/\s/g, "");
        if (!clean.includes(":") && clean.length === 4) {
          clean = clean.slice(0, 2) + ":" + clean.slice(2);
        }
        return clean;
      }).filter(t => t.includes(":") && t.length === 5);

      if (cleanTimes.length >= 2) {
        // 2. Extrair o nome
        // O nome geralmente vem ANTES dos horários. 
        // Vamos pegar tudo que vem antes do primeiro horário e limpar números.
        const firstTime = timesFound[0];
        const firstTimeIndex = line.indexOf(firstTime);
        let potentialName = line.slice(0, firstTimeIndex).trim();

        // Se o nome estiver vazio, talvez a estrutura seja diferente, ignoramos
        if (potentialName.length < 2) return;

        // Limpeza agressiva do nome:
        // Remove qualquer sequência de 4 dígitos (que seriam horários que sobraram)
        // Remove caracteres especiais e números isolados
        let cleanName = potentialName
          .replace(/\d{4}/g, "") // Remove horários colados
          .replace(/\d/g, "")    // Remove qualquer dígito que sobrou
          .replace(/[-_]/g, " ") // Remove traços
          .replace(/\s+/g, " ")  // Normaliza espaços
          .trim();

        // Só adiciona se o nome for válido (não apenas símbolos)
        if (cleanName.length > 2) {
          extractedData.push({
            name: cleanName,
            start: cleanTimes[0],
            end: cleanTimes[cleanTimes.length - 1],
            day: day
          });
        }
      }
    }
  });
}

// =====================
// GENERATE
// =====================
app.post("/generate", (req, res) => {
  const { day } = req.body;
  const filtered = extractedData
    .filter(e => e.day === day)
    .sort((a, b) => a.start.localeCompare(b.start));
  res.json(filtered);
});

// =====================
// EXPORT
// =====================
app.post("/export", async (req, res) => {
  const { data } = req.body;
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
    sheet.addRow({ name: row.name, start: row.start, end: row.end, break30: "", break15: "" });
  });
  const filePath = "schedule.xlsx";
  await workbook.xlsx.writeFile(filePath);
  res.download(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});