"use strict";

const API_BASE = "https://api.github.com";
const PAT_KEY = "github_navigator_pat";
const NOTIFICATIONS_KEY = "github_navigator_notifications";
const ALARM_NAME = "notifications-poll";
const POLL_INTERVAL_MINUTES = 1;
const LAST_MODIFIED_KEY = "github_navigator_notifications_last_modified";
// Force a full (unconditional) fetch at least this often, since GitHub's 304
// is keyed on new notification activity and may not reflect read-state changes.
const FULL_REFRESH_MS = 5 * 60 * 1000;
const RELEVANT_REASONS = new Set(["review_requested", "mention"]);

async function apiFetch(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `token ${token}` },
    cache: "no-store",
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

function toHtmlUrl(apiUrl) {
  if (!apiUrl) return null;
  return apiUrl
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/");
}

function summarizeNotifications(rawList) {
  const byRepo = {};
  const items = [];
  let total = 0;
  for (const item of rawList) {
    if (!RELEVANT_REASONS.has(item.reason)) continue;
    const fullName = item.repository && item.repository.full_name;
    if (!fullName || !item.subject) continue;
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

function extractNumber(apiUrl) {
  if (!apiUrl) return null;
  const match = apiUrl.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

async function enrichItemStates(items, token) {
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map((item) => {
        if (!item.htmlUrl) return Promise.resolve(null);
        const apiPath = item.htmlUrl
          .replace("https://github.com/", "/repos/")
          .replace("/pull/", "/pulls/");
        return apiFetch(apiPath, token);
      })
    );
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value) {
        const data = result.value;
        if (data.merged) {
          batch[j].state = "merged";
        } else {
          batch[j].state = data.state || "open";
        }
      }
      batch[j].number = extractNumber(batch[j].htmlUrl);
    }
  }
}

async function fetchNotifications(token, lastModified) {
  const headers = { Authorization: `token ${token}` };
  if (lastModified) {
    headers["If-Modified-Since"] = lastModified;
  }
  const response = await fetch(`${API_BASE}/notifications?per_page=50`, {
    headers,
    cache: "no-store",
  });

  // 304: nothing changed since last poll; doesn't count against rate limit.
  if (response.status === 304) {
    return { notModified: true };
  }
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

  const raw = await response.json();
  const summary = summarizeNotifications(raw);
  try {
    await enrichItemStates(summary.items, token);
  } catch (_) {
    // enrichment is best-effort
  }
  summary.lastModified = response.headers.get("Last-Modified");
  return summary;
}

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

function updateBadge(total) {
  const text = total > 0 ? String(total) : "";
  browser.browserAction.setBadgeText({ text });
}

async function setBadgeColor() {
  await browser.browserAction.setBadgeBackgroundColor({ color: "#0969da" });
}

let pollPromise = null;

function poll() {
  if (!pollPromise) {
    pollPromise = pollOnce().finally(() => { pollPromise = null; });
  }
  return pollPromise;
}

async function pollOnce() {
  const stored = await browser.storage.local.get([PAT_KEY, LAST_MODIFIED_KEY, NOTIFICATIONS_KEY]);
  const token = stored[PAT_KEY];
  if (!token) {
    await writeCache({ total: 0, byRepo: {}, items: [] }, false);
    updateBadge(0);
    return;
  }

  const cached = stored[NOTIFICATIONS_KEY];
  const cacheFresh =
    cached && cached.updatedAt && Date.now() - cached.updatedAt < FULL_REFRESH_MS;
  const lastModified = cacheFresh ? stored[LAST_MODIFIED_KEY] : null;

  try {
    const summary = await fetchNotifications(token, lastModified);
    if (summary.notModified) {
      // Badge text doesn't survive browser restarts; restore it from cache.
      updateBadge(cached && cached.total ? cached.total : 0);
      return;
    }
    await writeCache(summary, false);
    updateBadge(summary.total);
    if (summary.lastModified) {
      await browser.storage.local.set({ [LAST_MODIFIED_KEY]: summary.lastModified });
    }
  } catch (err) {
    if (err.message === "scope_missing") {
      await writeCache({ total: 0, byRepo: {}, items: [] }, true);
      updateBadge(0);
    } else if (err.message === "auth_failed") {
      await writeCache({ total: 0, byRepo: {}, items: [] }, false);
      updateBadge(0);
    }
    // rate_limited, network/5xx: leave previous cache as-is, do nothing
  }
}

async function ensureAlarm() {
  const existing = await browser.alarms.get(ALARM_NAME);
  // Recreate if missing or if the interval changed in an update.
  if (!existing || existing.periodInMinutes !== POLL_INTERVAL_MINUTES) {
    browser.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    poll();
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "poll") {
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
