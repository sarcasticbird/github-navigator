# PR Review Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an unread indicator (dot on repo rows, count pill on org headers, numeric badge on toolbar icon) for GitHub PR review requests and @-mentions, polled every 5 minutes by a new background script.

**Architecture:** A new MV2 non-persistent background script polls `GET /notifications` on a 5-minute alarm, filters by `reason ∈ {review_requested, mention}`, groups by repo, writes the result to `browser.storage.local`, and updates the toolbar badge. The popup reads the same storage key on open, renders dots/pills, then re-fetches and writes back. State clears server-side only — the popup never marks anything read.

**Tech Stack:** Vanilla JS, WebExtensions API (Firefox MV2), `browser.storage.local`, `browser.alarms`, `browser.browserAction.setBadgeText`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-05-review-notifications-design.md](../specs/2026-05-05-review-notifications-design.md)

**Branch:** `feature/review-notifications` (already created; spec commit landed).

---

## File Plan

| File | Action | Responsibility |
|---|---|---|
| `src/manifest.json` | Modify | Bump version to 1.1.0; add `alarms` permission; declare background script. |
| `src/background.js` | Create | Periodic poll, filter+group, storage write, badge update, alarm lifecycle. |
| `src/popup.js` | Modify | Read notifications cache; render dots/pills; refetch on popup open and write back; render scope-missing warning. |
| `src/popup.css` | Modify | New styles `.repo-unread-dot`, `.org-unread-count`. |
| `src/options.js` | Modify | On PAT change, clear notifications cache and reset the alarm. |
| `src/options.html` | Modify | Update PAT scope guidance text. |
| `README.md` | Modify | Update PAT scope list. |

---

## Task 1: Manifest update (permissions, background, version)

**Files:**
- Modify: `src/manifest.json`

- [ ] **Step 1: Bump version, add `alarms` permission, declare background script**

Current `src/manifest.json` is at version `1.0.0` with permissions `["storage", "tabs", "https://api.github.com/*"]` and no background section. Replace the file with:

```json
{
    "manifest_version": 2,
    "name": "GitHub Navigator",
    "description": "Quick access to your GitHub organizations and repositories. Built for Zen Browser.",
    "version": "1.1.0",

    "icons": {
        "48": "icon.svg",
        "96": "icon.svg"
    },

    "browser_specific_settings": {
        "gecko": {
            "id": "github-navigator@sarcasticbird.com",
            "strict_min_version": "79.0",
            "data_collection_permissions": {
                "required": ["authenticationInfo"]
            }
        }
    },

    "browser_action": {
        "default_icon": "icon.svg",
        "default_popup": "popup.html",
        "default_title": "GitHub Navigator"
    },

    "options_ui": {
        "page": "options.html",
        "open_in_tab": false
    },

    "background": {
        "scripts": ["background.js"],
        "persistent": false
    },

    "permissions": [
        "storage",
        "tabs",
        "alarms",
        "https://api.github.com/*"
    ]
}
```

- [ ] **Step 2: Verify lint passes**

Run: `flox activate -c 'npx web-ext lint --source-dir src'`

Expected: lint exits 0, no errors. (It will warn that `background.js` is referenced but does not exist — that's expected and resolved in the next task.)

If the lint complains specifically about the missing `background.js`, that's fine — leave it for now. The script lands in Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/manifest.json
git commit -m "chore: bump to 1.1.0 and add background+alarms scaffolding"
```

---

## Task 2: Background script — pure data layer

**Files:**
- Create: `src/background.js`

We're starting with the pure data shaping functions only — no storage, no alarms, no badge yet. This lets us verify the API call and filter logic in isolation before plumbing it into anything.

- [ ] **Step 1: Create `src/background.js` with API constants and pure helpers**

```javascript
"use strict";

const API_BASE = "https://api.github.com";
const PAT_KEY = "github_navigator_pat";
const NOTIFICATIONS_KEY = "github_navigator_notifications";
const ALARM_NAME = "notifications-poll";
const POLL_INTERVAL_MINUTES = 5;
const RELEVANT_REASONS = new Set(["review_requested", "mention"]);

async function apiFetch(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `token ${token}` },
  });

  if (response.status === 401) {
    throw new Error("auth_failed");
  }

  if (response.status === 403) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("rate_limited");
    }
    throw new Error("scope_missing");
  }

  if (!response.ok) {
    throw new Error(`api_error_${response.status}`);
  }

  return response.json();
}

