# Release Note Schema

## Storage Layout

- Markdown file: `data/release-notes/YYYY-MM-DD-<slug>.md`
- Feed file: `data/release-notes/index.json`

## JSON Contract

Each entry in `index.json` should contain:

- `id`: stable unique id, usually `YYYY-MM-DD-<slug>`
- `version`: user-facing version string
- `title`: release title shown in the modal
- `summary`: very short summary text; default to a compact phrase rather than a long sentence
- `published_at`: RFC3339 timestamp when possible
- `updates`: array of current shipped changes
- `roadmap`: array of planned follow-up items

## JSON Example

```json
{
  "entries": [
    {
      "id": "2026-03-26-system-release-notes",
      "version": "2026.03.26-preview",
      "title": "系统更新日志能力已接入",
      "summary": "首页公告与更新记录优化",
      "published_at": "2026-03-26T20:00:00+08:00",
      "updates": [
        "系统公告入口已移动到首页。",
        "自动弹窗改为浏览器会话级控制。"
      ],
      "roadmap": [
        "增加多条历史版本时的版本筛选能力。"
      ]
    }
  ]
}
```

## Markdown Template

```md
# <发布标题>

- 版本：`<version>`
- 发布时间：`<published time>`

## 摘要

<very short summary>

## 当前更新内容

- <update 1>
- <update 2>

## Roadmap

- <roadmap 1>
- <roadmap 2>
```

## Checklist

- Inspect local code before drafting.
- Show draft to the user before saving.
- Save only after explicit confirmation.
- Every confirmed version must record both `当前更新内容` and `Roadmap`.
- Keep `summary` short by default; avoid explanatory filler.
- Update Markdown and JSON together.
- Keep newest entry first in `index.json`.
