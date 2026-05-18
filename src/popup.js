"use strict";

const CACHE_KEY = "github_navigator_cache";
const NOTIFICATIONS_KEY = "github_navigator_notifications";
const PAT_KEY = "github_navigator_pat";
const USER_KEY = "github_navigator_user";
const CACHE_TTL_MS = 5 * 60 * 1000;
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const API_BASE = "https://api.github.com";

// DOM references
const setupView = document.getElementById("setup");
const mainView = document.getElementById("main");
const errorView = document.getElementById("error");
const loadingView = document.getElementById("loading");
const errorMessage = document.getElementById("error-message");
const searchInput = document.getElementById("search");
const treeEl = document.getElementById("tree");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");
const sortToggleBtn = document.getElementById("sort-toggle");
const openSettingsBtn = document.getElementById("open-settings");
const errorSettingsBtn = document.getElementById("error-settings");
const closeAllTabsBtn = document.getElementById("close-all-tabs");
const openNotificationsBtn = document.getElementById("open-notifications");
const modalEl = document.getElementById("modal");
const modalMessageEl = document.getElementById("modal-message");
const modalOkBtn = document.getElementById("modal-ok");
const modalCancelBtn = document.getElementById("modal-cancel");

const SORT_KEY = "github_navigator_sort";

let data = { orgs: [], repos: [] };
let notifications = { total: 0, byRepo: {}, items: [], scopeMissing: false };
let expandedOrgs = new Set();
let sortMode = "alpha";
let notificationsViewActive = false;

// --- Views ---

function showView(view) {
  [setupView, mainView, errorView, loadingView].forEach((v) => {
    v.hidden = v !== view;
  });
  if (view === mainView && !notificationsViewActive) {
    searchInput.focus();
  }
}

function showError(message, showSettings) {
  errorMessage.textContent = message;
  errorSettingsBtn.hidden = !showSettings;
  showView(errorView);
}

// --- GitHub API ---

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

async function fetchAllRepos(token) {
  const repos = [];
  let page = 1;

  while (true) {
    const batch = await apiFetch(
      `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`,
      token
    );
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return repos;
}

async function fetchAllOrgs(token) {
  const orgs = [];
  let page = 1;

  while (true) {
    const batch = await apiFetch(
      `/user/orgs?per_page=100&page=${page}`,
      token
    );
    orgs.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return orgs;
}

async function fetchMyLastCommits(repos, token, username) {
  const now = Date.now();
  const recentRepos = repos.filter((r) => now - new Date(r.pushed_at) < RECENT_WINDOW_MS);
  const commitDates = {};

  // Batch in groups of 10 to avoid hammering the API
  for (let i = 0; i < recentRepos.length; i += 10) {
    const batch = recentRepos.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map((r) =>
        apiFetch(`/repos/${r.full_name}/commits?author=${username}&per_page=1`, token)
      )
    );
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value.length > 0) {
        commitDates[batch[j].full_name] = result.value[0].commit.author.date;
      }
    }
  }

  return commitDates;
}

const RELEVANT_REASONS = new Set(["review_requested", "mention"]);

// Keep in sync with background.js
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
      items: summary.items || [],
      scopeMissing,
    },
  });
}

