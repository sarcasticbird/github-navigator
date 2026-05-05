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
