# BetterKanban — System Patterns & Architecture

## 1. Project Structure (Must Follow Exactly)

```
BetterKanban_GoogleAppScript/
├── Spec.md                     ← Full specification (2190 lines)
├── Config.json                 ← Base configuration (shipped with project)
├── Main.gs                     ← doGet(), global setup, session handling
├── Database.gs                 ← Script Properties read/write, backup logic, config loading
├── Users.gs                    ← User registration, lookup, admin check, profile update
├── Tasks.gs                    ← Task CRUD + complete/uncomplete/delete/undelete
├── Activities.gs               ← Activity CRUD + column movement + comment operations
├── Admin.gs                    ← Admin page: config validation, admin list, user deletion, snapshot import
├── Settings.gs                 ← User settings: webhook, vacations, import from dump, export to dump
├── Notifications.gs            ← Chat webhook dispatch, daily summary generation
├── Purge.gs                    ← Scheduled cleanup of old completed/soft-deleted tasks & activities
├── Triggers.gs                 ← Installable trigger management (setup/teardown)
├── Html/
│   ├── Index.html              ← Main HTML shell (skeleton layout, tabs, zones, modals)
│   ├── Styles.css              ← All CSS (custom properties for theming)
│   └── App.js                  ← Client-side JS (state, API calls, DnD, search filter, modals)
├── Tests.gs                    ← Unit tests (run manually from GAS editor)
├── README.md                   ← Setup & deployment instructions
└── .memory/                    ← Memory Bank (agent context)
    ├── projectBrief.md
    ├── productContext.md
    ├── systemPatterns.md
    ├── techContext.md
    └── progress.md
```

## 2. Architectural Pattern

### 2.1 Backend (GAS Server)

Every `.gs` file exports global functions callable from the client via `google.script.run`. The architecture follows a **module-per-domain** pattern:

| File | Responsibility | Exposes functions to client |
|---|---|---|
| `Main.gs` | `doGet()`, `include()`, `getInitialData()`, `getCurrentUser()`, `poll()` | Yes |
| `Database.gs` | `loadDatabase()`, `saveDatabase()`, `loadConfig()`, `incrementDbVersion()`, `backupToSpreadsheet()`, `readDumpSheet()`, `computeDeterministicId()` | No (internal helper) |
| `Users.gs` | `registerUser()`, `getUser()`, `getAllUsers()`, `updateUserSettings()` | Yes (getAllUsers) |
| `Tasks.gs` | Task CRUD + lifecycle | Yes |
| `Activities.gs` | Activity CRUD + comments + move | Yes |
| `Admin.gs` | Admin-only operations | Yes |
| `Settings.gs` | User settings + import/export | Yes |
| `Notifications.gs` | Chat webhook dispatch | No |
| `Purge.gs` | Hard-delete old records | No |
| `Triggers.gs` | Trigger setup/teardown | No |

### 2.2 Frontend (Browser JS via HtmlService)

Single-page application architecture within `Html/App.js`:

- **State object** — single `state` variable holding: `user`, `tasks`, `activities`, `columns`, `config`, `lastVersion`, `paneStates`, `searchTerms`, `filterToggles`
- **Rendering functions** — `renderTasks()`, `renderKanban()`, `renderWelcomeBar()` — pure DOM manipulation (no framework)
- **Event handlers** — delegated event listeners on pane containers (click, dragstart, dragover, drop, input, change)
- **google.script.run wrappers** — thin wrapper functions per API endpoint, e.g. `api.createTask(data)`, `api.updateTask(id, changes)`, `api.moveActivity(id, columnId, order, version)`
- **Polling loop** — `setInterval(pollLoop, interval)` managed by the boot sequence

### 2.3 HTML Serving Pattern (HtmlService `include()`)

```javascript
// Main.gs — required helper
function include(filename) {
  return HtmlService.createHtmlOutputFromFile('Html/' + filename).getContent();
}
```

```html
<!-- Html/Index.html — skeleton only, no data embedded -->
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <?!= include('Styles.css'); ?>
</head>
<body>
  <div id="app"><!-- Skeleton UI --></div>
  <?!= include('App.js'); ?>
  <script>google.script.run.withSuccessHandler(onInit).withFailureHandler(onError).getInitialData();</script>
</body>
</html>
```

**Critical rule:** Never embed large data arrays in the HTML template. Always fetch via `google.script.run` after skeleton renders.

## 3. Storage Strategy

### 3.1 Hot Storage: Script Properties (500KB total)

| Key | Content | Typical size |
|---|---|---|
| `db_users` | Array of User objects (full names, short keys) | ~2 KB (10 users) |
| `db_tasks` | Array of Task objects (short keys) | ~30 KB (200 tasks) |
| `db_activities` | Array of Activity objects (short keys, comments embedded) | ~50 KB (150 activities) |
| `db_meta` | `{version: number, snapshots: string[]}` | <1 KB |
| `configOverlay` | Admin-edited config overrides (JSON) | ~2 KB |
| `admin` | Semicolon-separated admin email list | <1 KB |

