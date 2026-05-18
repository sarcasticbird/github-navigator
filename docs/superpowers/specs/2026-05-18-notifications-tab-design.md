# Notifications Tab Design

**Date:** 2026-05-18
**Status:** Approved
**Scope:** github-navigator Firefox extension

## Summary

Add a notifications view to the popup, toggled via the existing bell button in the footer. Shows review requests and mentions with direct links to PRs/issues on GitHub. Read-only — no mark-as-read functionality.

## Requirements

- Bell button in footer toggles between repos view and notifications view
- Notifications list shows `review_requested` and `mention` notifications only (existing filter)
- Each row links directly to the PR/issue on GitHub (HTML URL, not API URL)
- "View all on GitHub" link at bottom of the list (replaces the bell's old behavior of opening github.com/notifications)
- Empty state when no notifications
- No new API calls, permissions, or polling — reuses existing background worker data

## Data Layer

### Background worker changes (background.js)

The existing `fetchNotifications()` reduces API responses to `{ total, byRepo, scopeMissing }`. We expand the cached shape to include full notification items:

```js
{
  total: 3,
  byRepo: { "org/repo": 2 },
  scopeMissing: false,
  items: [
    {
      id: "123456",
      reason: "review_requested",
      subject: { title: "Add feature X", type: "PullRequest" },
      repository: { full_name: "org/repo", owner: { avatar_url: "..." } },
      updated_at: "2026-05-18T...",
      htmlUrl: "https://github.com/org/repo/pull/42"
    }
  ]
}
```

- `htmlUrl` is derived at cache time from `subject.url`
- Items are sorted by `updated_at` descending (most recent first)
- Same 5-minute poll cycle, same `per_page=50` limit

### URL conversion

```
api.github.com/repos/org/repo/pulls/42  →  github.com/org/repo/pull/42
api.github.com/repos/org/repo/issues/7  →  github.com/org/repo/issues/7
```

Only `/pulls/` needs transforming to `/pull/`. The `/issues/` path is already correct.

## UI & Interaction

### Toggle behavior

- Bell button click toggles a `notificationsViewActive` boolean
- When active: notification list renders in the existing tree container
- When inactive: repos tree/flat list renders as usual
- Bell icon gets a visual highlight (`.bell-active`) when notifications view is shown
- Badge count on the bell still shows the notification count in both views

### Toolbar

- Search input and sort toggle hide when notifications view is active (`display: none`)
- Toolbar container stays for layout consistency
- Controls reappear when switching back to repos view

### Notification row

Each row displays:
- **Repo name** — dimmed, smaller text (e.g. `org/repo`)
- **Subject title** — primary text, clickable link
- **Reason badge** — small label: `review` or `mention`
- **Relative time** — right-aligned (e.g. "2h ago")

Clicking the row opens the target in a new tab.

### Empty state

"No pending review requests or mentions" — centered, muted text.

### Footer link

"View all on GitHub" link at the bottom of the notifications list. Opens `https://github.com/notifications` in a new tab.

### Refresh

Footer refresh button still works — triggers a re-poll which updates both views.

## Files Changed

| File | Change |
|------|--------|
| `background.js` | Cache full notification items with derived `htmlUrl` |
| `popup.js` | Toggle state, `renderNotifications()`, bell click handler |
| `popup.css` | Notification row styles, bell active state, footer link |
| `popup.html` | No changes needed |

No changes to: `manifest.json`, `options.js`, `options.html`

## Non-goals

- Mark-as-read from within the extension
- Pagination beyond 50 notifications
- Notification types beyond review_requested and mention
- Persistent view state (always opens to repos view)
