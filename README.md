# BetterKanban

A lightweight project management tool built entirely on **Google Apps Script (GAS)** for Google Workspace domains. Features a Task Manager and Kanban Board with per-card comment threads, automatic user registration via Google Workspace email, daily spreadsheet backups, and Google Chat notifications.

## Architecture

```
BetterKanban_GoogleAppScript/
├── Config.json              ← Default configuration
├── Main.gs                  ← doGet(), session handling, polling
├── Database.gs              ← Storage, backup, config loading, key translation
├── Users.gs                 ← User registration, lookup, admin check
├── Tasks.gs                 ← Task CRUD + lifecycle
├── Activities.gs            ← Activity CRUD + comments + column movement
├── Admin.gs                 ← Admin-only operations (users, config, import)
├── Settings.gs              ← User settings, import/export
├── Notifications.gs         ← Chat webhook dispatch, daily summaries
├── Purge.gs                 ← Scheduled cleanup of old records
├── Triggers.gs              ← Installable time-driven trigger management
├── Index.html              ← Main HTML shell (skeleton layout)
├── Styles.html              ← All CSS (custom properties for theming)
├── App.html                  ← Client-side JS (state, rendering, DnD, polling)
├── appscript.json             ← GAS manifest (timeZone, V8 runtime)
├── Tests.gs                 ← Unit tests (run from GAS editor)
└── README.md                ← This file
```

## Deployment

### Prerequisites

- A Google Workspace domain with the developer account as a member
- The backup spreadsheet created (empty) with its ID noted

### Step-by-Step

1. **Create GAS project** at [script.google.com](https://script.google.com)
2. **Create files** — create each file listed above in the project, copying the source code
3. **Create `Config.json`** — set `database.backupSpreadsheetId` to your backup spreadsheet ID
4. **Set admin list** — open Script Properties (`File → Project properties → Script properties`) and add key `"admin"` with semicolon-separated admin emails as the value (e.g., `admin1@domain.com;admin2@domain.com`)
5. **Deploy**:
   - Click **Deploy → New deployment**
   - Type: **Web app**
   - **Execute as:** Me (the developer account)
   - **Who has access:** Anyone within `[your-domain].com`
   - Click **Deploy** and accept the authorization scopes
6. **Post-deployment**:
   - Open the web app URL and verify it loads
   - Run `setupDailyTriggers()` once from the GAS script editor to install daily backup, purge, and notification triggers
   - Verify the backup spreadsheet has a snapshot for today

### Updating

1. Edit the code in the GAS editor
2. Click **Deploy → Manage deployments**
3. Find the active deployment, click the pencil icon
4. Select **Version: New version**
5. Click **Deploy** — new version is live immediately

## Configuration

Configuration is merged at runtime from two sources:

| Source | Priority | Editable by |
|---|---|---|
| `Config.json` (project file) | Base | Developer (via GAS editor) |
| `configOverlay` (Script Properties) | Overrides base | Admin (via Admin page) |

### Default Config

```json
{
  "app": {
    "title": "BetterKanban",
    "timeZone": "America/New_York",
    "dateFormat": "YYYY-MM-DD"
  },
  "kanban": {
    "columns": [
      { "id": "col-todo",       "name": "To Do",       "order": 0 },
      { "id": "col-in-progress","name": "In Progress",  "order": 1 },
      { "id": "col-blocked",    "name": "Blocked",      "order": 2 },
      { "id": "col-review",     "name": "In Review",    "order": 3 },
      { "id": "col-done",       "name": "Done",         "order": 4 }
    ],
    "completedColumnId": "col-done"
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

## Key GAS Limitations & Mitigations

| Limitation | Mitigation |
|---|---|
| Script Properties: 500 KB total | Short property keys, date compression, auto-purge at 400KB, daily spreadsheet backup |
| No WebSockets | Client-side polling (configurable interval, default 10s) |
| Single-threaded execution | **Benefit** for data consistency; optimistic locking (version field) prevents stale overwrites |
| No npm/external packages | Vanilla JS frontend, system font stack, no external dependencies |
| HtmlService max output: 500 KB | Skeleton UI only; data loaded via `google.script.run` after page boot |
| CacheService TTL: 600s | `dbVersion` key uses max TTL (21600s) for polling fast-path; write-through guarantees consistency |

## Data Model

**Users** — Auto-registered on first visit via `Session.getActiveUser().getEmail()`. Display name derived from email local part.

**Tasks** — Simple to-do items with optional due date, assignee, visibility (public/private), single comment. Soft-delete with 7-day retention.

**Activities** — Kanban cards with title, description, due date, assignee, column position, and embedded comment threads. Soft-delete with 7-day retention. All activities are public.

**Columns** — Defined in Config.json (max 5). If none defined, a single `"Activities"` column is created by default.

## Key Design Decisions

- **Short property keys** — Stored JSON uses 1-4 character keys (`desc`, `cr`, `asgn`, `cmts`) to save ~40% space in Script Properties. A translation layer in `Database.gs` converts between short and full key names.
- **Field-level partial updates** — Prevents lost updates when two users edit different fields of the same entity.
- **Optimistic locking** — Each entity has a `version` field. Updates check version match; on mismatch (409), the client re-fetches and merges pending changes.
- **Space budget** — At ~180B/task and ~250B/activity, 500KB supports ~2800 tasks or ~2000 activities — sufficient for teams of up to 10 users with daily backups.

## Running Tests

In the GAS script editor, select `testAll()` and click Run. Tests cover:
- Deterministic ID computation
- Key translation (short↔full)
- Display name derivation from email
- Task/Activity CRUD validation
- Comment operations
- Purge logic
- Config merging
- Vacation period checking
