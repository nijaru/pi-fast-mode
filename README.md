# pi-fast-mode

Toggle OpenAI Codex fast mode (`service_tier: "priority"`) in [pi](https://github.com/earendil-works/pi) with correct footer cost accounting.

Fast mode trades higher usage for speed. This extension sends `service_tier: "priority"` for supported OpenAI Codex models when enabled and corrects pi's displayed cost using an explicit billing basis: included subscription quota (default, 2.5×) or purchased credits / Enterprise pay-as-you-go (2×). The displayed dollar amount is a model-rate estimate, not a cash invoice or a measurement of remaining quota. Models without an established Fast rate are never tiered.

## Installation

```bash
pi install npm:@nijaru/pi-fast-mode
```

Restart pi. Development checks target Pi 1.4.0. Requires pi / `@earendil-works/pi-ai` >= 0.84.2 — that is when `openai-codex-responses` began forwarding `serviceTier` to the request. Your pi catalog and account must expose the selected model; adding a model to this extension's defaults does not grant access or select it.

## Usage

```text
/fast                  toggle fast mode and remember it for new sessions
/fast on               enable now and for new sessions
/fast off              disable now and for new sessions
/fast status           show current state and the active model
```

Fast mode is off by default. When enabled, supported, and installed without a provider conflict, the footer shows `⚡ FAST · quota 2.5×` or `⚡ FAST · credits 2×`. A per-model override shows `⚡ FAST · override 3×`; `/fast status` names its configured basis and source. Requests only change for listed OpenAI Codex models with an established Fast rate; all other models and providers are untouched.

## Supported models

- `openai-codex/gpt-6-astra`
- `openai-codex/gpt-6.1-sol`
- `openai-codex/gpt-6-sol`, `gpt-6-luna`
- `openai-codex/gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`

All current defaults have established Fast multipliers of 2.5× for included subscription limits and 2× for purchased credits / Enterprise PAYG ([Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Pricing](https://learn.chatgpt.com/docs/pricing), checked October 23, 2026). Availability depends on your account, client, rollout, and workspace permissions. The extension neither detects your plan nor switches billing basis when quota runs out. It supports Fast only, not Ultrafast.

GPT-5.5 retired from Codex with ChatGPT sign-in on October 14, 2026; GPT-5.4 retired on August 31. Neither is a default, even if an older pi catalog still lists it. Their established historical rates remain for explicit allowlisting on compatible endpoints: GPT-5.5 at 2.5× included quota / 2× credits, GPT-5.4 at 2× included quota. GPT-5.4 on the credits basis requires a verified `multipliers` override. API-key sessions are unaffected by these retirements, but ChatGPT credit multipliers do not describe API billing ([Models](https://learn.chatgpt.com/docs/models)).

Model selection per request: `(built-in defaults ∪ allowlist) − blocklist`; the model must also use an overlaid provider/API pair (currently `openai-codex` with `openai-codex-responses` only) and have an established fast-mode rate — a built-in rate-card entry for the selected billing basis or a configured `multipliers` entry keyed `provider/model`. Fast mode fails closed: a listed model without an established rate is not tiered, its request is sent unchanged, and `/fast status` shows the exact config entry to add. Allowlisting a model on a custom provider does not install an overlay for it. Edit `allowlist`/`blocklist` in the config to override the built-in defaults — add a custom `models.json` entry on a spec'd API, or block `gpt-6-astra` for cost reasons. Only spec'd APIs are ever touched, so other APIs are never modified even if allowlisted.

Other providers expose speed differently and are deliberately out of scope: Anthropic fast mode and Gemini priority inference are per-request tiers but need response-driven or rate-card pricing pi-ai does not surface yet (pi issue [#1381](https://github.com/earendil-works/pi/issues/1381)); OpenRouter and xAI ship speed as separate model variants (`:nitro`, Grok Fast), which need no extension.

## Configuration

Config resolves project-over-global and provides defaults for new sessions:

- global: `~/.pi/agent/extensions/pi-fast-mode.json` (honors `PI_CODING_AGENT_DIR`)
- project: `.pi/extensions/pi-fast-mode.json` (trusted projects only)

Untrusted project configuration is neither read nor written. The billing basis chooses estimate rates, not a different service tier, model, account plan, or Fast on/off state. If the chosen basis has no established rate, the request stays untiered.

Fast-mode state is recorded in each session's history, like model changes. `/fast`, `/fast on`, and `/fast off` update the current session and the `active` default for future new sessions. Resuming a session restores its own state, so an older session can remain independent of the latest default. Existing sessions without recorded state stay off and are given an explicit state when opened; only new or empty sessions inherit the current `active` default. The command writes to the project config when present, otherwise the global config. With `persistState: false`, saved session state is ignored, but the current setting still updates the default for new sessions.

```json
{
  "persistState": true,
  "active": false,
  "serviceTier": "priority",
  "billingBasis": "included-quota",
  "allowlist": [],
  "blocklist": [],
  "multipliers": {}
}
```

`billingBasis` accepts `"included-quota"` (default, preserving previous 2.5× estimates) or `"credits"` (purchased credits and Enterprise PAYG, 2×). Project configuration overrides global configuration per key; invalid basis values are ignored. Choose the basis explicitly to match the usage you want to estimate. The extension does not convert catalog dollars into credit units, infer quota consumption from API prices, or reconcile invoices.

`multipliers` maps `provider/model` keys to finite, positive Fast multipliers. A configured value replaces the built-in multiplier for either basis; it is not multiplied by 2 or 2.5. For example, `"openai-codex/gpt-6-luna": 3` uses 3× on either basis. Use overrides for verified custom rates or allowlisted models without a built-in rate. A rate alone does not enable a model: non-default models also need `allowlist`. The project map replaces the global map.

OpenAI renamed priority processing to Fast mode on July 30, 2026 and also accepts `service_tier: "fast"` on the wire. This extension keeps `serviceTier: "priority"` as its only accepted value — `"fast"` is not in the spec's supported tiers and would silently disable tiering if accepted.

## Provider compatibility

Fast mode uses Pi's stock Codex transport. Static model, authentication, endpoint, and header configuration is preserved. Native provider replacements, custom stream handlers, and dynamically refreshed legacy catalogs are left untouched, even when fast mode is enabled.

Pi 1.2 provider registration replaces stream owners rather than composing middleware. Fast mode cooperates with a `pi-provider-compaction` 0.0.6+ observer that explicitly marks transparent delegation to fast mode's own stock overlay. Other stream wrappers and provider replacements remain unsupported: fast mode adds no priority tier or fast-mode pricing, hides the footer indicator, and explains the conflict in `/fast status`. Disable the competing provider extension and reload to use `/fast`.

## How it works

- Installs a stock Codex stream handler only when no competing stream owner exists. While enabled, it adds `serviceTier` to eligible requests, preserving Pi's built-in Codex models and authentication. While off, the handler forwards requests without adding a tier or changing pricing, so a cooperative compaction observer can still observe ordinary requests. Shutdown or SDK disposal releases that observer first if present, then removes only fast mode's own handler, preserving later configuration changes.
- Uses session custom entries to restore fast-mode state per session and updates the trusted project or global `active` default whenever `/fast` changes.
- pi-ai converts `options.serviceTier` into the `service_tier` request body field and applies its priority cost multiplier, so the request path is unchanged.
- Fast-mode estimates: on the stock stream's terminal events, the extension re-runs pi-ai's `calculateCost` (token counts × the dispatched `model.cost`, respecting input-length tiers), excludes Codex cache writes, and applies the established multiplier for the configured basis or per-model override. This replaces pi-ai's internal priority multiplier rather than stacking onto it. Correction happens before downstream usage adjustments such as `message_end`; finalized session messages are never repriced. Time-of-day and other request-wide pricing adjustments are not owned here. Token counts are never modified.

## Security

Pi extensions run with your local user permissions. This extension reads and writes its config JSON files, persists session state through Pi's session API, and delegates LLM calls to pi's built-in OpenAI Codex provider; it makes no independent network requests.

## License

MIT