function summarizeNotifications(rawList) {
  const byRepo = {};
  let total = 0;
  for (const item of rawList) {
    if (!RELEVANT_REASONS.has(item.reason)) continue;
    const fullName = item.repository && item.repository.full_name;
    if (!fullName) continue;
    byRepo[fullName] = (byRepo[fullName] || 0) + 1;
    total += 1;
  }
  return { total, byRepo };
}

async function fetchNotifications(token) {
  const raw = await apiFetch("/notifications?per_page=50", token);
  return summarizeNotifications(raw);
}
```

- [ ] **Step 2: Verify pure-function logic via browser console**

Run: `flox activate -c 'npx web-ext run --source-dir src --target firefox-desktop'`

In the loaded Firefox window, open the Browser Toolbox: `Tools → Browser Tools → Browser Toolbox` (allow it if prompted). Switch to the **Multiprocess Toolbox** if needed. In the console, evaluate:

```javascript
summarizeNotifications([
  { reason: "review_requested", repository: { full_name: "a/b" } },
  { reason: "review_requested", repository: { full_name: "a/b" } },
  { reason: "mention", repository: { full_name: "a/c" } },
  { reason: "comment", repository: { full_name: "a/d" } },
  { reason: "subscribed", repository: { full_name: "a/e" } },
])
```

Expected output: `{ total: 3, byRepo: { "a/b": 2, "a/c": 1 } }`

If you can't reach `summarizeNotifications` from the toolbox, that means the background script isn't loaded — check that `background` block was added in Task 1 and `web-ext` reloaded.

- [ ] **Step 3: Commit**

```bash
git add src/background.js
git commit -m "feat: add background script API layer for notifications"
```

---

## Task 3: Background script — storage write and badge

**Files:**
- Modify: `src/background.js`

- [ ] **Step 1: Append cache write and badge update helpers**

Append to `src/background.js`:

```javascript
async function writeCache(summary, scopeMissing) {
  await browser.storage.local.set({
    [NOTIFICATIONS_KEY]: {
      updatedAt: Date.now(),
      total: summary.total,
      byRepo: summary.byRepo,
      scopeMissing,
    },
  });
}

function updateBadge(total) {
  const text = total > 0 ? String(total) : "";
  browser.browserAction.setBadgeText({ text });
}

async function setBadgeColor() {
  await browser.browserAction.setBadgeBackgroundColor({ color: "#0969da" });
}

async function poll() {
  const stored = await browser.storage.local.get(PAT_KEY);
  const token = stored[PAT_KEY];
  if (!token) {
    updateBadge(0);
    return;
  }

  try {
    const summary = await fetchNotifications(token);
    await writeCache(summary, false);
    updateBadge(summary.total);
  } catch (err) {
    if (err.message === "scope_missing") {
      await writeCache({ total: 0, byRepo: {} }, true);
      updateBadge(0);
    }
    // auth_failed, rate_limited, network/5xx: leave previous cache as-is, do nothing
  }
}
```

- [ ] **Step 2: Verify storage write and badge appear**

In Firefox launched by `web-ext run`, enter your PAT via the options page (it must already have the `notifications` scope for this verification to be meaningful — otherwise you'll get the scope-missing path, which is also valid to verify, just check that `scopeMissing: true` ends up in storage). Then in the Browser Toolbox console:

```javascript
await poll();
await browser.storage.local.get("github_navigator_notifications");
```

Expected:
- The toolbar badge shows your current unread count (or empty if zero).
- The storage object contains `{ updatedAt, total, byRepo, scopeMissing }` matching what the GitHub UI shows for unread review_requested + mention items.

If you have no actual unread notifications and want to test the badge rendering: in console, run `updateBadge(3)` — the toolbar should show "3" with a blue background.

- [ ] **Step 3: Commit**

```bash
git add src/background.js
git commit -m "feat: persist notifications and update toolbar badge"
```

---

## Task 4: Background script — alarm and lifecycle

**Files:**
- Modify: `src/background.js`

- [ ] **Step 1: Append alarm registration and event handlers**

Append to `src/background.js`:

```javascript
async function ensureAlarm() {
  const existing = await browser.alarms.get(ALARM_NAME);
  if (!existing) {
    browser.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    poll();
  }
});

