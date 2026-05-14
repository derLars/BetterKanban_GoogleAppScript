# BetterKanban — Technical Context

## Technology Stack

| Layer | Technology | Version / Runtime |
|---|---|---|
| Backend runtime | Google Apps Script | V8 (ES2019+) |
| Frontend rendering | HTML5 + CSS3 + Vanilla JavaScript | No frameworks |
| User identity | `Session.getActiveUser().getEmail()` | Google Workspace |
| Primary storage | `PropertiesService.getScriptProperties()` | 500KB total limit |
| Secondary storage | Google Sheets (`SpreadsheetApp`) | Via backup spreadsheet |
| Cache | `CacheService.getScriptCache()` | TTL 600s per entry |
| Drag & Drop | HTML5 Drag & Drop API | With touch event fallback |
| Notifications | Google Chat Webhooks | `UrlFetchApp.fetch()` POST |
| Config file | JSON (project file + Script Properties overlay) | Native `JSON.parse()`/`stringify()` |

## Critical GAS Limitations & Mitigations

| Limitation | Value | Mitigation |
|---|---|---|
| Script Properties max size | 500 KB total (all keys) | Split across 6 keys, short property keys, date compression, auto-purge at 400KB |
| Execution timeout | 6 min (regular triggers), 30 min (G Suite) | Keep functions lean; heavy ops (backup, purge, import) run as separate trigger executions |
| HtmlService output max | 500 KB per page | Skeleton UI only; data loaded async via `google.script.run` |
| Concurrent executions | 30 max | Client-side debounce (300ms for drag-and-drop); polling is lightweight (~60 invocations/min for 10 users) |
| CacheService TTL | 600s maximum | `dbVersion` key has no TTL (separate key) for polling fast-path; write-through ensures consistency |
| Trigger min interval | 1 minute | Daily backup/purge/notifications are sufficient; 5-min keep-warm ping acceptable |
| No WebSockets/SSE | GAS limitation | Polling at configurable interval (default 10s) |
| No npm/packages | GAS limitation | Vanilla JS frontend; no external libraries; no web fonts |
| `getActiveUser()` | Only works correctly with specific deployment config | Must deploy as: Execute as "Me", Access "Anyone within [domain]" |

## Deployment Configuration (Critical — Must Follow Exactly)

1. **GAS Project:** Created at `script.google.com`
2. **Deploy type:** Web App
3. **Execute as:** Me (the developer account)
4. **Who has access:** Anyone within [domain]
5. **Authorization scopes needed:**
   - `Script Properties` (read/write)
   - `Spreadsheets` (backup spreadsheet read/write)
   - `Chat` (send webhook notifications via `UrlFetchApp`)
   - `User info` (`Session.getActiveUser().getEmail()`)
   - `Triggers` (installable time-driven triggers)

## Storage Details

### Script Properties Keys (Live Database)

| Key | Entity type | Max entries |
|---|---|---|
| `db_users` | Array of User | ~3,300 (at ~150B each) |
| `db_tasks` | Array of Task | ~2,800 (at ~180B each) |
| `db_activities` | Array of Activity | ~2,000 (at ~250B each with avg 2 comments) |
| `db_meta` | `{version: number, snapshots: string[]}` | 1 |
| `configOverlay` | JSON string | 1 |
| `admin` | Semicolon-separated email string | 1 |

### CacheService Keys

Same as SP keys plus a separate `dbVersion` key (number, no TTL).

### Backup Spreadsheet Worksheet Patterns

- **Daily snapshots:** `YYYY-MM-DD_Tasks`, `YYYY-MM-DD_Activities`, `YYYY-MM-DD_Users` — created by daily time-driven trigger
- **Dump sheets (import/export):** `_Dump_Tasks`, `_Dump_Activities` — manually managed in Settings/Admin
- **Revert dumps (pre-import):** `Revert_YYYY-MM-DDTHHmmss_Tasks`, `Revert_YYYY-MM-DDTHHmmss_Activities` — auto-created by Admin import operation

## Entity Relationships

```
User (db_users)
  └── settings.chatWebhookUrl (optional Google Chat webhook)
  └── settings.vacations (array of {start, end} date ranges)

Task (db_tasks)
  └── creatorEmail → User.email
  └── assignedTo → User.email (optional)
  └── visibility: "private" | "public"
  └── deterministicId (SHA-256 hash, first 16 chars)

Activity (db_activities)
  └── creatorEmail → User.email
  └── assignedTo → User.email (optional)
  └── columnId → Column.id (from Config.json)
  └── columnOrder (integer position within column)
  └── comments (array of Comment, newest first)
      └── authorEmail → User.email

Column (Config.json / ConfigOverlay)
  └── id: string (e.g., "col-todo")
  └── name: string (e.g., "To Do")
  └── order: number (0-based)
  Max 5 columns. Column 0 must always exist.
```

## Key Libraries & Utilities (All Native GAS)

- `Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8)` — for deterministic IDs
- `Utilities.formatDate(date, timeZone, format)` — for date formatting in configured timezone
- `Session.getActiveUser().getEmail()` — identity
- `Session.getEffectiveUser().getEmail()` — developer identity
- `PropertiesService.getScriptProperties()` — storage
- `CacheService.getScriptCache()` — caching
- `ScriptApp.getProject().getFiles()` — reading Config.json
- `ScriptApp.newTrigger(...)` — installable triggers
- `SpreadsheetApp.openById(id)` — backup spreadsheet access
- `UrlFetchApp.fetch(url, params)` — Chat webhook POST
- `HtmlService.createTemplateFromFile(path)` — serving HTML
- `JSON.parse()` / `JSON.stringify()` — serialization (native V8)

## Dev Workflow

1. **Develop:** Edit code in GAS script editor (or locally with `clasp`)
2. **Test:** Run `Tests.gs` from GAS editor (manual execution)
3. **Deploy:** Deploy → New Deployment → Web App → Execute as Me → Anyone within domain
4. **Update:** Deploy → Manage Deployments → Edit → New Version → Deploy
5. **Trigger setup:** Run `setupDailyTriggers()` once from script editor after first deploy

## Config.json Schema (Default)

```json
{
  "app": {
    "title": "BetterKanban",
    "timeZone": "America/New_York",
    "dateFormat": "YYYY-MM-DD"
  },
  "kanban": {
    "columns": [
      { "name": "To Do",       "order": 0 },
      { "name": "In Progress", "order": 1 },
      { "name": "Blocked",     "order": 2 },
      { "name": "In Review",   "order": 3 },
      { "name": "Done",        "order": 4 }
    ],
    "completedColumnId": "Done"
  },
  "database": {
    "backupSpreadsheetId": "",
    "backupTime": "02:00",
    "purgeTime": "03:00",
    "notificationTime": "08:00",
    "backupSnapshotCount": 5,
    "completedTaskMaxCount": 100,
    "completedActivityMaxCount": 100,
    "deletedTaskRetentionDays": 7,
    "maxCommentsPerActivity": 50
  },
  "ui": {
    "theme": "light",
    "pageSize": 50,
    "pollingIntervalSeconds": 10
  }
}
```
