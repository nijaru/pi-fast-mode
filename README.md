# pi-fast-mode

Toggle OpenAI Codex fast mode (`service_tier: "priority"`) in [pi](https://github.com/earendil-works/pi) with correct footer cost accounting.

Fast mode runs currently supported Codex models at increased speed for a higher credit rate: 2.5x for GPT-6 Astra, GPT-6.1 Sol, GPT-5.6, and GPT-5.5. OpenAI documents a 1.5x speed increase for the GPT-5.6/5.5 families; the 6.x family's speedup is not separately published. This extension injects `service_tier: "priority"` into supported OpenAI Codex requests when enabled, and prices the displayed footer cost independently of pi's internals: on each terminal turn it recomputes cost from raw tokens × model rates × the model's established fast-mode multiplier. A multiplier is never guessed — a model without a verified rate-card entry or an explicit `multipliers` config entry is not tiered at all.

## Installation

```bash
pi install npm:@nijaru/pi-fast-mode
```

Restart pi. Development checks target Pi 1.2.0. Requires pi / `@earendil-works/pi-ai` >= 0.84.2 — that is when `openai-codex-responses` began forwarding `serviceTier` to the request. GPT-6 Astra needs a newer pi-ai (0.85.1 ships it in the Codex catalog), and GPT-6.1 Sol needs one that ships it (pi-ai 1.2.0 does); on older runtimes such models simply never match the defaults.

## Usage

```text
/fast                  toggle fast mode and remember it for new sessions
/fast on               enable now and for new sessions
/fast off              disable now and for new sessions
/fast status           show current state and the active model
```

When enabled, supported, and installed without a provider conflict, a compact footer status shows `⚡ FAST · $ 2.5×`; the active model is already shown elsewhere in the footer. Requests only change for listed OpenAI Codex models with an established fast-mode rate; all other models and providers are untouched.

## Supported models

- `openai-codex/gpt-6-astra`
- `openai-codex/gpt-6.1-sol`
- `openai-codex/gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- `openai-codex/gpt-5.5`

Credit multipliers (rate card): 2.5x for GPT-6 Astra, GPT-6.1 Sol, GPT-5.6, and GPT-5.5. OpenAI bills Fast mode at 2.5x the Standard rate against included subscription limits, and 2x the Standard rate for purchased credits and Enterprise pay-as-you-go ([Speed](https://developers.openai.com/codex/speed), [rate card](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing), checked October 2026). This extension prices at the 2.5x rate; if your workspace bills through purchased credits or PAYG, override the affected models in `multipliers`. GPT-6.1 Sol is rolling out to Plus, Pro, Business, Enterprise, and Edu in Codex, is off by default for Enterprise/Edu until an administrator enables it, and is not on Free/Go — so it can be absent from a given account's model picker.

OpenAI retired `gpt-5.4` and `gpt-5.4-mini` from Codex (ChatGPT sign-in) on August 31, 2026, so `gpt-5.4` is no longer a built-in default. Its historical 2x multiplier remains available for an explicit custom allowlist if a compatible endpoint still serves it. GPT-5.5 retires from ChatGPT, ChatGPT Work, and Codex on all plans on October 14, 2026 (the OpenAI API is unaffected); it stays a built-in default while pi's Codex catalog serves it.

Model selection per request: `(built-in defaults ∪ allowlist) − blocklist`; the model must also use an overlaid provider/API pair (currently `openai-codex` with `openai-codex-responses` only) and have an established fast-mode rate — a built-in rate-card entry or a configured `multipliers` entry keyed `provider/model`. Fast mode fails closed: a listed model without an established rate is not tiered, its request is sent unchanged, and `/fast status` shows the exact config entry to add. Allowlisting a model on a custom provider does not install an overlay for it. Edit `allowlist`/`blocklist` in the config to override the built-in defaults — add a custom `models.json` entry on a spec'd API, or block `gpt-5.5` for cost reasons. Only spec'd APIs are ever touched, so other APIs are never modified even if allowlisted.

Other providers expose speed differently and are deliberately out of scope: Anthropic fast mode and Gemini priority inference are per-request tiers but need response-driven or rate-card pricing pi-ai does not surface yet (pi issue [#1381](https://github.com/earendil-works/pi/issues/1381)); OpenRouter and xAI ship speed as separate model variants (`:nitro`, Grok Fast), which need no extension.

## Configuration

Config resolves project-over-global and provides defaults for new sessions:

- global: `~/.pi/agent/extensions/pi-fast-mode.json`
- project: `.pi/extensions/pi-fast-mode.json`

Fast-mode state is recorded in each session's history, like model changes. `/fast`, `/fast on`, and `/fast off` update the current session and the `active` default for future new sessions. Resuming a session restores its own state, so an older session can remain independent of the latest default. Existing sessions without recorded state stay off and are given an explicit state when opened; only new or empty sessions inherit the current `active` default. The command writes to the project config when present, otherwise the global config. With `persistState: false`, saved session state is ignored, but the current setting still updates the default for new sessions.

```json
{
  "persistState": true,
  "active": true,
  "serviceTier": "priority",
  "allowlist": [],
  "blocklist": [],
  "multipliers": {}
}
```

`multipliers` maps `provider/model` keys to the fast-mode multiplier used for footer cost accounting. Entries must be finite and positive; anything else is dropped. Use it to price allowlisted models the built-in rate card does not cover — the entry alone does not enable a model, so keep the model in `allowlist` too — or to override a built-in rate for your billing basis, e.g. `"openai-codex/gpt-6-astra": 2` on purchased credits. Configured entries override the built-in rate card, and like the other keys the project map replaces the global map.

OpenAI renamed priority processing to Fast mode on July 30, 2026 and also accepts `service_tier: "fast"` on the wire. This extension keeps `serviceTier: "priority"` as its only accepted value — `"fast"` is not in the spec's supported tiers and would silently disable tiering if accepted.

## Provider compatibility

Fast mode uses Pi's stock Codex transport. Static model, authentication, endpoint, and header configuration is preserved. Native provider replacements, custom stream handlers, and dynamically refreshed legacy catalogs are left untouched, even when fast mode is enabled.

Pi 1.2 provider registration replaces stream owners rather than composing middleware. Fast mode cooperates with a `pi-provider-compaction` observer that explicitly marks transparent delegation to fast mode's own stock overlay. Other stream wrappers and provider replacements remain unsupported: fast mode adds no priority tier or fast-mode pricing, hides the footer indicator, and explains the conflict in `/fast status`. Disable the competing provider extension and reload to use `/fast`.

## How it works

- Installs a stock Codex stream handler only when no competing stream owner exists. While enabled, it adds `serviceTier` to eligible requests, preserving Pi's built-in Codex models and authentication. While off, the handler forwards requests without adding a tier or changing pricing, so a cooperative compaction observer can still observe ordinary requests. Shutdown or SDK disposal releases that observer first if present, then removes only fast mode's own handler, preserving later configuration changes.
- Uses session custom entries to restore fast-mode state per session and updates the global `active` setting whenever `/fast` changes.
- pi-ai converts `options.serviceTier` into the `service_tier` request body field and applies its priority cost multiplier, so the request path is unchanged.
- Fast-mode cost accounting: on terminal stream events the extension re-runs pi-ai's `calculateCost` (token counts × `model.cost`, tier-aware), excludes Codex cache writes, and applies the model's established fast-mode multiplier (verified rate card or configured `multipliers`) on top. Without an established rate there is no tier and no pricing, so a cost is never multiplied by a guess. This is independent of pi-ai's internal multiplier table, so it stays correct if pi-ai changes its internals. Token counts are real and never modified.

## Security

Pi extensions run with your local user permissions. This extension reads and writes its config JSON files, persists session state through Pi's session API, and delegates LLM calls to pi's built-in OpenAI Codex provider; it makes no independent network requests.

## License

MIT