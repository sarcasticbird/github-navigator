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

let pollPromise = null;

function poll() {
  if (!pollPromise) {
    pollPromise = pollOnce().finally(() => { pollPromise = null; });
  }
  return pollPromise;
}

async function pollOnce() {
  const stored = await browser.storage.local.get(PAT_KEY);
  const token = stored[PAT_KEY];
  if (!token) {
    await writeCache({ total: 0, byRepo: {} }, false);
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
    } else if (err.message === "auth_failed") {
      await writeCache({ total: 0, byRepo: {} }, false);
      updateBadge(0);
    }
    // rate_limited, network/5xx: leave previous cache as-is, do nothing
  }
}

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
