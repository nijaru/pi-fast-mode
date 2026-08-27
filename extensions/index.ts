/**
 * pi-fast-mode — OpenAI Codex fast mode for pi.
 *
 * Registers an API-layer stream override for `openai-codex-responses` that
 * injects `service_tier: "priority"` into requests when fast mode is enabled
 * and the active model is on the supported set. pi-ai's built-in
 * `openai-codex-responses` implementation turns `options.serviceTier` into the
 * `service_tier` request body field AND applies its priority cost multiplier,
 * so passing the option keeps both the request and the footer cost accounting
 * consistent.
 *
 * Model selection is a three-part override, evaluated per request:
 *   supported = (built-in defaults ∪ allowlist) − blocklist
 * and the model's API must have an `ApiTierSpec`. Built-in defaults ship for
 * the OpenAI Codex models on the official fast-mode rate card; `allowlist`
 * adds models (e.g. custom models.json entries, or future spec'd providers);
 * `blocklist` excludes models you do not want tiered.
 *
 * service_tier is an OpenAI Responses concept: only APIs with an ApiTierSpec
 * participate. Anthropic Messages, Google, and completions-style APIs have no
 * tier and are never touched, even if they appear in the allowlist.
 *
 * Cost accounting: the displayed cost is recomputed from raw token counts ×
 * model.cost × the official rate-card multiplier (2.5x for GPT-5.6/5.5, 2x for
 * GPT-5.4) on terminal stream events. Codex cache writes are excluded because
 * the Codex rate card does not charge for them. This is independent of pi-ai's
 * internal service-tier multiplier table, so it stays correct if pi-ai changes
 * its internals. Token counts are real and never modified.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { calculateCost, clampThinkingLevel, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_TIERS = ["priority", "flex", "default", "auto", "scale"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** Options accepted by pi-ai's Codex Responses implementation. */
export type CodexStreamOptions = SimpleStreamOptions & {
	serviceTier?: ServiceTier;
	reasoningEffort?: ModelThinkingLevel | "none";
	textVerbosity?: "low" | "medium" | "high";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	toolChoice?: "auto" | "none" | "required";
};

export const CONFIG_BASENAME = "pi-fast-mode.json";
/** Existing provider whose Codex models should receive the API-layer override. */
export const CODEX_PROVIDER = "openai-codex";
// Footer statuses are rendered alphabetically by key; keep fast mode ahead of MCP.
export const STATUS_KEY = "fast-mode";
export const COMMAND_FAST = "fast";
export const SESSION_STATE_TYPE = "fast-mode-state";

/** Official Codex fast-mode credit multipliers per model (OpenAI Codex rate card). */
export const OFFICIAL_FAST_MULTIPLIER: Record<string, number> = {
	"gpt-5.6-sol": 2.5,
	"gpt-5.6-terra": 2.5,
	"gpt-5.6-luna": 2.5,
	"gpt-5.5": 2.5,
	"gpt-5.4": 2,
};

/** Built-in supported models for the OpenAI Codex provider. */
export const DEFAULT_FAST_MODE_MODELS = [
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.4",
] as const;

/**
 * How a fast tier is applied for one API. One spec per API; everything else in
 * the extension is driven off these.
 */
export interface ApiTierSpec {
	api: Api;
	/** Tiers this API accepts. openai-codex-responses accepts only `priority`. */
	supportedTiers: readonly ServiceTier[];
	/** Default `provider/model` allowlist entries shipped for this API. */
	defaultModels: readonly string[];
	/** Invoke the raw pi-ai stream for this API (no tier applied). */
	streamRaw: (
		model: Model<Api>,
		context: Context,
		options: CodexStreamOptions,
	) => AssistantMessageEventStream;
}

export const CODEX_RESPONSES_SPEC: ApiTierSpec = {
	api: "openai-codex-responses",
	supportedTiers: ["priority"],
	defaultModels: [...DEFAULT_FAST_MODE_MODELS],
	streamRaw: (model, context, options) =>
		openAICodexResponsesApi().stream(model as Model<"openai-codex-responses">, context, options),
};

export const SPECS: readonly ApiTierSpec[] = [CODEX_RESPONSES_SPEC];

