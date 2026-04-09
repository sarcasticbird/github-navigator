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
const listEl = document.getElementById("list");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");
const openSettingsBtn = document.getElementById("open-settings");
const errorSettingsBtn = document.getElementById("error-settings");
const tabs = document.querySelectorAll(".tab");

let activeTab = "orgs";
let data = { orgs: [], repos: [] };

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

async function fetchData(token) {
  const [orgs, repos] = await Promise.all([
    apiFetch("/user/orgs?per_page=100", token),
    fetchAllRepos(token),
  ]);

  return {
    orgs: orgs.map((o) => ({
      login: o.login,
      avatar: o.avatar_url,
    })),
    repos: repos.map((r) => ({
      full_name: r.full_name,
      owner: r.owner.login,
      name: r.name,
    })),
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

function renderList() {
  const query = searchInput.value.toLowerCase();
  listEl.innerHTML = "";

  const items = activeTab === "orgs" ? data.orgs : data.repos;
  const filtered = items.filter((item) => {
    const text = activeTab === "orgs" ? item.login : item.full_name;
    return text.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `No ${activeTab} found.`;
    listEl.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const row = document.createElement("div");
    row.className = "list-item";

    if (activeTab === "orgs") {
      const img = document.createElement("img");
      img.src = `${item.avatar}&s=40`;
      img.alt = item.login;
      const span = document.createElement("span");
      span.textContent = item.login;
      row.appendChild(img);
      row.appendChild(span);
      row.addEventListener("click", () => {
        browser.tabs.create({ url: `https://github.com/${item.login}` });
        window.close();
      });
    } else {
      const ownerSpan = document.createElement("span");
      ownerSpan.className = "repo-owner";
      ownerSpan.textContent = `${item.owner}/`;
      const nameSpan = document.createElement("span");
      nameSpan.className = "repo-name";
      nameSpan.textContent = item.name;
      row.appendChild(ownerSpan);
      row.appendChild(nameSpan);
      row.addEventListener("click", () => {
        browser.tabs.create({ url: `https://github.com/${item.full_name}` });
        window.close();
      });
    }

    listEl.appendChild(row);
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
    renderList();
    showView(mainView);
    return;
  }

  // Show stale cache while fetching
  if (cache) {
    data = cache;
    renderUpdatedTime(cache.timestamp);
    renderList();
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
    renderList();
    showView(mainView);
  } catch (err) {
    if (err.message === "auth_failed") {
      showError("Token is invalid or expired.", true);
    } else if (err.message === "rate_limited") {
      if (cache) {
        // Already showing stale cache — just add a warning
        const warning = document.createElement("div");
        warning.className = "warning";
        warning.textContent = "Rate limited — showing cached data.";
        mainView.insertBefore(warning, searchInput);
      } else {
        showError("Rate limited and no cached data available.", false);
      }
    } else {
      if (!cache) {
        showError("Failed to fetch data from GitHub.", false);
      }
      // If we have cache, it's already displayed — silently use stale data
    }
  }
}

// --- Event Listeners ---

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.tab;
    renderList();
  });
});

searchInput.addEventListener("input", renderList);

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
