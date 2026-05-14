# BetterKanban — Google Apps Script Specification

## 1. Project Overview

BetterKanban is a project management tool built entirely on **Google Apps Script (GAS)** for use within a Google Workspace domain. It provides:

- A **Task list** for one-off to-dos (no Kanban workflow).
- A **Kanban Board** for managing multi-step Activities via drag-and-drop, with per-card comment threads.
- **Automatic user registration** via Google Workspace email — no login screen.
- A combined **Home page** that shows both Tasks and Activities, with per-zone hide/show toggles and keyword search.
- Per-user **Settings** page (Google Chat webhook, vacation periods, import/export from a spreadsheet dump).
- An **Admin page** for managing configuration, admin users, and user deletion.
- **Daily spreadsheet backup** of all data.

**Deployment target**: GAS Web App (HtmlService), published to run as the developer and accessible to "Anyone within [domain]".

---

## 2. Technology Stack

| Layer          | Technology                                           |
| -------------- | ---------------------------------------------------- |
| Backend        | Google Apps Script (V8 runtime, ES2019+)             |
| Frontend       | HTML5 + CSS3 + Vanilla JS (via HtmlService)          |
| User Identity  | `Session.getActiveUser().getEmail()` (Google Workspace) |
| Hot Storage    | `PropertiesService.getScriptProperties()` (max 500 KB total) |
| Cold Storage   | Google Spreadsheet (1 worksheet per entity for daily snapshots) |
| Caching        | `CacheService.getScriptCache()` (short-lived, for read optimisation) |
| Drag & Drop    | HTML5 Drag & Drop API                                |
| Notifications  | Google Chat Webhooks (via `UrlFetchApp.fetch()`)      |
| Auto-trigger   | Time-driven trigger (once daily)                     |
| Config         | `Config.json` (project file) + Script Properties overlay editable by admin |

### 2.1 Config file format: JSON

**JSON** over YAML:

- `JSON.parse()` / `JSON.stringify()` are native in GAS (V8 runtime).
- YAML requires bundling a third-party parser (~20 KB minified).
- JSON is universally understood and easy to validate.

---

## 3. Data Model

### 3.1 User

```json
{
  "email": "peter-simon.hanson-muffin@thecompany.com",
  "displayName": "Peter Hanson",
  "firstAccessDate": "2026-05-14T12:00:00Z",
  "lastAccessDate": "2026-05-14T12:00:00Z",
  "deletedDate": null,
  "role": "user",
  "settings": {
    "chatWebhookUrl": "https://chat.googleapis.com/v1/spaces/...",
    "vacations": [
      { "start": "2026-07-01", "end": "2026-07-15" }
    ]
  }
}
```

| Field          | Type   | Notes                                                    |
| -------------- | ------ | -------------------------------------------------------- |
| email          | string | The user's Google Workspace email. Used as the unique identifier. |
| displayName    | string | Automatically derived from the email local part on first registration. The user may change it via Settings. |
| firstAccessDate| string | ISO 8601 timestamp of first visit.                       |
| lastAccessDate | string | ISO 8601 timestamp, updated on every page load.          |
| role           | string | `"user"` or `"admin"`. Determined by the admin email list (see §7). |
| deletedDate    | string | `null` = active user. Set to ISO 8601 when the admin deletes the user. Registration flow rejects users with a non-null `deletedDate`. |
| settings       | object | Per-user preferences.                                     |

**User settings object:**

| Sub-field       | Type   | Description                                                    |
| --------------- | ------ | -------------------------------------------------------------- |
| `chatWebhookUrl`| string | Google Chat webhook URL for notifications. Empty = disabled.   |
| `vacations`     | array  | Array of `{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }` objects. During these periods the user receives no notifications. |

**Display name derivation** from email local part:

Email → split `@` → local part → split `.` → first segment = first name, second segment = last name → split each segment by `-` → take first element only → capitalize first letter.

| Email local part                | First name | Last name | Display name          |
| ------------------------------- | ---------- | --------- | --------------------- |
| `peter-simon.hanson-muffin`     | Peter      | Hanson    | Peter Hanson          |
| `klaus.jansen`                  | Klaus      | Jansen    | Klaus Jansen          |
| `marie.curie-sklodowska`        | Marie      | Curie     | Marie Curie           |

**Registration flow**: When a user opens the web app, the server calls `Session.getActiveUser().getEmail()`. If the email is not yet in the database, a new `User` record is created (display name auto-derived, role checked against the admin list).

### 3.2 Task

```json
{
  "id": "uuid-v4",
  "deterministicId": "a1b2c3d4e5f6g7h8",
  "description": "Buy groceries",
  "creatorEmail": "peter-simon.hanson-muffin@thecompany.com",
  "creationDate": "2026-05-14T12:00:00Z",
  "dueDate": "2026-05-16T12:00:00Z",
  "assignedTo": "peter-simon.hanson-muffin@thecompany.com",
  "visibility": "public",
  "comment": "Remember to get milk",
  "version": 1,
  "completedDate": null,
  "deletedDate": null,
  "lastModifiedDate": "2026-05-14T12:00:00Z"
}
```

| Field            | Type   | Constraints                                              |
| ---------------- | ------ | -------------------------------------------------------- |
| id               | string | UUID v4. Internal unique identifier.                     |
| deterministicId  | string | SHA-256 hex digest (first 16 chars) of `creatorEmail + "|" + creationDate`. Used for import deduplication. |
| description      | string | **Mandatory**.                                           |
| creatorEmail     | string | Automatically set from `Session.getActiveUser().getEmail()`. |
| creationDate     | string | ISO 8601. Automatically set.                             |
| dueDate          | string | ISO 8601, **optional**.                                  |
| assignedTo       | string | Email of the assigned user. **Optional**. For private tasks, defaults to `creatorEmail` and is hidden from the form. |
| visibility       | string | `"private"` (only creator sees it) or `"public"` (all users). |
| comment          | string | Free-text, **optional**. Single-field note.              |
| version          | number | Optimistic-lock counter. Starts at 1, incremented on every server-side mutation. |
| completedDate    | string | `null` = not completed. Set to ISO 8601 when completing. |
| deletedDate      | string | `null` = not deleted. Set to ISO 8601 when deleting.     |
| lastModifiedDate | string | Updated on every server-side mutation.                   |

**Visibility change**: Only the **creator** or the **admin** can change the visibility flag after creation.

**Hard-delete rules**:
- A deleted task is **permanently removed** 7 days after `deletedDate`.
- `deletedDate` can be cleared (undelete) during those 7 days.
- Completed tasks beyond the configured threshold are hard-deleted (see §7).

### 3.3 Activity (Kanban Card)

```json
{
  "id": "uuid-v4",
  "deterministicId": "b2c3d4e5f6g7h8i9",
  "title": "Design login page",
  "description": "Create wireframes and implement the login flow",
  "creatorEmail": "peter-simon.hanson-muffin@thecompany.com",
  "creationDate": "2026-05-14T12:00:00Z",
  "dueDate": null,
  "assignedTo": null,
  "columnId": "col-in-progress",
  "columnOrder": 2,
  "version": 1,
  "comments": [
    {
      "id": "uuid-comment-1",
      "authorEmail": "klaus.jansen@thecompany.com",
      "creationDate": "2026-05-15T09:30:00Z",
      "lastModifiedDate": null,
      "text": "I can take this over if needed."
    },
    {
      "id": "uuid-comment-2",
      "authorEmail": "peter-simon.hanson-muffin@thecompany.com",
      "creationDate": "2026-05-14T14:00:00Z",
      "lastModifiedDate": "2026-05-15T08:00:00Z",
      "text": "Updated the wireframes in the shared drive."
    }
  ],
  "completedDate": null,
  "deletedDate": null,
  "lastModifiedDate": "2026-05-14T12:00:00Z"
}
```

| Field            | Type   | Notes                                                    |
| ---------------- | ------ | -------------------------------------------------------- |
| id               | string | UUID v4. Internal unique identifier.                     |
| deterministicId  | string | SHA-256 hex digest (first 16 chars) of `creatorEmail + "|" + creationDate`. Used for import deduplication. |
| title            | string | Short headline. **Mandatory**.                           |
| description      | string | Longer text. **Optional**.                               |
| creatorEmail     | string | Automatically set.                                       |
| creationDate     | string | ISO 8601. Automatically set.                             |
| dueDate          | string | Optional.                                                |
| assignedTo       | string | Optional email of the assigned user.                     |
| columnId         | string | References `Column.id`. Determines which Kanban column the card sits in. |
| columnOrder      | number | Integer position within the column (0 = top).            |
| comments         | array  | Array of `Comment` objects. Newest first.                |
| version          | number | Optimistic-lock counter. Starts at 1, incremented on every server-side mutation. |
| completedDate    | string | `null` or ISO 8601.                                      |
| deletedDate      | string | `null` or ISO 8601.                                      |
| lastModifiedDate | string | Updated on every mutation.                               |

Activities are **always public** — there is no `visibility` field. Every user sees every activity. The soft-delete and hard-delete rules for completion/deletion are the same as Tasks.

#### 3.3.1 Comment

```json
{
  "id": "uuid-comment-1",
  "authorEmail": "klaus.jansen@thecompany.com",
  "creationDate": "2026-05-15T09:30:00Z",
  "lastModifiedDate": null,
  "text": "I can take this over if needed."
}
```

| Field            | Type   | Notes                                                    |
| ---------------- | ------ | -------------------------------------------------------- |
| id               | string | UUID v4.                                                 |
| authorEmail      | string | Email of the comment author.                             |
| creationDate     | string | ISO 8601. Set on creation, never changed.                |
| lastModifiedDate | string | `null` if never edited. ISO 8601 on update.              |
| text             | string | The comment body. Limited to 2000 characters server-side. |

- Newest comment is always first in the array.
- Any user can create, update, or delete any comment (no author-only restriction).
- Updating sets `text` and `lastModifiedDate`.
- Deletion removes the comment from the `comments` array entirely.

### 3.4 Column (Kanban Columns)

```json
{
  "id": "col-in-progress",
  "name": "In Progress",
  "order": 1
}
```

Columns are defined in `Config.json` (see §7). If none are defined, a single **default column** named `"Activities"` is created automatically at startup.

### 3.5 Deterministic ID (Hash)

Every Task and Activity gets a `deterministicId` computed at creation time:

