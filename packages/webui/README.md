# Pi WebUI

Multi-user web interface for the durable Pi agent harness.

## Architecture

The webui is an in-process analogue of the coding-agent experimental runtime:

- One pi-server `Server` with a custom WebSocket `ServerListener` accepts
  browser connections. Every connection authenticates with a bearer token
  (`?token=...`, resolved against the account store during the HTTP upgrade).
- A per-user `ServerHost` owns one JSONL session repository (isolated per
  account) and answers the server-scoped services `SessionDirectory` /
  `SessionManagement`.
- Each opened session runs an in-process `AgentHarness` with a `main` lane
  plus lazily created sub-agent lanes, exposed as the session-scoped services
  `AgentController` / `Transcript`.

The browser client is bundled with esbuild into `static/app.js` and uses
`pi-client` + chord service bindings; no Node.js is required at runtime in the
browser.

## Running

```bash
npm install --ignore-scripts
npm run build                      # typecheck server + bundle client

node dist/server/main.js \
  --port 3000 --hostname 0.0.0.0 \
  --create-user --username admin --password secret
```

Open `http://<host>:3000`, log in (or register), then create a session and
chat with the agent. Sub-agent lanes can be created by name from the session
view.

Environment: `PI_WEBUI_PORT`, `PI_WEBUI_HOST`, `PI_WEBUI_DATA` (default
`~/.pi/webui`). Provider credentials (e.g. `OPENAI_API_KEY`) make the builtin
catalog available; without them, add a provider in Settings instead.

## Providers and models

Settings (gear icon in the sidebar) manages this account's providers. A
provider is one OpenAI-compatible endpoint: a name, base URL, API key, and a
list of models with optional context window, max output tokens, image input,
and reasoning flags. Entries are stored per user in
`<PI_WEBUI_DATA>/sessions/<user>/providers.json` and layer on top of the
builtin catalog, so env-configured builtins keep working.

The add-provider form has a `Fetch models` button that reads
`GET {baseUrl}/models` and adds any ids not already listed, so most
OpenAI-compatible endpoints need no manual model entry. `Test` on a saved
provider reports reachability and returns the same list.

Model selection lives in the chat header and applies to the attached session;
new sessions seed from the first available model. Builtins appear read-only
while their credentials are configured.

## Development

```bash
npm run typecheck                  # tsgo over server + shared + tests, and the browser client
npm test                           # vitest (accounts, host protocol round-trip, providers)
node scripts/build-browser.mjs     # re-bundle the browser client
```