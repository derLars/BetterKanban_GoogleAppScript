# BetterKanban — Product Context

## How It Works

### Authentication & Registration

- The GAS web app is deployed with **Execute as: Me** and **Access: Anyone within [domain]**.
- On every page load, the server calls `Session.getActiveUser().getEmail()` to identify the user.
- If the email is unknown, a `User` record is created automatically (auto-derived display name, role checked against admin list). There is **no signup form, no login screen, no password**.
- If the user was previously deleted (`deletedDate` is non-null), the registration flow rejects them with a "Your account has been deleted" message.

### Home Page Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  BetterKanban    [Home] [Admin]              [👤 Peter ▼]        │
├────────────────────────────────┬─────────────────────────────────┤
│  Tasks          🔍 [____]  ◀   │  Activities    🔍 [____]  ◀     │
│                                │  ┌──────┬──────┬──────┬──────┐  │
│  [+ New Task]                  │  │To Do │In Prg│Block │ Done │  │
│  ☑ Show completed             │  │  2   │  3   │  1   │  3   │  │
│  ☑ Show deleted               │  │ ┌──┐ │ ┌──┐ │ ┌──┐ │ ┌──┐ │  │
│  ┌─────────────────────┐      │  │ │  │ │ │  │ │ │  │ │ │  │ │  │
│  │ ☐ Buy groceries  🔓 │      │  │ └──┘ │ └──┘ │ └──┘ │ └──┘ │  │
│  │   👤 Peter          │      │  └──────┴──────┴──────┴──────┘  │
│  │   💬 Remember...    │      │                                  │
│  └─────────────────────┘      │                          ▶ Hide │
└────────────────────────────────┴─────────────────────────────────┘
```

- Two panes side-by-side at ≥1024px, stacked vertically at 768–1023px, vertical accordion at <768px.
- Each pane has its own: title, search input, hide/show toggle, new-item button, completed/deleted filter toggles.
- Resizable via a draggable divider between panes (or equal split by default).
- Pane hide/show state persisted per-user in their `User.settings` object.

### Task Manager (Left Pane)

- Compact cards: checkbox + description + visibility badge + assigned person (optional) + comment preview (optional, 80 chars).
- Click card → detail modal (480px max-width) with all editable fields: description, due date, assignee dropdown, visibility toggle (creator/admin only), comment textarea, read-only metadata (creator + creation date), action buttons (Update, Complete, Delete).
- Completing via checkbox on compact card = optimistic UI (strikethrough + fade immediately).
- Visibility toggles at top: `☑ Show completed` / `☑ Show deleted` — both default to off (hide completed/deleted).
- Search matches: description, creator display name, assignee display name, comment text. Client-side, debounced at 200ms.

### Kanban Board (Right Pane)

- Columns rendered as horizontal scroll (each column ≥220px wide, equal distribution). Column header = uppercase name + card count badge.
- Compact cards show: title (bold), description (full, no truncation), due date badge (red=overdue, yellow=today, grey=future), assignee (first name only), last comment text (1 line, truncated with ellipsis).
- Cards are `draggable="true"`. Drop zones = column containers + gaps between cards. On drop → `moveActivity(id, columnId, newOrder)` sent to server. Optimistic UI: card moves immediately, snaps back on error.
- Server normalizes `columnOrder` across source and target columns after every move (renumbers 0, 1, 2, ...).
- Click card → detail modal (600px max-width) with: title, due date, assignee, description, comments section (newest first, each with edit/delete buttons), new comment input, action buttons.
- Filter toggles (same pill style as Tasks): `☑ Show completed` / `☑ Show deleted`. Both default to off.

### Polling & Real-Time Updates

- `setInterval(poll, pollingIntervalSeconds * 1000)` after initial data load.
- Poll sends `lastVersion` (client's last known `dbVersion`).
- **Fast path (no change):** Server reads `dbVersion` from CacheService. Returns `{changed: false}` in <100ms. No Script Properties read.
- **Full path (change detected):** Server reads all `db_*` keys (cache or SP), returns `{changed: true, data: DatabaseSnapshot, newVersion}`.
- On change → client replaces entire in-memory state and re-renders visible components.
- 3 consecutive poll failures → error toast "Connection error. Retrying in 30s…" with auto-retry.

### Concurrency Model

| Scenario | Behavior |
|---|---|
| Two users edit different fields of same entity | Both succeed (field-level partial merge) |
| Two users edit same field | Last-write-wins (optimistic lock 409 → client re-fetches, re-applies pending edit, retries) |
| Two users edit different entities | Both succeed (independent Script Properties keys) |
| User edits while backup runs | Backup reads consistent snapshot; write is queued (GAS single-threaded) |
| Network error mid-write | Server function completes fully or throws — Script Properties not left half-written (single key-write is atomic) |

### Error Handling Philosophy

- **Validation:** Client-side before server call. Server re-validates (never trust client).
- **Optimistic UI:** Updates instantly. On server rejection, reverts with red error toast.
- **Server errors:** Structured as `{message, code, details}`. Code 400 = bad request, 403 = forbidden, 404 = not found, 409 = conflict.
- **Error states in UI:** Connection error banner (red left border) at top of affected pane. Inline validation errors below offending input. Undo toasts for reversible actions (complete, delete) lasting 5s.
- **Loading states:** Skeleton UI on initial load (grey rectangles, no spinner). Action buttons show small inline spinner during calls.
- **Empty states:** Centered placeholder with icon + message + CTA button per pane. "No results for..." for empty search results.

### Data Flow Diagram

```
┌──────────┐  google.script.run (mutations)   ┌────────────┐
│ Browser  │ ────────────────────────────────→ │ GAS Server │
│  (JS)    │                                   │  (doGet)   │
│          │ ←──────────────────────────────── │            │
│          │     JSON response / error          │            │
│          │                                   │   ↓    ↓   │
│          │  setInterval (polling)             │  SP   Cache │
│          │ ────────────────────────────────→ │            │
│          │     poll(lastVersion)              │            │
│          │ ←──────────────────────────────── │            │
│          │  {changed, data?, newVersion}      │            │
│          │                                   │     ↓      │
│          │        Session.getActiveUser()     │ Spreadsheet│
│          │                                   │ (backup)   │
└──────────┘                                   └────────────┘
```