```
input = creatorEmail + "|" + creationDate + "|" + id   // e.g. "klaus.jansen@thecompany.com|2026-05-14T12:00:00Z|uuid-v4"
hash  = SHA-256(input)                                   // full 64-char hex digest
deterministicId = hash.substring(0, 16)                  // first 16 hex characters

- Generated server-side in GAS via `Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8)`.
- The `id` (UUID v4) is appended to guarantee uniqueness even if the same user creates two entities within the same second. The dedup semantics during import remain intact (same UUID → same entity).
- Used as the deduplication key during import from a spreadsheet dump.

---

## 4. Database Strategy

### 4.1 Primary Storage: Script Properties

`PropertiesService.getScriptProperties()` holds the **live working dataset** as JSON blobs. The total limit is **500 KB** across all keys, so every byte is optimised.

#### Design

- Data is split across **multiple keys** (not one giant blob) for faster targeted reads and lower deserialisation overhead:

  | Key              | Content                              | Typical size |
  | ---------------- | ------------------------------------ | ------------ |
  | `db_users`       | Array of all User objects            | ~2 KB (10 users) |
  | `db_tasks`       | Array of all Task objects            | ~30 KB (200 tasks) |
  | `db_activities`  | Array of all Activity objects        | ~50 KB (150 activities + comments) |
  | `db_meta`        | Global version counters & metadata   | < 1 KB |
  | `configOverlay`  | Admin-edited config overrides        | ~2 KB |
  | `admin`          | Admin email list                     | < 1 KB |

- Each server function reads only the relevant key(s), modifies entities in memory, and writes the key back — all within a single GAS execution.
- The dataset is loaded in full only on initial page load (`getInitialData()`). All subsequent writes are targeted.

#### Space-Saving Techniques

| Technique                | Implementation                                              | Savings |
| ------------------------ | ----------------------------------------------------------- | ------- |
| **Short property keys**  | Keys stored at 1-4 characters instead of full camelCase names. A server-side translation layer (2 small lookup maps) converts between short and full names. | ~40 % |
| **No redundant fields**  | Fields with default values are omitted entirely (e.g., `completedDate: null` → absent). | ~10 % |
| **Date compression**     | Dates stored as compact ISO 8601 without timezone suffix (`"2026-05-14T12:00:00"`). | ~15 % |
| **No whitespace**        | `JSON.stringify(obj)` already produces no extra whitespace in V8. | built-in |
| **Pessimistic size check** | On every mutating write, the total size of all `db_*` keys is estimated (`JSON.stringify().length`). If it exceeds 400 KB, the oldest completed tasks and soft-deleted records beyond the configured thresholds are purged immediately. | headroom |

#### Size Budget Estimation

| Entity         | Approximate bytes per record | 500 KB capacity |
| -------------- | ---------------------------- | --------------- |
| Task           | ~180 B (short keys, compact) | ~2 800          |
| Activity       | ~250 B (short keys + 2 avg comments) | ~2 000 |
| User           | ~150 B                       | ~3 300          |

For a team of up to 10 users with a few hundred active tasks and activities, the 500 KB limit is comfortably sufficient. The daily spreadsheet backup (§4.2) guarantees no data loss if the budget is ever exceeded.

### 4.2 Secondary Storage: Spreadsheet (Backup)

A designated **Google Spreadsheet** (configured in `Config.json`) receives a full daily snapshot.

#### Snapshot Format

Each daily backup creates a **set of 3 timestamped worksheets** named `YYYY-MM-DD_Tasks`, `YYYY-MM-DD_Activities`, and `YYYY-MM-DD_Users`. Together these 3 sheets form one complete snapshot of the database at that date.

| Sheet pattern           | Columns                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `2026-05-14_Tasks`      | `id, deterministicId, description, creatorEmail, creationDate, dueDate, assignedTo, visibility, comment, version, completedDate, deletedDate, lastModifiedDate` |
| `2026-05-14_Activities` | `id, deterministicId, title, description, creatorEmail, creationDate, dueDate, assignedTo, columnId, columnOrder, version, comments, completedDate, deletedDate, lastModifiedDate` |
| `2026-05-14_Users`      | `email, displayName, firstAccessDate, lastAccessDate, deletedDate, role, settings` |

- The `comments` column stores the JSON-serialized array as a single cell.
- The `settings` column stores the user settings object as a JSON string.

#### Snapshot Retention

- A list of existing snapshot dates is tracked in `db_meta.snapshots` (JSON array of date strings, e.g. `["2026-05-13", "2026-05-12"]`).
- When the daily backup trigger runs:
  1. Read the current snapshot list from `db_meta`.
  2. Create 3 new worksheets for today's date.
  3. Populate them with current data from Script Properties.
  4. Prepend today's date to the snapshot list.
  5. If the list length exceeds `backupSnapshotCount`, remove the oldest entries and delete their corresponding worksheet sets from the Spreadsheet.
  6. Save the updated snapshot list to `db_meta.snapshots`.
- Default `backupSnapshotCount`: **5**.
- The export/import dump sheets (`_Dump_Tasks`, `_Dump_Activities`) are never rotated — they are manually managed.

### 4.3 Cache Layer (Write-Through with Invalidation)

`CacheService.getScriptCache()` is used to speed up reads. The rule: **every write to Script Properties must also write to CacheService** (or delete the cache entry), so stale data is never served.

#### Cache Strategy

| Operation | Behaviour                                                    |
| --------- | ------------------------------------------------------------ |
| **Read**  | Check CacheService first. On hit → return immediately. On miss → read from Script Properties, write result into CacheService (TTL 600 s), return. |
| **Write** | Write to Script Properties first. On success → write updated data to CacheService (same TTL) + increment `dbVersion` in both SP and cache. If the `dbVersion` cache write fails → the next poll will detect a version mismatch and reload from SP (safe fallback). |
| **Delete**| Remove the affected cache entry explicitly. Next read will miss and re-fetch from SP. |
| **Poll**  | Compare client's `lastVersion` against `dbVersion` in CacheService. Match → no change. Mismatch → reload from SP. |

#### Cache Contents

| Cache key(s)      | Content                            | TTL     | Why cached?                               |
| ----------------- | ---------------------------------- | ------- | ----------------------------------------- |
| `db_users`        | JSON array of User objects         | 600 s   | Read on every page load for display names |
| `db_tasks`        | JSON array of Task objects         | 600 s   | Read on every poll for full refresh       |
| `db_activities`   | JSON array of Activity objects     | 600 s   | Same as above                             |
| `db_meta`         | Metadata + `dbVersion`             | 600 s   | Version check + config                    |
| `dbVersion`       | Int (duplicate, separate key)      | **none**| Polling fast-path, no TTL vulnerability   |

All entity-level cache entries are keyed exactly like their Script Properties counterparts. When a write updates a `db_*` Script Properties key, the same key is written to CacheService in the same execution.

#### Consistency Guarantee

The 600-second TTL means infrequently accessed data can expire from cache — that's safe because the next read falls back to Script Properties. The critical guarantee is:

> **If data exists in CacheService, it is always the most recent version.**

This holds because:
1. Every write updates cache immediately after Script Properties.
2. A cache write failure after a successful SP write is detected on the next poll via `dbVersion` mismatch.
3. The TTL only removes data that hasn't been read or written in 10 minutes — it never creates a window where stale data is served.

#### Polling Fast-Path

The separate `dbVersion` cache key (no TTL) enables the polling fast-path:

```javascript
function poll(clientVersion) {
  const cachedVersion = CacheService.get('dbVersion');
  if (cachedVersion !== null && cachedVersion === clientVersion) {
    return { changed: false }; // Fast path: no change
  }
  // Fall back to Script Properties for authoritative version
  const meta = JSON.parse(PropertiesService.getScriptProperties().getProperty('db_meta'));
  if (meta.version === clientVersion) {
    CacheService.put('dbVersion', meta.version, 21600); // Correct cache
    return { changed: false };
  }
  return { changed: true, data: loadFullSnapshot(), newVersion: meta.version };
}
```

#### Summary

| Scenario                          | Behaviour                                               |
| --------------------------------- | ------------------------------------------------------- |
| Data recently read or written     | Cache hit → fast response.                              |
| Data not touched in > 10 minutes  | Cache miss → read from SP, re-cache. Consistent.        |
| Write to Script Properties succeeds, cache update fails | Next poll detects version mismatch → reload from SP. Recovers on next write. |
| Another user made a change        | Their write updated cache + `dbVersion`. Poll detects change → new data served. |

### 4.4 Data Flow

```
┌──────────┐  google.script.run (mutations)   ┌────────────┐
│ Browser  │ ────────────────────────────────→ │ GAS Server │
│  (JS)    │                                   │  (doGet)   │
│          │ ←──────────────────────────────── │            │
│          │     JSON response / error          │            │
│          │                                   │            │
│          │  setInterval (polling)             │   ↓    ↓   │
│          │ ────────────────────────────────→ │  SP   Cache │
│          │     poll(lastVersion)              │            │
│          │ ←──────────────────────────────── │            │
│          │  {changed, data?, newVersion}      │            │
│          │                                   │     ↓      │
│          │        Session.getActiveUser()     │ Spreadsheet│
│          │                                   │ (backup)   │
└──────────┘                                   └────────────┘
```

### 4.5 Backup Spreadsheet Dump Format (Import/Export)

A special **`_Dump_Tasks`** and **`_Dump_Activities`** sheet structure is used for manual export (triggered from the Settings page or Admin page) and import (from the Settings page).

These use **column number** (1-indexed) instead of `columnId`, making the dump portable between different Kanban configurations.

**`_Dump_Tasks`**:

| Column       | Example                                                     |
| ------------ | ----------------------------------------------------------- |
| hashId       | `a1b2c3d4e5f6g7h8`                                         |
| description  | Buy groceries                                               |
| creatorEmail | peter-simon.hanson-muffin@thecompany.com                   |
| creationDate | 2026-05-14T12:00:00Z                                        |
| dueDate      | 2026-05-16T12:00:00Z                                        |
| assignedTo   | klaus.jansen@thecompany.com                                 |
| visibility   | public                                                      |
| comment      | Remember to get milk                                        |
| version      | 1                                                           |
| completedDate| (blank if not completed)                                    |
| deletedDate  | (blank if not deleted)                                      |

**`_Dump_Activities`**:

| Column        | Example                                                     |
| ------------- | ----------------------------------------------------------- |
| hashId        | `b2c3d4e5f6g7h8i9`                                         |
| title         | Design login page                                           |
| description   | Create wireframes...                                        |
| creatorEmail  | peter-simon.hanson-muffin@thecompany.com                   |
| creationDate  | 2026-05-14T12:00:00Z                                        |
| dueDate       | (blank)                                                     |
| assignedTo    | (blank)                                                     |
| columnNumber  | `2` (1-indexed column position in the source Kanban)        |
| columnOrder   | `2` (position within column)                                |
| version       | 1                                                           |
| comments      | `[{"id":"...","authorEmail":"...",...}]` (JSON array)       |
| completedDate | (blank)                                                     |
| deletedDate   | (blank)                                                     |

**Import rules**:
1. The `hashId` is checked against existing `deterministicId` values. If a match is found, the row is skipped and a message is reported: *"Task/activity a1b2c3d4e5f6g7h8 already exists — skipped."*
2. The `creationDate` from the dump is **preserved** as-is on import (not regenerated). This ensures the `deterministicId` (which incorporates `creationDate`) remains stable and dedup works correctly across re-imports.
3. For activities: `columnNumber` (1-indexed) determines placement — the activity goes into whatever column currently occupies that index position. Column **names** are irrelevant; only the index matters. If the current Kanban has fewer columns than `columnNumber`, the activity is placed in **Column 1** (the first column, which must always exist).
4. `columnOrder` from the dump is preserved as the card's order within the target column. After inserting all imported activities into their respective columns, the server renumbers `columnOrder` values sequentially (0, 1, 2, …) for every column to eliminate gaps and duplicates.
5. `version` in the dump is ignored — all imported entities get `version: 1`. This ensures the optimistic lock starts clean and prevents stale-version conflicts with clients that may have cached older versions.
6. Rows without a valid `hashId` are skipped with a warning.

### 4.6 Multi-User Access & Concurrency

BetterKanban must be resilient when multiple users access the tool simultaneously. This section covers how data integrity is maintained.

#### 4.6.1 Mutex-Protected Write Access

Every write operation is protected by an **implicit mutex** provided by GAS's single-threaded execution model:

> GAS executes requests against a single project **sequentially** — only one server function runs at a time. If two write requests arrive simultaneously, GAS queues them. The first request acquires the mutex (executes), completes its read-modify-write cycle, and releases the mutex. Then the second request acquires the mutex and executes against the updated state.

This means:
- Two writes can never interleave at the instruction level.
- Every write sees a consistent snapshot of the data.
- No explicit lock/unlock code is needed — the GAS runtime provides this automatically.

#### 4.6.2 Atomic Server-Side Operations

Every mutating server method follows this pattern in a single execution context:

```
1. Read current entity from Script Properties   (db_tasks, db_activities, db_users)
2. Apply the change in memory (add, update, remove)
3. Increment dbVersion counter
4. Write the modified key back to Script Properties
5. Write the same key to CacheService (write-through) + update dbVersion in cache
```

Because GAS serialises all executions, step 1 always sees the result of any previous step 4. This means:

- `updateTask(taskId, changes)` — read task, apply changes, write back → safe.
- `moveActivity(id, columnId, newOrder)` — read activity, change column/order, write back → safe.
- `addComment(activityId, text)` — read activity, prepend comment, write back → safe.

**No client-side data is trusted**. The server always reads the authoritative state from Script Properties before applying changes. The client sends only the mutation parameters (which fields to change, new values), never the entire modified record.

#### 4.6.3 Optimistic Locking via Version Field

To prevent "lost updates" when a client holds stale data:

- Every entity (Task, Activity) includes a `version` field (integer, starts at 1, incremented on every server-side mutation).
- The client retains the `version` it last read for each entity.
- When the client sends an update, it includes the `version` it is modifying.
- The server compares `request.version` with `current.version`:
  - **Match** → apply the change, increment version, save.
  - **Mismatch** (request.version < current.version) → reject with error `409 Conflict: "Entity was modified by another user. Please refresh and try again."`
- The client handles 409 by calling `getTask(taskId)` / `getActivity(id)` to re-fetch only the affected entity (lightweight, avoids reloading the full dataset), then re-applies the user's pending edits on top and retries the update with the new version.

#### 4.6.4 Conflict Recovery Flow

```
User A loads page (v5 of task X)          User B loads page (v5 of task X)
         │                                          │
         │ User A edits description                  │ User B edits assignedTo
         │ updateTask(X, {desc}, v5)                 │ updateTask(X, {asgn}, v5)
         │                                          │
         ▼                                          ▼
   Server: v5 == v5 → OK                    Server: v5 < v6 → 409
   Server writes v6                                   ▲
         │                                          │
         │                                          User B's client:
         │                                          - re-fetches task X (now v6)
         │                                          - shows "modified by another user"
         │                                          - applies User B's assignedTo change on top
         │                                          - retries with update(X, {asgn}, v6)
         │                                          │
         ▼                                          ▼
   User A sees change saved                User B sees combined result saved
```

#### 4.6.5 Field-Level Merge (No Lost Updates on Different Fields)

The key design goal: **if two users edit different fields of the same entity, both changes are preserved.** This is achieved through field-level partial updates combined with GAS's single-threaded execution.

**How it works:**

Every mutating server function receives only the fields that changed (plus the entity `id` and `version`). The function:

```
1. Read the full entity from Script Properties.
2. Merge only the incoming fields into the current entity.
   - Incoming "description" → overwrite current "description"
   - Incoming "assignedTo"  → overwrite current "assignedTo"
   - No incoming "comments" → current "comments" is untouched