export interface SupportedModel {
	provider: string;
	id: string;
}

export interface ConfigFile {
	/** Record /fast changes in each session's history. */
	persistState?: boolean;
	/** Default fast-mode state for new sessions. */
	active?: boolean;
	serviceTier?: ServiceTier;
	allowlist?: string[];
	blocklist?: string[];
}

export interface ResolvedConfig {
	configPath: string;
	persistState: boolean;
	active: boolean;
	serviceTier: ServiceTier;
	allowlist: SupportedModel[];
	blocklist: SupportedModel[];
}

export interface RuntimeState {
	active: boolean;
	serviceTier: ServiceTier;
}

/** The model membership override applied per request. */
export interface ModelFilter {
	defaults: readonly SupportedModel[];
	allowlist: readonly SupportedModel[];
	blocklist: readonly SupportedModel[];
}

type OpenAIServiceTierOptions = CodexStreamOptions;

const DEFAULT_CONFIG: Required<Pick<ConfigFile, "persistState" | "active" | "serviceTier" | "allowlist" | "blocklist">> = {
	persistState: true,
	active: false,
	serviceTier: "priority",
	allowlist: [],
	blocklist: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateFromSessionEntry(entry: unknown): RuntimeState | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) return undefined;
	if (!isRecord(entry.data) || typeof entry.data.active !== "boolean" || !isServiceTier(entry.data.serviceTier)) {
		return undefined;
	}
	return { active: entry.data.active, serviceTier: entry.data.serviceTier };
}

/** Restore the latest fast-mode state on the active session branch. */
export function readSessionState(entries: readonly unknown[]): RuntimeState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const state = stateFromSessionEntry(entries[index]);
		if (state) return state;
	}
	return undefined;
}

export function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}

export function parseModelKey(value: string): SupportedModel | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const id = trimmed.slice(slash + 1).trim();
	return provider && id ? { provider, id } : undefined;
}

export function normalizeModelKeys(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const keys = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => parseModelKey(entry))
		.filter((entry): entry is SupportedModel => entry !== undefined)
		.map((entry) => `${entry.provider}/${entry.id}`);
	return [...new Set(keys)];
}

export function parseModels(value: unknown): SupportedModel[] | undefined {
	const keys = normalizeModelKeys(value);
	if (keys === undefined) return undefined;
	return keys
		.map((key) => parseModelKey(key))
		.filter((entry): entry is SupportedModel => entry !== undefined);
}

export function configPaths(cwd: string, home = homedir()): { project: string; global: string } {
	return {
		project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
		global: join(home, ".pi", "agent", "extensions", CONFIG_BASENAME),
	};
}

export function readConfig(path: string): ConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) return {};
		const config: ConfigFile = {};
		if (typeof parsed.persistState === "boolean") config.persistState = parsed.persistState;
		if (typeof parsed.active === "boolean") config.active = parsed.active;
		if (isServiceTier(parsed.serviceTier)) config.serviceTier = parsed.serviceTier;
		const allowlist = normalizeModelKeys(parsed.allowlist);
		if (allowlist !== undefined) config.allowlist = allowlist;
		const blocklist = normalizeModelKeys(parsed.blocklist);
		if (blocklist !== undefined) config.blocklist = blocklist;
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] Failed to read ${path}: ${message}`);
		return undefined;
	}
}

export function writeConfig(path: string, config: ConfigFile): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] Failed to write ${path}: ${message}`);
	}
}

export function defaultResolvedConfig(cwd: string, home = homedir()): ResolvedConfig {
	const paths = configPaths(cwd, home);
	return {
		configPath: paths.global,
		persistState: DEFAULT_CONFIG.persistState,
		active: DEFAULT_CONFIG.active,
		serviceTier: DEFAULT_CONFIG.serviceTier,
		allowlist: [],
		blocklist: [],
	};
}

export function resolveConfig(cwd: string, home = homedir()): ResolvedConfig {
	const paths = configPaths(cwd, home);
	const globalConfig = readConfig(paths.global) ?? {};
	const projectConfig = readConfig(paths.project) ?? {};
	const merged: ConfigFile = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
	return {
		configPath: existsSync(paths.project) ? paths.project : paths.global,
		persistState: merged.persistState ?? DEFAULT_CONFIG.persistState,
		active: merged.active ?? DEFAULT_CONFIG.active,
		serviceTier: merged.serviceTier ?? DEFAULT_CONFIG.serviceTier,
		allowlist: parseModels(merged.allowlist) ?? [],
		blocklist: parseModels(merged.blocklist) ?? [],
	};
}

