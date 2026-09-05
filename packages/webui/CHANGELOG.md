# Changelog

## [Unreleased]

### Added

- Multi-user web interface for the durable Pi agent harness: an in-process
  per-user `ServerHost` with JSONL session repositories, a WebSocket listener
  with bearer-token authentication, server-scoped `SessionDirectory` /
  `SessionManagement` services, and session-scoped `AgentController` /
  `Transcript` services over a `main` lane plus lazily created sub-agent
  lanes.
- Browser client (native TypeScript + DOM, bundled with esbuild) with login /
  registration, session list, chat, abort/resume, and sub-lane management.