3. Check optimistic lock (version match).
4. Increment version.
5. Write the merged entity back to Script Properties.
6. Write-through to CacheService.
```

**Concrete example — no conflict:**

| Time | User A                          | User B                          | Database state (after both)      |
| ---- | ------------------------------- | ------------------------------- | -------------------------------- |
| T1   | Reads task X (v1)               |                                 | `{desc: "A", asgn: null, v1}`   |
| T2   |                                 | Reads task X (v1)               | Same                            |
| T3   | `updateTask(X, {desc:"B"}, v1)` |                                 | Server reads X, merges desc, writes. X is now `{desc:"B", asgn:null, v2}` |
| T4   |                                 | `updateTask(X, {asgn:"user"}, v1)` | Server reads X (now v2, desc="B"). Version mismatch → v1 != v2 → **409 conflict**. |
| T5   |                                 | Client re-fetches X (v2, desc="B"). Auto-merges pending `asgn` change. Retries with `updateTask(X, {asgn:"user"}, v2)`. | Server merges asgn. X is now `{desc:"B", asgn:"user", v3}`. |

Both changes end up in the final record. User B's client sees a brief "conflict" toast but the pending change is applied automatically.

**Concrete example — same field conflict:**

| Time | User A                          | User B                          | Result                          |
| ---- | ------------------------------- | ------------------------------- | ------------------------------- |
| T1   | `updateTask(X, {desc:"B"}, v1)` |                                 | desc = B, v2                    |
| T2   |                                 | `updateTask(X, {desc:"C"}, v1)` | 409 conflict → User B re-fetches (desc=B, v2), merges desc=C, retries with v2. Final: desc=C, v3. |

Last write wins on the same field. User B's description overwrites User A's — this is expected because they explicitly edited the same property.

**Allowed per-field updates:**

| Entity   | Field            | Writable by            | Notes                              |
| -------- | ---------------- | ---------------------- | ---------------------------------- |
| Task     | description      | Any user               |                                    |
| Task     | dueDate          | Any user               | Set to null to clear               |
| Task     | assignedTo       | Any user               | Set to null to unassign            |
| Task     | visibility       | Creator or admin only  | `"private"` ↔ `"public"`          |
| Task     | comment          | Any user               | Replaces the entire comment string |
| Task     | completedDate    | Any user (via complete/uncomplete) | Set by `completeTask()` / `uncompleteTask()` |
| Task     | deletedDate      | Any user (via delete/undelete) | Set by `deleteTask()` / `undeleteTask()` |
| Activity | title            | Any user               |                                    |
| Activity | description      | Any user               |                                    |
| Activity | dueDate          | Any user               |                                    |
| Activity | assignedTo       | Any user               |                                    |
| Activity | columnId         | Any user (via drag-drop) | Set by `moveActivity()`          |
| Activity | columnOrder      | Any user (via drag-drop) | Set by `moveActivity()`          |

Fields not listed and fields marked as "Set by..." are **never directly writable** via the generic update endpoint — they are set automatically by specific server methods:
- `id`, `deterministicId`, `creatorEmail`, `creationDate` — set at creation time, never changed.
- `version` — managed internally by the optimistic locking system.
- `lastModifiedDate` — set server-side on every mutation, never accepted from the client.
- `completedDate` — set by `completeTask()` / `completeActivity()`, cleared by `uncomplete*()`.
- `deletedDate` — set by `deleteTask()` / `deleteActivity()`, cleared by `undelete*()`.

#### 4.6.6 What About Spreadsheet Backup During Writes?

The daily backup trigger reads the full state from Script Properties and writes to the Spreadsheet. This is a read-only operation on Script Properties — it never conflicts with user writes. If a user write occurs during backup, GAS queues it and executes it after the backup completes (or vice versa). No special handling is needed.

#### 4.6.7 Summary of Guarantees

| Scenario                          | Behaviour                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| Two users edit different fields   | Both succeed (field-level partial updates are independent).  |
| Two users edit the same field     | Last write wins (with optimistic-lock rejection + client-side retry). |
| Two users edit different entities | Both succeed (independent keys in Script Properties).        |
| User edits while backup runs      | Backup reads a consistent snapshot; write is queued.         |
| Network error mid-write           | The server function either completes fully or throws — Script Properties is not left in a half-written state (single key-write is atomic). |

---

## 5. User Management

### 5.1 Identity via Google Workspace

BetterKanban runs inside a Google Workspace domain. It is published as a GAS web app with:

- **Execute as**: Me (the developer)
- **Who has access**: Anyone within [domain]

When a user opens the app, `Session.getActiveUser().getEmail()` returns their company email address. This is the **sole and authoritative identity**. No UUIDs, no localStorage tokens, no login screen.

### 5.2 Auto-Registration

1. On every page load, the server calls `Session.getActiveUser().getEmail()`.
2. The email is looked up in the user database.
3. If not found, a `User` record is created:
   - `email` = the full email address
   - `displayName` = auto-derived from the local part (see §3.1)
   - `role` = `"admin"` if the email appears in the admin list (see §7), otherwise `"user"`
   - `firstAccessDate` / `lastAccessDate` = now
4. If found, `lastAccessDate` is updated.

### 5.3 Admin Determination

Admins are not defined by "first user to register". Instead, the admin list is stored in Script Properties under key `"admin"` as a semicolon-separated string of email addresses:

```
herman.tiflis@thecompany.com;nicola.muffert@thecompany.com
```

On every registration/login, the user's email is checked against this list. Matching emails get `role: "admin"`.

### 5.4 Display Name

- Derived automatically on first registration.
- The user can optionally change it via Settings (persisted to their `User` record).
- Used throughout the UI (task cards, activity cards, assignment badges, comment author).
- **Display names in the UI are always resolved from the current user database at render time**, not from historical snapshots in task/activity records. This means if a user changes their display name, all existing tasks and activities automatically reflect the new name (since they reference the user by `email`, and the display name is looked up dynamically).

---

## 6. Functional Modules

### 6.1 Home Page (Dashboard)

**UI**: The landing page and primary workspace.

The Home page is split into **two resizable side-by-side panes**: Tasks on the **left**, Kanban on the **right**.

```
┌─────────────────────────────────────────────────────────────┐
│  Home Page                                                   │
├──────────────────────────────┬──────────────────────────────┤
│  ┌────────────────────────┐ │ ┌──────┬──────┬──────┬──...  │
│  │ Tasks          🔍 [_] │ │ │Actvt │🔍 [_]│      │       │
│  │                        │ │ ├──────┤──────┤──────┤       │
│  │  ☐ Buy groceries  🔓  │ │ │To Do │In Pr │Block │       │
│  │  ☐ Fix login      🔒  │ │ │ 2    │ 3    │ 1    │       │
│  │                        │ │ │┌────┐│┌────┐│┌────┐│       │
│  │  [+ New Task]          │ │ ││Card│││Card│││Card││       │
│  └────────────────────────┘ │ └──────┴──────┴──────┘       │
├──────────────────────────────┴──────────────────────────────┤
│  [+ New Task]                     [+ New Activity]          │
└─────────────────────────────────────────────────────────────┘
```

**Pane toggles**: Each pane has a `[Hide ◀]` / `[Show ▶]` button in its header. Hiding a pane collapses it so the other pane fills the full width.

**Search**: Each zone has its own keyword search input. Items are filtered client-side in real-time:

- **Task search**: matches against `description`, `assignedTo` (display name), `comment`.
- **Activity search**: matches against `title`, `description`, `assignedTo` (display name), comment `text` (any comment in the thread).

Empty search shows all items.

**Welcome bar**: At the top, a greeting: *"Welcome back, Peter Hanson"* with quick counters (tasks assigned to me, tasks due today, overdue tasks). Counters reflect **all** tasks (including completed and deleted), regardless of the current filter toggles — giving the user a complete picture of their workload.

### 6.2 Task Manager

**Location**: The left pane on the Home page.

**Operations**:

| Action          | Server method        | Notes                                                     |
| --------------- | -------------------- | --------------------------------------------------------- |
| Create          | `createTask(data)`   | `data` must include `description`. `creatorEmail`, `deterministicId`, and dates are set server-side. |
| Read (list)     | `getTasks(opts)`     | `opts` include `{ showDeleted: bool, showCompleted: bool }`. Returns array of visible `Task` objects. |
| Read (single)   | `getTask(taskId)`   | Returns a single `Task` object by ID. Used by the client after a 409 conflict to re-fetch only the affected entity. |
| Update          | `updateTask(taskId, changes)` | `changes` is a partial object. Only allowed fields are overwritten. |
| Complete        | `completeTask(taskId)` | Sets `completedDate` to now.                           |
| Uncomplete      | `uncompleteTask(taskId)` | Sets `completedDate` to `null`.                      |
| Delete (soft)   | `deleteTask(taskId)`  | Sets `deletedDate` to now.                              |
| Undelete        | `undeleteTask(taskId)` | Sets `deletedDate` to `null`.                          |
| Purge old       | `purgeOldTasks()`     | Called automatically by the daily purge trigger. Hard-deletes tasks where `deletedDate` is older than `deletedTaskRetentionDays`, and oldest completed tasks beyond `completedTaskMaxCount`. |

**Task card display** — compact card showing only the essential overview:

```
┌──────────────────────────────────────┐
│ ☐  Buy groceries                  🔓 │   ← checkbox + description + visibility badge
│     👤 Peter                        │   ← assigned person (display name)
│     💬 Remember to get milk          │   ← comment preview (only if comment exists)
└──────────────────────────────────────┘
```

| Element           | Style                                                       |
| ----------------- | ----------------------------------------------------------- |
| Checkbox `☐`     | 16×16 px, circular. Checked = filled green with white checkmark. |
| Description       | `--font-size-md`, `--text-primary`, `font-weight: 500`. Strikes through when completed, opacity 0.5. |
| Visibility badge  | `🔓` public or `🔒` private, small pill.                   |
| Assigned person   | `👤 Peter` in `--font-size-sm`, `--text-secondary`. Only shown if a person is assigned. |
| Comment preview   | `💬` + first 80 chars of comment, `--font-size-sm`, `--text-muted`. Only shown if comment exists. |

**Task card interaction**:
- Click the card → **detail modal** opens (see §8.14). There the user can view/edit all fields: description, due date, assigned person, visibility (`🔓`/`🔒`), comment, complete/delete actions.
- The detail modal also shows the creator name and creation date (read-only).
- Completing via checkbox on the compact card strikes through and fades the card immediately (optimistic UI).
- Clicking **"Update"** inside the modal sends only the changed fields (+ version) to the server. The server merges them into the current entity atomically (see §4.6.5).

**Visibility toggle buttons** (at top of zone):
- `☑ Show completed` — toggles `opts.showCompleted`.
- `☑ Show deleted` — toggles `opts.showDeleted`.

### 6.3 Kanban Board (Activities)

**Location**: The right pane on the Home page.

**Column layout**: Rendered as a horizontal scroll of columns. Each column is a vertical list of cards.

**Column header**: Column name + card count badge.

**Filter toggles** (above the columns, right-aligned in the pane header):
- `☑ Show completed` — toggles visibility of activities with `completedDate` set.
- `☑ Show deleted` — toggles visibility of activities with `deletedDate` set.
- Same pill-style toggle buttons as the Tasks pane (§6.2). Both default to off (hide completed/deleted).

#### 6.3.1 Activity Card (Compact View)

In the Kanban view, each card shows only the **essential information** for a clean overview:

```
┌──────────────────────────────────┐
│ Design login page                │  ← title
│                                  │
│ Create wireframes and implement  │  ← description (full, no truncation)
│ the login flow and user          │
│ authentication flow...           │
│                                  │
│ 📅 2026-05-20                    │  ← due date (red if overdue)
│ 👤 Klaus Jansen                  │  ← assigned user (display name)
│ 💬 "I can take this over..."     │  ← last comment text (truncated to 1 line only)
└──────────────────────────────────┘
```

| Element          | Behaviour                                                    |
| ---------------- | ------------------------------------------------------------ |
| Title            | Bold, always visible.                                        |
| Description      | Shown in full on the card face. No truncation. Card height grows with content. |
| Due date         | Shown as a compact badge. Red = overdue, yellow = due today, grey = future. |
| Assigned user    | Display name with a 👤 icon. Optionally colour-coded.         |
| Last comment     | The `text` of the last (newest) comment in the `comments` array, truncated to 1 line with ellipsis. If no comments exist, this line is hidden. |

#### 6.3.2 Operations

| Action          | Server method               | Notes                                                    |
| --------------- | --------------------------- | -------------------------------------------------------- |
| Create          | `createActivity(data)`      | `data` must include `title`. `creatorEmail`, `deterministicId`, and dates set server-side. `columnId` defaults to first column. |
| Read (list)     | `getActivities(opts)`       | Same filter options as tasks. Full `comments` array is returned. |
| Read (single)   | `getActivity(id)`           | Returns a single `Activity` object by ID. Used by the client after a 409 conflict. |
| Update          | `updateActivity(id, changes)` | Partial update. Includes title, description, dueDate, assignedTo. |
| Complete        | `completeActivity(id)`      | Sets `completedDate`. Card may move to `completedColumnId` if configured. |
| Uncomplete      | `uncompleteActivity(id)`    | Clears `completedDate`. Card moves to the **first column** (`columns[0].id`). |
| Delete (soft)   | `deleteActivity(id)`        | Sets `deletedDate`.                                      |
| Undelete        | `undeleteActivity(id)`      | Clears `deletedDate`.                                    |
| Move card       | `moveActivity(id, columnId, newOrder)` | Updates `columnId` and `columnOrder` atomically. Also used for reordering within the same column — `newOrder` is the target position index. |
| Purge old       | `purgeOldActivities()`  | Called automatically by the same daily trigger as `purgeOldTasks()`. Hard-deletes activities where `deletedDate` is older than `deletedTaskRetentionDays`, and oldest completed activities beyond `completedActivityMaxCount`. |

#### 6.3.3 Comment Operations

Each activity's comments are managed through these server methods. All comment operations also update the parent Activity's `lastModifiedDate` and increment its `version` (since the Activity's `comments` array is mutated and the entire Activity is written back to storage):

| Action          | Server method                     | Notes                                                    |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| Add comment     | `addComment(activityId, text)`    | Creates a new `Comment` (server sets `id`, `authorEmail`, `creationDate`). Prepended to the `comments` array. |
| Update comment  | `updateComment(activityId, commentId, newText)` | Updates `text` and sets `lastModifiedDate` to now. |
| Delete comment  | `deleteComment(activityId, commentId)` | Removes the comment from the `comments` array entirely. |

#### 6.3.4 Activity Detail View (Card Editor)

Clicking a card opens the detail view (modal panel):

```
┌──────────────────────────────────────────────┐
│  Edit Activity                     [Close X]  │
├──────────────────────────────────────────────┤
│  Title:    [Design login page              ]  │
│  Due date: [2026-05-20       ] 👤 [Klaus ▼]  │
│                                              │
│  Description:                                │
│  ┌────────────────────────────────────────┐  │
│  │ Create wireframes and implement the   │  │
│  │ login flow                             │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ── Comments ──                              │
│                                              │
│  [Klaus Jansen — 2026-05-15 09:30]  [✏ 🗑]  │
│  I can take this over if needed.             │
│                                              │
│  [Peter Hanson — 2026-05-14 14:00]  [✏ 🗑]  │
│  Updated the wireframes in the shared        │
│  drive.                                      │  ← editable text
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Write a comment...                     │  │
│  └────────────────────────────────────────┘  │
│                                    [Add]     │
│                                              │
│  [ Update ]  [ Complete ]  [ Delete ]       │
└──────────────────────────────────────────────┘
```

- Comments are displayed **newest first**.
- Each comment has **author, creation date, and text**.
- Each comment has edit and delete buttons in the **top-right corner** of the comment block, small and muted (`--font-size-xs`, `--text-muted`, no background). The buttons are always visible but visually unobtrusive.
- Edit button (`✏`): clicking turns the comment text into an inline textarea. Save confirms, Cancel reverts.
- Delete button (`🗑`): clicking shows a small confirmation prompt *"Delete comment?"* and removes the comment permanently from the database. No undo.
- A text area at the bottom lets the user add a new comment.

#### 6.3.5 Drag & Drop

- Implemented with the **HTML5 Drag and Drop API**.
- Cards are `draggable="true"`. Drop zones are column containers and the gaps between cards within a column.
- On drop: `moveActivity(id, columnId, newOrder)` sends the target column and the desired position index.
- **Order calculation**: When a card is dropped, the client calculates the target index as the zero-based position where the card should land (0 = before the first card, 1 = after the first card / before the second, etc.). If dropped at the very end or the gap after the last card, index = column's card count. The server receives this `newOrder` value and:
  1. Removes the card from its source column.
  2. Inserts the card at position `newOrder` in the target column.
  3. Renumbers `columnOrder` values sequentially (0, 1, 2, …) for **all** cards in **both** the source and target columns, ensuring no gaps or duplicates.
- **Reordering within the same column**: Dropping a card at a different position in the same column triggers the same renumbering logic on that single column.
- **Optimistic UI**: The card moves immediately; if the server call fails, it snaps back with an error toast.
- Touch support via pointer events, falling back to touch events.

### 6.4 Admin Page

**Visibility**: Only shown as a tab for users whose email appears in the admin list. Non-admin users never see the tab or its route.

**Access**: The admin list is read from Script Properties at every page load. A user is deemed admin if their email appears in the semicolon-separated list.

**Server-side authorization**: Every admin-only server method (editing admin list, saving config, deleting users, importing snapshots) performs its own `isAdmin(email)` check against the current admin list in Script Properties — regardless of what the client's UI shows. If Admin A removes Admin B from the list, Admin B's next server call is rejected with a `403 Forbidden` response, even if their session still shows the Admin tab.

#### 6.4.1 Admin User Management

A text field showing the current semicolon-separated admin email list:

```
Admin emails:
─────────────────────────────────────────────
herman.tiflis@thecompany.com;nicola.muffert@thecompany.com
─────────────────────────────────────────────
[ Save ]
```

- The admin can add or remove email addresses.
- **Validation**: Each entry is checked for a basic email format (`*@*.*`). Malformed addresses trigger a warning but do not block saving.
- **Last-admin guard**: Saving an admin list with zero valid email addresses is rejected with *"At least one admin must remain."*
- On save, the new list is written to Script Properties key `"admin"`.

#### 6.4.2 Configuration Editor

A large monospace text area pre-filled with the current active `Config.json` content (merged default + overrides):

**Validation step** — critical guard:
1. When the admin clicks **"Save Config"**, the tool **first** runs a JSON syntax check (`JSON.parse()`).
2. If parsing fails, a clear error message is shown (`"Syntax error at line 12, column 5: ..."`), and **the config is NOT saved**.
3. If parsing succeeds, the config is saved to Script Properties under key `"configOverlay"`.
4. **`dbVersion` is incremented** so polling clients pick up the new config (including column changes) on their next poll.
5. After saving, the UI reloads so the changes take effect.

**Config hierarchy** (merged at runtime):
```
Config.json (project file, read-only at runtime)
    ∪
