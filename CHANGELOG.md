# Changelog

## 0.3.1
- Add resilience layer (rate limiting, retries, timeouts) and batch search + health checks.
- Fix GenAI request config wiring for `maxOutputTokens` / `responseMimeType`.
- Improve token presets and allow larger `max_tokens` overrides.

## 0.3.2
- Fix CI build by adding Node.js type definitions.

## 0.3.3
- Fix npm Trusted Publishing by using npm >= 11.5.1 in CI.

## 0.3.0
- Add verbosity presets and optional source metadata in responses.
- Default model updated to `gemini-3-flash-preview`.