### 3.2 Cold Storage: Google Spreadsheet (Backup)

- Daily snapshots create 3 timestamped worksheets: `YYYY-MM-DD_Tasks`, `YYYY-MM-DD_Activities`, `YYYY-MM-DD_Users`
- Retention: `backupSnapshotCount` (default 5) — oldest deleted when exceeded
- Dump sheets (import/export): `_Dump_Tasks`, `_Dump_Activities` — manually managed, never auto-rotated
- Revert dumps (before import): `Revert_YYYY-MM-DDTHHmmss_Tasks`, `Revert_YYYY-MM-DDTHHmmss_Activities`

### 3.3 Cache: CacheService (Write-Through, TTL 600s)

| Cache key | Content | TTL | Notes |
|---|---|---|---|
| `db_users` | JSON array | 600s | |
| `db_tasks` | JSON array | 600s | |
| `db_activities` | JSON array | 600s | |
| `db_meta` | JSON with version | 600s | |
| `dbVersion` | Number | **None** | Separate key for polling fast-path |

**Write-through rule:** Every write to Script Properties must also write the same key to CacheService (or delete the cache entry). This guarantees: "If data exists in CacheService, it is always the most recent version."

### 3.4 Space-Saving Techniques

| Technique | Implementation |
|---|---|
| **Short property keys** | 1–4 char keys in stored JSON. Server-side translation maps (`shortToFull` / `fullToShort`). Example: `desc` → `description`, `cr` → `creatorEmail`, `asgn` → `assignedTo`, `cmts` → `comments`. |
| **No redundant fields** | Fields with default values (null, empty string, false) are omitted from stored JSON. Translation layer adds them back on read. |
| **Date compression** | ISO 8601 without timezone suffix: `"2026-05-14T12:00:00"` (no trailing Z, no offset). |
| **No whitespace** | `JSON.stringify()` in V8 already produces compact output. |
| **Pessimistic size check** | On every mutating write, estimate total `db_*` size. If >400KB, immediately purge oldest completed and soft-deleted records beyond thresholds. |

## 4. Concurrency & Locking

### 4.1 GAS Single-Threaded Execution

GAS executes requests against a single project **sequentially** — only one server function runs at a time. This provides an implicit mutex:
- Two writes never interleave at the instruction level.
- Every write sees a consistent snapshot.
- No explicit lock/unlock code needed.

### 4.2 Optimistic Locking via Version Field

- Every Task and Activity has a `version` field (integer, starts at 1).
- Client retains `version` from last read.
- Update request includes `version`.
- Server compares: match → apply + increment. Mismatch → throw 409.
- Client handles 409: re-fetch entity, merge pending changes, retry.

### 4.3 Field-Level Partial Updates

Server functions for updates receive **only changed fields** (plus `id` + `version`):

```javascript
function updateTask(taskId, changes) {
  const tasks = loadDatabase('tasks');
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('Task not found');
  if (changes.version !== task.version) throw new Error('Conflict: entity was modified');

  // Allowed fields only
  const allowed = ['description', 'dueDate', 'assignedTo', 'visibility', 'comment'];
  allowed.forEach(f => { if (changes[f] !== undefined) task[f] = changes[f]; });

  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();
  saveDatabase('tasks', tasks);
  incrementDbVersion();
  return task;
}
```

## 5. API Design Conventions

### 5.1 Client-Server Bridge

```javascript
// Client pattern
google.script.run
  .withSuccessHandler(result => { /* update UI */ })
  .withFailureHandler(error => { /* show toast, handle 409 */ })
  .serverFunctionName(arg1, arg2);
```

### 5.2 Error Object Format (all server errors)

```json
{ "message": "Human-readable description", "code": 409, "details": {} }
```

