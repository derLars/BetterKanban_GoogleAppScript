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

**Next priority:** Create Config.json, then implement backend files in dependency order.

---

## Phase 1: Backend Foundation

| Item | Status | Notes |
|---|---|---|
| `Config.json` | ⏳ Pending | Create default configuration file per §7.3 schema |
| `Database.gs` | ⏳ Pending | Core: `loadDatabase()`, `saveDatabase()`, `loadConfig()`, `computeDeterministicId()`, key translation (short↔full), cache write-through, size estimation, backup/restore, dump sheet read |
| `Main.gs` | ⏳ Pending | `doGet()`, `include()` helper, `getInitialData()`, `getCurrentUser()`, `poll()` |
| `Triggers.gs` | ⏳ Pending | `setupDailyTriggers()`, `keepWarm()` |

**Dependency order:** `Config.json` → `Database.gs` → `Main.gs` → `Triggers.gs`

---

## Phase 2: Domain Modules

| Item | Status | Notes |
|---|---|---|
| `Users.gs` | ⏳ Pending | `registerUser()`, `getUser()`, `getAllUsers()`, `updateUserSettings()`, display name derivation |
| `Tasks.gs` | ⏳ Pending | `createTask()`, `getTasks()`, `getTask()`, `updateTask()`, `completeTask()`, `uncompleteTask()`, `deleteTask()`, `undeleteTask()`, `purgeOldTasks()` |
| `Activities.gs` | ⏳ Pending | `createActivity()`, `getActivities()`, `getActivity()`, `updateActivity()`, `completeActivity()`, `uncompleteActivity()`, `deleteActivity()`, `undeleteActivity()`, `moveActivity()`, `purgeOldActivities()`, `addComment()`, `updateComment()`, `deleteComment()` |
| `Admin.gs` | ⏳ Pending | `isAdmin()`, `getAdminList()`, `saveAdminList()`, `getConfig()`, `saveConfig()`, `deleteUser()`, `getAvailableSnapshots()`, `importSnapshot()` |
| `Settings.gs` | ⏳ Pending | `updateProfile()`, `saveChatWebhook()`, `saveVacations()`, `importFromSpreadsheet()`, `exportToSpreadsheet()` |
| `Notifications.gs` | ⏳ Pending | `sendDailyChatSummaries()`, vacation suppression logic |
| `Purge.gs` | ⏳ Pending | Called by daily trigger; hard-deletes old completed/soft-deleted tasks & activities |

**Dependency order:** `Users.gs` → `Tasks.gs` + `Activities.gs` → `Admin.gs` → `Settings.gs` → `Notifications.gs` → `Purge.gs`

---

## Phase 3: Frontend

| Item | Status | Notes |
|---|---|---|
| `Html/Styles.css` | ⏳ Pending | CSS custom properties (§8.2), layout (top bar, two panes, columns), cards, modals, buttons, toasts, empty states, responsive breakpoints, skeleton loading |
| `Html/Index.html` | ⏳ Pending | Skeleton HTML: top bar, welcome bar, two pane containers, filter controls, modal shells, toast container. No data embedded. |
| `Html/App.js` | ⏳ Pending | State management, rendering, `google.script.run` wrappers, drag-and-drop handlers, search filtering, modal management, polling loop, optimistic UI, error handling |

**Dependency order:** Backend Phase 2 must be complete before frontend integration testing.

---

## Phase 4: Integration & Testing

| Item | Status | Notes |
|---|---|---|
| `Tests.gs` | ⏳ Pending | Unit tests for all server functions. Run manually from GAS editor. |
| End-to-end manual test | ⏳ Pending | Open web app, verify skeleton + data load, create tasks/activities, drag cards, edit comments, test admin operations, test settings, verify polling |
| Deployment checklist | ⏳ Pending | Follow steps in Spec.md §15 |

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
