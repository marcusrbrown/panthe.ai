# Provider settings evidence

Requirements: P06, P07.

Captured from the packaged macOS `.app` with `screencapture -l` (window only).

- `empty-settings.png`: initial settings with no endpoints.
- `configured-endpoints.png`: local and hosted endpoints with `Not tried` status.
- `key-set-after-restart.png`, `key-missing-after-delete.png`: write-only key status before and after app restart and deletion. `key-missing.png` also shows a separate unset key reference.
- `validation-error.png`: invalid base URL is blocked with a field message.
- `offline-mode.png`: hosted endpoint is named as dropped while offline.

The real Keychain check used a dummy value and a test-only key reference: set returned `set`; after quitting and reopening the packaged app, status remained `set`; delete returned `missing`. No Keychain prompt appeared. No real credential was used, and the dummy entry was deleted.

The browser bundle was scanned for `@ai-sdk/openai-compatible`, `ai-sdk/openai`, `createOpenAICompatible`, `AI SDK`, and `api.openai.com`; none appeared in the generated client JavaScript.
