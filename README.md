# pi-fast-mode

Toggle OpenAI Codex fast mode (`service_tier: "priority"`) in [pi](https://github.com/earendil-works/pi) with correct footer cost accounting.

Fast mode serves the same GPT-5.6 / GPT-5.5 / GPT-5.4 models at roughly 1.5x speed for a credit multiplier. This extension injects `service_tier: "priority"` into supported OpenAI Codex requests when enabled, and prices the displayed footer cost independently of pi's internals: on each terminal turn it recomputes cost from raw tokens × model rates × the official rate-card multiplier (2.5x for GPT-5.6/5.5, 2x for GPT-5.4).

## Installation

```bash
pi install git:github.com/nijaru/pi-fast-mode
```

Restart pi. Requires pi / `@earendil-works/pi-ai` >= 0.84.

## Usage

```text
/fast          toggle fast mode on/off
/fast on       enable
/fast off      disable
/fast status   show current state and the active model
```

Start with fast mode enabled:

```bash
pi --fast
```

When enabled and the active model is supported, a footer status shows `FAST <model> 2.5x`. Requests only change for the allowlisted OpenAI Codex models; all other models and providers are untouched.

## Supported models

- `openai-codex/gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.4`

Credit multipliers (rate card): 2.5x for GPT-5.6 and GPT-5.5, 2x for GPT-5.4.

Model selection per request: `(built-in defaults ∪ allowlist) − blocklist`; the model's API must also be spec'd (currently `openai-codex-responses` only). Edit `allowlist`/`blocklist` in the config to override the built-in defaults — add a custom `models.json` entry on a spec'd API, or block `gpt-5.5` for cost reasons. `service_tier` only exists on OpenAI Responses-style APIs, so other APIs are never touched even if allowlisted.

## Configuration

Config resolves project-over-global, is created on first use, and persists `active` state across sessions:

- global: `~/.pi/agent/extensions/pi-fast-mode.json`
- project: `.pi/extensions/pi-fast-mode.json`

```json
{
  "persistState": true,
  "active": true,
  "serviceTier": "priority",
  "allowlist": [],
  "blocklist": []
}
```

## Adding another provider/API

Fast mode is applied through `ApiTierSpec` entries in `extensions/index.ts`. Each spec declares the API name, the tiers that API accepts, a default model allowlist, and the raw pi-ai stream call. Commands, config, pricing, and the footer status are spec-driven, so adding an API is one spec plus one `registerProvider` loop iteration — no structural refactor.

## How it works

- Registers an API-layer stream override (`pi-fast-mode:openai-codex-responses`) that adds `serviceTier` to request options on allowlisted models, then delegates to pi-ai's built-in `openai-codex-responses` stream.
- pi-ai converts `options.serviceTier` into the `service_tier` request body field and applies its priority cost multiplier, so the request path is unchanged.
- Fast-mode cost accounting: on terminal stream events the extension re-runs pi-ai's `calculateCost` (token counts × `model.cost`, tier-aware) and applies the official rate-card multiplier on top. This is independent of pi-ai's internal multiplier table, so it stays correct if pi-ai changes its internals. Token counts are real and never modified.

## Security

Pi extensions run with your local user permissions. This extension only reads/writes its config JSON files and delegates LLM calls to pi's built-in OpenAI Codex provider; it makes no independent network requests.

## License

MIT