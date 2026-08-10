# pi-fast-mode

Toggle OpenAI Codex fast mode (`service_tier: "priority"`) in pi with correct footer cost accounting.

Fast mode serves the same GPT-5.6/5.5/5.4 models at higher speed for a credit multiplier. This extension sends `service_tier: "priority"` on supported OpenAI Codex requests and fixes pi's displayed cost for GPT-5.6 (pi's built-in multiplier under-reports it at 2x; the official rate card is 2.5x).

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`).

## Testing

```bash
bun run check
```

No build step — pi loads the extension directly.

## Integration discipline

Merge only a coherent, independently usable slice: it must be complete as a user-facing capability or behavior-preserving infrastructure with a tested contract that leaves `main` usable. Keep incomplete scaffolding and dependent follow-ups on feature branches. Before merging, run `bun run check` and inspect the complete diff.

## Key Files

```
extensions/index.ts   # extension: api-tier spec, config, commands, pricing correction
tests/                 # deterministic config, tier-resolution, and pricing tests
```