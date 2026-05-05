# GitHub Navigator

A Firefox/Zen Browser extension for quick access to your GitHub organizations and repositories. Built for [Zen Browser](https://zen-browser.app/), compatible with any Firefox-based browser.

## Features

- Browse your GitHub orgs and repos from a toolbar popup
- Search/filter across all orgs and repos
- Three view modes: alphabetical tree, recent-by-my-commits tree, and flat recent list
- Collapsible tree view: orgs expand to show their repos
- Hybrid sort: repos you've committed to recently float to the top
- Cached for speed (5-minute TTL with stale-while-revalidate)
- Click any repo to open in a new tab

## Setup

1. Install the extension in Firefox or Zen Browser (load from `src/` as a temporary add-on, or install the built `.xpi`)
2. Click the toolbar icon and follow the prompt to add your GitHub Personal Access Token
3. Your token needs these scopes: `read:org`, `repo` (must be a **classic** token — fine-grained tokens don't support the org membership API)

## Development

Node 22 is pinned via the Flox environment; `web-ext` is pinned in `package.json`.

```sh
flox activate -c 'npm install'   # first time only, rebuilds node_modules

flox activate -c 'npm run lint'
flox activate -c 'npm run start' # run in Firefox with hot reload
flox activate -c 'npm run build' # produces .xpi in dist/
```
