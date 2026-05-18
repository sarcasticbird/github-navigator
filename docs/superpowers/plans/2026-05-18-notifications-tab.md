# Notifications Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a notifications view toggled via the footer bell button, showing review requests and mentions with direct links to PRs/issues.

**Architecture:** The background worker already fetches notifications and discards everything except counts. We expand it to cache full notification objects with derived HTML URLs. The popup reads these cached items and renders them in the existing tree container when the bell is toggled. No new API calls, permissions, or polling changes.

**Tech Stack:** Vanilla JS, Firefox WebExtension APIs (MV2), CSS

**Kata tracking:** Parent `sfky`, children `ea8n` (background), `5dtw` (popup), `8ps0` (CSS)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/background.js` | Modify | Expand `summarizeNotifications()` to return items array; derive `htmlUrl` from API URLs |
| `src/popup.js` | Modify | Toggle state, `renderNotifications()`, rewire bell click handler, hide toolbar when active |
| `src/popup.css` | Modify | Notification row styles, bell active state, footer link, empty state |

No changes to: `src/popup.html`, `src/manifest.json`, `src/options.js`, `src/options.html`

---

### Task 1: Expand background worker to cache notification items (kata `ea8n`)

**Files:**
- Modify: `src/background.js:34-45` (`summarizeNotifications`)
- Modify: `src/background.js:52-61` (`writeCache`)

- [ ] **Step 1: Add `toHtmlUrl` helper**

Add this function above `summarizeNotifications` at line 34 in `src/background.js`:

```js
function toHtmlUrl(apiUrl) {
  if (!apiUrl) return null;
  return apiUrl
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/");
}
```

- [ ] **Step 2: Expand `summarizeNotifications` to build items array**

Replace the existing `summarizeNotifications` function (lines 34-45) with:

```js
function summarizeNotifications(rawList) {
  const byRepo = {};
  const items = [];
  let total = 0;
  for (const item of rawList) {
    if (!RELEVANT_REASONS.has(item.reason)) continue;
    const fullName = item.repository && item.repository.full_name;
    if (!fullName) continue;
    byRepo[fullName] = (byRepo[fullName] || 0) + 1;
    total += 1;
    items.push({
      id: item.id,
      reason: item.reason,
      subject: {
        title: item.subject.title,
        type: item.subject.type,
      },
      repository: {
        full_name: fullName,
        owner: { avatar_url: item.repository.owner.avatar_url },
      },
      updated_at: item.updated_at,
      htmlUrl: toHtmlUrl(item.subject.url),
    });
  }
  items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return { total, byRepo, items };
}
```

- [ ] **Step 3: Include items in cached data**

Replace the existing `writeCache` function (lines 52-61) with:

```js
async function writeCache(summary, scopeMissing) {
  await browser.storage.local.set({
    [NOTIFICATIONS_KEY]: {
      updatedAt: Date.now(),
      total: summary.total,
      byRepo: summary.byRepo,
      items: summary.items || [],
      scopeMissing,
    },
  });
}
```

- [ ] **Step 4: Update empty-cache calls to include items**

The two places that call `writeCache` with a manually-constructed object (lines 85 and 96-97) pass `{ total: 0, byRepo: {} }`. These need an `items` field:

Change both occurrences of:
```js
await writeCache({ total: 0, byRepo: {} }, false);
```
to:
```js
await writeCache({ total: 0, byRepo: {}, items: [] }, false);
```

And change:
```js
await writeCache({ total: 0, byRepo: {} }, true);
```
to:
```js
await writeCache({ total: 0, byRepo: {}, items: [] }, true);
```

- [ ] **Step 5: Verify extension still loads**

Run: `flox activate -c 'npx web-ext lint --source-dir src'`

Expected: No errors related to background.js changes.

- [ ] **Step 6: Commit**

```bash
git add src/background.js
git commit -m "feat: cache full notification items with HTML URLs in background worker"
```

---

### Task 2: Add notification row styles and bell active state (kata `8ps0`)

**Files:**
- Modify: `src/popup.css` (append new rules)

- [ ] **Step 1: Add notification view styles**

Append the following to the end of `src/popup.css`:

```css
/* Notifications view */
.notif-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  padding: 7px 12px;
  cursor: pointer;
  border-bottom: 1px solid #eaeef2;
}

.notif-row:hover {
  background: #eaeef2;
}

.notif-repo {
  width: 100%;
  font-size: 11px;
  color: #57606a;
}

.notif-title {
  flex: 1;
  font-size: 13px;
  color: #0969da;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notif-reason {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #ddf4ff;
  color: #0969da;
  flex-shrink: 0;
  line-height: 1.4;
}

