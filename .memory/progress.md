# BetterKanban — Progress Tracking

> **Last updated:** 2026-05-14

## Legend

- ✅ **Done** — Implemented, tested, and working
- 🔄 **In Progress** — Currently being worked on
- ⏳ **Pending** — Not yet started
- ❌ **Blocked** — Blocked by another task or external factor

---

## Phase 0: Specification & Planning

| Item | Status | Notes |
|---|---|---|
| Functional specification (Spec.md) | ✅ Done | 2190-line complete specification covering all modules, data model, API, UI, deployment |
| Memory Bank (`.memory/` directory) | ✅ Done | projectBrief.md, productContext.md, systemPatterns.md, techContext.md, progress.md |
| `.git` init | ✅ Done | Repository initialized in `/home/BetterKanban_GoogleAppScript` |

---

## Phase 1: Backend Foundation

| Item | Status | Notes |
|---|---|---|
| `Config.json` | ✅ Done | Default configuration per §7.3 with 5 columns |
| `Database.gs` | ✅ Done | `loadDatabase/saveDatabase`, `loadConfig()` (merge Config.json + configOverlay), `computeDeterministicId()` (SHA-256), short↔full key translation maps for all 4 entity types, cache write-through, backup snapshot creation/rotation, dump sheet read/write, revert dumps, size estimation & auto-purge, UUID generation |
| `Main.gs` | ✅ Done | `doGet()` with session handling & auto-registration, `include()` helper, `getInitialData()` (full snapshot with visibility filtering + display name enrichment), `getCurrentUser()`, `poll(lastVersion)` (fast path via CacheService, full path via SP) |
| `Triggers.gs` | ✅ Done | `setupDailyTriggers()` (backup, purge tasks, purge activities, chat notification, keep-warm), `removeAllTriggers()`, `keepWarm()` |

---

## Phase 2: Domain Modules

| Item | Status | Notes |
|---|---|---|
| `Users.gs` | ✅ Done | `registerUser()` (auto-registration with deleted check), `getUser()`, `getAllUsers()`, `updateUserSettings()`, `isAdmin()`, `deriveDisplayName()` (handles hyphenated, dot-separated, single-part emails) |
| `Tasks.gs` | ✅ Done | Full CRUD: `createTask()` (validates description, sets deterministicId), `getTasks(opts)` (visibility filtering: public + own private, showDeleted, showCompleted), `getTask()`, `updateTask()` (field-level merge with optimistic locking, visibility guard), `completeTask/uncompleteTask`, `deleteTask/undeleteTask` |
| `Activities.gs` | ✅ Done | Full CRUD: `createActivity()` (defaults to first column), `getActivities/Activity`, `updateActivity()` (field-level merge), `completeActivity` (moves to completedColumnId), `uncompleteActivity` (moves to first column), `delete/undelete`, `moveActivity()` (column move + order renormalization across source & target columns), comment operations: `addComment` (newest-first, max comments eviction), `updateComment`, `deleteComment` |
| `Admin.gs` | ✅ Done | `checkAdmin()` guard, `getAdminList()/saveAdminList()` (email validation, last-admin guard), `getConfig()/saveConfig()` (JSON validation + spreadsheet accessibility check), `deleteUser()` (dump generation, private task hard-delete, public task reassignment to `_deleted_`, activity reassignment, user soft-delete), `getAvailableSnapshots()`, `importSnapshot()` (merge/overwrite modes, revert dump creation, columnNumber → columnId mapping, order renormalization) |
| `Settings.gs` | ✅ Done | `updateProfile()`, `saveChatWebhook()` (URL prefix validation), `saveVacations()` (date range validation), `importFromSpreadsheet()` (reads `_Dump_Tasks`/`_Dump_Activities`, dedup by deterministicId, columnNumber mapping, version reset to 1), `exportToSpreadsheet()` (creates/updates dump sheets) |
| `Notifications.gs` | ✅ Done | `sendDailyChatSummaries()` (iterates users with webhooks, skips on vacation, builds summary with open tasks/due today/overdue/open activities), `isOnVacation()` (date range check), `buildSummary()`, `sendChatMessage()` (HTTP POST via UrlFetchApp) |
| `Purge.gs` | ✅ Done | `purgeOldTasksInternal()` (hard-deletes soft-deleted beyond retentionDays, enforces completedTaskMaxCount by removing oldest), `purgeOldActivitiesInternal()` (same logic), `purgeOldTasks/Activities()` (public trigger entry points) |

