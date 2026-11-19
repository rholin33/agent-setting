# EasyPM API Reference

Base URL: `https://easypm2.jingtengtech.com`

## Authentication

Endpoint: `POST /api/handleAuthentication`

Body:

```json
{
  "accountId": "<account>",
  "pass": "<password>"
}
```

Response data includes `userId` and `token`. The deployed frontend sends the raw token as the `Authorization` header value, without a `Bearer ` prefix.

The helper CLI exposes this as:

```bash
python3 ~/.codex/skills/easypm/scripts/easypm.py login
python3 ~/.codex/skills/easypm/scripts/easypm.py session
python3 ~/.codex/skills/easypm/scripts/easypm.py logout
```

`login` caches only `token`, `userId`, `accountId`, and token expiry in `~/.easypm/session.json`. It does not store the password.

## Project List

Endpoint: `POST /api/getAllProjectsWithProcess`

Headers:

```http
Authorization: <raw token>
Content-Type: application/json
```

Body: `{}`.

Important project fields:

- `projectNo`
- `projectGuid`
- `projectName`
- `ownerName`
- `closed`
- `endDate`
- `percentage`
- `totalEffort`
- `doneEffort`

## Work Items

Create/update endpoint: `POST /api/saveWorkItem`

Body:

```json
{
  "item": {
    "workGuid": "<uuid>",
    "projectGuid": "<projectGuid>",
    "title": "<title>",
    "content": "<description>",
    "contentImages": "",
    "keyword": null,
    "isDeleted": false,
    "workType": 100,
    "priority": 4,
    "status": 0,
    "effort": 1
  }
}
```

New work items may be saved as `status=0` even if `status=2` is supplied. To set `working`, add status logs.

Read one work item: `POST /api/getWorkItemById` with `{ "workGuid": "..." }`.

Read project work tree: `POST /api/getProjectWorks` with `{ "projectGuid": "..." }`.

To list working tasks, read project work tree and filter `status == 2` and `isDeleted != true`.

To update the work item estimate, send the existing work item back to `saveWorkItem` with the changed `effort` field. Preserve existing fields whenever possible.

Actual man-hours are not recorded by `saveWorkItem`; they must be recorded through `saveLabourLog`.

## Status Logs

Endpoint: `POST /api/addWorkLog`

Body:

```json
{
  "item": {
    "logGuid": "<uuid>",
    "workGuid": "<workGuid>",
    "logDate": "<ISO date>",
    "actualEffort": 0,
    "status": 2,
    "userGuid": "<current userId>",
    "comment": "<comment>"
  }
}
```

The skill uses status logs only for status transitions and sends `actualEffort: 0`; actual hours are recorded separately with `saveLabourLog.manHour`.

Status values:

- `0`: `new`
- `1`: `accept`
- `2`: `working`
- `3`: `finished`
- `4`: `verifing`
- `5`: `re-open`
- `6`: `re-work`
- `99`: `reject`
- `100`: `close`

## Labour Logs

Endpoint: `POST /api/saveLabourLog`

The local source file is under `api/labour/saveLabourLog.js`, but the deployed EasyPM service exposes it at the root API path above.

Body:

```json
{
  "item": {
    "labourGuid": "<uuid>",
    "projectGuid": "<projectGuid>",
    "workGuid": "<workGuid>",
    "labourDate": "<ISO date>",
    "userGuid": "<current userId>",
    "content": "<title or summary>",
    "memo": "<description>",
    "labourType": 3,
    "manHour": 2,
    "isDeleted": false
  }
}
```

The backend overwrites `userGuid` from the authenticated user on insert, but the helper still sends it for compatibility.

`labourType` values from `tables/labourLogs.js`:

- `1`: meeting
- `2`: discuss
- `3`: program
- `4`: model
- `5`: UI
- `6`: doc
- `7`: test
- `8`: deploy
- `9`: training
- `10`: support
- `11`: demo

Skill defaults: `design=4`, `test=7`, `deploy=8`, `travel=9`, `other=10`, and git push hook tasks use `3`.