export function getModelsForApi(specs: readonly ApiTierSpec[], api: Api | undefined): readonly ServiceTier[] {
	const spec = specs.find((entry) => entry.api === api);
	return spec?.supportedTiers ?? [];
}

function contains(list: readonly SupportedModel[], model: Pick<Model<Api>, "provider" | "id">): boolean {
	return list.some((entry) => entry.provider === model.provider && entry.id === model.id);
}

/** Merge every spec's built-in defaults into one filter list. */
export function buildModelFilter(specs: readonly ApiTierSpec[], config: {
	allowlist?: readonly SupportedModel[];
	blocklist?: readonly SupportedModel[];
}): ModelFilter {
	const defaults = specs
		.flatMap((spec) => spec.defaultModels)
		.map((key) => parseModelKey(key))
		.filter((entry): entry is SupportedModel => entry !== undefined);
	return { defaults, allowlist: config.allowlist ?? [], blocklist: config.blocklist ?? [] };
}

/** True when the model may be tiered: its API is spec'd and it survives the default/allow/block override. */
export function isModelAllowed(
	model: Pick<Model<Api>, "provider" | "id" | "api"> | undefined,
	specs: readonly ApiTierSpec[],
	filter: ModelFilter,
): boolean {
	if (!model) return false;
	if (getModelsForApi(specs, model.api).length === 0) return false;
	if (!contains(filter.defaults, model) && !contains(filter.allowlist, model)) return false;
	if (contains(filter.blocklist, model)) return false;
	return true;
}

/** The tier to send for this model, or undefined when fast mode should not apply. */
export function resolveServiceTierForModel(
	model: Pick<Model<Api>, "provider" | "id" | "api"> | undefined,
	state: RuntimeState,
	specs: readonly ApiTierSpec[],
	filter: ModelFilter,
): ServiceTier | undefined {
	if (!state.active) return undefined;
	if (!isModelAllowed(model, specs, filter)) return undefined;
	const tiers = getModelsForApi(specs, model?.api);
	return tiers.includes(state.serviceTier) ? state.serviceTier : undefined;
}

/**
 * Official fast-mode credit multiplier for a model, from the OpenAI Codex rate
 * card. Falls back to pi-ai's 2x default for models without a published rate.
 */
export function fastModeMultiplier(modelId: string): number {
	return OFFICIAL_FAST_MULTIPLIER[modelId] ?? 2;
}

interface CostableUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	cost: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; total: number }>;
}

/**
 * Recompute displayed fast-mode cost: pi-ai's `calculateCost` is idempotent — it
 * reads only raw token counts and `model.cost`, never the previously stored
 * cost — so re-running it cleanly replaces any prior (multiplied) pricing, then
 * the official rate-card multiplier is applied. This depends on `model.cost`
 * and pi-ai's tier logic, not on pi-ai's internal multiplier table.
 */
export function applyFastModePricing(model: Model<Api>, usage: CostableUsage, multiplier: number): void {
	calculateCost(model as never, usage as never);
	// Codex does not charge for cache writes, even when the shared model metadata
	// contains an API cache-write rate.
	usage.cost.cacheWrite = 0;
	usage.cost.input = (usage.cost.input ?? 0) * multiplier;
	usage.cost.output = (usage.cost.output ?? 0) * multiplier;
	usage.cost.cacheRead = (usage.cost.cacheRead ?? 0) * multiplier;
	usage.cost.cacheWrite = (usage.cost.cacheWrite ?? 0) * multiplier;
	usage.cost.total = (usage.cost.input ?? 0) + (usage.cost.output ?? 0) + (usage.cost.cacheRead ?? 0) + (usage.cost.cacheWrite ?? 0);
}

function withUsage(msg: unknown): CostableUsage | undefined {
	const usage = (msg as { usage?: unknown })?.usage as CostableUsage | undefined;
	if (!usage || typeof usage.input !== "number" || !usage.cost) return undefined;
	return usage;
}