browser.runtime.onInstalled.addListener(async () => {
  await setBadgeColor();
  await ensureAlarm();
  poll();
});

browser.runtime.onStartup.addListener(async () => {
  await setBadgeColor();
  await ensureAlarm();
  poll();
});
```

- [ ] **Step 2: Verify alarm fires and immediate poll runs**

Reload the extension (`web-ext run` reloads on file change automatically). In the Browser Toolbox console:

```javascript
await browser.alarms.get("notifications-poll");
```

Expected: returns `{ name: "notifications-poll", periodInMinutes: 5, scheduledTime: <future ms> }`.

To verify the immediate-on-startup poll, watch the Network panel of the Browser Toolbox for a request to `https://api.github.com/notifications` shortly after the extension reloads. The badge should reflect your unread count within seconds.

To force a poll without waiting 5 minutes:

```javascript
poll();
```

- [ ] **Step 3: Commit**

```bash
git add src/background.js
git commit -m "feat: schedule 5-minute notifications poll"
```

---

## Task 5: Popup styles for dot and count pill

**Files:**
- Modify: `src/popup.css`

- [ ] **Step 1: Read current popup.css to find a sensible insertion point**

Run: `grep -n "repo-name\|org-name\|section-label" src/popup.css`

Identify the rule blocks for `.repo-name`, `.org-name`, and the surrounding `.org-header` / `.repo-item` styles so the new classes sit nearby.

- [ ] **Step 2: Append new styles**

Append to `src/popup.css`:

```css
.repo-unread-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #0969da;
  margin-left: 6px;
  vertical-align: middle;
  flex-shrink: 0;
}

.org-unread-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  margin-left: 6px;
  border-radius: 8px;
  background: #0969da;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Verify visually with a temporary stub**

Reload the extension. In the popup HTML (via Inspector in the Browser Toolbox), pick any rendered repo row and inject a span manually:

```javascript
const row = document.querySelector(".repo-item");
const dot = document.createElement("span");
dot.className = "repo-unread-dot";
row.appendChild(dot);
```

Expected: a small blue dot appears at the end of that repo row, vertically centered. Do the same with `.org-unread-count` and `textContent = "3"` on an org header — it should render a small blue pill with "3".

Then close and reopen the popup (the manual injection vanishes; that's fine). The styles are now ready for Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/popup.css
git commit -m "feat: styles for unread dot and count pill"
```

---

## Task 6: Popup — load and render notifications

**Files:**
- Modify: `src/popup.js`

This task adds storage-read and rendering, but does not yet refetch from the API on popup open (Task 7) or surface the scope-missing warning (Task 8).

- [ ] **Step 1: Add the storage key constant and an in-memory holder**

In `src/popup.js`, near the existing `const CACHE_KEY` line at the top of the file, add:

```javascript
const NOTIFICATIONS_KEY = "github_navigator_notifications";
```

And near `let data = { orgs: [], repos: [] };`, add:

```javascript
let notifications = { total: 0, byRepo: {}, scopeMissing: false };
```

- [ ] **Step 2: Add a loader function next to `loadCache`**

After the existing `loadCache` function, add:

```javascript
async function loadNotificationsCache() {
  const result = await browser.storage.local.get(NOTIFICATIONS_KEY);
  const cached = result[NOTIFICATIONS_KEY];
  if (!cached) return { total: 0, byRepo: {}, scopeMissing: false };
  return {
    total: cached.total || 0,
    byRepo: cached.byRepo || {},
    scopeMissing: !!cached.scopeMissing,
  };
}
```

