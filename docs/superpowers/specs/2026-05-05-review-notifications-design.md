# PR Review Notifications — Design

Date: 2026-05-05
Status: Approved (pending implementation)
Version target: GitHub Navigator 1.1.0

## Summary

Add an unread indicator to GitHub Navigator that surfaces PR review requests
and @-mentions assigned to the user. The indicator appears as a dot on repo
rows, a count pill on org headers, and a numeric badge on the toolbar icon,
so the user can see at a glance whether GitHub is waiting on them without
visiting github.com.

## Goals

- Show the user when they have outstanding review requests or mentions, both
  inside the popup and on the toolbar icon (so it is visible without opening
  the popup).
- Match the existing extension's quiet, low-overhead model: storage-cached,
  stale-while-revalidate, no surprise UI churn.
- Keep the existing orgs/repos browsing flow untouched. Notifications are an
  overlay, not a new sort dimension.

## Non-goals

- Marking notifications read from inside the extension. Server-side read state
  is the source of truth; the dot clears when GitHub clears the notification.
- Showing notification content (PR title, comment text, etc.). The extension
  remains a navigator, not a notification viewer.
- Real-time push or sub-minute freshness. A 5-minute poll is sufficient.
- Floating unread items to the top of any sort mode.
- OS-level notifications. We do not use the `notifications` browser permission.

## User-facing behavior

### What counts as "unread"

A notification from `GET /notifications` whose `reason` is one of:

- `review_requested` — the user was added as a reviewer on a PR.
- `mention` — the user was @-mentioned on a PR or issue.

All other reasons (`comment`, `subscribed`, `author`, `ci_activity`,
`assign`, etc.) are ignored. The `reason` filter is applied client-side
after the API call rather than via the `participating=true` query parameter,
because `participating` drops some legitimate `mention` notifications.

### Where the indicator appears

- **Repo row:** small filled blue dot (~8px, GitHub blue `#0969da`) to the
  right of the repo name. Plain dot, no number.
- **Org header:** small rounded count pill between the org name and the
  existing close (✕) button, showing the integer count of unread items
  across all of that org's repos. Same blue background, white text.
- **Personal repos section:** if any personal repo has unread, the section
  label gets the same count pill.
- **Toolbar icon:** Firefox browser-action badge. Text is the integer total
  when > 0, empty string otherwise. Background `#0969da`, set once.

When the unread count for a scope is zero, no indicator is rendered for
that scope. When the entire feature is unavailable (no token, missing
scope, never-succeeded fetch), the badge is empty and no dots appear.

### When the indicator clears

Server-driven only. The dot disappears when GitHub itself marks the
notification read — which happens when the user opens the PR/comment/issue
on github.com or marks it read in GitHub's notifications UI. Clicking a
repo in the popup just navigates; it does not call any write-side API.

### Sort interaction

None. Indicators are pure overlays. All three existing view modes
(alpha tree, recent tree, flat) keep their current ordering.

### PAT scope guidance

Existing tokens do not have the `notifications` scope. When the API returns
403 with a missing-scope indication, the popup displays a one-line warning
above the toolbar:

> GitHub `notifications` scope missing — open settings to update your token.

Clicking the warning opens the options page. Other extension features
(orgs/repos browsing) continue to work normally.

## Architecture

### Approach

The background script owns the periodic poll and the toolbar badge. The
popup reads cached notification data from `browser.storage.local` for
instant render, then re-fetches in parallel with its existing orgs/repos
fetch and writes the result back to storage. Both writers update the
badge after a successful fetch. Storage is the shared-state mechanism;
no `runtime.sendMessage` plumbing is added.

This mirrors the existing orgs/repos cache pattern (read storage, render,
refresh in background) so the popup's flow stays symmetric.

### Components

**`src/background.js`** (new, MV2 non-persistent background page)

- Registers a `notifications-poll` alarm at 5-minute intervals on
  `runtime.onInstalled` and `runtime.onStartup` (idempotent registration).
- On alarm fire: reads PAT from storage; if absent, exits. Otherwise
  calls `GET /notifications?per_page=50`, filters
  `reason ∈ {review_requested, mention}` client-side, groups by
  `repository.full_name`, writes the result to storage, updates the badge.
- Does not maintain its own in-memory state across wakeups; storage is
  authoritative.

**`src/popup.js`** (modified)

- On open: reads the new `github_navigator_notifications` storage key
  alongside the existing orgs/repos cache. If present, renders dots and
  count pills immediately.
- After the existing `fetchData` completes, also fetches `/notifications`,
  applies the same filter/group, writes to storage, calls
  `setBadgeText` to keep the toolbar in sync, and re-renders.
- Adds two new render functions: one that adds the dot to a repo row,
  one that adds the count pill to an org header / personal-repos label.
- Surfaces the `.warning` div if `scopeMissing` is set in storage.

**`src/options.js`** (modified)