PropertiesService key "configOverlay" (admin edits, takes precedence)
    =
Active config
```

#### 6.4.3 User Deletion

A dropdown (or searchable select) listing all registered users by display name and email.

**Flow**:
1. Admin selects a user from the list.
2. Admin clicks **"Delete User"**.
3. A confirmation dialog appears:
   > *"Are you sure you want to delete [User Name]? All their private tasks will be permanently removed. A spreadsheet dump will be generated before deletion."*
4. Admin confirms → server performs the following steps:

**Server-side deletion logic**:

| Step | Action                                                       |
| ---- | ------------------------------------------------------------ |
| 1    | Generate a spreadsheet dump (`_Dump_Deleted_User_<email>`) in the backup Spreadsheet containing all tasks where the user is `creatorEmail` or `assignedTo`. |
| 2    | **Private tasks** where `creatorEmail === user.email && visibility === "private"`: hard-deleted from the database. |
| 3    | **Public tasks** where `creatorEmail === user.email`: `creatorEmail` is set to `"_deleted_"`, `assignedTo` is set to `null`. These tasks become permanently public — nobody can change their visibility to private. Any user can edit, complete, or delete them. |
| 4    | **Public tasks** where `assignedTo === user.email` (but creator is someone else): `assignedTo` is set to `null`. |
| 5    | **Activities** where `creatorEmail === user.email`: `creatorEmail` is set to `"_deleted_"`. Activities where `assignedTo === user.email`: `assignedTo` is set to `null`. |
| 6    | The user's `User` record is flagged with `deletedDate` (soft-delete, same as tasks). They cannot log in anymore (the registration flow rejects deleted users). |
| 7    | A success toast is shown: *"User [Name] deleted. A dump has been generated in the backup spreadsheet."* |

**UI notes**:
- The deleted user's display name in old tasks/activities/comments remains as-is (historical record).
- The sentinel creator `"_deleted_"` is displayed as `"Deleted User"` in the UI.
- If a deleted user somehow accesses the app again (e.g. their session is still active), the server rejects them with a *"Your account has been deleted"* message.

#### 6.4.4 Snapshot Import

The admin can import a previous daily snapshot from the backup spreadsheet. The available snapshots are listed by date (read from `db_meta.snapshots`). If no snapshots exist, the section shows a message: *"No snapshots available."*

```
Import Snapshot
─────────────────────────────────────────────
Available snapshots:
  ○ 2026-05-14
  ○ 2026-05-13
  ● 2026-05-12  ← selected
  ○ 2026-05-11

Import mode:
  ● Merge — add only non-existing tasks and activities
  ○ Overwrite — replace all current tasks and activities

[ Import Snapshot ]  [ Cancel ]
─────────────────────────────────────────────
```

**Import modes**:

| Mode        | Behaviour                                                    |
| ----------- | ------------------------------------------------------------ |
| **Merge**   | For each task/activity in the snapshot: check `deterministicId`. If it does not exist in the current database, import it. If it exists, skip it. Comments from the snapshot are ignored in merge mode (existing records keep their comments). |
| **Overwrite** | All current tasks and activities are **deleted** from Script Properties, then replaced with the full set from the snapshot. Users and config are untouched. The Kanban columns are re-read from the current config (column mapping uses the same `columnNumber` fallback as import — see §4.5). |

**Revert dump** (both modes):

Before any import, the tool automatically creates a **revert dump** — a complete export of the current state of tasks and activities as a set of timestamped worksheets in the backup spreadsheet:

```
Revert_2026-05-14T143022_Tasks      ← created just before import at 14:30:22
Revert_2026-05-14T143022_Activities
```

- The revert dump sheets use the same column structure as the regular backup sheets.
- The admin can use these sheets later via the normal **Import from Spreadsheet** flow in Settings (§6.5.3) to manually restore the pre-import state.
- The import result toast includes the revert dump sheet names: *"Snapshot imported. Revert dump created as Revert_2026-05-14T143022_Tasks / Revert_2026-05-14T143022_Activities."*

**Server-side flow**:

```
1. Read the selected snapshot sheets from the backup spreadsheet.
2. Create revert dump sheets with current tasks/activities data.
3. If mode is "Merge":
     For each record in snapshot:
       if deterministicId not found in current db → insert
       else → skip
   If mode is "Overwrite":
     Clear db_tasks and db_activities in Script Properties.
     Insert all records from the snapshot.
4. Increment dbVersion.
5. Refresh cache.
6. Return result summary (imported count, skipped count, revert sheet names).
```

**Confirmation dialog**: Before executing, a confirmation is shown with the mode and the date: *"Import snapshot from 2026-05-12 in [Overwrite] mode? A revert dump will be created before proceeding."*

### 6.5 User Settings

**Access**: A dialog accessible from the user dropdown menu (`[👤 ▼] → Settings`). Every user has access to their own settings.

#### 6.5.1 Google Chat Webhook

A text field where the user can paste their Google Chat webhook URL.

```
Google Chat Webhook URL:
─────────────────────────────────────────────
https://chat.googleapis.com/v1/spaces/AAAA...
─────────────────────────────────────────────
[ Save ]
```

- The webhook receives a **once-daily summary** of open actions for the user, sent by a time-driven trigger (configured via `database.notificationTime` in Config.json). The summary includes: tasks assigned to the user that are not completed, tasks due today or overdue, and activities assigned to the user that are not completed.
- **Vacation period check**: If the current date falls within any defined vacation period, the daily summary is suppressed (no webhook POST sent).
- Empty webhook URL = notifications are disabled.
- The webhook URL is validated with a basic `https://chat.googleapis.com/` prefix check on save.

#### 6.5.2 Vacation Periods

A list of date ranges during which the user does not receive notifications.

```
Vacation Periods:
─────────────────────────────────────────────
  From: [2026-07-01]  To: [2026-07-15]  [✕]
  From: [2026-12-24]  To: [2026-12-26]  [✕]
                              [+ Add period]
─────────────────────────────────────────────
[ Save ]
```

- Each period has a start and end date. A user is considered on vacation on any date `D` where `start <= D <= end` (all three compared as date-only strings in `YYYY-MM-DD` format, in the configured `app.timeZone`).
- The user can add new periods or remove existing ones.
- Validation: `start <= end`. Overlapping periods are allowed (the union is used for the check).

#### 6.5.3 Import from Spreadsheet Dump

The user can import tasks and activities from a structured spreadsheet dump.

```
Import Data
─────────────────────────────────────────────
Spreadsheet ID: [___________________________]
                                       [Import]
─────────────────────────────────────────────
```

- The user provides the ID of a Google Spreadsheet that contains `_Dump_Tasks` and/or `_Dump_Activities` sheets.
- The tool reads the sheets and imports rows according to the rules in §4.5.

**Import process**:
1. The user enters the Spreadsheet ID and clicks **"Import"**.
2. The server reads the `_Dump_Tasks` and `_Dump_Activities` sheets.
3. For each row, the `hashId` is matched against existing records:
   - Match found → skip, add to skipped list.
   - No match → create new Task or Activity.
4. After processing, a result dialog shows:
   > *"Import complete. 12 tasks imported, 3 skipped (already exist). 5 activities imported, 1 skipped. 2 rows had invalid data."*
5. The home page auto-refreshes after import.

#### 6.5.4 Export to Spreadsheet

A button in Settings to generate a fresh dump:

```
Export Data
─────────────────────────────────────────────
[ Generate Export Spreadsheet ]
─────────────────────────────────────────────
```

- Creates or updates `_Dump_Tasks` and `_Dump_Activities` sheets in the backup Spreadsheet.
- Shows a success toast with the Spreadsheet ID and a link: *"Export ready in spreadsheet [ID]."*

### 6.6 Polling & Real-Time Updates

