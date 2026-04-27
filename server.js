const express = require("express");
const multer = require("multer");
const fs = require("fs");
const ExcelJS = require("exceljs");
const pdf = require("pdf-parse");

const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const app = express();

app.use(express.static("public"));
app.use(express.json());

let extractedData = [];

// =====================
// UPLOAD (AGORA EM JS)
// =====================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdf(dataBuffer);

    const lines = data.text.split("\n");

    extractedData = [];

    lines.forEach(line => {
      const match = line.match(/(.+?)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);

      if (match) {
        extractedData.push({
          name: match[1].trim(),
          start: match[2],
          end: match[3],
          day: "Mon" // temporário (vamos melhorar depois)
        });
      }
    });

    console.log("Parsed:", extractedData.length, "rows");

    res.json({ success: true });

  } catch (err) {
    console.error("PDF parse error:", err);
    res.status(500).send("Error parsing PDF");
  }
});

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
    sheet.addRow({
      name: row.name,
      start: row.start,
      end: row.end,
      break30: "",
      break15: ""
    });
  });

  const filePath = "schedule.xlsx";
  await workbook.xlsx.writeFile(filePath);

  res.download(filePath);
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});