---

## Phase 3: Frontend

| Item | Status | Notes |
|---|---|---|
| `Styles.html` | ✅ Done | Full CSS (~604 lines): custom properties palette, top bar with user dropdown, welcome bar with counters, two-pane layout with hide/show toggles, task cards (compact with checkbox + visibility badge + assignee + comment preview), Kanban columns with horizontal scroll, activity cards, 4 modal types, form fields, comments section, button variants, toast system, empty states, skeleton loading shimmer, responsive breakpoints (≥1024 / 768–1023 / <768), error banner, scrollbar styling |
| `Index.html` | ✅ Done | Skeleton HTML (no embedded data): top bar with tabs + user avatar/dropdown, welcome bar, tasks pane + activities pane with search/toggle/add/filters, 5 modal shells (task detail, activity detail, new task, new activity, settings, admin), toast container, boot script calling `getInitialData()` |
| `App.html` | ✅ Done | Complete client SPA (~920 lines): `onInit()`, `renderAll()` (`renderTasks`, `renderKanban`, `renderWelcome`), task detail modal (change tracking + visibility guard), activity detail modal (inline comment edit/add/delete with edit/delete buttons), 3 settings tabs (profile, notifications, import/export), admin panel (admin list, config editor, user deletion, snapshot import), API wrappers for all 25+ server methods, HTML5 Drag & Drop + touch fallback with long-press, optimistic task complete/uncomplete, 409 conflict recovery (re-fetch + re-open modal), debounced search (200ms), polling loop (fast-path caching, 3-failure detection), keyboard shortcuts (Ctrl+N, Ctrl+Shift+N, /, Escape), toast system (stacked, max 3, auto-dismiss), escapeHtml() XSS prevention |

---

## Phase 4: Testing & Documentation

| Item | Status | Notes |
|---|---|---|
| `Tests.gs` | ✅ Done | 26 unit tests: 3 database, 4 users, 8 tasks, 6 activities, 2 purge, 2 config, 2 notifications. `testAll()` runner with pass/fail logging. |
| `README.md` | ✅ Done | Full setup & deployment instructions, config reference, GAS limitations table, data model overview, key design decisions, test instructions |
| Spec.md | ✅ Done | 2190-line complete specification (pre-existing) |

---

## Known Technical Decisions & Trade-offs

| Decision | Rationale | Risk |
|---|---|---|
| Short property keys in storage | Saves ~40% space in 500KB Script Properties | Adds translation complexity in `Database.gs` |
| Polling over WebSockets | GAS doesn't support WebSockets | Up to 10s delay for updates |
| Vanilla JS (no framework) | GAS has no npm — keeping it simple | More manual DOM work; no reactivity |
| Comments embedded in Activity object | Avoids separate `db_comments` key; simplifies reads | Increases Activity serialization size; `maxCommentsPerActivity` cap mitigates this |
| Optimistic locking via version field | Only viable concurrency mechanism in GAS | Requires 409 handling on client side |
| Field-level partial updates | Prevents lost updates when users edit different fields | More complex server merge logic |
| Skeleton UI + async data load | Avoids 500KB HtmlService limit | Two-step rendering (skeleton → data) |
| Auto-registration via Session | Zero-friction onboarding | Only works within Google Workspace domain with correct deployment config |

## Future Milestones (Post-v1)

- Email notifications via `MailApp`
- Labels / Tags on tasks and activities
- Reporting dashboard (task completion trends, cycle times)
- Offline mode (Service Worker + IndexedDB)
- Google Calendar integration (sync due dates)