Because GAS does not support WebSockets or Server-Sent Events, the frontend uses **polling** to keep its state synchronised with the server.

#### 6.6.1 Polling Endpoint

```
poll(lastVersion: number) → { changed: boolean, newVersion?: number, data?: DatabaseSnapshot }
```

| Response field | Type    | Description                                                  |
| -------------- | ------- | ------------------------------------------------------------ |
| `changed`      | boolean | `true` if `dbVersion` differs from `lastVersion`.            |
| `newVersion`   | number  | The current `dbVersion` (only when `changed: true`).         |
| `data`         | object  | Full database snapshot (users, tasks, activities, columns) — only when `changed: true`. |

**Performance**: The endpoint returns in **< 100 ms** when nothing changed — it compares the client's `lastVersion` against `dbVersion` in CacheService without touching Script Properties.

#### 6.6.2 Polling Interval

- The interval is configured in `Config.json` → `ui.pollingIntervalSeconds` (default: **10 seconds**).
- On page load, the client fetches initial data and starts `setInterval(poll, pollingIntervalSeconds * 1000)`.
- The client sends its last-known `dbVersion` with every poll.
- When `changed: true`, the client replaces its entire in-memory state with the fresh snapshot and re-renders all visible components.

#### 6.6.3 Smart Polling (Bandwidth Optimisation)

To minimise data transfer and server execution time:

- **Fast path (no change)**: Server reads `dbVersion` from CacheService, compares, returns `{ changed: false }`. No Script Properties read needed.
- **Full path (change detected)**: Server reads all `db_*` keys from CacheService (or Script Properties on cache miss), serialises, returns full snapshot.
**Cold start optimisation**: If CacheService has expired and Script Properties must be read, the poll response may take 200–500 ms. The returned data is written to CacheService (write-through, see §4.3) so subsequent reads are fast.

#### 6.6.4 Debouncing Writes to Reduce Unnecessary Polling

The `dbVersion` counter is incremented only after the write is confirmed. A write-triggered poll refresh uses the **updated version immediately** — the next `setInterval` tick picks up the new value.

However, rapid writes (e.g., dragging a card through multiple columns quickly) increment the version many times. Mitigations:

- **Client-side debounce** (300 ms) on drag-and-drop `moveActivity()` calls — if the user drags again within 300 ms, only the final position is sent.
- **Server-side coalescing**: If the same user sends two `moveActivity()` calls for the same card within 500 ms, the server processes the last one only (optional optimisation, low priority).

#### 6.6.5 Polling vs. User Experience

| Scenario                         | UX behaviour                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| User A adds a task               | User A's client sees the change immediately (optimistic UI). All other clients pick it up on the next poll tick (max 30 s delay). |
| User B drags a card              | All clients see the new position within 30 s.                |
| User closes and reopens the tab  | Full fresh data load on `doGet()`.                           |
| Poll fails (network error)       | Client retries after `pollingIntervalSeconds`. Error toast shown after 3 consecutive failures. |
| `dbVersion` in cache expired     | Fallback reads from Script Properties. Response is slightly slower but correct. |

#### 6.6.6 Quota Considerations

Each poll is a lightweight GAS invocation. At 10-second intervals with 10 concurrent users:

- 10 users × 6 polls/minute = **60 invocations/minute**
- GAS quota: **30 concurrent executions** (hard limit) / **90 seconds of execution time per day** for consumer accounts, **90,000 seconds** for Google Workspace accounts
- At 10 users polling every 10 seconds, total execution time ≈ 6 s/min × 60 min × 24 h = ~144 min/day. Well within the 90,000 s/day Workspace quota.

---

## 7. Configuration

### 7.1 Config Sources

| Source         | Storage                        | Editable by | Override priority |
| -------------- | ------------------------------ | ----------- | ----------------- |
| `Config.json`  | GAS project file (read at startup) | Developer (in GAS editor) | Base |
| `configOverlay`| Script Properties key          | Admin (via Admin page) | Overrides base |

### 7.2 Admin List

Stored in Script Properties key `"admin"` as a semicolon-separated string:

```
herman.tiflis@thecompany.com;nicola.muffert@thecompany.com
```

Editable via the Admin page.

### 7.3 Config.json Schema

```jsonc
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
    "backupSpreadsheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
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

| Section                        | Key                      | Type   | Default                | Description                                              |
| ------------------------------ | ------------------------ | ------ | ---------------------- | -------------------------------------------------------- |
| `app`                          | `title`                  | string | `"BetterKanban"`       | Title shown in the browser tab and page header.          |
| `app`                          | `timeZone`               | string | `"America/New_York"`   | Server time zone. All date comparisons (due dates, vacation periods, creation dates) use this time zone. Only dates are relevant (time-of-day is never compared or displayed — due dates are whole-day). |
| `app`                          | `dateFormat`             | string | `"YYYY-MM-DD"`         | Display format for dates.                                |
| `kanban`                       | `columns`                | array  | `[{id:"col-default", name:"Activities", order:0}]` | Array of column definitions. **Max 5**. Column 1 must always exist. |
| `kanban`                       | `completedColumnId`      | string | null                   | Which column completed cards go to. If null, cards stay in their current column. |
| `database`                     | `backupSpreadsheetId`    | string | `""`                   | Spreadsheet ID for daily backups. **Warning**: if left empty, no daily backup occurs and data may be lost if the 500 KB Script Properties budget is exceeded. |
| `database`                     | `backupTime`             | string | `"02:00"`              | HH:MM for the daily backup trigger. Interpreted in `app.timeZone`. |
| `database`                     | `purgeTime`              | string | `"03:00"`              | HH:MM for the daily purge trigger. Interpreted in `app.timeZone`. |
| `database`                     | `notificationTime`       | string | `"08:00"`              | HH:MM for the daily Chat notification summary. Interpreted in `app.timeZone`. |
| `database`                     | `backupSnapshotCount`    | number | `5`                    | Max daily snapshots to keep. When exceeded, the oldest is deleted on the next backup. |
| `database`                     | `completedTaskMaxCount`  | number | `100`                  | Max completed tasks before the oldest is hard-deleted.   |
| `database`                     | `completedActivityMaxCount` | number | `100`                | Max completed activities before the oldest is hard-deleted. |
| `database`                     | `maxCommentsPerActivity` | number | `50`                   | Max comments per activity. When exceeded, the oldest comment is evicted. Each comment is also limited to 2000 characters server-side. |
| `database`                     | `deletedTaskRetentionDays` | number | `7`                  | Days before a soft-deleted record is hard-deleted. Applies to both tasks and activities. |
| `ui`                           | `theme`                  | string | `"light"`              | `"light"` or `"dark"`.                                   |
| `ui`                           | `pageSize`               | number | `50`                   | Reserved for future pagination. Currently unused — all matching items are returned in a single response. |
| `ui`                           | `pollingIntervalSeconds` | number | `10`                   | Seconds between poll requests. Higher = less server load but slower updates. |

---

## 8. User Interface

The UI follows a **clean, modern, content-first** design philosophy. The goal is maximum readability at a glance — minimal chrome, generous whitespace, subtle colour accents that guide attention, never distract.

### 8.1 Design Principles

| Principle               | Application                                                  |
| ----------------------- | ------------------------------------------------------------ |
| **Content-first**       | Chrome elements (headers, borders, tabs) use minimal visual weight. The data — tasks, cards, columns — dominates the screen. |
| **Visual hierarchy**    | Due dates in colour, title in bold, metadata in muted grey. The eye lands on what matters most, then scans secondary info. |
| **Consistent spacing**  | A single spacing unit (8 px) drives all gaps, paddings, and margins. Cards, columns, and inputs align to this grid. |
| **Flat + subtle**       | No gradients, no heavy shadows. Cards use a 1 px border + very light drop shadow (or none). Active/ hover states use a colour shift, not a shadow pop. |
| **Forgiving**           | Destructive actions (complete, delete) have undo toasts. Comment deletion is permanent with a confirmation prompt. Every input validates client-side before the server call. Empty states guide, not frustrate. |
| **GAS-appropriate**     | No external framework. Vanilla CSS with custom properties. No web fonts (load speed matters). System font stack. |

### 8.2 Colour Palette & Typography

Defined via CSS custom properties on `:root`:

```css
:root {
  /* Greys */
  --bg-page:        #f5f6f8;
  --bg-card:        #ffffff;
  --bg-hover:       #f0f1f3;
  --bg-column:      #ebecf0;
  --border-default: #dfe1e6;
  --border-hover:   #c1c7d0;
  --text-primary:   #172b4d;
  --text-secondary: #5e6c84;
  --text-muted:     #97a0af;

  /* Accent */
  --accent-blue:    #0052cc;
  --accent-green:   #36b37e;
  --accent-red:     #de350b;
  --accent-yellow:  #ff991f;

  /* Semantic */
  --overdue:        var(--accent-red);
  --due-today:      var(--accent-yellow);
  --public-badge:   var(--accent-green);
  --private-badge:  var(--text-muted);

  /* Spacing */
  --sp-xs:  4px;
  --sp-sm:  8px;
  --sp-md:  16px;
  --sp-lg:  24px;
  --sp-xl:  32px;

  /* Typography */
  --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  --font-size-xs:  11px;
  --font-size-sm:  13px;
  --font-size-md:  14px;
  --font-size-lg:  16px;
  --font-size-xl:  20px;
}
```

- **System font stack**: No external font loading. Fast, native feel on every OS.
- **No bold weights beyond 600**: Headlines use `font-weight: 600`, body text `400`, metadata `400` with muted colour.
- **Colour is meaningful**: Red = overdue. Yellow = due today. Green = public badge. Grey = private. Blue = interactive (buttons, links).

### 8.3 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [logo] BetterKanban    [Home] [Admin]         [👤 Peter ▼]     │
├────────────────────────────────┬─────────────────────────────────┤
│                                │                                 │
│  Tasks                         │  Activities                     │
│  ┌──────────────────────────┐  │  ┌──────┬──────┬──────┬──────┐ │
│  │ 🔍 Search tasks...      │  │  │To Do │ In   │Block │ Done │ │
│  │                          │  │  │      │ Prog │      │      │ │
│  │ [+ New Task]            │  │  │      │      │      │      │ │
│  │                          │  │  │ ┌──┐ │ ┌──┐ │ ┌──┐ │ ┌──┐ │ │
│  │ ┌──────────────────┐    │  │  │ │  │ │ │  │ │ │  │ │ │  │ │ │
│  │ │ Task card        │    │  │  │ └──┘ │ └──┘ │ └──┘ │ └──┘ │ │
│  │ └──────────────────┘    │  │  └──────┴──────┴──────┴──────┘ │
│  └──────────────────────────┘  │                                 │
│                                │                                 │
│  ◀ Hide                        │                          ▶ Hide │
└────────────────────────────────┴─────────────────────────────────┘
```

**Top bar** (40 px height):
- **Left**: App name in bold (`--font-size-lg`, `--text-primary`). No logo image — just text.
- **Center**: Tab pills. *Home* always visible. *Admin* only for admins. Active tab has a subtle bottom border or filled pill background.
- **Right**: User avatar (first letter of display name in a circle, coloured background derived from email hash) + dropdown chevron. Dropdown: *Settings*, *Close session* (clears local state — your Google account remains signed in).

**Welcome bar** (below top bar):
- Single line: *"Welcome back, Peter"* in `--text-secondary`.
- Quick counters as small grey pills: `3 due today`, `1 overdue`, `8 active cards`.
- Each pill is colour-coded when relevant (overdue pill has red text/icon).

**Two panes** (side by side):
- Resizable via a draggable divider (or equally split by default).
- Each pane has its own header with title, search, and action buttons.
- Separator line uses `--border-default`.

### 8.4 Task Cards (Compact View)

Task cards in the left pane show only the essentials for a clean overview. Clicking a card opens a detail modal for full editing.

**Compact card** (always visible in the pane):

```
┌──────────────────────────────────────┐
│ ☐  Buy groceries                  🔓 │   ← checkbox + description + visibility badge
│     👤 Peter                        │   ← assigned person
│     💬 Remember to get milk          │   ← comment preview (only if exists)
└──────────────────────────────────────┘
```

**Dimensions**: Full width of the pane, ~56–72 px height.

| Element          | Style                                                       |
| ---------------- | ----------------------------------------------------------- |
| Checkbox `☐`    | 16×16 px, circular. Checked = filled green with white checkmark. |
| Description      | `--font-size-md`, `--text-primary`, `font-weight: 500`. Strikethrough when completed, opacity 0.5. |
| Visibility badge | `🔓` public or `🔒` private, small pill at the end of the description row. |
| Assigned person  | `👤 Peter` in `--font-size-sm`, `--text-secondary`. Only shown if assigned. |
| Comment preview  | `💬` + first 80 chars of comment, `--font-size-sm`, `--text-muted`. Only shown if comment exists. |

**Hover**: Background shifts to `--bg-hover`. Cursor becomes pointer.

**Completed card**: Opacity 0.5, description struck through. Checkbox is filled green.

**Detail modal** (opened on card click, see §8.14):

- Description (editable textarea)
- Due date (date picker, optional)
- Assigned person (dropdown of all registered users)
- Visibility toggle (`🔓` public / `🔒` private) — **only enabled for the creator or admin**
- Comment (editable textarea)
- Creator email + creation date (read-only, shown in a muted section at the bottom)
- `[Complete]` / `[Delete]` action buttons
- `[Update]` button to push changes (sends only changed fields + version to server)