async function fetchData(token, username) {
  const [orgs, repos] = await Promise.all([
    fetchAllOrgs(token),
    fetchAllRepos(token),
  ]);

  const commitDates = username ? await fetchMyLastCommits(repos, token, username) : {};

  return {
    orgs: orgs
      .map((o) => ({ login: o.login, avatar: o.avatar_url }))
      .sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: "base" })),
    repos: repos
      .map((r) => ({
        full_name: r.full_name,
        owner: r.owner.login,
        name: r.name,
        pushed_at: r.pushed_at,
        my_last_commit: commitDates[r.full_name] || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  };
}

// --- Cache ---

async function loadCache() {
  const result = await browser.storage.local.get(CACHE_KEY);
  return result[CACHE_KEY] || null;
}

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

async function saveCache(newData) {
  await browser.storage.local.set({
    [CACHE_KEY]: { ...newData, timestamp: Date.now() },
  });
}

function isFresh(cache) {
  return cache && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

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
      } else {
        row.style.cursor = "default";
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

// --- Sorting ---

function recentScore(repo) {
  // Repos I committed to sort first (by my commit date), then repos I haven't (by pushed_at)
  if (repo.my_last_commit) {
    return { tier: 1, date: new Date(repo.my_last_commit) };
  }
  return { tier: 2, date: new Date(repo.pushed_at || 0) };
}

function compareRecent(a, b) {
  const sa = recentScore(a);
  const sb = recentScore(b);
  if (sa.tier !== sb.tier) return sa.tier - sb.tier;
  return sb.date - sa.date;
}

function sortRepos(repos) {
  if (sortMode === "recent" || sortMode === "flat") {
    return [...repos].sort(compareRecent);
  }
  return [...repos].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

const SORT_MODES = ["alpha", "recent", "flat"];
const SORT_LABELS = { alpha: "A-Z", recent: "\u{1F552}", flat: "\u{2261}" };
const SORT_TITLES = { alpha: "Sort: alphabetical", recent: "Sort: recent (tree)", flat: "Sort: recent (flat)" };

function updateSortButton() {
  sortToggleBtn.textContent = SORT_LABELS[sortMode];
  sortToggleBtn.title = SORT_TITLES[sortMode];
}

// --- Modal ---

function showModal(message, { showCancel, onConfirm }) {
  modalMessageEl.textContent = message;
  modalCancelBtn.hidden = !showCancel;
  modalEl.hidden = false;
  modalOkBtn.focus();

  const close = () => {
    modalEl.hidden = true;
    modalOkBtn.onclick = null;
    modalCancelBtn.onclick = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  modalOkBtn.onclick = () => {
    close();
    if (onConfirm) onConfirm();
  };
  modalCancelBtn.onclick = close;
}

// --- Tab closing ---

async function closeMatchingTabs(patterns, label) {
  const tabs = await browser.tabs.query({ url: patterns });
  if (tabs.length === 0) {
    showModal(`No ${label} tabs to close.`, { showCancel: false });
    return;
  }
  const noun = tabs.length === 1 ? "tab" : "tabs";
  showModal(`Close ${tabs.length} ${label} ${noun}?`, {
    showCancel: true,
    onConfirm: () => browser.tabs.remove(tabs.map((t) => t.id)),
  });
}

// --- Rendering ---

function renderFlat(query) {
  const filtered = data.repos.filter((r) =>
    r.name.toLowerCase().includes(query) || r.full_name.toLowerCase().includes(query)
  );
  const sorted = sortRepos(filtered);

  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No results found.";
    treeEl.appendChild(empty);
    return;
  }

  for (const repo of sorted) {
    const repoRow = document.createElement("div");
    repoRow.className = "repo-item repo-item-flat";

    const repoName = document.createElement("span");
    repoName.className = "repo-name";
    repoName.textContent = repo.full_name;
    repoRow.appendChild(repoName);

    if (notifications.byRepo[repo.full_name]) {
      const dot = document.createElement("span");
      dot.className = "repo-unread-dot";
      repoRow.appendChild(dot);
    }

    repoRow.addEventListener("click", () => {
      browser.tabs.create({ url: `https://github.com/${repo.full_name}` });
      window.close();
    });

    treeEl.appendChild(repoRow);
  }
}

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

function renderTree() {
  const query = searchInput.value.toLowerCase();
  treeEl.replaceChildren();

  if (sortMode === "flat") {
    renderFlat(query);
    return;
  }

  const orgLogins = new Set(data.orgs.map((o) => o.login));

  // Group repos by owner
  const reposByOwner = {};
  const personalRepos = [];

  for (const repo of data.repos) {
    if (orgLogins.has(repo.owner)) {
      if (!reposByOwner[repo.owner]) reposByOwner[repo.owner] = [];
      reposByOwner[repo.owner].push(repo);
    } else {
      personalRepos.push(repo);
    }
  }

  let hasVisibleContent = false;

  // Sort orgs by most-recent repo when in recent mode
  const orgsToRender = sortMode === "recent"
    ? [...data.orgs].sort((a, b) => {
        const aRepos = reposByOwner[a.login] || [];
        const bRepos = reposByOwner[b.login] || [];
        const aHasMine = aRepos.some((r) => r.my_last_commit);
        const bHasMine = bRepos.some((r) => r.my_last_commit);
        if (aHasMine !== bHasMine) return aHasMine ? -1 : 1;
        const aMax = aRepos.reduce((t, r) => Math.max(t, recentScore(r).date), 0);
        const bMax = bRepos.reduce((t, r) => Math.max(t, recentScore(r).date), 0);
        return bMax - aMax;
      })
    : data.orgs;

  // Render each org as a collapsible section
  for (const org of orgsToRender) {
    const orgRepos = reposByOwner[org.login] || [];

    // Filter repos for this org
    const filteredRepos = orgRepos.filter((r) =>
      r.name.toLowerCase().includes(query) || r.full_name.toLowerCase().includes(query)
    );
    const orgMatchesQuery = org.login.toLowerCase().includes(query);

    // Skip org if neither it nor any of its repos match
    if (!orgMatchesQuery && filteredRepos.length === 0) continue;

    hasVisibleContent = true;
    const isExpanded = expandedOrgs.has(org.login);
    // Auto-expand when searching and repos match
    const showRepos = isExpanded || (query && filteredRepos.length > 0);

    // Org header row
    const header = document.createElement("div");
    header.className = "org-header" + (showRepos ? " expanded" : "");

    const toggle = document.createElement("span");
    toggle.className = "org-toggle";
    toggle.textContent = "\u25B6";
    header.appendChild(toggle);

    const avatar = document.createElement("img");
    avatar.className = "org-avatar";
    avatar.src = `${org.avatar}&s=36`;
    avatar.alt = "";
    header.appendChild(avatar);

    const name = document.createElement("span");
    name.className = "org-name";
    name.textContent = org.login;
    header.appendChild(name);

    const orgCount = orgUnreadCount(org.login);
    if (orgCount > 0) {
      const pill = document.createElement("span");
      pill.className = "org-unread-count";
      pill.textContent = String(orgCount);
      header.appendChild(pill);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "org-close";
    closeBtn.textContent = "\u2715";
    closeBtn.title = `Close ${org.login} tabs`;
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMatchingTabs(
        [`*://github.com/${org.login}`, `*://github.com/${org.login}/*`],
        org.login
      );
    });
    header.appendChild(closeBtn);

    const openBtn = document.createElement("button");
    openBtn.className = "org-open";
    openBtn.textContent = "\u2197";
    openBtn.title = `Open ${org.login} on GitHub`;
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      browser.tabs.create({ url: `https://github.com/${org.login}` });
      window.close();
    });
    header.appendChild(openBtn);

    header.addEventListener("click", () => {
      if (expandedOrgs.has(org.login)) {
        expandedOrgs.delete(org.login);
      } else {
        expandedOrgs.add(org.login);
      }
      renderTree();
    });

    treeEl.appendChild(header);

    // Repo list for this org
    const reposContainer = document.createElement("div");
    reposContainer.className = "org-repos" + (showRepos ? " visible" : "");

    const reposToShow = sortRepos(query ? filteredRepos : orgRepos);
    for (const repo of reposToShow) {
      const repoRow = document.createElement("div");
      repoRow.className = "repo-item";

      const repoName = document.createElement("span");
      repoName.className = "repo-name";
      repoName.textContent = repo.name;
      repoRow.appendChild(repoName);

      if (notifications.byRepo[repo.full_name]) {
        const dot = document.createElement("span");
        dot.className = "repo-unread-dot";
        repoRow.appendChild(dot);
      }

      repoRow.addEventListener("click", () => {
        browser.tabs.create({ url: `https://github.com/${repo.full_name}` });
        window.close();
      });

      reposContainer.appendChild(repoRow);
    }

    treeEl.appendChild(reposContainer);
  }

  // Personal repos section
  const filteredPersonal = personalRepos.filter((r) =>
    r.name.toLowerCase().includes(query) || r.full_name.toLowerCase().includes(query)
  );

  const sortedPersonal = sortRepos(filteredPersonal);

  if (sortedPersonal.length > 0) {
    hasVisibleContent = true;

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

    for (const repo of sortedPersonal) {
      const repoRow = document.createElement("div");
      repoRow.className = "repo-item";
      repoRow.style.paddingLeft = "12px";

      const repoName = document.createElement("span");
      repoName.className = "repo-name";
      repoName.textContent = repo.name;
      repoRow.appendChild(repoName);

      if (notifications.byRepo[repo.full_name]) {
        const dot = document.createElement("span");
        dot.className = "repo-unread-dot";
        repoRow.appendChild(dot);
      }

      repoRow.addEventListener("click", () => {
        browser.tabs.create({ url: `https://github.com/${repo.full_name}` });
        window.close();
      });

      treeEl.appendChild(repoRow);
    }
  }

  if (!hasVisibleContent) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No results found.";
    treeEl.appendChild(empty);
  }
}

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

