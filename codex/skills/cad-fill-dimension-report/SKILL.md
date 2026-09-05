---
name: cad-fill-dimension-report
description: Fill only the 尺寸报告 worksheet of an Excel signing or FAI report from dimension specifications extracted from a DWG. Use when Codex must parse CAD dimensions such as 324.75±0.15, split tolerance and nominal values across the two SPECIFICATION rows, update MAX/MIN formulas, preserve all other worksheets, and produce matching diagnostics for .dwg and .xlsx files.
---

# Fill CAD Dimension Reports

Fill a report copy with deterministic DWG-derived dimension values. Preserve every XLSX package part except the `尺寸报告` worksheet and workbook calculation settings.

## Workflow

1. Resolve one source DWG, one source `.xlsx`, and explicit output paths. Never overwrite the source report unless the user explicitly requests it and a backup exists.
2. Confirm the workbook contains a worksheet named `尺寸报告` and that item blocks use `ITEM NO.` with `SPECIFICATION` two rows below.
3. Resolve the installed Skill directory, then run the bundled script with absolute input and output paths:

```bash
python3 "/absolute/path/to/cad-fill-dimension-report/scripts/fill_dimension_report.py" \
  --dwg "/absolute/input.dwg" \
  --report "/absolute/source-report.xlsx" \
  --output "/absolute/output-report.xlsx" \
  --diagnostics "/absolute/output-report.diagnostics.json"
```

4. Read the diagnostics JSON. Report the matched count, unmatched nonblank items, blank placeholders, formula cache count, and changed XLSX package parts.
5. Treat any nonblank unmatched or ambiguous item as requiring review. Do not guess a blank row from drawing order or repeated `Axx` identifiers.
6. Verify the output ZIP and reopen the workbook when an Excel-compatible engine is available. Formula caches are already written for the report's common arithmetic and pass/fail formulas; the workbook is also marked for full automatic recalculation.

## Required Behavior

- Write tolerance text to the upper SPECIFICATION row and a numeric nominal value to the lower row. For example, split `324.75±0.15` into `±0.15` and numeric `324.75`.
- Update MAX/MIN formulas from the parsed upper and lower tolerances. Keep dependent measurement judgment formulas and refresh their cached results.
- Modify no worksheet other than `尺寸报告`. Store diagnostics in a separate JSON file; never add analysis worksheets.
- Match by the report cell's existing nominal/tolerance anchor. Permit nominal-only matching only when CAD has one unique specification for that nominal. Do not use `ITEM NO.` as a unique key because reports may repeat identifiers.
- Preserve unresolved blank placeholders. Do not infer their values from proximity or sequence.
- Keep source DWG and report unchanged by default.

## Inputs And Dependencies

- Require LibreDWG `dwgread` on `PATH`; the script also checks common Homebrew locations.
- Use only the Python standard library after DWG conversion.
- Reuse `--json-cache` when provided. Use `--force-json` only when the DWG changed or the cache is suspect.
- Read [references/specification-format.md](references/specification-format.md) when extending supported CAD tolerance syntax or report row layouts.

## Output Interpretation

- `matched_exact`: Existing report nominal and tolerance both match CAD.
- `matched_nominal_unique`: The nominal identifies exactly one CAD specification; CAD tolerance replaces the report tolerance.
- `blank_placeholder`: Neither report row provides a usable anchor; no value is written.
- `unmatched`: Existing report data has no safe CAD match; no value is written.
- `changed_package_parts`: Must contain only the `尺寸报告` worksheet XML and `xl/workbook.xml` calculation metadata.

If zero items match, stop and report the mismatch instead of delivering a misleading workbook.
