# Dimension Specification Format

## Report Layout

Detect every row whose column A value is `ITEM NO.`. For each `A`-numbered item cell in that row, use this relative layout:

| Offset | Meaning | Value type |
|---|---|---|
| `+2` | Tolerance / specification | Text |
| `+3` | Nominal value | Number |
| `+4` | MAX | Formula with numeric cache |
| `+5` | MIN | Formula with numeric cache |

Do not assume an item identifier is unique. A report can repeat A38, A40, or other labels in different columns.

## CAD Syntax

Normalize AutoCAD MTEXT codes before parsing:

| CAD text | Upper row | Lower row | Bounds |
|---|---|---|---|
| `324.75±0.15` | `±0.15` | `324.75` | MAX `324.90`, MIN `324.60` |
| `313.48+0.30/-0.00` | `+0.30/-0.00` | `313.48` | MAX `313.78`, MIN `313.48` |
| `1.40 Min.` | `Min.` | `1.40` | Lower bound only |
| `0.20 Max.` | `Max.` | `0.20` | Upper bound only |

Treat `%%p` as `±` and stacked MTEXT such as `\\S+0.10^-0.00;` as `+0.10/-0.00`. Strip diameter symbols only for numeric matching; retain the numeric value.

## Matching Rules

1. Match existing nominal plus tolerance exactly after numeric normalization.
2. If tolerance differs, match by nominal only when every CAD occurrence for that nominal has the same specification signature.
3. Prefer MTEXT owned by an anonymous dimension block (`*D...`) over notes or ordinary text.
4. Leave blank or ambiguous targets unchanged and record them in diagnostics.