### 8.5 Activity Cards (Kanban)

```
┌──────────────────────────────────┐
│ Design login page                │   ← title (bold)
│                                  │
│ Create wireframes and implement  │   ← description (full, no truncation)
│ the login flow and user          │
│ authentication logic.            │
│                                  │
│ 📅 2026-05-20                    │   ← due date badge
│ 👤 Klaus                         │   ← assignee (first name only)
│ 💬 "I can take this over…"       │   ← last comment, 1 line with ellipsis
└──────────────────────────────────┘
```

**Dimensions**: Fixed width matching column width. Height variable, typically 100–140 px.

**Elements** (stacked vertically):

| Element          | Style                                                       |
| ---------------- | ----------------------------------------------------------- |
| Title            | `--font-size-md`, `--text-primary`, `font-weight: 600`. No truncation for titles under ~30 chars. |
| Description      | `--font-size-sm`, `--text-secondary`. Shown in full — card height grows with content. |
| Due date badge   | Inline pill: `📅 2026-05-20`. Background colour: red if overdue, yellow if today, transparent/grey otherwise. `--font-size-xs`. |
| Assignee         | `👤 Klaus` in `--font-size-xs`, `--text-secondary`. Truncated to first name only in card view. |
| Last comment     | `💬` + first ~40 chars of the newest comment's `text`. `--font-size-xs`, `--text-muted`. 1-line clamp. Hidden if no comments. |

**Card interactions**:
- **Click**: Opens the detail modal (see §6.3.4).
- **Drag**: `draggable="true"`. Card lifts with a subtle shadow while dragging. The drop target (between cards or at column bottom) shows a blue insertion line.
- **Hover**: Card lifts 2 px (translateY(-2px)), border colour shifts to `--border-hover`.

**Column width**: Equal width distribution, minimum 220 px. If columns exceed the pane width, horizontal scroll appears with visible scrollbar (styled thin).

**Column header**: Column name in `--font-size-sm`, `font-weight: 600`, `text-transform: uppercase`, `--text-secondary`. Card count as a grey pill next to the name. No background — just the name + count.

### 8.6 Empty States

When a pane has no data to show, a centred placeholder replaces the list:

**Tasks — empty**:
```
┌─────────────────────────────────────────┐
│                                         │
│            📋 No tasks yet               │
│     Create your first task to get       │
│              started.                   │
│                                         │
│           [+ Create Task]               │
│                                         │
└─────────────────────────────────────────┘
```

**Activities — empty**:
```
┌─────────────────────────────────────────┐
│                                         │
│          📊 No activities yet            │
│    Add an activity card to start your   │
│            Kanban board.                │
│                                         │
│          [+ Create Activity]            │
│                                         │
└─────────────────────────────────────────┘
```

**Search — no results**:
```
┌─────────────────────────────────────────┐
│                                         │
│     🔍 No results for "searchterm"      │
│     Try a different keyword.            │
│                                         │
└─────────────────────────────────────────┘
```

- Empty state icons use large `font-size` (48 px), muted colour (`--text-muted`).
- The action button mirrors the pane's "New" button.

### 8.7 Pane Toggles & Search

Each pane header contains:

```
Tasks  🔍 [_______________]  ◀ Hide   [+]
```

| Element           | Behaviour                                                    |
| ----------------- | ------------------------------------------------------------ |
| Title             | Bold pane name.                                              |
| 🔍 Search icon    | Click or press `/` focuses the search input.                 |
| Search input      | Filters items client-side. Cleared search = show all. Debounced at 200 ms. Placeholder text: *"Search tasks…"* or *"Search activities…"*. |
| `◀ Hide` / `▶ Show` | Collapses / expands the pane. The arrow points in the collapse direction. State persisted to user settings. |
| `[+]` button      | Opens the "New Task" or "New Activity" inline creator.       |

**Search scope**:
- **Tasks**: matches `description`, creator display name, assignee display name, `comment`.
- **Activities**: matches `title`, `description`, assignee display name, comment `text` (all comments in the thread).

### 8.8 Settings Dialog

Triggered from `[👤 ▼] → Settings`. A modal dialog (`480 px max-width`, centred overlay with backdrop).

| Tab              | Content                                                     |
| ---------------- | ----------------------------------------------------------- |
| Profile          | Display name text input. Email shown as read-only. [Save] button. |
| Notifications    | Google Chat webhook URL input. Vacation period list with date pickers. [Add period] link. [✕] to remove. [Save] button. |
| Import/Export    | Spreadsheet ID input + [Import] button. [Generate Export] button. Result summary shown inline. |

- Modal closes on backdrop click or `Escape` key.
- Tabs use a simple underline style (no pills). Active tab has a 2 px `--accent-blue` underline.

### 8.9 Activity Detail Modal

Opened when clicking a Kanban card (see §6.3.4 for full diagram).

- **Width**: 600 px max. **Height**: fill available viewport (max 80 vh), scrollable.
- **Backdrop**: Semi-transparent black (`rgba(0,0,0,0.3)`). Click to close.
- **Top section**: Editable title, due date, assignee dropdown, description textarea.
- **Comments section**: Separated by a thin rule. Each comment block has: author name + timestamp (right-aligned on the same line), then comment text below. Edit (`✏`) and delete (`🗑`) buttons are in the top-right corner of the block — always visible, small and grey (`--font-size-xs`, `--text-muted`).
- **New comment input**: A small textarea with placeholder *"Write a comment…"* and an [Add] button.
- **Bottom actions**: `[Update]` (primary blue), `[Complete]` (green outline), `[Delete]` (red outline, with confirmation).

### 8.10 Toggle Filters (Tasks Pane)

Below the search bar in the Tasks pane:

```
[☐ Show completed]   [☐ Show deleted]
```

- Pill-style toggle buttons. Inactive = grey outline. Active = filled with `--bg-hover`.
- Clicking toggles the filter. State is applied immediately (server re-fetch with new `opts`).
- Filters are independent of search (they stack: search further filters the visible set).

### 8.11 Responsiveness

| Breakpoint  | Behaviour                                                    |
| ----------- | ------------------------------------------------------------ |
| ≥ 1024 px   | Side-by-side panes. Full Kanban with horizontal scroll.      |
| 768–1023 px | Panes stack vertically (Tasks on top, Kanban below). Both still expandable. Kanban uses horizontal scroll. |
| < 768 px    | Panes stack vertically. Kanban switches to a vertical accordion — only one column visible at a time, with column tabs or arrows to switch. Task cards stack full width. The top bar collapses: tabs become a hamburger menu. |

### 8.12 States & Edge Cases

| State                    | Visual behaviour                                             |
| ------------------------ | ------------------------------------------------------------ |
| **Loading (initial)**    | Skeleton UI: grey placeholder rectangles for each card/column. No spinner. After data arrives, smooth fade-in of real cards (200 ms opacity transition). |
| **Loading (action)**     | The specific button shows a small spinner. No full-screen overlay. |
| **Error (server down)**  | Banner at top of the affected pane: *"Connection error. Retrying in 30 s…"* with a red left border. Auto-retries on next poll tick. |
| **Error (validation)**   | Inline red text below the offending input field. The "Update" button stays enabled but shows the error count (*"2 errors"*). |
| **Optimistic (mutation)**| The UI updates instantly. If the server rejects, the change reverts with a red error toast. |
| **Empty (no data)**      | Centred placeholder with icon + message + CTA button (§8.6). |
| **No search results**    | Centred placeholder.                                         |
| **Concurrent edit conflict** | The 409 error triggers a toast: *"This item was modified by another user. Reloading…"* The client re-fetches and re-renders. If the user had unsaved edits, they are restored on top of the fresh data (see §4.6.4). |

### 8.13 Toasts & Feedback

All toasts appear in the **top-right corner**, stacked downwards. Auto-dismiss after 3 seconds (except undo toasts, which last 5 s).

```
┌──────────────────────────────────┐
│ ✅ Task created                  │   ← green left border
└──────────────────────────────────┘
┌──────────────────────────────────┐
│ ❌ Could not save changes        │   ← red left border  
└──────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ ⚠ Task completed               [Undo] [✕]  │   ← orange left border, 5 s timer
└─────────────────────────────────────────────┘
```

| Type     | Left border | Icon  | Duration | Action                          |
| -------- | ----------- | ----- | -------- | ------------------------------- |
| Success  | Green       | ✅    | 3 s      | None (auto-dismiss)             |
| Error    | Red         | ❌    | 5 s      | [✕] dismiss button. No auto-dismiss for network errors (stays until next successful poll). |
| Warning  | Orange      | ⚠    | 5 s      | [Undo] button for reversible actions (complete, delete). [✕] dismiss. Comment deletion is permanent (no undo). |
| Info     | Blue        | ℹ     | 3 s      | None (auto-dismiss). Used for import/export results. |

- Maximum 3 toasts visible simultaneously. Older toasts are pushed up (CSS `overflow: scroll` within the toast container).
- Toasts use `--bg-card` background with a 4 px coloured left border. No shadow. `--font-size-sm` text.

### 8.14 Task Detail Modal

Opened when clicking a compact task card in the left pane.

- **Width**: 480 px max. **Height**: fill available viewport (max 70 vh), scrollable.
- **Backdrop**: Semi-transparent black (`rgba(0,0,0,0.3)`). Click to close.
- **Close**: `[X]` button or `Escape` key.

```
┌───────────────────────────────────────────────┐
│  Edit Task                          [Close X]  │
├───────────────────────────────────────────────┤
│  Description:                                  │
│  ┌─────────────────────────────────────────┐  │
│  │ Buy groceries                           │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  Due date:  [2026-05-16    ]  👤 [Peter ▼]    │
│                                               │
│  Visibility:  🔓 Public    [Change to 🔒]     │
│              (only creator or admin)           │
│                                               │
│  Comment:                                     │
│  ┌─────────────────────────────────────────┐  │
│  │ Remember to get milk                    │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  ── Metadata (read-only) ──                   │
│  Created by Peter Hanson on 2026-05-14        │
│                                               │
│  [ Update ]  [ Complete ]  [ Delete ]         │
└───────────────────────────────────────────────┘
```

**Sections**:

| Section            | Content                                                     |
| ------------------ | ----------------------------------------------------------- |
| Description        | Editable textarea. Mandatory — validation error shown if empty. |
| Due date           | Date picker. Optional. A small `[✕]` button clears the date. |
| Assigned person    | Dropdown of all registered users (display name + email).    |
| Visibility         | Toggle button `🔓 Public` / `🔒 Private`. **Only enabled** if the current user is the creator or an admin. Disabled users see the current value but cannot change it. |
| Comment            | Editable textarea. Free text, optional.                     |
| Metadata           | Creator email + creation date. Displayed in `--font-size-xs`, `--text-muted`. Not editable. |
| Action buttons     | `[Update]` (primary blue, sends only changed fields + version), `[Complete]` (green outline), `[Delete]` (red outline, with confirmation *"Delete this task?"*). |



## 9. GAS Limitations & Mitigation Strategies

| Limitation                       | Impact                                       | Mitigation                                                   |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| **Script Properties: 500 KB total** | The full live dataset must fit.             | Split across multiple keys. Short property keys, date compression, no redundant fields. Auto-purge when approaching 400 KB. Daily spreadsheet backup prevents data loss. |
| **Execution time: 6 min** (regular triggers) | Complex operations may time out.         | Keep server functions lean. Batch heavy operations (backup, purge, import) into their own trigger executions. Poll endpoint is < 100 ms. |
| **Maximum HTML output: 500 KB** (HtmlService) | Very large initial page may fail.        | Lazy-load data via `google.script.run` after skeleton UI renders. Never embed the full dataset in the template. |
| **Session.getActiveUser() availability** | Only returns the real user email when deployed correctly. | Deploy as: execute as "Me", access "Anyone within [domain]". Document as a required deployment step. |
| **Single-threaded execution**     | All users share one execution queue.         | **Benefit** for data consistency: no race conditions. Optimistic locking (version field) protects against stale-client overwrites. Long operations block everyone, so keep server functions fast. |
| **No npm / external packages**    | Can't install libraries.                     | Vanilla JS on frontend. Backend uses native GAS JS (V8). Small third-party libs included as script files if needed. |
| **CacheService TTL: 600 s**       | Cache expiry requires re-fetch from Script Properties. | `dbVersion` counter is refreshed on every write (no expiry). Other cache entries are acceptable at 600 s. |
| **Trigger minimum interval: 1 min** | Can't schedule backups more frequently.    | Daily backup is sufficient.                                  |
| **Concurrent request limit: 30**  | Heavy use may hit quota.                     | Client-side debouncing for rapid updates (drag-and-drop). Poll requests are lightweight (< 100 ms each). At 10 users × 2 polls/min, well within Workspace quotas. |
| **Polling latency**              | Clients see changes up to `pollingIntervalSeconds` late. | Configurable via `Config.json`. The cold-start penalty applies only on first request after inactivity. |
| **Script cold start** (no state preserved between invocations) | First request after idle period is slower (2–5 s). | 5-minute "keep warm" trigger (pings the script, consumes one of the available trigger slots). Polling by active users naturally keeps the script warm during working hours. |

