# pi-fast-mode

Toggle ChatGPT subscription fast mode (`service_tier: "priority"`) in Pi through `openai` and legacy `openai-codex` logins. Displayed costs estimate subscription usage, not API charges or remaining quota.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`). `README.md` owns route-specific runtime requirements; pinned development dependencies are the check target.

## Testing

```bash
bun run check
```

No build step — pi loads the extension directly.

## Invariants

- API-key requests must retain stock handling, without subscription tiers or usage multipliers. On `openai`, proxy endpoints and conflicting authorization headers are also excluded.
- Pi's legacy provider composer routes both `stream()` and `streamSimple()` through the registered `streamSimple` overlay. Never overwrite an API-specific `reasoningEffort` when only the provider-neutral `reasoning` option is absent.
- Project configuration and the `/fast` write destination are gated on `ctx.isProjectTrusted()`; an untrusted project must not steer tier eligibility.
- Pricing is fail-closed: request the priority tier and apply a multiplier only when the model has an established rate — a verified `OFFICIAL_FAST_MULTIPLIER` entry or an explicit configured `multipliers` entry. Never guess a rate for an unknown model.
- The global config path uses `getAgentDir()` so `PI_CODING_AGENT_DIR` is honored.

## Integration discipline

Merge only a coherent, independently usable slice: it must be complete as a user-facing capability or behavior-preserving infrastructure with a tested contract that leaves `main` usable. Keep incomplete scaffolding and dependent follow-ups on feature branches. Before merging, run `bun run check` and inspect the complete diff.

## Key Files

```
extensions/index.ts   # extension: api-tier spec, config, commands, pricing correction
tests/                 # deterministic config, tier-resolution, and pricing tests
```