function scaleEventUsage(event: AssistantMessageEvent, model: Model<Api>, multiplier: number): void {
	if (event.type === "done") {
		const usage = withUsage(event.message);
		if (usage) applyFastModePricing(model, usage, multiplier);
	} else if (event.type === "error") {
		const usage = withUsage(event.error);
		if (usage) applyFastModePricing(model, usage, multiplier);
	}
}

/**
 * Wrap the raw stream, forwarding every event unchanged but recomputing the
 * fast-mode cost on the terminal done/error events.
 */
export function withFastModePricing(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	multiplier: number,
): AssistantMessageEventStream {
	if (multiplier === 1) return stream;
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of stream) {
				scaleEventUsage(event, model, multiplier);
				out.push(event);
			}
			out.end(await stream.result());
		} catch (error) {
			out.end();
			throw error;
		}
	})();
	return out;
}

/**
 * Rebuild request options the way pi's provider layer expects: forward the
 * caller's options, keep reasoning as a concrete effort, cap maxTokens, and add
 * `serviceTier` only when a tier applies for this model. Mirrors the option
 * handling of the published pi-openai-service-tier extension.
 */
export function buildFullOpenAIOptions(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	serviceTier: ServiceTier | undefined,
): OpenAIServiceTierOptions {
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const result: OpenAIServiceTierOptions = {
		...options,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32_000) : undefined),
		reasoningEffort,
	};
	if (serviceTier) result.serviceTier = serviceTier;
	return result;
}

function getConfigCwd(ctx: ExtensionContext): string {
	return ctx.cwd || process.cwd();
}

export function statusText(
	model: Pick<Model<Api>, "provider" | "id" | "api"> | undefined,
	state: RuntimeState,
	specs: readonly ApiTierSpec[],
	filter: ModelFilter,
): string {
	const tier = resolveServiceTierForModel(model, state, specs, filter);
	if (tier && model) {
		const mult = OFFICIAL_FAST_MULTIPLIER[model.id];
		return mult !== undefined ? `⚡ FAST · $ ${mult}×` : "⚡ FAST";
	}
	// Keep the footer quiet for inactive or non-tierable models. The active model
	// and provider already identify the current context, while /fast status can
	// still explain why fast mode did not apply when explicitly requested.
	return "";
}