.notif-reason.mention {
  background: #fff8c5;
  color: #9a6700;
}

.notif-time {
  font-size: 11px;
  color: #8c959f;
  flex-shrink: 0;
}

.notif-footer-link {
  display: block;
  padding: 10px 12px;
  text-align: center;
  font-size: 12px;
  color: #0969da;
  cursor: pointer;
  border-bottom: 1px solid #eaeef2;
}

.notif-footer-link:hover {
  background: #eaeef2;
  text-decoration: underline;
}

.notif-empty {
  padding: 24px 16px;
  text-align: center;
  color: #8c959f;
  font-size: 13px;
}

#open-notifications.bell-active {
  background: #ddf4ff;
  color: #0969da;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/popup.css
git commit -m "feat: add notification row and bell toggle styles"
```

---

### Task 3: Add toggle state and renderNotifications() to popup (kata `5dtw`)

**Files:**
- Modify: `src/popup.js:34` (add state variable)
- Modify: `src/popup.js:201-210` (`loadNotificationsCache`)
- Modify: `src/popup.js` (add `renderNotifications` function)
- Modify: `src/popup.js:708-711` (rewire bell click handler)
- Modify: `src/popup.js:689` (guard search input listener)

- [ ] **Step 1: Add toggle state variable**

In `src/popup.js`, after line 36 (`let sortMode = "alpha";`), add:

```js
let notificationsViewActive = false;
```

- [ ] **Step 2: Update `loadNotificationsCache` to include items**

Replace the existing `loadNotificationsCache` function (lines 201-210) with:

```js
async function loadNotificationsCache() {
  const result = await browser.storage.local.get(NOTIFICATIONS_KEY);
  const cached = result[NOTIFICATIONS_KEY];
  if (!cached) return { total: 0, byRepo: {}, items: [], scopeMissing: false };
  return {
    total: cached.total || 0,
    byRepo: cached.byRepo || {},
    items: cached.items || [],
    scopeMissing: !!cached.scopeMissing,
  };
}
```

- [ ] **Step 3: Add `relativeTime` helper**

Add this function after the `isFresh` function (after line 220):

```js
function relativeTime(isoDate) {
  const seconds = Math.floor((Date.now() - new Date(isoDate)) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 4: Add `renderNotifications` function**

Add this function after the `relativeTime` helper:

```js
function renderNotifications() {
  treeEl.replaceChildren();

  const items = notifications.items || [];

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "notif-empty";
    empty.textContent = "No pending review requests or mentions";
    treeEl.appendChild(empty);
  } else {
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "notif-row";

      const repo = document.createElement("div");
      repo.className = "notif-repo";
      repo.textContent = item.repository.full_name;
      row.appendChild(repo);

      const title = document.createElement("span");
      title.className = "notif-title";
      title.textContent = item.subject.title;
      row.appendChild(title);

      const reason = document.createElement("span");
      reason.className = "notif-reason" + (item.reason === "mention" ? " mention" : "");
      reason.textContent = item.reason === "review_requested" ? "review" : "mention";
      row.appendChild(reason);

      const time = document.createElement("span");
      time.className = "notif-time";
      time.textContent = relativeTime(item.updated_at);
      row.appendChild(time);

      if (item.htmlUrl) {
        row.addEventListener("click", () => {
          browser.tabs.create({ url: item.htmlUrl });
          window.close();
        });
      }

      treeEl.appendChild(row);
    }
  }

  const footerLink = document.createElement("div");
  footerLink.className = "notif-footer-link";
  footerLink.textContent = "View all on GitHub";
  footerLink.addEventListener("click", () => {
    browser.tabs.create({ url: "https://github.com/notifications" });
    window.close();
  });
  treeEl.appendChild(footerLink);
}
```

- [ ] **Step 5: Add `toggleNotificationsView` function**

Add this function after `renderNotifications`:

```js
function toggleNotificationsView() {
  notificationsViewActive = !notificationsViewActive;

  searchInput.style.display = notificationsViewActive ? "none" : "";
  sortToggleBtn.style.display = notificationsViewActive ? "none" : "";

  if (notificationsViewActive) {
    openNotificationsBtn.classList.add("bell-active");
    renderNotifications();
  } else {
    openNotificationsBtn.classList.remove("bell-active");
    renderTree();
  }
}
```

- [ ] **Step 6: Rewire the bell button click handler**

Replace the existing bell click handler (lines 708-711):

```js
openNotificationsBtn.addEventListener("click", () => {
  browser.tabs.create({ url: "https://github.com/notifications" });
  window.close();
});
```

with:

```js
openNotificationsBtn.addEventListener("click", toggleNotificationsView);
```

- [ ] **Step 7: Guard `renderTree` calls to respect active view**

The search input listener on line 689 calls `renderTree` directly. When notifications view is active, typing in the (hidden) search box shouldn't switch back. Replace:

```js
searchInput.addEventListener("input", renderTree);
```

with:

```js
searchInput.addEventListener("input", () => {
  if (!notificationsViewActive) renderTree();
});
```

- [ ] **Step 8: Guard `renderTree` calls in `loadData`**

In `loadData`, there are several calls to `renderTree()` (around lines 617, 659, 669, 681). Each should respect the active view. Replace each bare `renderTree()` call with:

```js
if (notificationsViewActive) {
  renderNotifications();
} else {
  renderTree();
}
```

There are four occurrences in `loadData`:
1. Line 617: after loading from cache
2. Line 659: after fresh data fetch succeeds
3. Line 669: after rate-limited with cache fallback
4. Line 681: after other error with cache fallback

- [ ] **Step 9: Update popup.js `writeNotificationsCache` to include items**

In `src/popup.js`, the `writeNotificationsCache` function (lines 159-168) also needs to pass through `items`. Replace it with:

```js
async function writeNotificationsCache(summary, scopeMissing) {
  await browser.storage.local.set({
    [NOTIFICATIONS_KEY]: {
      updatedAt: Date.now(),
      total: summary.total,
      byRepo: summary.byRepo,
      items: summary.items || [],
      scopeMissing,
    },
  });
}
```

- [ ] **Step 10: Update popup.js `summarizeNotifications` to match background.js**

The popup has its own copy of `summarizeNotifications` (lines 141-152) used when it fetches notifications directly. It needs to produce the same shape. Replace it with the same expanded version from Task 1:

```js
function summarizeNotifications(rawList) {
  const byRepo = {};
  const items = [];
  let total = 0;
  for (const item of rawList) {
    if (!RELEVANT_REASONS.has(item.reason)) continue;
    const fullName = item.repository && item.repository.full_name;
    if (!fullName) continue;
    byRepo[fullName] = (byRepo[fullName] || 0) + 1;
    total += 1;
    items.push({
      id: item.id,
      reason: item.reason,
      subject: {
        title: item.subject.title,
        type: item.subject.type,
      },
      repository: {
        full_name: fullName,
        owner: { avatar_url: item.repository.owner.avatar_url },
      },
      updated_at: item.updated_at,
      htmlUrl: toHtmlUrl(item.subject.url),
    });
  }
  items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return { total, byRepo, items };
}
```

And add the `toHtmlUrl` helper above it (before line 141):

```js
function toHtmlUrl(apiUrl) {
  if (!apiUrl) return null;
  return apiUrl
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/");
}
```

- [ ] **Step 11: Update `loadData` notifications result handler**

In `loadData`, the notifications result handler (lines 642-652) builds `notifications` without `items`. Update it:

Replace:
```js
  if (notificationsResult.ok) {
    notifications = { ...notificationsResult.summary, scopeMissing: false };
```

with:
```js
  if (notificationsResult.ok) {
    notifications = { ...notificationsResult.summary, items: notificationsResult.summary.items || [], scopeMissing: false };
```

- [ ] **Step 12: Lint**

Run: `flox activate -c 'npx web-ext lint --source-dir src'`

Expected: No errors.

- [ ] **Step 13: Commit**

```bash
git add src/popup.js
git commit -m "feat: add notifications toggle view to popup"
```

---

### Task 4: Manual smoke test

- [ ] **Step 1: Build the extension**

Run: `flox activate -c 'npx web-ext build --source-dir src --overwrite'`

- [ ] **Step 2: Load in Firefox and test**

Run: `flox activate -c 'npx web-ext run --source-dir src'`

Test checklist:
1. Click the bell button — notifications view appears, search/sort hide, bell highlights
2. Click bell again — repos view returns, search/sort reappear, bell un-highlights
3. Notification rows show: repo name, PR title, reason badge (blue for review, yellow for mention), relative time
4. Clicking a notification row opens the correct PR in a new tab
5. "View all on GitHub" link at bottom opens `github.com/notifications`
6. Empty state shows "No pending review requests or mentions" when no notifications
7. Refresh button re-polls and updates both views
8. Badge count on bell still shows notification count

- [ ] **Step 3: Close kata issues**

```bash
kata close ea8n --done --message "Background worker now caches full notification items with derived HTML URLs." --commit <sha-from-step-6-task-1>
kata close 8ps0 --done --message "Added CSS for notification rows, reason badges, bell active state, and footer link." --commit <sha-from-step-2-task-2>
kata close 5dtw --done --message "Bell button toggles notifications view with renderNotifications(), toolbar hides when active." --commit <sha-from-step-13-task-3>
```
