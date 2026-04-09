# GitHub Navigator

A Firefox extension for quick access to your GitHub organizations and repositories.

## Features

- Browse your GitHub orgs and repos from a toolbar popup
- Search/filter across orgs and repos
- Two-tab UI: Orgs and Repos
- Cached for speed (5-minute TTL)
- Click to open in a new tab

## Setup

1. Install the extension in Firefox (load from `src/` as a temporary add-on, or install the built `.xpi`)
2. Click the toolbar icon and follow the prompt to add your GitHub Personal Access Token
3. Your token needs these scopes: `read:org`, `repo`

## Development

```sh
# Lint
flox activate -c 'npx web-ext lint --source-dir src'

# Run in Firefox with hot reload
flox activate -c 'npx web-ext run --source-dir src --target firefox-desktop'

# Build
flox activate -c 'npx web-ext build --source-dir src --artifacts-dir dist'
```
