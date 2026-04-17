"use strict";

const CACHE_KEY = "github_navigator_cache";
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
const modalEl = document.getElementById("modal");
const modalMessageEl = document.getElementById("modal-message");
const modalOkBtn = document.getElementById("modal-ok");
const modalCancelBtn = document.getElementById("modal-cancel");

const SORT_KEY = "github_navigator_sort";

let data = { orgs: [], repos: [] };
let expandedOrgs = new Set();
let sortMode = "alpha";

// --- Views ---

function showView(view) {
  [setupView, mainView, errorView, loadingView].forEach((v) => {
    v.hidden = v !== view;
  });
  if (view === mainView) {
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
  });

  if (response.status === 401 || response.status === 403) {
    const isRateLimit = response.headers.get("x-ratelimit-remaining") === "0";
    if (isRateLimit) {
      throw new Error("rate_limited");
    }
    throw new Error("auth_failed");
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

async function saveCache(newData) {
  await browser.storage.local.set({
    [CACHE_KEY]: { ...newData, timestamp: Date.now() },
  });
}

function isFresh(cache) {
  return cache && Date.now() - cache.timestamp < CACHE_TTL_MS;
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

    repoRow.addEventListener("click", () => {
      browser.tabs.create({ url: `https://github.com/${repo.full_name}` });
      window.close();
    });

    treeEl.appendChild(repoRow);
  }
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
    treeEl.appendChild(label);

    for (const repo of sortedPersonal) {
      const repoRow = document.createElement("div");
      repoRow.className = "repo-item";
      repoRow.style.paddingLeft = "12px";

      const repoName = document.createElement("span");
      repoName.className = "repo-name";
      repoName.textContent = repo.name;
      repoRow.appendChild(repoName);

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

  if (!forceRefresh && isFresh(cache)) {
    data = cache;
    renderUpdatedTime(cache.timestamp);
    renderTree();
    showView(mainView);
    return;
  }

  // Show stale cache while fetching
  if (cache) {
    data = cache;
    renderUpdatedTime(cache.timestamp);
    renderTree();
    showView(mainView);
  } else {
    showView(loadingView);
  }

  const existingWarning = mainView.querySelector(".warning");
  if (existingWarning) existingWarning.remove();

  try {
    data = await fetchData(token, username);
    await saveCache(data);
    renderUpdatedTime(Date.now());
    renderTree();
    showView(mainView);
  } catch (err) {
    if (err.message === "auth_failed") {
      showError("Token is invalid or expired.", true);
    } else if (err.message === "rate_limited") {
      if (cache) {
        const warning = document.createElement("div");
        warning.className = "warning";
        warning.textContent = "Rate limited \u2014 showing cached data.";
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
}

// --- Event Listeners ---

searchInput.addEventListener("input", renderTree);

sortToggleBtn.addEventListener("click", async () => {
  const idx = SORT_MODES.indexOf(sortMode);
  sortMode = SORT_MODES[(idx + 1) % SORT_MODES.length];
  await browser.storage.local.set({ [SORT_KEY]: sortMode });
  updateSortButton();
  renderTree();
});

refreshBtn.addEventListener("click", () => loadData(true));

closeAllTabsBtn.addEventListener("click", () => {
  closeMatchingTabs(
    ["*://github.com/*", "*://gist.github.com/*"],
    "GitHub"
  );
});

openSettingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

errorSettingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

document.addEventListener("DOMContentLoaded", () => loadData(false));
