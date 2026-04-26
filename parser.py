import pdfplumber
import pandas as pd
import sys
import json

pdf_path = sys.argv[1]

result = []

days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

with pdfplumber.open(pdf_path) as pdf:
    for page in pdf.pages:
        table = page.extract_table()

        if not table:
            continue

        for row in table:
            if not row or not row[0]:
                continue

            name = row[0]

            for i in range(1, len(row)):
                cell = row[i]

                if cell and "-" in cell:
                    times = cell.split("-")
                    start = times[0].strip()
                    end = times[1].strip()

                    result.append({
                        "name": name,
                        "day": days[i-1],
                        "start": start,
                        "end": end
                    })

print(json.dumps(result))