- [ ] **Step 3: Add a helper to compute org-level counts**

Above the `renderTree` function in `src/popup.js`, add:

```javascript
function orgUnreadCount(orgLogin) {
  let count = 0;
  for (const fullName in notifications.byRepo) {
    if (fullName.startsWith(orgLogin + "/")) {
      count += notifications.byRepo[fullName];
    }
  }
  return count;
}

function personalUnreadCount(personalRepos) {
  let count = 0;
  for (const repo of personalRepos) {
    if (notifications.byRepo[repo.full_name]) {
      count += notifications.byRepo[repo.full_name];
    }
  }
  return count;
}
```

- [ ] **Step 4: Render the dot inside repo rows**

In `renderTree`, in the loop that builds each repo row inside an org section (around the existing `repoRow.appendChild(repoName);` line), append a dot if needed. The block currently looks like:

```javascript
const repoName = document.createElement("span");
repoName.className = "repo-name";
repoName.textContent = repo.name;
repoRow.appendChild(repoName);
```

Add immediately after that `appendChild`:

```javascript
if (notifications.byRepo[repo.full_name]) {
  const dot = document.createElement("span");
  dot.className = "repo-unread-dot";
  repoRow.appendChild(dot);
}
```

Apply the same addition in **two more places**: the `renderFlat` function (where `repoName.textContent = repo.full_name`) and the personal-repos section (where `repoName.textContent = repo.name`). All three sites use the same pattern.

- [ ] **Step 5: Render the count pill on org headers**

In `renderTree`, in the section that builds the org header (where `header.appendChild(name)` is called for the org name), append after that `name` append:

```javascript
const orgCount = orgUnreadCount(org.login);
if (orgCount > 0) {
  const pill = document.createElement("span");
  pill.className = "org-unread-count";
  pill.textContent = String(orgCount);
  header.appendChild(pill);
}
```

- [ ] **Step 6: Render the count pill on the personal-repos label**

In `renderTree`, in the personal-repos section (around `label.textContent = "Personal repos";`), modify to:

```javascript
const label = document.createElement("div");
label.className = "section-label";
label.textContent = "Personal repos";
const personalCount = personalUnreadCount(personalRepos);
if (personalCount > 0) {
  const pill = document.createElement("span");
  pill.className = "org-unread-count";
  pill.textContent = String(personalCount);
  label.appendChild(pill);
}
treeEl.appendChild(label);
```

- [ ] **Step 7: Wire `loadNotificationsCache` into `loadData`**

Find the `loadData` function. After the existing `const cache = await loadCache();` line, add:

```javascript
notifications = await loadNotificationsCache();
```

This ensures dots/pills render on the very first paint from cache.

- [ ] **Step 8: Verify dots and pills appear**

Reload the extension. Open the popup. If you have outstanding review requests, dots should appear next to those repos and counts next to their orgs. If you have none, manually populate storage from the Browser Toolbox console:

```javascript
await browser.storage.local.set({
  github_navigator_notifications: {
    updatedAt: Date.now(),
    total: 3,
    byRepo: { "anthropics/claude-code": 1, "anthropics/anthropic-sdk-python": 2 },
    scopeMissing: false,
  },
});
```

Replace the repo names with two repos that actually appear in your popup. Close and reopen the popup. Expected: dots next to those two repos, a pill showing "3" on the `anthropics` org header.

- [ ] **Step 9: Commit**

```bash
git add src/popup.js
git commit -m "feat: render unread dots and counts in popup"
```

---

## Task 7: Popup — refetch on open and update badge

**Files:**
- Modify: `src/popup.js`

- [ ] **Step 1: Add a popup-side fetch helper**

In `src/popup.js`, near the other fetch helpers (after `fetchMyLastCommits`), add:

