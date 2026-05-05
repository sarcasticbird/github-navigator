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
