"use strict";

const CACHE_KEY = "github_navigator_cache";
const PAT_KEY = "github_navigator_pat";
const CACHE_TTL_MS = 5 * 60 * 1000;
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
const openSettingsBtn = document.getElementById("open-settings");
const errorSettingsBtn = document.getElementById("error-settings");

let data = { orgs: [], repos: [] };
let expandedOrgs = new Set();

// --- Views ---

function showView(view) {
  [setupView, mainView, errorView, loadingView].forEach((v) => {
    v.hidden = v !== view;
  });
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

async function fetchData(token) {
  const [orgs, repos] = await Promise.all([
    fetchAllOrgs(token),
    fetchAllRepos(token),
  ]);

  return {
    orgs: orgs
      .map((o) => ({ login: o.login, avatar: o.avatar_url }))
      .sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: "base" })),
    repos: repos
      .map((r) => ({ full_name: r.full_name, owner: r.owner.login, name: r.name }))
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

// --- Rendering ---

function renderTree() {
  const query = searchInput.value.toLowerCase();
  treeEl.innerHTML = "";

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

  // Render each org as a collapsible section
  for (const org of data.orgs) {
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

    const reposToShow = query ? filteredRepos : orgRepos;
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

  if (filteredPersonal.length > 0) {
    hasVisibleContent = true;

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Personal repos";
    treeEl.appendChild(label);

    for (const repo of filteredPersonal) {
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
  const { [PAT_KEY]: token } = await browser.storage.local.get(PAT_KEY);

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
    data = await fetchData(token);
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
        mainView.insertBefore(warning, searchInput);
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

refreshBtn.addEventListener("click", () => loadData(true));

openSettingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

errorSettingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

document.addEventListener("DOMContentLoaded", () => loadData(false));