```javascript
const RELEVANT_REASONS = new Set(["review_requested", "mention"]);

function summarizeNotifications(rawList) {
  const byRepo = {};
  let total = 0;
  for (const item of rawList) {
    if (!RELEVANT_REASONS.has(item.reason)) continue;
    const fullName = item.repository && item.repository.full_name;
    if (!fullName) continue;
    byRepo[fullName] = (byRepo[fullName] || 0) + 1;
    total += 1;
  }
  return { total, byRepo };
}

async function fetchNotifications(token) {
  const raw = await apiFetch("/notifications?per_page=50", token);
  return summarizeNotifications(raw);
}

async function writeNotificationsCache(summary, scopeMissing) {
  await browser.storage.local.set({
    [NOTIFICATIONS_KEY]: {
      updatedAt: Date.now(),
      total: summary.total,
      byRepo: summary.byRepo,
      scopeMissing,
    },
  });
}
```

Note: the existing popup `apiFetch` throws `"auth_failed"` for both 401 and 403. We need to distinguish scope-missing from auth-failed for notifications. Update the existing `apiFetch` (lines 54-72 of popup.js) to match the background's logic:

```javascript
async function apiFetch(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `token ${token}` },
  });

  if (response.status === 401) {
    throw new Error("auth_failed");
  }

  if (response.status === 403) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("rate_limited");
    }
    throw new Error("scope_missing");
  }

  if (!response.ok) {
    throw new Error(`api_error_${response.status}`);
  }

  return response.json();
}
```

The existing orgs/repos error handling already treats `auth_failed` and `rate_limited` correctly. Adding `scope_missing` is new — for the orgs/repos calls it would only occur if the `repo` or `read:org` scope was revoked, which is also a token problem. Catch it at the call site (next step).

- [ ] **Step 2: Wire notifications refetch into `loadData`**

Find the existing try block in `loadData` that calls `fetchData(token, username)`. Replace the body of that try block:

```javascript
  try {
    const [freshData, notificationsResult] = await Promise.all([
      fetchData(token, username),
      fetchNotifications(token).then(
        (summary) => ({ ok: true, summary }),
        (err) => ({ ok: false, err })
      ),
    ]);

    data = freshData;
    await saveCache(data);

    if (notificationsResult.ok) {
      notifications = { ...notificationsResult.summary, scopeMissing: false };
      await writeNotificationsCache(notificationsResult.summary, false);
      browser.browserAction.setBadgeText({
        text: notifications.total > 0 ? String(notifications.total) : "",
      });
    } else if (notificationsResult.err.message === "scope_missing") {
      notifications = { total: 0, byRepo: {}, scopeMissing: true };
      await writeNotificationsCache({ total: 0, byRepo: {} }, true);
      browser.browserAction.setBadgeText({ text: "" });
    }
    // For auth_failed / rate_limited / network on the notifications side: leave
    // the previously-rendered notifications state alone. The orgs/repos error
    // handler below will cover whole-token failures.

    renderUpdatedTime(Date.now());
    renderTree();
    showView(mainView);
  } catch (err) {
    if (err.message === "auth_failed" || err.message === "scope_missing") {
      showError("Token is invalid or missing required scopes.", true);
    } else if (err.message === "rate_limited") {
      if (cache) {
        const warning = document.createElement("div");
        warning.className = "warning";
        warning.textContent = "Rate limited — showing cached data.";
        mainView.insertBefore(warning, mainView.querySelector(".toolbar"));
      } else {
        showError("Rate limited and no cached data available.", false);
      }
    } else {
      if (!cache) {
        showError("Failed to fetch data from GitHub.", false);
      }
    }
  }
```

The `Promise.all` here always settles for the notifications side (we wrap rejection into a result tuple) so a notifications failure cannot blow up the orgs/repos path.

- [ ] **Step 3: Verify popup-driven refetch updates storage and badge**

Reload the extension. Wipe the notifications cache from the Browser Toolbox console:

```javascript
await browser.storage.local.remove("github_navigator_notifications");
await browser.browserAction.setBadgeText({ text: "" });
```

Open the popup. Expected:
- A network request to `https://api.github.com/notifications` appears in the Network panel.
- After it completes, `browser.storage.local.get("github_navigator_notifications")` shows fresh data.
- The toolbar badge reflects the current total.
- Dots/pills render in the popup matching the data.

