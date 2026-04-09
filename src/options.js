"use strict";

const patInput = document.getElementById("pat");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");

async function loadToken() {
  const { github_navigator_pat: token } = await browser.storage.local.get("github_navigator_pat");
  if (token) {
    patInput.value = token;
  }
}

async function saveToken() {
  const token = patInput.value.trim();
  if (!token) {
    statusEl.textContent = "Token cannot be empty.";
    statusEl.className = "status error";
    return;
  }

  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}` },
    });

    if (!response.ok) {
      statusEl.textContent = `Invalid token (HTTP ${response.status}).`;
      statusEl.className = "status error";
      return;
    }

    await browser.storage.local.set({ github_navigator_pat: token });
    await browser.storage.local.remove("github_navigator_cache");
    statusEl.textContent = "Token saved.";
    statusEl.className = "status success";
  } catch (err) {
    statusEl.textContent = "Network error — could not validate token.";
    statusEl.className = "status error";
  }
}

saveButton.addEventListener("click", saveToken);
document.addEventListener("DOMContentLoaded", loadToken);