- The existing PAT-change handler that clears `CACHE_KEY` is extended to
  also clear `github_navigator_notifications` and to call
  `browser.alarms.clear("notifications-poll")` followed by re-registration
  (so the new token is used on the next fire).

**`src/manifest.json`** (modified)

- Version: `1.0.0` → `1.1.0`.
- Permissions: add `alarms`. (The `notifications` scope is on the PAT,
  not a manifest permission. We do *not* request the `notifications`
  manifest permission, which is for OS-level notifications.)
- Adds `background: { scripts: ["background.js"], persistent: false }`.

**`src/popup.css`** (modified) — adds styles for `.repo-unread-dot` and
`.org-unread-count`.

**`src/popup.html`** (no change expected; new elements are created in JS).

**`src/options.html`** / `README.md` (modified) — PAT scope list now
reads `read:org`, `repo`, `notifications`.

### Data flow

```
                +---------------------+
                |  alarms (5 min)     |
                +----------+----------+
                           |
                           v
+-------------------+  fetch /notifications  +-------------------+
|  background.js    | --------------------->  |  GitHub API      |
+---------+---------+ <---------------------  +-------------------+
          | filter+group
          v
+-------------------+
| storage.local     |
| github_navigator_ |
| notifications     |
+----+--------------+
     ^                                   ^
     | write                             | write
     |                                   |
+----+----------+   on open    +---------+--------+
|  popup.js     | <----------> |  GitHub API      |
|  - read cache |   fetch      +------------------+
|  - render     |
|  - refresh    |
+---------------+
                          \
                           v
                   +-------+--------+
                   | setBadgeText   |
                   | (both writers) |
                   +----------------+
```

### Storage schema

New key in `browser.storage.local`:

```
github_navigator_notifications: {
  updatedAt: <ms epoch>,
  total: <int>,                          // sum of all counts
  byRepo: { "owner/name": <int>, ... },  // only repos with count > 0
  scopeMissing: <bool>                   // true if last call returned a scope error
}
```

`byRepo` only contains entries with `count > 0`. The popup looks up by
`repo.full_name` when rendering each row, so absent keys naturally render
no dot. Cleared (set to `{ scopeMissing: false }`) when the PAT changes.

## Error handling

| Condition | Background script | Popup |
|---|---|---|
| No PAT | Exit silently. Alarm continues to fire and exit cheaply. | Already handled — shows setup view. |
| 401 (token invalid) | Clear badge. Set `scopeMissing: false`. | Existing token-invalid error view takes over (orgs/repos call also 401s). |
| 403 missing `notifications` scope | Clear badge. Set `scopeMissing: true`. | Render warning row above toolbar. Other features continue to work. |
| 403 rate-limited (`x-ratelimit-remaining: 0`) | Skip silently, retain previous cache. | Reuses existing rate-limit warning path; no separate handling for notifications. |
| 5xx / network error | Skip silently, retain previous cache. | Existing error handling applies; notifications cache stays as-is. |
| Success | Replace `byRepo`/`total`, set `scopeMissing: false`, update badge. | Same. |

Both rate-limited and missing-scope responses come back as 403. The
discriminator is the `x-ratelimit-remaining` header: `"0"` means rate
limit, anything else means a permission/scope problem. The existing
`apiFetch` already implements this check for the orgs/repos calls; the
notifications path uses the same pattern.

## Edge cases

- **First install.** Alarm registration runs in `runtime.onInstalled`;
  the script also calls the poll function immediately so the user does
  not wait 5 minutes for the first signal. If no PAT yet, the immediate
  call exits cheaply.
- **Browser restart.** `runtime.onStartup` re-registers the alarm
  idempotently. Non-persistent background page is recreated when the
  alarm next fires.
- **PAT changed.** Options page handler clears the cache, clears and
  re-registers the alarm, and triggers an immediate poll.
- **Notification for a repo not yet in the orgs/repos cache.** Rare —
  would only happen for a brand-new repo created in the last 5 minutes.
  The dot would not appear next to a row (because the row does not
  exist), but the count would still show up on the toolbar badge and
  the org header (or in `byRepo` for later use). This is acceptable
  and self-heals on the next orgs/repos refresh.
- **More than 50 unread items.** `per_page=50` is the page size. We do
  not paginate `/notifications` — the toolbar shows up to 50, and the
  user is presumably overwhelmed enough at that point that the exact
  number is academic. (If this ever matters, we add pagination.)

## Release plan

- Bump `manifest.json` version to `1.1.0`.
- `web-ext lint` clean.
- `web-ext build` to produce a new `.xpi` in `dist/`.
- AMO listing: upload new `.xpi`, update description to mention review
  notifications, update permissions disclosure to include `alarms`.
- README and options page updated with new PAT scope guidance for
  existing users.

## Open questions

None at design time. Implementation may surface ones around:

- Exact CSS positioning of the dot/pill within existing row markup.
- Whether the immediate-on-install poll needs a small startup delay to
  avoid racing with options-page setup.

These are fine to settle during implementation.