- [ ] **Step 4: Commit**

```bash
git add src/popup.js
git commit -m "feat: refetch notifications on popup open"
```

---

## Task 8: Popup — scope-missing warning row

**Files:**
- Modify: `src/popup.js`

- [ ] **Step 1: Add a render function for the warning**

In `src/popup.js`, near the existing rendering helpers, add:

```javascript
function renderScopeWarning() {
  const existing = mainView.querySelector(".warning.scope-missing");
  if (!notifications.scopeMissing) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;

  const warning = document.createElement("div");
  warning.className = "warning scope-missing";
  warning.textContent =
    "GitHub `notifications` scope missing — click to update PAT.";
  warning.style.cursor = "pointer";
  warning.addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  mainView.insertBefore(warning, mainView.querySelector(".toolbar"));
}
```

- [ ] **Step 2: Call `renderScopeWarning` whenever the popup re-renders**

In `loadData`, immediately after every `renderTree();` call inside `loadData`, add a `renderScopeWarning();` call. There are three such call sites:

1. The fresh-cache fast path (just after `data = cache; renderUpdatedTime(cache.timestamp); renderTree();`)
2. The stale-cache-while-fetching path (just after the second `renderTree()` for cached display)
3. The post-fetch path inside the try block (after the new `renderTree()` call from Task 7)

After each, add:

```javascript
renderScopeWarning();
```

- [ ] **Step 3: Verify the warning appears and clicks open options**

In the Browser Toolbox console, force the missing-scope state:

```javascript
await browser.storage.local.set({
  github_navigator_notifications: {
    updatedAt: Date.now(),
    total: 0,
    byRepo: {},
    scopeMissing: true,
  },
});
```

Open the popup. Expected: a warning row appears above the toolbar with the scope-missing message. Clicking it opens the options page and closes the popup.

Then clear the flag and verify the warning disappears:

```javascript
await browser.storage.local.set({
  github_navigator_notifications: {
    updatedAt: Date.now(),
    total: 0,
    byRepo: {},
    scopeMissing: false,
  },
});
```

Reopen the popup. Expected: no warning.

- [ ] **Step 4: Commit**

```bash
git add src/popup.js
git commit -m "feat: warn when notifications scope is missing"
```

---

## Task 9: Options page — clear notifications cache and reset alarm on PAT change

**Files:**
- Modify: `src/options.js`

- [ ] **Step 1: Extend `saveToken` to clear notifications and reset the alarm**

In `src/options.js`, find the success path of `saveToken` (lines 33-37):

```javascript
    const user = await response.json();
    await browser.storage.local.set({ github_navigator_pat: token, github_navigator_user: user.login });
    await browser.storage.local.remove("github_navigator_cache");
    statusEl.textContent = `Token saved for ${user.login}.`;
    statusEl.className = "status success";
```

Replace with:

```javascript
    const user = await response.json();
    await browser.storage.local.set({ github_navigator_pat: token, github_navigator_user: user.login });
    await browser.storage.local.remove([
      "github_navigator_cache",
      "github_navigator_notifications",
    ]);
    await browser.alarms.clear("notifications-poll");
    browser.alarms.create("notifications-poll", { periodInMinutes: 5 });
    browser.browserAction.setBadgeText({ text: "" });
    statusEl.textContent = `Token saved for ${user.login}.`;
    statusEl.className = "status success";
```

`browser.alarms` is part of the WebExtensions API; no import is needed. The `alarms` permission was added in Task 1.

- [ ] **Step 2: Verify cache clear and alarm reset on PAT change**

Reload the extension. Open the options page. With Browser Toolbox open on the options page, change the PAT to a new value and save. Then in the console:

```javascript
await browser.storage.local.get(["github_navigator_cache", "github_navigator_notifications"]);
await browser.alarms.get("notifications-poll");
```

Expected: both storage entries are absent or empty. The alarm is registered with a fresh `scheduledTime`.