---

## 10. Enhancement Proposals

### 10.1 User-Friendliness Ideas

| Idea                        | Benefit                                                    |
| --------------------------- | ---------------------------------------------------------- |
| **Undo Toast**             | After complete/delete/comment-delete, show "Undo?" button for 5 seconds. |
| **Keyboard Shortcuts**     | `Ctrl+N` = new task, `Ctrl+Shift+N` = new activity, `Escape` = close editor, `/` = focus search. |
| **Auto-save Drafts**       | Drafts saved to `sessionStorage` and restored on return.   |
| **Bulk Actions**           | Shift-click to select multiple tasks: "Complete all", "Delete all", "Assign to...". |
| **Dark Mode**              | CSS custom properties make this trivial.                   |
| **Notification preview**   | In Settings, a "Send test" button that fires a sample webhook so the user can verify their Chat URL works. |

### 10.2 GAS-Specific Pragmatic Ideas

| Idea                        | Benefit                                                    |
| --------------------------- | ---------------------------------------------------------- |
| **Ping to keep warm**      | 5-minute trigger that keeps the script "warm". Reduces cold-start for infrequent users. |
| **Lazy data loading**      | Skeleton UI → `google.script.run` fetch. Avoids 500 KB HTML limit. |
| **Data compression**       | Short property keys (`desc`, `cr`, `asgn`, `cmts`) in stored JSON. Client/server translation layer maps short ↔ full names. |
| **Graceful degradation**   | If Script Properties are full or a quota is exceeded, the UI shows a clear message and enters read-only mode. |
| **Rate-limited writes**    | Client-side debounce (300 ms) on frequent writes (drag-and-drop reordering, comment typing). |

---

## 11. Project Files & Structure

```
BetterKanban_GoogleAppScript/
├── Spec.md                     ← This document
├── Config.json                 ← Base configuration (shipped with the project)
├── Main.gs                     ← doGet(), global setup, session handling
├── Database.gs                 ← Script Properties read/write, backup logic
├── Users.gs                    ← User registration, lookup, admin check
├── Tasks.gs                    ← Task CRUD operations
├── Activities.gs               ← Activity CRUD + column movement + comment operations
├── Admin.gs                    ← Admin page server logic (config validation, admin list, user deletion)
├── Settings.gs                 ← User settings: webhook, vacations, import, export
├── Notifications.gs            ← Chat webhook dispatch, vacation suppression logic
├── Purge.gs                    ← Scheduled cleanup of old tasks/activities
├── Triggers.gs                 ← Installable trigger management (daily backup, purge)
├── Html/
│   ├── Index.html              ← Main HTML shell (layout, tabs, zones, modals)
│   ├── Styles.css              ← All CSS (custom properties for theming)
│   └── App.js                  ← Client-side JS (state, API calls, DnD, search filter, modals)
├── Tests.gs                    ← Unit tests (run manually from the GAS editor)
└── README.md                   ← Setup & deployment instructions
```

---

## 12. Future Milestones (Post-v1)

- **Email notifications** for tasks due within 24 hours (GAS `MailApp`).
- **Labels / Tags** on tasks and activities.
- **Reporting** — a dashboard page with charts showing task completion trends, activity cycle times.
- **Offline mode** — Service Worker + IndexedDB to cache the app shell.
- **Calendar integration** — sync due dates to Google Calendar.

---

## 13. Server API Reference

This section lists every server-side function exposed to the client via `google.script.run`. All functions run in the GAS backend and communicate with the client asynchronously.

**Conventions used below:**
- `→` indicates the value passed to the success handler.
- `throws` indicates the error message passed to the failure handler.
- Parameters listed in order. Optional parameters are shown with `?`.
- `Session.getActiveUser().getEmail()` is called internally by every function (not listed as a parameter).

### 13.1 Session & Initialisation

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `getInitialData()` | none | `{ user, tasks, activities, columns, config }` | — | Called once on page load. Returns the entire current user object, all visible tasks/activities, column definitions, and active config. |
| `getCurrentUser()` | none | `User` | — | Returns the User object for the current session. Used on every page load. |

### 13.2 Tasks (`Tasks.gs`)

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `createTask(data)` | `data.description: string` (required), `data.dueDate?: string`, `data.assignedTo?: string`, `data.visibility?: "private"\|"public"`, `data.comment?: string` | `Task` | `"Description is required"` | Sets `id`, `deterministicId`, `creatorEmail`, `creationDate`, `version: 1`, `lastModifiedDate` server-side. Default visibility: `"private"`. |
| `getTasks(opts)` | `opts.showDeleted?: bool` (default false), `opts.showCompleted?: bool` (default false) | `Task[]` | — | Returns only tasks the current user is allowed to see (all public tasks + own private tasks). |
| `getTask(taskId)` | `taskId: string` | `Task` | `"Task not found"` | Returns a single task. Lightweight — used by the client after a 409 conflict (§4.6.4). |
| `updateTask(taskId, changes)` | `taskId: string`, `changes: object` (partial fields: `description`, `dueDate`, `assignedTo`, `visibility`, `comment`), `changes.version: number` | `Task` | `"Task not found"`, `"Conflict: entity was modified"` (version mismatch), `"Not authorized to change visibility"` (non-creator, non-admin attempting visibility change), `"Field is not writable"` | Only allowed fields are applied (see §4.6.5). Fields not in `changes` are untouched. |
| `completeTask(taskId)` | `taskId: string` | `Task` | `"Task not found"` | Sets `completedDate` to now. Increments version. |
| `uncompleteTask(taskId)` | `taskId: string` | `Task` | `"Task not found"` | Sets `completedDate` to null. Increments version. |
| `deleteTask(taskId)` | `taskId: string` | `Task` | `"Task not found"` | Sets `deletedDate` to now. Soft delete. |
| `undeleteTask(taskId)` | `taskId: string` | `Task` | `"Task not found"` | Sets `deletedDate` to null. |
| `purgeOldTasks()` | none | `{ purged: number, deletedCount: number, completedCount: number }` | — | Called by the daily trigger. Hard-deletes expired soft-deleted tasks and excess completed tasks. |

### 13.3 Activities (`Activities.gs`)

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `createActivity(data)` | `data.title: string` (required), `data.description?: string`, `data.dueDate?: string`, `data.assignedTo?: string`, `data.columnId?: string` | `Activity` | `"Title is required"` | Sets `id`, `deterministicId`, `creatorEmail`, `creationDate`, `version: 1`, `lastModifiedDate` server-side. Default column: first column from config. |
| `getActivities(opts)` | `opts.showDeleted?: bool`, `opts.showCompleted?: bool` | `Activity[]` | — | All activities are public. Full `comments` array is included. |
| `getActivity(id)` | `id: string` | `Activity` | `"Activity not found"` | Returns a single activity. Used by the client after a 409 conflict. |
| `updateActivity(id, changes)` | `id: string`, `changes: object` (partial: `title`, `description`, `dueDate`, `assignedTo`), `changes.version: number` | `Activity` | `"Activity not found"`, `"Conflict: entity was modified"` | Same field-level merge pattern as tasks. |
| `completeActivity(id)` | `id: string` | `Activity` | `"Activity not found"` | Sets `completedDate`. Moves card to `completedColumnId` if configured. |
| `uncompleteActivity(id)` | `id: string` | `Activity` | `"Activity not found"` | Clears `completedDate`. Card moves to the first column (`columns[0].id`). |
| `deleteActivity(id)` | `id: string` | `Activity` | `"Activity not found"` | Soft delete. |
| `undeleteActivity(id)` | `id: string` | `Activity` | `"Activity not found"` | Clears `deletedDate`. |
| `moveActivity(id, columnId, newOrder, version)` | `id: string`, `columnId: string`, `newOrder: number`, `version: number` | `Activity` | `"Activity not found"`, `"Conflict"` | Updates `columnId` and `columnOrder`. Server normalises `columnOrder` values for all cards in the target column. |
| `purgeOldActivities()` | none | `{ purged: number }` | — | Called by the daily trigger. Same logic as `purgeOldTasks()`. |

### 13.4 Comments (`Activities.gs`)

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `addComment(activityId, text)` | `activityId: string`, `text: string` | `Activity` (with new comment) | `"Activity not found"`, `"Comment text is required"` | Creates comment with `id`, `authorEmail`, `creationDate` set server-side. Prepended to the `comments` array. |
| `updateComment(activityId, commentId, newText)` | `activityId: string`, `commentId: string`, `newText: string` | `Activity` | `"Activity not found"`, `"Comment not found"` | Updates `text` and sets `lastModifiedDate`. |
| `deleteComment(activityId, commentId)` | `activityId: string`, `commentId: string` | `Activity` | `"Activity not found"`, `"Comment not found"` | Removes comment from array permanently. |

### 13.5 Users (`Users.gs`)

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `registerUser(email)` | `email: string` | `User` | — | Called internally (not from client). Creates user if not exists, updates `lastAccessDate` otherwise. |
| `getUser(email)` | `email: string` | `User \| null` | — | |
| `getAllUsers()` | none | `User[]` | — | Used for assignee dropdowns. |
| `updateUserSettings(email, settings)` | `email: string`, `settings: object` (`chatWebhookUrl`, `vacations`) | `User` | — | |

### 13.6 Admin (`Admin.gs`)

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `isAdmin(email?)` | `email?: string` (defaults to current user) | `bool` | — | Checks against the admin list in Script Properties. |
| `getAdminList()` | none | `string` (semicolon-separated) | `403 Forbidden` | Only for admins. |
| `saveAdminList(list)` | `list: string` (semicolon-separated) | `{ success: true }` | `403 Forbidden`, `"At least one admin must remain"` | Validates email formats and rejects if the result would have zero valid admins. |
| `getConfig()` | none | `string` (JSON) | `403 Forbidden` | Returns the merged active config as a formatted JSON string. |
| `saveConfig(json)` | `json: string` | `{ success: true }` | `403 Forbidden`, `"Invalid JSON: ..."`, `"Spreadsheet not found or not accessible: <id>"` | Validates JSON syntax before saving. If `database.backupSpreadsheetId` is not empty, attempts `SpreadsheetApp.openById(id)` as a validation step before saving. Saves to `configOverlay`. Increments `dbVersion` so polling clients pick up the new config. |
| `deleteUser(userEmail)` | `userEmail: string` | `{ dumpSheetName: string }` | `403 Forbidden`, `"Cannot delete self"` | Generates revert dump, handles tasks/activities reassignment. |
| `getAvailableSnapshots()` | none | `string[]` (array of date strings) | `403 Forbidden` | Reads `db_meta.snapshots`. |
| `importSnapshot(date, mode)` | `date: string` (YYYY-MM-DD), `mode: "merge"\|"overwrite"` | `{ imported: number, skipped: number, revertSheet: string }` | `403 Forbidden` | Creates revert dump, then imports. |

### 13.7 Settings (`Settings.gs`)

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `updateProfile(displayName)` | `displayName: string` | `User` | — | |
| `saveChatWebhook(url)` | `url: string` | `User` | `"Invalid webhook URL"` | Validates `https://chat.googleapis.com/` prefix. |
| `saveVacations(vacations)` | `vacations: array` | `User` | `"Invalid date range"` | Validates `start <= end`. |
| `importFromSpreadsheet(sheetId)` | `sheetId: string` | `{ tasksImported, tasksSkipped, activitiesImported, activitiesSkipped, errors }` | `"Spreadsheet not found"` | Reads `_Dump_Tasks` and `_Dump_Activities` sheets. |
| `exportToSpreadsheet()` | none | `{ sheetId: string }` | — | Creates/updates dump sheets in the backup spreadsheet. |

### 13.8 DatabaseSnapshot Type

Both `getInitialData()` and `poll()` (when `changed: true`) return a `DatabaseSnapshot` object with this structure:

```
DatabaseSnapshot = {
  user: User,
  tasks: Task[],
  activities: Activity[],
  columns: Column[],
  config: object       // Active merged config (same structure as Config.json, see §7.3)
}
```

This is identical to the return value of `getInitialData()`. Clients replace their entire in-memory state with this snapshot.

### 13.9 Polling

