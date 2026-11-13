"""Edit workbooks the way a person would, through LibreOffice itself, and save the recalculated result.

Used by tests/workbook.test.ts to check what happens when a buyer inserts or removes rows on the Rules sheet:
only a spreadsheet application adjusts the formulas around an inserted row, so the edit has to be made in one.

    python3 edit_workbook.py jobs.json

jobs.json: {"profileDir": "/abs/dir", "jobs": [{"input": "/abs/in.xlsx", "output": "/abs/out.xlsx", "ops": [...]}]}

ops (rows and cells are written as in the application, 1-based):
    {"op": "set", "sheet": "Planner", "cell": "C12", "value": 15000}      number or text
    {"op": "insertRows", "sheet": "Rules", "before": 18, "count": 1}      new rows take this row number
    {"op": "removeRows", "sheet": "Rules", "row": 18, "count": 1}
    {"op": "copy", "sheet": "Rules", "from": "E17:G17", "to": "E18"}      copy cells (formulas adjust as in a paste)

Needs the `uno` Python module that ships with LibreOffice. Exits with status 3 when it is not available.
"""
import json
import os
import subprocess
import sys
import time

try:
    import uno
    from com.sun.star.beans import PropertyValue
except ImportError:  # pragma: no cover - depends on the machine
    sys.stderr.write("python uno module not available\n")
    sys.exit(3)


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def apply(doc, op):
    sheet = doc.Sheets.getByName(op["sheet"])
    kind = op["op"]
    if kind == "set":
        cell = sheet.getCellRangeByName(op["cell"])
        value = op["value"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            cell.setString(str(value))
        else:
            cell.setValue(value)
    elif kind == "insertRows":
        sheet.Rows.insertByIndex(op["before"] - 1, op.get("count", 1))
    elif kind == "removeRows":
        sheet.Rows.removeByIndex(op["row"] - 1, op.get("count", 1))
    elif kind == "copy":
        source = sheet.getCellRangeByName(op["from"]).RangeAddress
        target = sheet.getCellRangeByName(op["to"]).CellAddress
        sheet.copyRange(target, source)
    else:
        raise ValueError("unknown op: %s" % kind)


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        spec = json.load(handle)
    port = 20000 + os.getpid() % 20000
    office = subprocess.Popen(
        [
            "soffice",
            "-env:UserInstallation=file://" + spec["profileDir"],
            "--headless",
            "--norestore",
            "--nologo",
            "--accept=socket,host=127.0.0.1,port=%d;urp;" % port,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        context = None
        for _ in range(120):
            try:
                context = resolver.resolve("uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % port)
                break
            except Exception:
                time.sleep(0.5)
        if context is None:
            raise SystemExit("could not connect to LibreOffice")
        desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        for job in spec["jobs"]:
            doc = desktop.loadComponentFromURL("file://" + job["input"], "_blank", 0, (prop("Hidden", True),))
            try:
                for op in job["ops"]:
                    apply(doc, op)
                doc.calculateAll()
                doc.storeToURL("file://" + job["output"], (prop("FilterName", "Calc MS Excel 2007 XML"),))
            finally:
                doc.close(True)
    finally:
        office.terminate()
        try:
            office.wait(timeout=15)
        except Exception:
            office.kill()


if __name__ == "__main__":
    main()