function renderUpdatedTime(timestamp) {
  if (!timestamp) {
    updatedEl.textContent = "";
    return;
  }
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) {
    updatedEl.textContent = "Updated just now";
  } else {
    updatedEl.textContent = `Updated ${minutes}m ago`;
  }
}

// --- Main ---

async function loadData(forceRefresh) {
  const stored = await browser.storage.local.get([PAT_KEY, USER_KEY, SORT_KEY]);
  const token = stored[PAT_KEY];
  const username = stored[USER_KEY];
  if (stored[SORT_KEY]) {
    sortMode = stored[SORT_KEY];
    updateSortButton();
  }

  if (!token) {
    showView(setupView);
    return;
  }

  const cache = await loadCache();
  notifications = await loadNotificationsCache();

  if (cache) {
    data = cache;
    renderUpdatedTime(cache.timestamp);
    if (notificationsViewActive) {
      renderNotifications();
    } else {
      renderTree();
    }
    renderScopeWarning();
    showView(mainView);
  } else {
    showView(loadingView);
  }

  const existingRateLimit = mainView.querySelector(".warning.rate-limited");
  if (existingRateLimit) existingRateLimit.remove();

  const skipDataFetch = !forceRefresh && isFresh(cache);

  const [dataResult, notificationsResult] = await Promise.all([
    skipDataFetch
      ? Promise.resolve({ ok: true, freshData: null })
      : fetchData(token, username).then(
          (freshData) => ({ ok: true, freshData }),
          (err) => ({ ok: false, err })
        ),
    fetchNotifications(token).then(
      (summary) => ({ ok: true, summary }),
      (err) => ({ ok: false, err })
    ),
  ]);

  if (notificationsResult.ok) {
    notifications = { ...notificationsResult.summary, scopeMissing: false };
    await writeNotificationsCache(notificationsResult.summary, false);
    browser.browserAction.setBadgeText({
      text: notifications.total > 0 ? String(notifications.total) : "",
    });
  } else if (notificationsResult.err.message === "scope_missing") {
    notifications = { total: 0, byRepo: {}, items: [], scopeMissing: true };
    await writeNotificationsCache({ total: 0, byRepo: {}, items: [] }, true);
    browser.browserAction.setBadgeText({ text: "" });
  }

  if (dataResult.ok) {
    if (dataResult.freshData) {
      data = dataResult.freshData;
      await saveCache(data);
      renderUpdatedTime(Date.now());
    }
    if (notificationsViewActive) {
      renderNotifications();
    } else {
      renderTree();
    }
    renderScopeWarning();
    showView(mainView);
  } else {
    const errMsg = dataResult.err.message;
    if (errMsg === "auth_failed" || errMsg === "scope_missing") {
      showError("Token is invalid or missing required scopes.", true);
    } else if (errMsg === "rate_limited") {
      if (cache) {
        if (notificationsViewActive) {
          renderNotifications();
        } else {
          renderTree();
        }
        const warning = document.createElement("div");
        warning.className = "warning rate-limited";
        warning.textContent = "Rate limited \u2014 showing cached data.";
        mainView.insertBefore(warning, mainView.querySelector(".toolbar"));
        renderScopeWarning();
      } else {
        showError("Rate limited and no cached data available.", false);
      }
    } else if (!cache) {
      showError("Failed to fetch data from GitHub.", false);
    } else {
      if (notificationsViewActive) {
        renderNotifications();
      } else {
        renderTree();
      }
      renderScopeWarning();
    }
  }
}

// --- Event Listeners ---

searchInput.addEventListener("input", () => {
  if (!notificationsViewActive) renderTree();
});

sortToggleBtn.addEventListener("click", async () => {
  const idx = SORT_MODES.indexOf(sortMode);
  sortMode = SORT_MODES[(idx + 1) % SORT_MODES.length];
  await browser.storage.local.set({ [SORT_KEY]: sortMode });
  updateSortButton();
  if (!notificationsViewActive) renderTree();
});

refreshBtn.addEventListener("click", () => loadData(true));

closeAllTabsBtn.addEventListener("click", () => {
  closeMatchingTabs(
    ["*://github.com/*", "*://gist.github.com/*"],
    "GitHub"
  );
});

openNotificationsBtn.addEventListener("click", toggleNotificationsView);

openSettingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

errorSettingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

document.addEventListener("DOMContentLoaded", () => loadData(false));
