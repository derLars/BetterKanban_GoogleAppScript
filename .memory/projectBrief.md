# BetterKanban — Project Brief

## Why: The Problem

Teams within Google Workspace domains lack a lightweight, integrated project management tool that works **entirely within the Google ecosystem** (no external SaaS, no server provisioning, no per-seat licensing). Existing solutions like Trello, Asana, or Jira require separate accounts, cross-domain authentication, and IT approval. Google's own Tasks is too simplistic (no Kanban, no collaboration). The goal of BetterKanban is to fill this gap with a **zero-infrastructure, self-hosted PM tool** that works out of the box for any Google Workspace domain.

## What: The Product

BetterKanban is a project management web app built **entirely on Google Apps Script (GAS)**. It provides four core modules in a single-page application:

1. **Task Manager** — A simple list of one-off to-dos (no Kanban workflow). Each task has: description, optional due date, assignee, visibility (public/private), optional comment. Supports create, read, update, complete/uncomplete, soft-delete/undelete, and auto-purge of old records.

2. **Kanban Board** — A multi-column drag-and-drop board for managing multi-step Activities (cards). Each card has: title, description, optional due date, assignee, column position, and a **per-card comment thread** (multiple comments with edit/delete). Supports create, read, update, complete/uncomplete, soft-delete/undelete, drag-to-reorder, drag-between-columns, and auto-purge.

3. **Home Dashboard** — A combined view with two resizable side-by-side panes (Tasks left, Kanban right), per-pane keyword search, per-pane hide/show toggles, welcome bar with workload counters (assigned to me, due today, overdue).

4. **Settings & Admin** — Per-user Settings (Google Chat webhook for daily summaries, vacation periods for notification suppression, spreadsheet dump import/export). Admin page (admin list management, config editor with JSON validation, user deletion with automatic data dump, snapshot import with merge/overwrite modes).

## Who: Target Users

- **Primary:** Teams of 2–50 people within a single Google Workspace domain who need task management and lightweight Kanban workflows without leaving the Google ecosystem.
- **Admin:** One or more designated users who manage the tool (edit config, delete users, import snapshots).
- **Non-goal:** External collaborators outside the domain, standalone (non-Google) deployments, or teams larger than ~50 users (Script Properties 500KB limit becomes a bottleneck).

## Key Design Constraints

| Constraint | Implication |
|---|---|
| **GAS Script Properties: 500KB total** | Every byte is optimized. Short property keys. Date compression. No redundant fields. Auto-purge near 400KB. Daily spreadsheet backup prevents data loss. |
| **No WebSockets / SSE** | Client-side polling (configurable interval, default 10s) via `poll(lastVersion)` endpoint. Fast path via CacheService `dbVersion` key. |
| **GAS single-threaded execution** | No race conditions — GAS queues concurrent requests. Optimistic locking (version field) protects against stale-client overwrites. |
| **No npm / external packages** | Vanilla JS frontend. No framework. System font stack. No web fonts. No third-party CSS. |
| **HtmlService max output: 500KB** | Skeleton UI loads first, then data is fetched asynchronously via `google.script.run`. Never embed large data in HTML template. |
| **Identity via Google Workspace** | `Session.getActiveUser().getEmail()` is the sole identity. No login screen. Auto-registration on first visit. |

## Deployment Model

- **Type:** GAS Web App
- **Execute as:** Developer ("Me")
- **Access:** "Anyone within [domain]"
- **Storage:** Script Properties (live) + Google Spreadsheet (backup, import/export dump sheets)
- **Triggers:** Time-driven (daily backup, daily purge, daily chat notifications, 5-min keep-warm ping)