| Code | Meaning |
|---|---|
| 400 | Bad request (missing field, invalid input) |
| 403 | Forbidden (non-admin on admin operation) |
| 404 | Not found (entity ID doesn't exist) |
| 409 | Conflict (optimistic lock version mismatch) |

### 5.3 Server Functions Reference

Complete API documented in `Spec.md §13`. The key functions every agent must know:

**Session:**
- `getInitialData()` → `{user, tasks[], activities[], columns[], config}`
- `poll(lastVersion)` → `{changed: boolean, data?, newVersion?}`

**Tasks:** `createTask`, `getTasks`, `getTask`, `updateTask`, `completeTask`, `uncompleteTask`, `deleteTask`, `undeleteTask`, `purgeOldTasks`

**Activities:** `createActivity`, `getActivities`, `getActivity`, `updateActivity`, `completeActivity`, `uncompleteActivity`, `deleteActivity`, `undeleteActivity`, `moveActivity`, `purgeOldActivities`

**Comments:** `addComment`, `updateComment`, `deleteComment`

**Users:** `getAllUsers`, `updateUserSettings`

**Admin:** `isAdmin`, `getAdminList`, `saveAdminList`, `getConfig`, `saveConfig`, `deleteUser`, `getAvailableSnapshots`, `importSnapshot`

**Settings:** `updateProfile`, `saveChatWebhook`, `saveVacations`, `importFromSpreadsheet`, `exportToSpreadsheet`

## 6. Config Hierarchy

```
Config.json (project file, shipped with code, read at startup via ScriptApp.getProject().getFiles())
    ∪
PropertiesService key "configOverlay" (admin-edited via Admin page, takes precedence)
    = merge (per top-level section overlay)
Active config (in-memory, returned to client in getInitialData())
```

- `loadConfig()` in `Database.gs` handles the merge logic. On bad overlay JSON, silently returns base config.
- `saveConfig()` in `Admin.gs` validates JSON + spreadsheet ID accessibility before saving overlay.

## 7. Naming Conventions & Code Rules

### 7.1 File & Function Naming

- `.gs` files: PascalCase filenames (e.g., `Tasks.gs`, `Activities.gs`). One domain per file.
- Server functions: `camelCase` (e.g., `createTask`, `getInitialData`). Must be global functions.
- Internal helper functions: `camelCase`, defined within files but not exported (used by other `.gs` files via global scope — GAS has no module system).
- HTML/CSS/JS files: PascalCase with extension (e.g., `Index.html`, `Styles.css`, `App.js`).

### 7.2 Short Property Key Mapping

Every entity type has a consistent key map. Example for Task:

```javascript
const TASK_FULL_TO_SHORT = {
  id: 'i', deterministicId: 'di', description: 'd', creatorEmail: 'cr',
  creationDate: 'cd', dueDate: 'dd', assignedTo: 'as', visibility: 'v',
  comment: 'co', version: 'vr', completedDate: 'cpd', deletedDate: 'ddt',
  lastModifiedDate: 'lmd'
};
const TASK_SHORT_TO_FULL = swapKeys(TASK_FULL_TO_SHORT);
```

Short keys are used when:
- **Storing to Script Properties** (after `JSON.stringify`)
- **Writing to CacheService**
- **Writing to backup spreadsheet** (headers use full names for human readability)

Full keys are used when:
- **Returning data to client** (so client code is readable)
- **Accepting data from client** (client sends full key names)

Translation happens in `Database.gs`: `translateKeys(obj, mapping)`.

### 7.3 CSS Naming

- CSS custom properties on `:root` (see `Spec.md §8.2` for exact palette).
- Class names: `kebab-case` prefixed with `bk-` (e.g., `bk-card`, `bk-column-header`, `bk-modal-backdrop`).
- No nested selectors deeper than 3 levels.
- All spacing uses `var(--sp-*)` units.
- All font sizes use `var(--font-size-*)`.

### 7.4 JS Client-Side Naming

- State object property names: `camelCase`.
- Render functions: `renderXxx()`.
- Event handlers: `onXxx()` or inline arrow functions in delegated listeners.
- API wrapper functions: `api.xxx()`.

## 8. Key Implementation Rules

1. **Every server function must call `Session.getActiveUser().getEmail()`** at the top (except publicly readable endpoints like `poll`). Never accept the user identity from the client.

2. **Admin-only operations must always check `isAdmin(email)` server-side**, regardless of what the client UI shows.

3. **Never trust client data.** The server always reads authoritative state from Script Properties before applying mutations. Client sends only mutation parameters, never the entire record.

4. **Write-through cache.** After every Script Properties write, immediately write the same data to CacheService. On write failure to cache, increment `dbVersion` in both SP and cache (cache failure is detected on next poll).

5. **Skeleton-first frontend.** `Index.html` must contain only the skeleton layout (top bar, empty pane containers, modal shells). Data is loaded via `google.script.run.getInitialData()` after page boot.

6. **Compact storage.** All stored JSON uses short property keys. The translation layer is the single responsibility of `Database.gs`.

7. **Deterministic ID:** `SHA-256(creatorEmail + "|" + creationDate + "|" + id)` → first 16 hex chars. Computed in `Database.gs:computeDeterministicId()`.

8. **Soft-delete pattern:** Never hard-delete user data immediately. Set `deletedDate` to now. Hard-delete only after `deletedTaskRetentionDays` (default 7) via daily purge trigger. Exception: admin user deletion hard-deletes private tasks immediately.

9. **Version increment:** Every mutation to a Task or Activity increments its `version` field. The `dbVersion` counter (in `db_meta`) is a global counter incremented on every mutation across all entities, used by the polling system.

10. **No global variables between executions.** GAS does not preserve global state between invocations. Load config on every execution (with in-execution caching via local variable). Use Script Properties + CacheService as the only persistent stores.