export default function piFastMode(pi: ExtensionAPI): void {
	let config: ResolvedConfig = defaultResolvedConfig(process.cwd());
	let state: RuntimeState = { active: config.active, serviceTier: config.serviceTier };

	function refreshConfig(ctx: ExtensionContext): ResolvedConfig {
		config = resolveConfig(getConfigCwd(ctx));
		return config;
	}

	function appendSessionState(): void {
		if (!config.persistState) return;
		pi.appendEntry(SESSION_STATE_TYPE, { ...state });
	}

	function restoreSessionState(ctx: ExtensionContext, reason: string | undefined): void {
		const entries = ctx.sessionManager.getEntries();
		const saved = config.persistState ? readSessionState(ctx.sessionManager.getBranch()) : undefined;
		const contextEntries = ctx.sessionManager.buildContextEntries?.() ?? entries;
		const hasConversation = contextEntries.some(
			(entry) =>
				isRecord(entry) &&
				(entry.type === "message" ||
					entry.type === "custom_message" ||
					entry.type === "compaction" ||
					entry.type === "branch_summary"),
		);
		if (saved) {
			state = saved;
			return;
		}

		// A global default applies only to a new/empty session. An existing
		// session created before this extension recorded state stays off rather
		// than being changed retroactively by the global config.
		state = {
			active: reason === "new" || !hasConversation ? config.active : false,
			serviceTier: config.serviceTier,
		};
		appendSessionState();
	}

	function updateStatus(ctx: ExtensionContext): void {
		const filter = buildModelFilter(SPECS, config);
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx.model, state, SPECS, filter) || undefined);
	}

	function supportedListText(filter: ModelFilter): string {
		const all = [...filter.defaults, ...filter.allowlist, ...filter.blocklist];
		const keys = [...new Set(all.map((model) => `${model.provider}/${model.id}`))];
		return keys.join(", ") || "none";
	}

	function notifyStatus(ctx: ExtensionContext): void {
		const filter = buildModelFilter(SPECS, config);
		const tier = resolveServiceTierForModel(ctx.model, state, SPECS, filter);
		const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		if (tier) {
			ctx.ui.notify(`Fast mode: ${tier} service tier for ${modelKey}. Cost accounting includes the priority multiplier.`, "info");
			return;
		}
		if (state.active) {
			ctx.ui.notify(
				`Fast mode is on, but ${modelKey} is not tierable (missing API spec, not on the default/allowlist, or blocked). Mentioned models: ${supportedListText(filter)}.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(`Fast mode is off. Current model: ${modelKey}.`, "info");
	}

	function setActive(ctx: ExtensionContext, active: boolean): void {
		refreshConfig(ctx);
		state = { ...state, active };
		appendSessionState();
		updateStatus(ctx);
		notifyStatus(ctx);
	}

	function setDefault(ctx: ExtensionContext, active: boolean): void {
		refreshConfig(ctx);
		writeConfig(config.configPath, { ...readConfig(config.configPath), active });
		refreshConfig(ctx);
		ctx.ui.notify(
			`Fast mode default: ${config.active ? "on" : "off"} for new sessions (${config.configPath}).`,
			"info",
		);
	}

	function notifyDefault(ctx: ExtensionContext): void {
		refreshConfig(ctx);
		ctx.ui.notify(
			`Fast mode default is ${config.active ? "on" : "off"} for new sessions (${config.configPath}).`,
			"info",
		);
	}

	for (const spec of SPECS) {
		// Overlay the built-in provider to preserve its models and authentication.
		pi.registerProvider(CODEX_PROVIDER, {
			api: spec.api,
			streamSimple(model, context, options) {
				const filter = buildModelFilter(SPECS, config);
				const serviceTier = resolveServiceTierForModel(model, state, SPECS, filter);
				const stream = spec.streamRaw(model, context, buildFullOpenAIOptions(model, options, serviceTier));
				if (!serviceTier) return stream;
				return withFastModePricing(stream, model, fastModeMultiplier(model.id));
			},
		});
	}

	pi.registerCommand(COMMAND_FAST, {
		description: "Toggle OpenAI Codex fast mode; /fast [on|off|status|default]",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();
			if (normalized.startsWith("default ")) {
				const subprefix = normalized.slice("default ".length).trim();
				const values = ["on", "off", "status"];
				const items = values.filter((value) => value.startsWith(subprefix));
				return items.length ? items.map((value) => ({ value, label: value })) : null;
			}
			const values = ["on", "off", "status", "default"];
			const items = values.filter((value) => value.startsWith(normalized.trim()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const [scope, value, ...extra] = arg.split(/\s+/).filter(Boolean);
			if (scope === "default") {
				if (extra.length > 0) {
					ctx.ui.notify("Usage: /fast [on|off|status] or /fast default [on|off|status]", "error");
					return;
				}
				if (!value) {
					refreshConfig(ctx);
					return setDefault(ctx, !config.active);
				}
				if (value === "on") return setDefault(ctx, true);
				if (value === "off") return setDefault(ctx, false);
				if (value === "status") return notifyDefault(ctx);
				ctx.ui.notify("Usage: /fast [on|off|status] or /fast default [on|off|status]", "error");
				return;
			}
			if (!arg) return setActive(ctx, !state.active);
			if (arg === "on") return setActive(ctx, true);
			if (arg === "off") return setActive(ctx, false);
			if (arg === "status") {
				refreshConfig(ctx);
				updateStatus(ctx);
				return notifyStatus(ctx);
			}
			ctx.ui.notify("Usage: /fast [on|off|status] or /fast default [on|off|status]", "error");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		refreshConfig(ctx);
		restoreSessionState(ctx, event.reason);
		updateStatus(ctx);
		if (state.active) notifyStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshConfig(ctx);
		const saved = config.persistState ? readSessionState(ctx.sessionManager.getBranch()) : undefined;
		if (saved) {
			state = saved;
		} else if (config.persistState) {
			state = { active: false, serviceTier: config.serviceTier };
		}
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
