# pi-fast-mode

Toggle ChatGPT fast mode (`service_tier: "priority"`) in [pi](https://github.com/earendil-works/pi), with cost estimates for subscription usage.

Fast mode trades higher usage for speed. This extension sends `service_tier: "priority"` for supported models signed in with a ChatGPT subscription when enabled and corrects pi's displayed cost using an explicit billing basis: included subscription quota (default, 2.5×) or purchased credits / Enterprise pay-as-you-go (2×). The displayed dollar amount is a model-rate estimate, not a cash invoice or a measurement of remaining quota. Models without an established Fast rate are never tiered.

## Installation

```bash
pi install npm:@nijaru/pi-fast-mode
```

Restart pi. Development checks target Pi 1.4.0. Requires pi / `@earendil-works/pi-ai` >= 0.84.2 — that is when `openai-codex-responses` began forwarding `serviceTier` to the request. The `openai` ChatGPT subscription login requires Pi 1.4.0+. The legacy `openai-codex` login is also supported. API-key requests receive no subscription tier or usage multiplier.

Your pi catalog and account must expose the selected model; adding a model to this extension's defaults does not grant access or select it.

## Usage

```text
/fast                  toggle fast mode and remember it for new sessions
/fast on               enable now and for new sessions
/fast off              disable now and for new sessions
/fast status           show whether fast mode is on or off
```

Fast mode is off by default. The footer shows `⚡FAST` when enabled and available for the selected model; otherwise, the indicator is hidden. Toggles and `/fast status` show “Fast mode on.” or “Fast mode off.” Normal session startup is silent. Configuration errors and provider conflicts still explain what prevents fast mode from working.

Priority tiers and usage multipliers apply only to listed ChatGPT subscription models with an established Fast rate. Other providers are untouched.

## Supported models

The following models are supported through both `openai` (ChatGPT subscription login) and `openai-codex`:

- `gpt-6-astra`
- `gpt-6.1-sol`
- `gpt-6-sol`, `gpt-6-luna`
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`

For example, select `openai/gpt-6.1-sol` after signing in with ChatGPT, then run `/fast on`.

All current defaults have established Fast multipliers of 2.5× for included subscription limits and 2× for purchased credits / Enterprise PAYG ([Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Pricing](https://learn.chatgpt.com/docs/pricing), checked October 30, 2026). Availability depends on your account, client, rollout, and workspace permissions. The extension neither detects your plan nor switches billing basis when quota runs out. It supports Fast only, not Ultrafast.

GPT-5.5 retired from Codex with ChatGPT sign-in on October 14, 2026; GPT-5.4 retired on August 31. Neither is a default, even if an older pi catalog still lists it. Their established historical rates remain for explicit allowlisting on compatible endpoints: GPT-5.5 at 2.5× included quota / 2× credits, GPT-5.4 at 2× included quota. GPT-5.4 on the credits basis requires a verified `multipliers` override. API-key sessions are unaffected by these retirements, but ChatGPT credit multipliers do not describe API billing ([Models](https://learn.chatgpt.com/docs/models)).

Model selection per request: `(built-in defaults ∪ allowlist) − blocklist`; the model must also use an overlaid provider/API pair (`openai` with `openai-responses`, or `openai-codex` with `openai-codex-responses`) and have an established fast-mode rate — a built-in rate-card entry for the selected billing basis or a configured `multipliers` entry keyed `provider/model`. Fast mode fails closed: a listed model without an established rate gets no priority tier or usage multiplier, and `/fast status` shows the exact config entry to add. Allowlisting a model on a custom provider does not install an overlay for it. Edit `allowlist`/`blocklist` in the config to override the built-in defaults — add a custom `models.json` entry on a spec'd API, or block `gpt-6-astra` for cost reasons. Only those provider/API pairs are modified, even if other models are allowlisted. On `openai`, the request must use a ChatGPT access token at `https://api.openai.com/v1`; API keys, proxy endpoints, and conflicting authorization headers do not receive subscription tiers or pricing.

Other providers expose speed differently and are deliberately out of scope: Anthropic fast mode and Gemini priority inference are per-request tiers but need response-driven or rate-card pricing pi-ai does not surface yet (pi issue [#1381](https://github.com/earendil-works/pi/issues/1381)); OpenRouter and xAI ship speed as separate model variants (`:nitro`, Grok Fast), which need no extension.

## Configuration

Config resolves project-over-global and provides defaults for new sessions:

- global: `~/.pi/agent/extensions/pi-fast-mode.json` (honors `PI_CODING_AGENT_DIR`)
- project: `.pi/extensions/pi-fast-mode.json` (trusted projects only)

Untrusted project configuration is neither read nor written. The billing basis chooses estimate rates, not a different service tier, model, account plan, or Fast on/off state. If the chosen basis has no established rate, the request stays untiered.

Fast-mode state is recorded in each session's history, like model changes. `/fast`, `/fast on`, and `/fast off` update the current session and the `active` default for future new sessions. Resuming a session restores its own state, so an older session can remain independent of the latest default. Existing sessions without recorded state stay off and are given an explicit state when opened; only new or empty sessions inherit the current `active` default. The command writes to the project config when present, otherwise the global config. It refuses to overwrite malformed or unreadable configuration; a failed save reports an error without changing the session. With `persistState: false`, saved session state is ignored, but the current setting still updates the default for new sessions.

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

Fast mode uses Pi's stock Responses or Codex transport. Static model, authentication, endpoint, and header configuration is preserved. The new `openai` login stays on the public Responses API; it is never redirected to the legacy Codex backend. Native provider replacements, custom stream handlers, and dynamically refreshed legacy catalogs are left untouched, even when fast mode is enabled.

Pi sends both full and simple calls through the overlay's single handler. Ordinary API-key calls use Pi's stock simple-call defaults and context clamp; calls with explicit API-specific options use the stock full transport. An explicit reasoning effort is preserved. ChatGPT subscription requests omit the output-limit field, as required by that endpoint.

Pi 1.2 provider registration replaces stream owners rather than composing middleware. Fast mode cooperates with a `pi-provider-compaction` 0.0.6+ observer that explicitly marks transparent delegation to fast mode's own stock overlay. Other stream wrappers and provider replacements remain unsupported: fast mode adds no priority tier or fast-mode pricing, hides the footer indicator, and explains the conflict in `/fast status`. Disable the competing provider extension and reload to use `/fast`.

## How it works

- Installs stock stream handlers for `openai` and `openai-codex` only where no competing stream owner exists. Each provider is checked separately. While enabled, it adds `serviceTier` to eligible requests, preserving Pi's built-in models and authentication. While off, each handler forwards requests without adding a tier or changing pricing, so a cooperative compaction observer can still observe ordinary requests. Shutdown or SDK disposal releases that observer first if present, then removes only fast mode's own handler, preserving later configuration changes.
- Uses session custom entries to restore fast-mode state per session and updates the trusted project or global `active` default whenever `/fast` changes.
- pi-ai converts `options.serviceTier` into the `service_tier` request body field and applies its priority cost multiplier, so the request path is unchanged.
- Fast-mode estimates: on the stock stream's terminal events, the extension re-runs pi-ai's `calculateCost` (token counts × the dispatched `model.cost`, respecting input-length tiers), excludes Codex cache writes, and applies the established multiplier for the configured basis or per-model override. This replaces pi-ai's internal priority multiplier rather than stacking onto it. On public Responses, a reported `priority` or `fast` tier uses that estimate; another reported tier keeps Pi's stock pricing. When the server omits the tier, the requested tier is used as the estimate. Legacy Codex keeps Pi's existing interpretation: its `default` response label can still represent the requested Fast tier. Correction happens before downstream usage adjustments such as `message_end`; finalized session messages are never repriced. Time-of-day and other request-wide pricing adjustments are not owned here. Token counts are never modified.

## Security

Pi extensions run with your local user permissions. This extension reads and writes its config JSON files, persists session state through Pi's session API, and delegates LLM calls to Pi's built-in OpenAI transports; it makes no independent network requests.

## License

MIT