- [ ] **Step 3: Commit**

```bash
git add src/options.js
git commit -m "fix: clear notifications cache and reset alarm on PAT change"
```

---

## Task 10: Documentation updates

**Files:**
- Modify: `src/options.html`
- Modify: `README.md`

- [ ] **Step 1: Update the PAT scope guidance in `options.html`**

Run: `grep -n "scope\|read:org\|repo" src/options.html`

Find the line that lists required scopes (currently `read:org`, `repo`). Update it to: `read:org`, `repo`, `notifications`.

- [ ] **Step 2: Update the README**

In `README.md`, find the line:

> Your token needs these scopes: `read:org`, `repo` (must be a **classic** token — fine-grained tokens don't support the org membership API)

Change to:

> Your token needs these scopes: `read:org`, `repo`, `notifications` (must be a **classic** token — fine-grained tokens don't support the org membership API)

Also add a new bullet near the existing `## Features` list:

> - Unread indicator for review requests and @-mentions (dot per repo, count per org, count on toolbar icon)

- [ ] **Step 3: Commit**

```bash
git add src/options.html README.md
git commit -m "docs: note new notifications scope and feature"
```

---

## Task 11: Final lint and build

**Files:** none modified (verification + artifact only).

- [ ] **Step 1: Run `web-ext lint`**

Run: `flox activate -c 'npx web-ext lint --source-dir src'`

Expected: zero errors. Warnings about manifest v2 deprecation in Chrome are acceptable and pre-existing — Firefox still supports MV2.

- [ ] **Step 2: Run `web-ext build`**

Run: `flox activate -c 'npx web-ext build --source-dir src --artifacts-dir dist --overwrite-dest'`

Expected: a new `.xpi` file appears in `dist/` named like `github_navigator-1.1.0.xpi`. Confirm the version number in the filename matches the manifest bump.

- [ ] **Step 3: Sanity-check the built extension**

Run: `flox activate -c 'npx web-ext run --source-dir src --target firefox-desktop'` (or load the built `.xpi` via `about:addons`). Open the popup. Expected:
- Existing functionality unchanged: orgs/repos render, search works, sort toggle works, close-all-tabs works.
- If you have unread review requests / mentions: dots and counts appear; toolbar badge shows the total.
- If you don't, badge is empty and no dots are rendered.
- Options page still saves/clears PAT correctly.

- [ ] **Step 4: Push the branch (do NOT open a PR or push to main without user approval)**

Stop here. Surface the work to the user:

> Branch `feature/review-notifications` is ready locally. Want me to push it to origin and open a PR?

Wait for the user's explicit go-ahead before `git push` or `gh pr create`. Per the user's CLAUDE.md, no commits/pushes/PRs without explicit approval.

---

## Self-Review Notes

A few cross-references worth double-checking during execution:

- `summarizeNotifications` is defined identically in `background.js` (Task 2) and `popup.js` (Task 7). This is intentional duplication — the spec keeps the architecture simple by avoiding shared modules. If the duplication later annoys, extract into `src/notifications-shared.js` as a follow-up.
- `RELEVANT_REASONS` is also duplicated for the same reason.
- `apiFetch`'s 403 handling is changed in popup.js in Task 7 to distinguish `scope_missing` from `auth_failed`. Existing callers (`fetchAllOrgs`, `fetchAllRepos`, `fetchMyLastCommits`) already throw out the response so they're agnostic to which 403 variant occurred — the catch block in `loadData` (also updated in Task 7) treats both the same when they bubble up from non-notifications calls.
- The toolbar badge color is set in three places: once on `runtime.onInstalled` and once on `runtime.onStartup` (Task 4) — both call `setBadgeColor()`. The popup never sets the color, only the text. That's correct: color is set-once-at-startup, and the background is the canonical owner of the badge across browser sessions.
- Storage key `github_navigator_notifications` is referenced in five files (background.js, popup.js, options.js — Tasks 2, 6, 9). Confirm during execution that it's spelled identically everywhere; consider extracting to a single constants file as a follow-up if it grows.
