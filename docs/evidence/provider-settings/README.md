# Provider settings evidence

Requirements: P06, P07.

Captured from the packaged macOS `.app` with `screencapture -l` (window only).

- `empty-settings.png`: initial settings with no endpoints.
- `configured-endpoints.png`: local and hosted endpoints with `Not tried` status.
- `key-set-after-restart.png`, `key-missing-after-delete.png`: write-only key status before and after app restart and deletion. `key-missing.png` also shows a separate unset key reference.
- `validation-error.png`: invalid base URL is blocked with a field message.
- `offline-mode.png`: hosted endpoint is named as dropped while offline.
- `role-fallback-inherited-1280x720.png`, `role-fallback-explicit-1280x720.png`, and `role-fallback-empty-1280x720.png`: the inherited, explicit-list, and explicit-empty states with a configured local endpoint.
- `role-fallback-inherited-1024x768.png` and `role-fallback-inherited-880x768.png`: the same row at the narrower window sizes. The toggle now sits under the fallback field in the three-column row, and beside it at the two-column breakpoint.

The real Keychain check used a dummy value and a test-only key reference: set returned `set`; after quitting and reopening the packaged app, status remained `set`; delete returned `missing`. No Keychain prompt appeared. No real credential was used, and the dummy entry was deleted.

The browser bundle was scanned for `@ai-sdk/openai-compatible`, `ai-sdk/openai`, `createOpenAICompatible`, `AI SDK`, and `api.openai.com`; none appeared in the generated client JavaScript.