| Function | Parameters | Returns | Throws | Notes |
|----------|-----------|---------|--------|-------|
| `poll(lastVersion)` | `lastVersion: number` (client's last known dbVersion) | `{ changed: false }` or `{ changed: true, data: DatabaseSnapshot, newVersion: number }` | — | Fast path: cache hit on `dbVersion`. Slow path: full SP read. See §4.3. |

### 13.10 Error Object Format

All server errors thrown to the client follow this structure:

```json
{
  "message": "Human-readable error description",
  "code": 409,
  "details": {}
}
```

| HTTP code | Meaning | Typical scenario |
|-----------|---------|-----------------|
| 400 | Bad request | Missing required field, invalid input |
| 403 | Forbidden | Non-admin trying an admin operation |
| 404 | Not found | Task/activity/comment ID does not exist |
| 409 | Conflict | Version mismatch (optimistic lock) |

The client's `withFailureHandler(error)` receives this object. The `message` field is displayed in the error toast.

---

## 14. GAS Implementation Patterns

This section covers the Google Apps Script-specific implementation details that a developer needs to build the backend.

### 14.1 Project Structure & Entry Points

Every GAS web app entry point is `doGet()`:

```javascript
// Main.gs
function doGet() {
  // Called when a user opens the web app URL.
  // Must return an HtmlOutput object.
  const userEmail = Session.getActiveUser().getEmail();
  registerUser(userEmail);  // auto-registration
  const template = HtmlService.createTemplateFromFile('Html/Index');
  template.userEmail = userEmail;
  return template.evaluate()
    .setTitle(config.app.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
```

### 14.2 Serving HTML, CSS, and JS

Google Apps Script's HtmlService has a specific pattern for serving multiple files. The recommended approach uses an `include()` helper:

```javascript
// Main.gs — include helper
function include(filename) {
  return HtmlService.createHtmlOutputFromFile('Html/' + filename).getContent();
}
```

**`Html/Index.html`** — the main HTML file:
```html
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <?!= include('Styles.css'); ?>
</head>
<body>
  <div id="app"><!-- Skeleton UI --></div>
  <?!= include('App.js'); ?>
  <script>
    // Boot: fetch initial data from server
    google.script.run
      .withSuccessHandler(onInit)
      .withFailureHandler(onError)
      .getInitialData();
  </script>
</body>
</html>
```

**`Html/Styles.css`** — wrapped in `<style>` tags by the include helper:
```html
<style>
  :root { /* CSS custom properties from §8.2 */ }
  /* … all component styles … */
</style>
```

**`Html/App.js`** — wrapped in `<script>` tags:
```html
<script>
  // All client-side logic: state management, rendering, google.script.run calls, DnD
</script>
```

**Important**: Never embed large data arrays in the HTML template. Always fetch data asynchronously via `google.script.run` after the page loads. This keeps the initial HTML output small and avoids the 500 KB HtmlService limit.

### 14.3 Client-Server Bridge (`google.script.run`)

All server communication uses the GAS asynchronous RPC pattern:

```javascript
// Client side (App.js)
google.script.run
  .withSuccessHandler(function(result) {
    // Handle success — result is the return value from the server function
    updateUI(result);
  })
  .withFailureHandler(function(error) {
    // Handle error — error.message contains the error description
    showErrorToast(error.message);
    if (error.code === 409) handleConflict();
  })
  .serverFunctionName(arg1, arg2);
```

Key rules:
- Server functions must be global functions in `.gs` files.
- Parameters are serialised as JSON — only plain objects, arrays, strings, numbers, booleans, and null are supported.
- Functions run in a new execution context each time — no global state is preserved between calls (except Script Properties and CacheService).
- The server function's return value is passed to `withSuccessHandler`.
- If the server function throws an error, the exception is passed to `withFailureHandler`.

### 14.4 Loading Config.json at Startup

`Config.json` is stored as a file in the GAS project. It is loaded at startup and cached:

```javascript
// Database.gs
function loadConfig() {
  // 1. Read base config from project file
  const base = { app: { title: 'BetterKanban' }, kanban: { columns: [] }, database: {}, ui: {} };
  const files = ScriptApp.getProject().getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName() === 'Config.json') {
      const parsed = JSON.parse(file.getContent());
      Object.keys(parsed).forEach(k => { base[k] = parsed[k]; });
      break;
    }
  }

  // 2. Read admin overlay
  const overlay = PropertiesService.getScriptProperties().getProperty('configOverlay');
  if (!overlay) return base;

  // 3. Deep merge per top-level section: overlay replaces base sections,
  //    keys not in overlay keep their base values.
  try {
    const overlayObj = JSON.parse(overlay);
    ['app', 'kanban', 'database', 'ui'].forEach(section => {
      if (overlayObj[section]) {
        Object.keys(overlayObj[section]).forEach(k => {
          base[section][k] = overlayObj[section][k];
        });
      }
    });
    return base;
  } catch (e) {
    return base; // On bad overlay, return base
  }
}
```

**Config hierarchy** (merged at runtime):
```
Config.json (project file)  ← base, shipped with the project
    ↓
configOverlay (Script Properties)  ← admin edits, takes precedence
    ↓ merge
activeConfig (in-memory)
```

### 14.5 Installable Triggers

Triggers are set up programmatically. They must be installed once (e.g., from a menu item or the Admin page), not from `doGet()`.

```javascript
// Triggers.gs
function setupDailyTriggers() {
  const cfg = loadConfig().database;

  // Remove existing triggers to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));

  // Daily backup at configured time
  ScriptApp.newTrigger('backupToSpreadsheet')
    .timeBased()
    .everyDays(1)
    .atHour(parseInt((cfg.backupTime || '02:00').split(':')[0]))
    .nearMinute(parseInt((cfg.backupTime || '02:00').split(':')[1] || '0'))
    .create();

  // Daily purge at configured time
  ScriptApp.newTrigger('purgeOldTasks')
    .timeBased()
    .everyDays(1)
    .atHour(parseInt((cfg.purgeTime || '03:00').split(':')[0]))
    .nearMinute(parseInt((cfg.purgeTime || '03:00').split(':')[1] || '0'))
    .create();

  ScriptApp.newTrigger('purgeOldActivities')
    .timeBased()
    .everyDays(1)
    .atHour(parseInt((cfg.purgeTime || '03:00').split(':')[0]))
    .nearMinute(parseInt((cfg.purgeTime || '03:00').split(':')[1] || '0'))
    .create();

  // Daily notification summary at configured time
  ScriptApp.newTrigger('sendDailyChatSummaries')
    .timeBased()
    .everyDays(1)
    .atHour(parseInt((cfg.notificationTime || '08:00').split(':')[0]))
    .nearMinute(parseInt((cfg.notificationTime || '08:00').split(':')[1] || '0'))
    .create();

  // Keep-warm ping (optional)
  ScriptApp.newTrigger('keepWarm')
    .timeBased()
    .everyMinutes(5)
    .create();
}
```

**Trigger functions** (in `Triggers.gs` or separate files):
- `backupToSpreadsheet()` — reads the full database from Script Properties, creates timestamped worksheets in the backup spreadsheet, rotates old snapshots.
- `purgeOldTasks()` / `purgeOldActivities()` — hard-deletes expired records.
- `sendDailyChatSummaries()` — iterates users with webhooks, sends open-actions summary. This is the longest-running trigger (~500 ms per webhook POST, ~5 seconds for 10 users). If the team grows, consider batching users across multiple trigger runs.
- `keepWarm()` — calls `CacheService.get('dbVersion')` to keep the script warm. Fires 288 times/day — consumes one trigger slot (5 total, well within GAS's 20-trigger limit).

### 14.6 Spreadsheet Operations

The backup spreadsheet is manipulated via the `SpreadsheetApp` service:

```javascript
// Database.gs (backup logic)

function getBackupSpreadsheet() {
  const id = activeConfig.database.backupSpreadsheetId;
  if (!id) throw new Error('No backup spreadsheet configured');
  return SpreadsheetApp.openById(id);
}

function createSnapshotSheets(dateStr) {
  const ss = getBackupSpreadsheet();
  const sheets = ['Tasks', 'Activities', 'Users'];

  sheets.forEach(type => {
    const name = `${dateStr}_${type}`;
    // Delete if exists (from a previous failed run)
    const existing = ss.getSheetByName(name);
    if (existing) ss.deleteSheet(existing);

    const sheet = ss.insertSheet(name);
    const data = loadDatabase(type.toLowerCase());

    // Write headers
    const headers = getHeadersForType(type);
    sheet.appendRow(headers);

    // Write data rows
    data.forEach(item => {
      const row = headers.map(h => formatCellValue(item, h));
      sheet.appendRow(row);
    });
  });
}

function deleteSnapshotSheets(dateStr) {
  const ss = getBackupSpreadsheet();
  ['Tasks', 'Activities', 'Users'].forEach(type => {
    const sheet = ss.getSheetByName(`${dateStr}_${type}`);
    if (sheet) ss.deleteSheet(sheet);
  });
}
```

**Important**: `SpreadsheetApp` has quotas (20,000 calls/day for consumer accounts, 100,000 for Workspace). The daily backup is a single bulk operation, well within limits.

### 14.7 Reading a Dump Spreadsheet for Import

```javascript
function readDumpSheet(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const data = [];

  for (let i = 1; i < rows.length; i++) {
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = rows[i][idx];
    });
    data.push(row);
  }
  return data;
}
```

### 14.8 Hash / Deterministic ID

Computed server-side using `Utilities.computeDigest`:

```javascript
function computeDeterministicId(creatorEmail, creationDate, id) {
  const input = creatorEmail + '|' + creationDate + '|' + id;
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    input,
    Utilities.Charset.UTF_8
  );
  // Convert byte array to hex string, take first 16 chars
  return digest
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
}
```

### 14.9 Session.getActiveUser() Behaviour

In a GAS web app deployed with **Execute as: Me** and **Access: Anyone within [domain]**:

- `Session.getActiveUser().getEmail()` returns the email of the user viewing the page.
- `Session.getEffectiveUser().getEmail()` returns the developer's email (the owner of the script).
- Always use `getActiveUser()` for identifying the current user.
- If the app is deployed with **Execute as: User accessing the app**, `getActiveUser()` may return `null` or behave differently for users outside the domain. The deployment must follow the exact settings in §15.

### 14.10 Optimistic Locking in Practice

Every entity carrier a `version` field. The pattern for all updates:

```javascript
function updateTask(taskId, changes) {
  const tasks = loadDatabase('tasks');
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) throw new Error('Task not found');

  const task = tasks[idx];

  // Optimistic lock check
  if (changes.version !== undefined && changes.version !== task.version) {
    throw new Error('Conflict: entity was modified');
  }

  // Field-level merge: only apply allowed fields from changes
  const allowedFields = ['description', 'dueDate', 'assignedTo', 'visibility', 'comment'];
  allowedFields.forEach(f => {
    if (changes[f] !== undefined) task[f] = changes[f];
  });

  // Auto-set system fields
  task.version += 1;
  task.lastModifiedDate = new Date().toISOString();

  tasks[idx] = task;
  saveDatabase('tasks', tasks);
  incrementDbVersion();

  return task;
}
```

---

## 15. Deployment Checklist

Follow these steps exactly when deploying the web app for the first time.

### 15.1 Prerequisites

- A Google Workspace domain with the developer account as a member.
- The developer account has permission to deploy GAS web apps.
- The backup spreadsheet is created (empty) and its ID noted.

### 15.2 Project Setup

| Step | Action |
|------|--------|
| 1 | Create a new GAS project at `script.google.com`. |
| 2 | Create each file as listed in §11 (Project Files & Structure). |
| 3 | Copy the source code for each `.gs` file from the implementation. |
| 4 | Copy the `Html/` files (Index.html, Styles.css, App.js). |
| 5 | Create `Config.json` with the desired configuration (see §7.3). |
| 6 | Set `Config.json` → `database.backupSpreadsheetId` to the backup spreadsheet ID. |
| 7 | Set the admin list: open Script Properties via `File → Project properties → Script properties` and add key `"admin"` with semicolon-separated admin emails as the value. |

### 15.3 Deployment

| Step | Action |
|------|--------|
| 1 | In the GAS editor, click **Deploy → New deployment**. |
| 2 | Select type: **Web app**. |
| 3 | **Description**: `BetterKanban v1.0`. |
| 4 | **Execute as**: **Me** (`developer@thecompany.com`). |
| 5 | **Who has access**: **Anyone within `thecompany.com`**. |
| 6 | Click **Deploy**. |
| 7 | Copy the generated **web app URL**. It will look like `https://script.google.com/macros/s/.../exec`. |
| 8 | In the Authorization dialog, review the permissions and accept. The app needs access to: `Script Properties`, `Spreadsheets` (backup), `Chat` (notifications), `User info` (email). |

### 15.4 Post-Deployment

| Step | Action |
|------|--------|
| 1 | Open the web app URL in a browser (logged into the company Google account). |
| 2 | Verify the home page loads with skeleton UI and data appears after a moment. |
| 3 | Run trigger setup: open the GAS editor → run `setupDailyTriggers()` once from the script editor. This installs the daily backup, purge, and notification triggers. |
| 4 | Verify the daily backup trigger: check that the backup spreadsheet has a snapshot sheet for today. |
| 5 | Test with a second user account to verify auto-registration works. |
| 6 | Test admin access: log in with an admin email, verify the Admin tab appears. |

### 15.5 Updating the App

When updating the code:

| Step | Action |
|------|--------|
| 1 | Edit the code in the GAS editor. |
| 2 | Click **Deploy → Manage deployments**. |
| 3 | Find the active deployment and click the pencil icon (Edit). |
| 4 | Select **Version: New version**. |
| 5 | Click **Deploy**. The new version is live immediately. |
| 6 | Users do not need to re-authorize unless new OAuth scopes are added. |

### 15.6 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Session.getActiveUser()` returns developer email | Web app published with wrong access setting | Re-deploy with "Anyone within [domain]" |
| Page loads blank / no data | HtmlService 500 KB limit hit | Reduce skeleton HTML size; lazy-load all data |
| Backup spreadsheet not updating | Missing trigger or wrong spreadsheet ID | Run `setupDailyTriggers()` manually; verify backupSpreadsheetId |
| "Admin tab not showing" | User email not in admin list | Check Script Properties key `"admin"` |
| Version conflict errors | Multiple users editing same entity | Normal — client auto-recovers (see §4.6.4) |
