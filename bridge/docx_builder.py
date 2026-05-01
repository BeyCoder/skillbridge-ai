#!/usr/bin/env python3
"""Deterministic DOCX builder for SkillBridge AI tailored applications.

Uses only Python standard library so the bridge does not depend on python-docx,
LibreOffice, Poppler, or GUI renderers during normal tailoring.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


FONT = "Arial"


def clean(value: object, limit: int = 2000) -> str:
    text = str(value or "")
    replacements = {
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2212": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u00a0": " ",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    text = " ".join(text.replace("\r", "\n").split())
    return text[:limit]


def xml_text(value: object) -> str:
    return escape(clean(value), {'"': "&quot;"})


def zip_info(name: str) -> ZipInfo:
    info = ZipInfo(name)
    info.date_time = (2026, 1, 1, 0, 0, 0)
    info.compress_type = ZIP_DEFLATED
    return info


def run(text: object, *, bold: bool = False, size: int = 20) -> str:
    bold_xml = "<w:b/>" if bold else ""
    return (
        "<w:r><w:rPr>"
        f"{bold_xml}<w:rFonts w:ascii=\"{FONT}\" w:hAnsi=\"{FONT}\"/>"
        f"<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/>"
        "</w:rPr>"
        f"<w:t xml:space=\"preserve\">{xml_text(text)}</w:t>"
        "</w:r>"
    )


def paragraph(
    runs: list[str] | str,
    *,
    align: str | None = None,
    before: int = 0,
    after: int = 0,
    line: int = 220,
    border: bool = False,
    indent_left: int = 0,
    hanging: int = 0,
    keep_next: bool = False,
) -> str:
    if isinstance(runs, str):
        body = runs
    else:
        body = "".join(runs)
    props = [f'<w:spacing w:before="{before}" w:after="{after}" w:line="{line}" w:lineRule="auto"/>']
    if align:
        props.append(f'<w:jc w:val="{align}"/>')
    if border:
        props.append('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="666666"/></w:pBdr>')
    if indent_left or hanging:
        props.append(f'<w:ind w:left="{indent_left}" w:hanging="{hanging}"/>')
    if keep_next:
        props.append("<w:keepNext/>")
    return f"<w:p><w:pPr>{''.join(props)}</w:pPr>{body}</w:p>"


def section_heading(text: str) -> str:
    return paragraph(run(text, bold=True, size=19), before=70, after=20, line=200, border=True, keep_next=True)


def normal_line(text: str, *, bold: bool = False, size: int = 18, after: int = 16) -> str:
    return paragraph(run(text, bold=bold, size=size), after=after, line=205)


def bullet(text: str) -> str:
    line = clean(text, 320)
    if not line.startswith("-"):
        line = f"- {line}"
    return paragraph(run(line, size=18), after=12, line=205, indent_left=260, hanging=180)


def document_xml(body: str, *, margin: int = 540) -> str:
    section = (
        "<w:sectPr>"
        '<w:pgSz w:w="12240" w:h="15840"/>'
        f'<w:pgMar w:top="{margin}" w:right="{margin}" w:bottom="{margin}" w:left="{margin}" '
        'w:header="360" w:footer="360" w:gutter="0"/>'
        "</w:sectPr>"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<w:body>{body}{section}</w:body></w:document>"
    )


def build_resume(content: dict) -> str:
    resume = content.get("resume") or {}
    parts: list[str] = [
        paragraph(run(resume.get("name") or "Applicant Name", bold=True, size=34), align="center", after=10, line=220),
        paragraph(run(resume.get("contactLine") or "", size=17), align="center", after=75, line=205),
        section_heading("TECHNICAL SKILLS"),
    ]

    for group in resume.get("technicalSkills") or []:
        if not isinstance(group, dict):
            continue
        label = clean(group.get("label"), 120)
        items = [clean(item, 100) for item in (group.get("items") or []) if clean(item, 100)]
        if not label or not items:
            continue
        parts.append(paragraph([run(f"{label}:", bold=True, size=18), run(f" {', '.join(items)}", size=18)], after=14, line=205))

    parts.append(section_heading("EDUCATION"))
    for line in resume.get("education") or []:
        if clean(line):
            parts.append(normal_line(line, size=18, after=14))

    section_map = {
        "PROFESSIONAL EXPERIENCE": resume.get("professionalExperience") or [],
        "VOLUNTEERING EXPERIENCE": resume.get("volunteeringExperience") or [],
    }
    order = [clean(item).upper() for item in (resume.get("experienceSectionOrder") or [])]
    if set(order) != set(section_map):
        order = ["PROFESSIONAL EXPERIENCE", "VOLUNTEERING EXPERIENCE"]

    for section in order:
        parts.append(section_heading(section))
        for item in section_map.get(section, []):
            if not isinstance(item, dict):
                continue
            heading = clean(item.get("heading"), 240)
            date_range = clean(item.get("dateRange"), 80)
            if heading:
                parts.append(normal_line(f"{heading} | {date_range}" if date_range else heading, bold=True, size=18, after=10))
            for point in (item.get("bullets") or [])[:6]:
                if clean(point):
                    parts.append(bullet(point))

    return document_xml("".join(parts), margin=520)


def build_cover_letter(content: dict) -> str:
    letter = content.get("coverLetter") or {}
    parts: list[str] = [
        paragraph(run(letter.get("greeting") or "Dear Hiring Committee,", size=21), after=180, line=250),
    ]
    for text in (letter.get("paragraphs") or [])[:8]:
        if clean(text):
            parts.append(paragraph(run(text, size=21), after=150, line=250))
    parts.extend([
        paragraph(run(letter.get("closing") or "Sincerely,", size=21), after=80, line=250),
        paragraph(run(letter.get("signature") or "Applicant Name", size=21), after=0, line=250),
    ])
    return document_xml("".join(parts), margin=720)


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"""

STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>"""

SETTINGS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>
</w:settings>"""

APP = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>SkillBridge AI</Application>
</Properties>"""


def core() -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>SkillBridge AI</dc:creator>
  <cp:lastModifiedBy>SkillBridge AI</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>"""


def write_docx(path: Path, document: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w") as docx:
        for name, data in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", RELS),
            ("word/document.xml", document),
            ("word/_rels/document.xml.rels", DOC_RELS),
            ("word/styles.xml", STYLES),
            ("word/settings.xml", SETTINGS),
            ("docProps/core.xml", core()),
            ("docProps/app.xml", APP),
        ]:
            docx.writestr(zip_info(name), data)


def main() -> int:
    if len(sys.argv) != 4:
        print("Usage: docx_builder.py content.json resume.docx cover_letter.docx", file=sys.stderr)
        return 2

    content_path = Path(sys.argv[1])
    resume_path = Path(sys.argv[2])
    cover_path = Path(sys.argv[3])
    content = json.loads(content_path.read_text(encoding="utf-8"))
    write_docx(resume_path, build_resume(content))
    write_docx(cover_path, build_cover_letter(content))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
