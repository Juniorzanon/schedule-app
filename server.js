const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const fs = require("fs");
const { execFile } = require("child_process");

const app = express(); // 🔥 ESSENCIAL
const upload = multer({ dest: "uploads/" });

let extractedData = [];

app.use(express.static("public"));
app.use(express.json());

// UPLOAD + PYTHON PARSER
app.post("/upload", upload.single("file"), async (req, res) => {
  execFile("python", ["parser.py", req.file.path], (error, stdout) => {
    if (error) {
      console.error(error);
      return res.status(500).send("Erro no parser");
    }

    extractedData = JSON.parse(stdout);

    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    res.json({ days });
  });
});

// GERAR ESCALA
app.post("/generate", (req, res) => {
  const { day } = req.body;

  const filtered = extractedData
    .filter(e => e.day === day)
    .sort((a, b) => a.start.localeCompare(b.start));

  res.json(filtered);
});

// EXPORTAR EXCEL
app.post("/export", async (req, res) => {
  const { data } = req.body;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Schedule");

  sheet.columns = [
    { header: "Name", key: "name" },
    { header: "Start", key: "start" },
    { header: "End", key: "end" }
  ];

  data.forEach(row => sheet.addRow(row));

  const filePath = "schedule.xlsx";
  await workbook.xlsx.writeFile(filePath);

  res.download(filePath);
});

// START
app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});