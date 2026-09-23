# Changelog

## 0.2.0

- Add a one-command example that manages a local server/password and tests both decision adapters with real inference; initialize the container cache directory with the service user's ownership for persistent volumes.

- Second audit: bounded HTTP handlers, disconnect/header handling, checkpoint identity validation and 15 new scenarios.

- Harden service framing, JSON and output limits, error attribution and routing; add 20 service/backend scenarios and two Node-to-Python end-to-end tests.

- Initial optional package: Laya provider for self-hosted typed decision inference, with a persistent Python reference service.
- Typed decision protocol with runtime validation and structured failure handling.
- Offline tests, agent recipes, and a documented live test environment.
- Core runtime integration is intentionally deferred.
