const express = require("express");
const multer = require("multer");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { execFile } = require("child_process");

const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const app = express();

app.use(express.static("public"));
app.use(express.json());

let extractedData = [];

// =====================
// UPLOAD
// =====================
app.post("/upload", upload.single("file"), (req, res) => {
  execFile("python", ["parser.py", req.file.path], (error, stdout) => {
    if (error) {
      console.error(error);
      return res.status(500).send("Parser error");
    }

    const parsed = JSON.parse(stdout);
    extractedData = parsed.data || parsed;

    res.json({ success: true });
  });
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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});