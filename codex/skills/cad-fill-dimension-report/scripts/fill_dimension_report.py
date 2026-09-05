#!/usr/bin/env python3
"""Fill only the 尺寸报告 worksheet from DWG dimension specifications."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_DOC_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
XML_NS = "http://www.w3.org/XML/1998/namespace"
SHEET_NAME = "尺寸报告"
NUM_PATTERN = r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)"
MATCH_QUANTUM = Decimal("0.000001")
CELL_REF_RE = re.compile(r"^([A-Z]+)([0-9]+)$")
ITEM_RE = re.compile(r"^A\s*[0-9]+$", re.IGNORECASE)
DIMENSION_ENTITIES = {
    "DIMENSION_LINEAR",
    "DIMENSION_ALIGNED",
    "DIMENSION_ANG2LN",
    "DIMENSION_ANG3PT",
    "DIMENSION_DIAMETER",
    "DIMENSION_RADIUS",
    "DIMENSION_ORDINATE",
    "DIMENSION_ARC",
}


def qname(local: str) -> str:
    return f"{{{MAIN_NS}}}{local}"


def decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def decimal_json(value: Optional[Decimal]) -> Optional[str]:
    return None if value is None else decimal_text(value)


def nominal_key(value: Decimal) -> Decimal:
    return value.quantize(MATCH_QUANTUM)


def to_decimal(value: Any) -> Optional[Decimal]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return (
        str(value)
        .replace("﹢", "+")
        .replace("＋", "+")
        .replace("－", "-")
        .replace("／", "/")
        .replace("％", "%")
        .replace("\u3000", " ")
        .strip()
    )


def clean_mtext(value: Any) -> str:
    text = normalize_text(value)
    text = re.sub(r"%%[pP]", "±", text)
    text = re.sub(r"%%[cC]", "∅", text)
    text = re.sub(r"%%[dD]", "°", text)

    def unstack(match: re.Match[str]) -> str:
        return match.group(1).replace("^", "/").replace("#", "/")

    text = re.sub(r"\\S([^;]*);", unstack, text)
    text = text.replace("\\P", "\n").replace("\\~", " ")
    text = re.sub(r"\\p[^;]*;", "\n", text)
    text = re.sub(r"\\[A-Za-z][^;{}]*;", "", text)
    text = re.sub(r"\\[LlOoKk]", "", text)
    text = text.replace("{", "").replace("}", "")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


@dataclass(frozen=True)
class ParsedSpec:
    kind: str
    nominal: Decimal
    nominal_source: str
    upper: Optional[Decimal]
    upper_source: Optional[str]
    lower: Optional[Decimal]
    lower_source: Optional[str]

    @property
    def signature(self) -> Tuple[str, Decimal, Optional[Decimal], Optional[Decimal]]:
        return self.kind, self.nominal, self.upper, self.lower

    @property
    def tolerance_signature(self) -> Tuple[str, Optional[Decimal], Optional[Decimal]]:
        return self.kind, self.upper, self.lower

    @property
    def tolerance_text(self) -> str:
        if self.kind == "sym":
            return f"±{self.upper_source}"
        if self.kind == "asym":
            return f"+{self.upper_source}/-{self.lower_source}"
        if self.kind == "min":
            return "Min."
        if self.kind == "max":
            return "Max."
        raise ValueError(f"Unsupported specification kind: {self.kind}")


@dataclass(frozen=True)
class CadOccurrence:
    spec: ParsedSpec
    raw_text: str
    clean_text: str
    entity_type: str
    owner_block: str
    layer: str
    handle: str
    json_index: Any
    position: Tuple[Any, Any, Any]

    @property
    def priority(self) -> int:
        if self.entity_type == "MTEXT" and self.owner_block.startswith("*D"):
            return 0
        if self.entity_type in DIMENSION_ENTITIES:
            return 1
        if self.entity_type == "MTEXT":
            return 2
        return 3


def parse_specs(value: Any) -> List[ParsedSpec]:
    text = clean_mtext(value)
    specs: List[ParsedSpec] = []
    prefix = r"(?:[∅Ø⌀Φφ]\s*)?"

    asym = re.compile(
        rf"(?<![0-9.]){prefix}({NUM_PATTERN})\s*\+\s*({NUM_PATTERN})\s*/\s*-\s*({NUM_PATTERN})",
        re.IGNORECASE,
    )
    sym = re.compile(
        rf"(?<![0-9.]){prefix}({NUM_PATTERN})\s*±\s*({NUM_PATTERN})",
        re.IGNORECASE,
    )
    minimum = re.compile(
        rf"(?<![0-9.]){prefix}({NUM_PATTERN})\s*(?:MM\s*)?MIN\.?",
        re.IGNORECASE,
    )
    maximum = re.compile(
        rf"(?<![0-9.]){prefix}({NUM_PATTERN})\s*(?:MM\s*)?MAX\.?",
        re.IGNORECASE,
    )

    for match in asym.finditer(text):
        nominal, upper, lower = match.groups()
        specs.append(
            ParsedSpec(
                "asym",
                Decimal(nominal),
                nominal,
                Decimal(upper),
                upper,
                Decimal(lower),
                lower,
            )
        )
    for match in sym.finditer(text):
        nominal, tolerance = match.groups()
        specs.append(
            ParsedSpec(
                "sym",
                Decimal(nominal),
                nominal,
                Decimal(tolerance),
                tolerance,
                Decimal(tolerance),
                tolerance,
            )
        )
    for match in minimum.finditer(text):
        nominal = match.group(1)
        specs.append(ParsedSpec("min", Decimal(nominal), nominal, None, None, None, None))
    for match in maximum.finditer(text):
        nominal = match.group(1)
        specs.append(ParsedSpec("max", Decimal(nominal), nominal, None, None, None, None))
    return specs


def parse_tolerance(value: Any) -> Optional[Tuple[str, Optional[Decimal], Optional[Decimal]]]:
    text = normalize_text(value).replace(" ", "")
    if not text:
        return None
    match = re.search(rf"±({NUM_PATTERN})", text)
    if match:
        tolerance = Decimal(match.group(1))
        return "sym", tolerance, tolerance
    match = re.search(rf"\+({NUM_PATTERN})/-({NUM_PATTERN})", text)
    if match:
        return "asym", Decimal(match.group(1)), Decimal(match.group(2))
    if "MIN" in text.upper():
        return "min", None, None
    if "MAX" in text.upper():
        return "max", None, None
    return None


def replace_nonstandard_json_numbers(text: str) -> Tuple[str, int]:
    out: List[str] = []
    in_string = False
    escaped = False
    index = 0
    replacements = 0
    tokens = ("-nan", "+nan", "nan", "-inf", "+inf", "inf")
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        matched = ""
        for token in tokens:
            end = index + len(token)
            if text[index:end].lower() != token:
                continue
            previous = text[index - 1] if index else ""
            following = text[end] if end < len(text) else ""
            if not (previous.isalnum() or previous == "_") and not (
                following.isalnum() or following == "_"
            ):
                matched = token
                break
        if matched:
            out.append("null")
            index += len(matched)
            replacements += 1
        else:
            out.append(char)
            index += 1
    return "".join(out), replacements


def iter_libredwg_objects(path: Path) -> Iterator[Tuple[Dict[str, Any], int]]:
    in_objects = False
    buffer: List[str] = []
    object_number = 0
    start_line = 0
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not in_objects:
                if re.match(r'^\s*"OBJECTS"\s*:\s*\[', line):
                    in_objects = True
                continue
            if not buffer:
                if line.startswith("    {"):
                    buffer = [line]
                    start_line = line_number
                elif line.startswith("  ]"):
                    return
                continue
            buffer.append(line)
            if not line.startswith("    }"):
                continue
            object_number += 1
            raw = "".join(buffer).rstrip().rstrip(",")
            buffer = []
            if '"entity"' not in raw and not re.search(
                r'"object"\s*:\s*"(?:LAYER|BLOCK_HEADER)"', raw
            ):
                continue
            cleaned, replacements = replace_nonstandard_json_numbers(raw)
            try:
                obj = json.loads(cleaned)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"Cannot parse LibreDWG object {object_number} starting at line {start_line}: {exc}"
                ) from exc
            yield obj, replacements
    raise RuntimeError(f"OBJECTS array was not completed in {path}")


def reference_number(value: Any) -> Optional[int]:
    if isinstance(value, list):
        for item in reversed(value):
            if isinstance(item, int) and not isinstance(item, bool):
                return item
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def entity_text(obj: Dict[str, Any]) -> str:
    entity_type = str(obj.get("entity", ""))
    if entity_type == "TEXT":
        return str(obj.get("text_value", "") or obj.get("text", "") or "")
    if entity_type == "MTEXT":
        return str(obj.get("text", "") or "")
    if entity_type in {"MULTILEADER", "MLEADER"}:
        return str(obj.get("ctx.content.txt.default_text", "") or "")
    if entity_type in DIMENSION_ENTITIES:
        text = str(obj.get("user_text", "") or "")
        measurement = obj.get("act_measurement")
        if text and measurement is not None:
            text = text.replace("<>", str(measurement))
        return text
    return ""


def entity_position(obj: Dict[str, Any]) -> Tuple[Any, Any, Any]:
    for key in (
        "text_midpt",
        "ins_pt",
        "def_pt",
        "ctx.content.txt.location",
        "ctx.location",
    ):
        value = obj.get(key)
        if isinstance(value, list) and value:
            coords = list(value[:3])
            while len(coords) < 3:
                coords.append(None)
            return tuple(coords)  # type: ignore[return-value]
    return None, None, None


def extract_cad_specs(json_path: Path) -> Tuple[List[CadOccurrence], Dict[str, Any]]:
    layers: Dict[int, str] = {}
    blocks: Dict[int, str] = {}
    candidate_entities: List[Dict[str, Any]] = []
    replacements = 0
    object_records = 0

    for obj, replaced in iter_libredwg_objects(json_path):
        replacements += replaced
        object_records += 1
        handle = reference_number(obj.get("handle"))
        if obj.get("object") == "LAYER" and handle is not None:
            layers[handle] = str(obj.get("name", ""))
            continue
        if obj.get("object") == "BLOCK_HEADER" and handle is not None:
            blocks[handle] = str(obj.get("name", ""))
            continue
        entity_type = str(obj.get("entity", ""))
        if entity_type not in {"TEXT", "MTEXT", "MULTILEADER", "MLEADER"} | DIMENSION_ENTITIES:
            continue
        raw_text = entity_text(obj)
        if not raw_text:
            continue
        candidate_entities.append(
            {
                "entity_type": entity_type,
                "raw_text": raw_text,
                "owner": reference_number(obj.get("ownerhandle")),
                "layer": reference_number(obj.get("layer")),
                "handle": handle,
                "json_index": obj.get("index"),
                "position": entity_position(obj),
            }
        )

    occurrences: List[CadOccurrence] = []
    for entity in candidate_entities:
        clean_text = clean_mtext(entity["raw_text"])
        owner_block = blocks.get(entity["owner"], "")
        layer = layers.get(entity["layer"], "")
        handle = "" if entity["handle"] is None else f"{entity['handle']:X}"
        for spec in parse_specs(entity["raw_text"]):
            occurrences.append(
                CadOccurrence(
                    spec=spec,
                    raw_text=entity["raw_text"],
                    clean_text=clean_text,
                    entity_type=entity["entity_type"],
                    owner_block=owner_block,
                    layer=layer,
                    handle=handle,
                    json_index=entity["json_index"],
                    position=entity["position"],
                )
            )
    stats = {
        "parsed_object_records": object_records,
        "candidate_text_entities": len(candidate_entities),
        "spec_occurrences": len(occurrences),
        "unique_specifications": len({item.spec.signature for item in occurrences}),
        "nan_inf_replacements": replacements,
    }
    return occurrences, stats


def find_dwgread(requested: Optional[str]) -> str:
    if requested:
        resolved = shutil.which(requested)
        if resolved:
            return resolved
        path = Path(requested)
        if path.is_file():
            return str(path)
        raise FileNotFoundError(f"dwgread not found: {requested}")
    for candidate in (
        shutil.which("dwgread"),
        "/opt/homebrew/bin/dwgread",
        "/usr/local/bin/dwgread",
    ):
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise FileNotFoundError("LibreDWG dwgread is required but was not found")


def export_dwg_json(dwg: Path, json_path: Path, executable: str) -> Path:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = json_path.with_suffix(json_path.suffix + ".dwgread.log")
    process = subprocess.run(
        [executable, "-O", "JSON", "-o", str(json_path), str(dwg)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    log_path.write_text((process.stdout or "") + (process.stderr or ""), encoding="utf-8")
    if process.returncode != 0 or not json_path.is_file() or json_path.stat().st_size == 0:
        raise RuntimeError(
            f"dwgread failed with exit code {process.returncode}; see {log_path}"
        )
    return log_path


def register_namespaces(data: bytes) -> None:
    for _, item in ET.iterparse(io.BytesIO(data), events=("start-ns",)):
        prefix, uri = item
        if prefix == "xml" or re.fullmatch(r"ns[0-9]+", prefix or ""):
            continue
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            continue


def parse_xml(data: bytes) -> ET.Element:
    register_namespaces(data)
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    return ET.fromstring(data, parser=parser)


def serialize_xml(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def resolve_sheet_path(parts: Dict[str, bytes], sheet_name: str) -> Tuple[str, ET.Element]:
    workbook_path = "xl/workbook.xml"
    relationships_path = "xl/_rels/workbook.xml.rels"
    workbook_root = parse_xml(parts[workbook_path])
    sheets = workbook_root.find(qname("sheets"))
    if sheets is None:
        raise RuntimeError("Workbook has no sheets collection")
    relationship_id = ""
    for sheet in sheets:
        if sheet.get("name") == sheet_name:
            relationship_id = sheet.get(f"{{{REL_DOC_NS}}}id", "")
            break
    if not relationship_id:
        raise RuntimeError(f"Workbook does not contain worksheet {sheet_name!r}")
    relationships_root = parse_xml(parts[relationships_path])
    target = ""
    for relationship in relationships_root.findall(f"{{{REL_PKG_NS}}}Relationship"):
        if relationship.get("Id") == relationship_id:
            target = relationship.get("Target", "")
            break
    if not target:
        raise RuntimeError(f"Cannot resolve relationship for worksheet {sheet_name!r}")
    if target.startswith("/"):
        sheet_path = target.lstrip("/")
    else:
        sheet_path = posixpath.normpath(posixpath.join("xl", target))
    if sheet_path not in parts:
        raise RuntimeError(f"Worksheet package part not found: {sheet_path}")
    return sheet_path, workbook_root


def shared_strings(parts: Dict[str, bytes]) -> List[str]:
    path = "xl/sharedStrings.xml"
    if path not in parts:
        return []
    root = parse_xml(parts[path])
    values: List[str] = []
    for item in root.findall(qname("si")):
        values.append("".join(node.text or "" for node in item.iter(qname("t"))))
    return values


def column_number(letters: str) -> int:
    value = 0
    for char in letters:
        value = value * 26 + ord(char.upper()) - ord("A") + 1
    return value


def column_letters(number: int) -> str:
    letters = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def cell_value(cell: ET.Element, strings: Sequence[str]) -> Any:
    cell_type = cell.get("t", "")
    if cell_type == "inlineStr":
        inline = cell.find(qname("is"))
        if inline is None:
            return ""
        return "".join(node.text or "" for node in inline.iter(qname("t")))
    value_node = cell.find(qname("v"))
    text = "" if value_node is None or value_node.text is None else value_node.text
    if cell_type == "s":
        try:
            return strings[int(text)]
        except (ValueError, IndexError):
            return ""
    if cell_type in {"str", "e", "d"}:
        return text
    if cell_type == "b":
        return text == "1"
    return to_decimal(text)


def cell_maps(
    sheet_root: ET.Element, strings: Sequence[str]
) -> Tuple[Dict[str, ET.Element], Dict[str, Any], Dict[int, ET.Element]]:
    cells: Dict[str, ET.Element] = {}
    values: Dict[str, Any] = {}
    rows: Dict[int, ET.Element] = {}
    sheet_data = sheet_root.find(qname("sheetData"))
    if sheet_data is None:
        raise RuntimeError("Dimension worksheet has no sheetData")
    for row in sheet_data.findall(qname("row")):
        row_number = int(row.get("r", "0"))
        rows[row_number] = row
        for cell in row.findall(qname("c")):
            coordinate = cell.get("r", "").upper()
            if not coordinate:
                continue
            cells[coordinate] = cell
            values[coordinate] = cell_value(cell, strings)
    return cells, values, rows


def get_or_create_cell(
    coordinate: str,
    cells: Dict[str, ET.Element],
    rows: Dict[int, ET.Element],
    sheet_root: ET.Element,
) -> ET.Element:
    coordinate = coordinate.upper()
    if coordinate in cells:
        return cells[coordinate]
    match = CELL_REF_RE.match(coordinate)
    if not match:
        raise ValueError(f"Invalid cell coordinate: {coordinate}")
    column, row_text = match.groups()
    row_number = int(row_text)
    row = rows.get(row_number)
    if row is None:
        sheet_data = sheet_root.find(qname("sheetData"))
        if sheet_data is None:
            raise RuntimeError("Dimension worksheet has no sheetData")
        row = ET.Element(qname("row"), {"r": str(row_number)})
        inserted = False
        for index, existing in enumerate(sheet_data.findall(qname("row"))):
            if int(existing.get("r", "0")) > row_number:
                sheet_data.insert(index, row)
                inserted = True
                break
        if not inserted:
            sheet_data.append(row)
        rows[row_number] = row
    cell = ET.Element(qname("c"), {"r": coordinate})
    target_column = column_number(column)
    inserted = False
    for index, existing in enumerate(row.findall(qname("c"))):
        existing_match = CELL_REF_RE.match(existing.get("r", ""))
        if existing_match and column_number(existing_match.group(1)) > target_column:
            row.insert(index, cell)
            inserted = True
            break
    if not inserted:
        row.append(cell)
    cells[coordinate] = cell
    return cell


def remove_payload(cell: ET.Element) -> None:
    for child in list(cell):
        if child.tag in {qname("f"), qname("v"), qname("is")}:
            cell.remove(child)


def append_payload(cell: ET.Element, child: ET.Element) -> None:
    for index, existing in enumerate(list(cell)):
        if existing.tag == qname("extLst"):
            cell.insert(index, child)
            return
    cell.append(child)


def write_text_cell(cell: ET.Element, value: str) -> None:
    remove_payload(cell)
    cell.set("t", "inlineStr")
    inline = ET.Element(qname("is"))
    text_node = ET.SubElement(inline, qname("t"))
    if value[:1].isspace() or value[-1:].isspace():
        text_node.set(f"{{{XML_NS}}}space", "preserve")
    text_node.text = value
    append_payload(cell, inline)


def write_number_cell(cell: ET.Element, value: Decimal) -> None:
    remove_payload(cell)
    cell.attrib.pop("t", None)
    node = ET.Element(qname("v"))
    node.text = decimal_text(value)
    append_payload(cell, node)


def write_formula_cell(cell: ET.Element, formula: str, cached: Any = None) -> None:
    remove_payload(cell)
    formula = formula.lstrip("=")
    formula_node = ET.Element(qname("f"))
    formula_node.text = formula
    append_payload(cell, formula_node)
    value_node = ET.Element(qname("v"))
    if isinstance(cached, Decimal):
        cell.attrib.pop("t", None)
        value_node.text = decimal_text(cached)
    elif cached is not None:
        cell.set("t", "str")
        value_node.text = str(cached)
    else:
        cell.attrib.pop("t", None)
        value_node.text = None
    append_payload(cell, value_node)


def formula_text(cell: ET.Element) -> Optional[str]:
    node = cell.find(qname("f"))
    return None if node is None else (node.text or "")


def extract_report_items(values: Dict[str, Any], cells: Dict[str, ET.Element]) -> List[Dict[str, Any]]:
    header_rows = sorted(
        int(match.group(2))
        for coordinate, value in values.items()
        if (match := CELL_REF_RE.match(coordinate))
        and match.group(1) == "A"
        and normalize_text(value).upper() == "ITEM NO."
    )
    items: List[Dict[str, Any]] = []
    for header_row in header_rows:
        header_cells: List[Tuple[int, str, Any]] = []
        for coordinate, value in values.items():
            match = CELL_REF_RE.match(coordinate)
            if not match or int(match.group(2)) != header_row:
                continue
            column = column_number(match.group(1))
            if column < 3 or not ITEM_RE.fullmatch(normalize_text(value)):
                continue
            header_cells.append((column, coordinate, value))
        for column, item_coordinate, item_value in sorted(header_cells):
            letter = column_letters(column)
            tolerance_coordinate = f"{letter}{header_row + 2}"
            nominal_coordinate = f"{letter}{header_row + 3}"
            max_coordinate = f"{letter}{header_row + 4}"
            min_coordinate = f"{letter}{header_row + 5}"
            items.append(
                {
                    "item": normalize_text(item_value).replace(" ", ""),
                    "item_cell": item_coordinate,
                    "header_row": header_row,
                    "column": column,
                    "tolerance_cell": tolerance_coordinate,
                    "nominal_cell": nominal_coordinate,
                    "max_cell": max_coordinate,
                    "min_cell": min_coordinate,
                    "existing_tolerance": values.get(tolerance_coordinate),
                    "existing_nominal": values.get(nominal_coordinate),
                    "max_formula": formula_text(cells[max_coordinate]) if max_coordinate in cells else None,
                    "min_formula": formula_text(cells[min_coordinate]) if min_coordinate in cells else None,
                }
            )
    return items


def report_anchor(item: Dict[str, Any]) -> Tuple[Optional[Decimal], Optional[Tuple[Any, ...]]]:
    nominal = to_decimal(item["existing_nominal"])
    tolerance = parse_tolerance(item["existing_tolerance"])
    combined: List[ParsedSpec] = []
    for value in (item["existing_tolerance"], item["existing_nominal"]):
        combined.extend(parse_specs(value))
    unique_combined = {spec.signature: spec for spec in combined}
    if nominal is None and len(unique_combined) == 1:
        nominal = next(iter(unique_combined.values())).nominal
    if tolerance is None and len(unique_combined) == 1:
        tolerance = next(iter(unique_combined.values())).tolerance_signature
    return nominal, tolerance


def choose_match(
    item: Dict[str, Any], by_nominal: Dict[Decimal, List[CadOccurrence]]
) -> Tuple[str, Optional[CadOccurrence], int, int]:
    nominal, tolerance = report_anchor(item)
    has_anchor = item["existing_tolerance"] not in (None, "") or item["existing_nominal"] not in (
        None,
        "",
    )
    if nominal is None:
        return ("blank_placeholder" if not has_anchor else "unmatched"), None, 0, 0
    candidates = by_nominal.get(nominal_key(nominal), [])
    if not candidates:
        return "unmatched", None, 0, 0
    exact = [item for item in candidates if tolerance == item.spec.tolerance_signature]
    if exact:
        chosen = min(exact, key=lambda occurrence: (occurrence.priority, occurrence.json_index or 0))
        return "matched_exact", chosen, len(exact), len(candidates)
    unique_signatures = {occurrence.spec.signature for occurrence in candidates}
    if len(unique_signatures) == 1:
        chosen = min(candidates, key=lambda occurrence: (occurrence.priority, occurrence.json_index or 0))
        return "matched_nominal_unique", chosen, 0, len(candidates)
    return "ambiguous", None, 0, len(candidates)


def item_diagnostic(
    item: Dict[str, Any],
    status: str,
    occurrence: Optional[CadOccurrence],
    exact_count: int,
    nominal_count: int,
) -> Dict[str, Any]:
    result = {
        "item": item["item"],
        "item_cell": item["item_cell"],
        "tolerance_cell": item["tolerance_cell"],
        "nominal_cell": item["nominal_cell"],
        "max_cell": item["max_cell"],
        "min_cell": item["min_cell"],
        "existing_tolerance": None
        if item["existing_tolerance"] is None
        else str(item["existing_tolerance"]),
        "existing_nominal": decimal_json(to_decimal(item["existing_nominal"])),
        "status": status,
        "exact_cad_occurrences": exact_count,
        "nominal_cad_occurrences": nominal_count,
    }
    if occurrence is not None:
        result["cad"] = {
            "kind": occurrence.spec.kind,
            "nominal": decimal_text(occurrence.spec.nominal),
            "tolerance": occurrence.spec.tolerance_text,
            "raw_text": occurrence.raw_text,
            "clean_text": occurrence.clean_text,
            "entity_type": occurrence.entity_type,
            "owner_block": occurrence.owner_block,
            "layer": occurrence.layer,
            "handle": occurrence.handle,
            "json_index": occurrence.json_index,
            "position": list(occurrence.position),
        }
    return result


def formula_for_bounds(item: Dict[str, Any], spec: ParsedSpec) -> Tuple[str, str]:
    nominal = item["nominal_cell"]
    if spec.kind in {"sym", "asym"}:
        assert spec.upper is not None and spec.lower is not None
        return (
            f"{nominal}+{decimal_text(spec.upper)}",
            f"{nominal}-{decimal_text(spec.lower)}",
        )
    if spec.kind == "min":
        return '""', nominal
    if spec.kind == "max":
        return nominal, '""'
    raise ValueError(f"Unsupported specification kind: {spec.kind}")


def update_one_sided_judgment_formulas(
    item: Dict[str, Any],
    spec: ParsedSpec,
    values: Dict[str, Any],
    cells: Dict[str, ET.Element],
    rows: Dict[int, ET.Element],
    sheet_root: ET.Element,
) -> List[str]:
    if spec.kind not in {"min", "max"}:
        return []
    updated: List[str] = []
    status_column = item["column"]
    measured_column = column_letters(status_column + 1)
    for row_number in range(item["header_row"] + 6, item["header_row"] + 12):
        if normalize_text(values.get(f"A{row_number}")).upper() == "MEASUREMENT":
            break
        measured = f"{measured_column}{row_number}"
        status = f"{column_letters(status_column)}{row_number}"
        if measured not in values and status not in cells:
            continue
        if spec.kind == "min":
            formula = f'IF({measured}<{item["min_cell"]},"★"," ")'
        else:
            formula = f'IF({measured}>{item["max_cell"]},"★"," ")'
        cell = get_or_create_cell(status, cells, rows, sheet_root)
        write_formula_cell(cell, formula)
        updated.append(status)
    return updated


def compare_formula_values(left: Any, operator: str, right: Any) -> Optional[bool]:
    left_number = to_decimal(left)
    right_number = to_decimal(right)
    if left_number is None or right_number is None:
        return None
    return left_number > right_number if operator == ">" else left_number < right_number


def evaluate_formula(expression: str, values: Dict[str, Any]) -> Any:
    formula = expression.strip().lstrip("=").replace("$", "")
    if formula == '""':
        return ""
    direct = re.fullmatch(r"([A-Z]{1,3}[0-9]+)", formula, re.IGNORECASE)
    if direct:
        return values.get(direct.group(1).upper())
    arithmetic = re.fullmatch(
        rf"([A-Z]{{1,3}}[0-9]+)([+-])({NUM_PATTERN})", formula, re.IGNORECASE
    )
    if arithmetic:
        reference, operator, number = arithmetic.groups()
        base = to_decimal(values.get(reference.upper()))
        if base is None:
            return None
        operand = Decimal(number)
        return base + operand if operator == "+" else base - operand
    if formula.upper().startswith("IF("):
        comparisons = re.findall(
            r"([A-Z]{1,3}[0-9]+)([<>])([A-Z]{1,3}[0-9]+)",
            formula,
            flags=re.IGNORECASE,
        )
        if not comparisons:
            return None
        for left, operator, right in comparisons[:2]:
            result = compare_formula_values(
                values.get(left.upper()), operator, values.get(right.upper())
            )
            if result is None:
                return None
            if result:
                return "★"
        return " "
    return None


def recalculate_formula_caches(
    cells: Dict[str, ET.Element], strings: Sequence[str]
) -> Tuple[int, List[str], Dict[str, Any]]:
    values: Dict[str, Any] = {}
    formulas: Dict[str, str] = {}
    for coordinate, cell in cells.items():
        formula = formula_text(cell)
        if formula is None:
            values[coordinate] = cell_value(cell, strings)
        else:
            formulas[coordinate] = formula
    unresolved = dict(formulas)
    for _ in range(max(4, len(formulas) + 1)):
        progress = False
        for coordinate, formula in list(unresolved.items()):
            result = evaluate_formula(formula, values)
            if result is None:
                continue
            values[coordinate] = result
            del unresolved[coordinate]
            progress = True
        if not progress:
            break
    for coordinate in formulas:
        if coordinate in values:
            write_formula_cell(cells[coordinate], formulas[coordinate], values[coordinate])
    return len(formulas) - len(unresolved), sorted(unresolved), values


def set_calculation_properties(workbook_root: ET.Element) -> None:
    calculation = workbook_root.find(qname("calcPr"))
    if calculation is None:
        calculation = ET.SubElement(workbook_root, qname("calcPr"))
    calculation.set("calcMode", "auto")
    calculation.set("fullCalcOnLoad", "1")
    calculation.set("forceFullCalc", "1")
    calculation.set("calcOnSave", "1")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_xlsx_copy(
    source: Path,
    output: Path,
    replacements: Dict[str, bytes],
    overwrite: bool,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not overwrite:
        raise FileExistsError(f"Output already exists; pass --overwrite to replace it: {output}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.stem}.", suffix=".tmp", dir=str(output.parent)
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(source, "r") as source_zip, zipfile.ZipFile(
            temporary, "w"
        ) as output_zip:
            for info in source_zip.infolist():
                data = replacements.get(info.filename, source_zip.read(info.filename))
                output_zip.writestr(info, data)
        with zipfile.ZipFile(temporary, "r") as check_zip:
            bad = check_zip.testzip()
            if bad:
                raise RuntimeError(f"Generated XLSX has a corrupt package part: {bad}")
        os.replace(temporary, output)
        os.chmod(output, source.stat().st_mode & 0o777)
    finally:
        if temporary.exists():
            temporary.unlink()


def fill_report(
    report: Path,
    output: Path,
    occurrences: List[CadOccurrence],
    overwrite: bool,
) -> Dict[str, Any]:
    with zipfile.ZipFile(report, "r") as archive:
        infos = archive.infolist()
        parts = {info.filename: archive.read(info.filename) for info in infos}
    sheet_path, workbook_root = resolve_sheet_path(parts, SHEET_NAME)
    strings = shared_strings(parts)
    sheet_root = parse_xml(parts[sheet_path])
    cells, values, rows = cell_maps(sheet_root, strings)
    items = extract_report_items(values, cells)
    if not items:
        raise RuntimeError("No ITEM NO. dimension blocks were found in 尺寸报告")

    by_nominal: Dict[Decimal, List[CadOccurrence]] = defaultdict(list)
    for occurrence in occurrences:
        by_nominal[nominal_key(occurrence.spec.nominal)].append(occurrence)

    details: List[Dict[str, Any]] = []
    formula_updates: List[str] = []
    matched = 0
    for item in items:
        status, occurrence, exact_count, nominal_count = choose_match(item, by_nominal)
        details.append(item_diagnostic(item, status, occurrence, exact_count, nominal_count))
        if occurrence is None:
            continue
        matched += 1
        spec = occurrence.spec
        tolerance_cell = get_or_create_cell(item["tolerance_cell"], cells, rows, sheet_root)
        nominal_cell = get_or_create_cell(item["nominal_cell"], cells, rows, sheet_root)
        max_cell = get_or_create_cell(item["max_cell"], cells, rows, sheet_root)
        min_cell = get_or_create_cell(item["min_cell"], cells, rows, sheet_root)
        write_text_cell(tolerance_cell, spec.tolerance_text)
        write_number_cell(nominal_cell, spec.nominal)
        max_formula, min_formula = formula_for_bounds(item, spec)
        write_formula_cell(max_cell, max_formula)
        write_formula_cell(min_cell, min_formula)
        formula_updates.extend([item["max_cell"], item["min_cell"]])
        formula_updates.extend(
            update_one_sided_judgment_formulas(
                item, spec, values, cells, rows, sheet_root
            )
        )
        values[item["tolerance_cell"]] = spec.tolerance_text
        values[item["nominal_cell"]] = spec.nominal

    if matched == 0:
        raise RuntimeError("No report specification could be safely matched to a CAD specification")

    cached_count, unresolved_formulas, calculated_values = recalculate_formula_caches(
        cells, strings
    )
    set_calculation_properties(workbook_root)
    replacements = {
        sheet_path: serialize_xml(sheet_root),
        "xl/workbook.xml": serialize_xml(workbook_root),
    }
    write_xlsx_copy(report, output, replacements, overwrite)

    with zipfile.ZipFile(output, "r") as archive:
        output_parts = {info.filename: archive.read(info.filename) for info in archive.infolist()}
        bad_part = archive.testzip()
    changed_parts = sorted(
        name
        for name, source_data in parts.items()
        if output_parts.get(name) != source_data
    )
    unexpected_changes = [
        name for name in changed_parts if name not in {sheet_path, "xl/workbook.xml"}
    ]
    if unexpected_changes:
        raise RuntimeError(f"Unexpected XLSX package changes: {unexpected_changes}")

    status_counts = Counter(detail["status"] for detail in details)
    formula_samples = {}
    for detail in details:
        if not detail.get("cad"):
            continue
        for key in ("max_cell", "min_cell"):
            coordinate = detail[key]
            formula_samples[coordinate] = {
                "formula": formula_text(cells[coordinate]),
                "cached": str(calculated_values.get(coordinate, "")),
            }
        if len(formula_samples) >= 8:
            break
    return {
        "sheet": SHEET_NAME,
        "sheet_part": sheet_path,
        "report_items": len(items),
        "matched_items": matched,
        "status_counts": dict(sorted(status_counts.items())),
        "formula_cells_updated": len(set(formula_updates)),
        "formula_caches_written": cached_count,
        "unresolved_formula_cells": unresolved_formulas,
        "formula_samples": formula_samples,
        "changed_package_parts": changed_parts,
        "unexpected_package_changes": unexpected_changes,
        "zip_test": "ok" if bad_part is None else bad_part,
        "source_report_sha256": sha256(report.read_bytes()),
        "output_report_sha256": sha256(output.read_bytes()),
        "items": details,
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fill only the 尺寸报告 worksheet from DWG dimensions."
    )
    parser.add_argument("--dwg", type=Path, required=True, help="Source DWG file")
    parser.add_argument("--report", type=Path, required=True, help="Source XLSX report")
    parser.add_argument("--output", type=Path, required=True, help="Output XLSX copy")
    parser.add_argument(
        "--diagnostics", type=Path, help="Diagnostics JSON path; defaults beside output"
    )
    parser.add_argument("--json-cache", type=Path, help="LibreDWG JSON cache path")
    parser.add_argument("--dwgread", help="dwgread executable or path")
    parser.add_argument("--force-json", action="store_true", help="Regenerate JSON cache")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing output files")
    return parser.parse_args(argv)


def validate_paths(args: argparse.Namespace) -> None:
    if not args.dwg.is_file():
        raise FileNotFoundError(f"DWG not found: {args.dwg}")
    if not args.report.is_file():
        raise FileNotFoundError(f"Report not found: {args.report}")
    if args.report.suffix.lower() != ".xlsx" or args.output.suffix.lower() != ".xlsx":
        raise ValueError("Report and output must both use the .xlsx extension")
    if args.report.resolve() == args.output.resolve():
        raise ValueError("Refusing to overwrite the source report; choose a different --output")


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    try:
        validate_paths(args)
        output = args.output.resolve()
        diagnostics = (
            args.diagnostics.resolve()
            if args.diagnostics
            else output.with_suffix(".diagnostics.json")
        )
        json_cache = (
            args.json_cache.resolve()
            if args.json_cache
            else output.with_suffix(".libredwg.json")
        )
        if diagnostics.exists() and not args.overwrite:
            raise FileExistsError(
                f"Diagnostics already exists; pass --overwrite to replace it: {diagnostics}"
            )
        executable = find_dwgread(args.dwgread)
        log_path: Optional[Path] = None
        if (
            args.force_json
            or not json_cache.is_file()
            or json_cache.stat().st_mtime < args.dwg.stat().st_mtime
        ):
            log_path = export_dwg_json(args.dwg.resolve(), json_cache, executable)
        occurrences, cad_stats = extract_cad_specs(json_cache)
        report_result = fill_report(
            args.report.resolve(), output, occurrences, args.overwrite
        )
        result = {
            "source_dwg": str(args.dwg.resolve()),
            "source_report": str(args.report.resolve()),
            "output_report": str(output),
            "diagnostics": str(diagnostics),
            "json_cache": str(json_cache),
            "dwgread": executable,
            "dwgread_log": None if log_path is None else str(log_path),
            "cad": cad_stats,
            "report": report_result,
        }
        diagnostics.parent.mkdir(parents=True, exist_ok=True)
        diagnostics.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Wrote report: {output}")
        print(f"Wrote diagnostics: {diagnostics}")
        print(
            "Matched items: "
            f"{report_result['matched_items']}/{report_result['report_items']} "
            f"{report_result['status_counts']}"
        )
        print(
            "Formula caches: "
            f"{report_result['formula_caches_written']}, "
            f"unresolved: {len(report_result['unresolved_formula_cells'])}"
        )
        print(f"Changed package parts: {report_result['changed_package_parts']}")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
