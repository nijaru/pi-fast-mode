import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupSessionResources, createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import piFastMode, {
	buildFullOpenAIOptions,
	buildFastModePolicy,
	applyFastModePricing,
	fastMultiplierFor,
	CONFIG_BASENAME,
	isModelAllowed,
	parseModelKey,
	parseMultipliers,
	readConfig,
	resolveConfig,
	resolveFastMode,
	readSessionState,
	SESSION_STATE_TYPE,
	SPECS,
	statusText,
	withFastModePricing,
	writeConfig,
} from "../extensions/index.ts";

const codexModel = (id: string) => ({
	provider: "openai-codex",
	id,
	api: "openai-codex-responses" as const,
});

const harnessSessions = new Set<string>();
afterEach(() => {
	for (const id of harnessSessions) cleanupSessionResources(id);
	harnessSessions.clear();
});

/** Real registry with isolated storage; commands/events have a small UI harness. */
async function extensionHarness(opts: {
	cwd: string;
	entries?: unknown[];
	model?: ReturnType<typeof codexModel> | undefined;
	buildContextEntries?: () => unknown[] | undefined;
	trusted?: boolean;
}) {
	harnessSessions.add(opts.cwd);
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({
		credentials, modelsPath: null, refreshOnCreate: false,
	});
	const modelRegistry = new ModelRegistry(runtime);
	const entries: unknown[] = opts.entries ?? [];
	const events: Record<string, Function> = {};
	const commands: Record<string, { handler: Function }> = {};
	const statuses: Array<string | undefined> = [];
	const notices: Array<{ message: string; level: string }> = [];
	const pi = {
		registerProvider(name: string, config: Parameters<ModelRuntime["registerProvider"]>[1]) {
			runtime.registerProvider(name, config);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type: "custom", customType: type, data });
		},
		registerCommand(name: string, command: { handler: Function }) {
			commands[name] = command;
		},
		on(name: string, handler: Function) {
			events[name] = handler;
		},
	};
	piFastMode(pi as never);
	const ctx = {
		cwd: opts.cwd,
		model: opts.model,
		modelRegistry,
		isProjectTrusted: () => opts.trusted ?? true,
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			notify(message: string, level: string) {
				notices.push({ message, level });
			},
		},
		sessionManager: {
			getSessionId: () => opts.cwd,
			getEntries: () => entries,
			getBranch: () => entries,
			buildContextEntries: opts.buildContextEntries,
		},
	};
	return { pi, ctx, runtime, credentials, entries, events, commands, statuses, notices };
}

const stateOn = { active: true, serviceTier: "priority" as const };
const stateOff = { active: false, serviceTier: "priority" as const };

describe("parseModelKey", () => {
	test("parses provider/model", () => {
		expect(parseModelKey("openai-codex/gpt-5.6-luna")).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
	});
	test("rejects bare ids and empty parts", () => {
		expect(parseModelKey("gpt-5.6-luna")).toBeUndefined();
		expect(parseModelKey("openai-codex/")).toBeUndefined();
		expect(parseModelKey("/gpt-5.6-luna")).toBeUndefined();
		expect(parseModelKey("  ")).toBeUndefined();
	});
});

describe("config", () => {
	test("writes and reads back allowlist/blocklist", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const path = join(dir, CONFIG_BASENAME);
			writeConfig(path, {
				active: true,
				serviceTier: "priority",
				allowlist: ["openai-codex/custom-model"],
				blocklist: ["openai-codex/gpt-5.5"],
				multipliers: { "openai-codex/custom-model": 2.5 },
			});
			const read = readConfig(path);
			expect(read?.active).toBe(true);
			expect(read?.serviceTier).toBe("priority");
			expect(read?.allowlist).toEqual(["openai-codex/custom-model"]);
			expect(read?.blocklist).toEqual(["openai-codex/gpt-5.5"]);
			expect(read?.multipliers).toEqual({ "openai-codex/custom-model": 2.5 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults resolve with empty overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const config = resolveConfig(dir, join(dir, "home", ".pi", "agent"));
			expect(config.active).toBe(false);
			expect(config.serviceTier).toBe("priority");
			expect(config.allowlist).toEqual([]);
			expect(config.blocklist).toEqual([]);
			expect(config.multipliers).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isModelAllowed", () => {
	const policy = buildFastModePolicy(SPECS, {});

	test("allowlist adds a custom model on a spec'd api", () => {
		const f = buildFastModePolicy(SPECS, { allowlist: [parseModelKey("openai-codex/custom-model")!] });
		expect(isModelAllowed(codexModel("custom-model"), SPECS, f)).toBe(true);
	});
	test("blocklist wins over allowlist", () => {
		const f = buildFastModePolicy(SPECS, {
			allowlist: [parseModelKey("openai-codex/contested")!],
			blocklist: [parseModelKey("openai-codex/contested")!],
		});
		expect(isModelAllowed(codexModel("contested"), SPECS, f)).toBe(false);
	});
	test("rejects an allowed model on the wrong api or provider", () => {
		expect(isModelAllowed({ ...codexModel("gpt-5.6-luna"), api: "anthropic-messages" }, SPECS, policy)).toBe(false);
		const custom = { ...codexModel("gpt-5.6-luna"), provider: "custom-codex" };
		const allowlisted = buildFastModePolicy(SPECS, { allowlist: [{ provider: custom.provider, id: custom.id }] });
		expect(isModelAllowed(custom, SPECS, allowlisted)).toBe(false);
	});
	test("rejects a non-listed model, including retired GPT-5.4", () => {
		expect(isModelAllowed(codexModel("deepseek-v4-flash"), SPECS, policy)).toBe(false);
		expect(isModelAllowed(codexModel("gpt-5.4"), SPECS, policy)).toBe(false);
	});
});

describe("session state", () => {
	test("restores the latest state on the active branch", () => {
		expect(
			readSessionState([
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
				{ type: "custom", customType: "other-state", data: { active: false } },
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: false, serviceTier: "priority" } },
			]),
		).toEqual({ active: false, serviceTier: "priority" });
	});

	test("ignores malformed state entries", () => {
		expect(
			readSessionState([
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "unsupported" } },
			]),
		).toBeUndefined();
	});
});

describe("resolveFastMode", () => {
	const policy = buildFastModePolicy(SPECS, {});

	test.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"])(
		"tiers the supported default %s at the 2.5× rate-card multiplier",
		id => {
			expect(resolveFastMode(codexModel(id), stateOn, SPECS, policy)).toEqual({ tier: "priority", multiplier: 2.5 });
		},
	);
	test("no tier when inactive", () => {
		expect(resolveFastMode(codexModel("gpt-5.6-luna"), stateOff, SPECS, policy)).toBeUndefined();
	});
	test("no tier when the api rejects the configured tier", () => {
		expect(
			resolveFastMode(codexModel("gpt-5.6-luna"), { active: true, serviceTier: "flex" }, SPECS, policy),
		).toBeUndefined();
	});
	test("no tier for a blocked default", () => {
		const f = buildFastModePolicy(SPECS, { blocklist: [parseModelKey("openai-codex/gpt-5.6-sol")!] });
		expect(resolveFastMode(codexModel("gpt-5.6-sol"), stateOn, SPECS, f)).toBeUndefined();
	});
	test("fails closed for an allowlisted model without an established rate", () => {
		const f = buildFastModePolicy(SPECS, { allowlist: [parseModelKey("openai-codex/custom-model")!] });
		expect(isModelAllowed(codexModel("custom-model"), SPECS, f)).toBe(true);
		expect(resolveFastMode(codexModel("custom-model"), stateOn, SPECS, f)).toBeUndefined();
	});
	test("uses the configured rate to tier and price an allowlisted model", () => {
		const f = buildFastModePolicy(SPECS, {
			allowlist: [parseModelKey("openai-codex/custom-model")!],
			multipliers: { "openai-codex/custom-model": 3 },
		});
		expect(resolveFastMode(codexModel("custom-model"), stateOn, SPECS, f)).toEqual({ tier: "priority", multiplier: 3 });
	});
	test("a configured rate overrides the built-in rate card", () => {
		const f = buildFastModePolicy(SPECS, { multipliers: { "openai-codex/gpt-5.6-luna": 2 } });
		expect(resolveFastMode(codexModel("gpt-5.6-luna"), stateOn, SPECS, f)?.multiplier).toBe(2);
	});
	test("a rate alone does not tier a non-listed model", () => {
		const f = buildFastModePolicy(SPECS, { multipliers: { "openai-codex/deepseek-v4-flash": 2 } });
		expect(resolveFastMode(codexModel("deepseek-v4-flash"), stateOn, SPECS, f)).toBeUndefined();
	});
});

describe("fast-mode pricing", () => {
	const policy = buildFastModePolicy(SPECS, {});

	test("no rate is established for unknown models instead of guessing one", () => {
		expect(fastMultiplierFor(codexModel("gpt-6.1-sol"), policy)).toBe(2.5);
		expect(fastMultiplierFor(codexModel("gpt-5.4"), policy)).toBe(2);
		expect(fastMultiplierFor(codexModel("deepseek-v4-flash"), policy)).toBeUndefined();
		expect(fastMultiplierFor({ provider: "custom-codex", id: "gpt-5.6-luna" }, policy)).toBeUndefined();
		expect(fastMultiplierFor(undefined, policy)).toBeUndefined();
	});

	test("configured rates establish a multiplier for unknown models", () => {
		const f = buildFastModePolicy(SPECS, { multipliers: { "openai-codex/deepseek-v4-flash": 2 } });
		expect(fastMultiplierFor(codexModel("deepseek-v4-flash"), f)).toBe(2);
	});

	test("parseMultipliers drops unestablishable entries", () => {
		expect(
			parseMultipliers({
				"bare-id": 2.5,
				"openai-codex/": 2.5,
				"openai-codex/zero": 0,
				"openai-codex/negative": -1,
				"openai-codex/infinite": Infinity,
				"openai-codex/nan": Number.NaN,
				"openai-codex/string": "2.5",
				"openai-codex/good": 2.5,
			}),
		).toEqual({ "openai-codex/good": 2.5 });
		expect(parseMultipliers(2.5)).toBeUndefined();
		expect(parseMultipliers(undefined)).toBeUndefined();
	});

	const luna = {
		id: "gpt-5.6-luna",
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, tiers: [] },
	} as const;

	test("does not charge Codex cache writes", () => {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000, cost: {} };
		applyFastModePricing(luna as never, usage as never, 2.5);
		const cost = usage.cost as { cacheWrite: number; total: number };
		expect(cost.cacheWrite).toBe(0);
		expect(cost.total).toBe(0);
	});

	test("recomputes cost from token counts × rates × official multiplier", () => {
		const usage = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: {} };
		// base: 1e6×$0.2/1e6 + 0.5e6×$1.2/1e6 = 0.2 + 0.6 = 0.8; ×2.5 = 2.0
		applyFastModePricing(luna as never, usage as never, 2.5);
		const cost = usage.cost as { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		expect(cost.input).toBeCloseTo(0.5);
		expect(cost.output).toBeCloseTo(1.5);
		expect(cost.total).toBeCloseTo(2.0);
	});

	test("selects the input-token cost tier before applying the multiplier", () => {
		const tiered = {
			id: "gpt-5.6-luna",
			cost: {
				input: 0.2,
				output: 1.2,
				cacheRead: 0.02,
				cacheWrite: 0.25,
				tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
			},
		} as const;
		const usage = { input: 300_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cost: {} };
		// tier rates: 0.4 and 1.8; base = 0.12 + 0.18 = 0.30; ×2.5 = 0.75
		applyFastModePricing(tiered as never, usage as never, 2.5);
		const cost = usage.cost as { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		expect(cost.input).toBeCloseTo(0.3);
		expect(cost.output).toBeCloseTo(0.45);
		expect(cost.total).toBeCloseTo(0.75);
	});

	test("cached-input cost is rate-card priced like pi-ai (cache reads count as input tokens for tier selection)", () => {
		const usage = { input: 100_000, output: 10_000, cacheRead: 500_000, cacheWrite: 0, cost: {} };
		// inputTokens for tier selection = 100k + 500k = 600k > 272k → tier rates.
		applyFastModePricing({ ...luna, cost: { ...luna.cost, tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }] } } as never, usage as never, 2.5);
		const cost = usage.cost as { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		expect(cost.input).toBeCloseTo(0.1); // 100k × 0.4/1e6 × 2.5
		expect(cost.cacheRead).toBeCloseTo(0.05); // 500k × 0.04/1e6 × 2.5
	});
});

describe("config robustness", () => {
	test("malformed JSON falls back to defaults with a warning", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const path = join(dir, CONFIG_BASENAME);
			writeFileSync(path, "{ not json");
			const warned = captureWarnings(() => {
				const read = readConfig(path);
				expect(read).toBeUndefined();
			});
			expect(warned.length).toBeGreaterThan(0);
			const config = resolveConfig(dir, join(dir, "home", ".pi", "agent"));
			expect(config.active).toBe(false);
			expect(config.allowlist).toEqual([]);
			expect(config.blocklist).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("invalid allowlist/blocklist entries are dropped", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, {
				allowlist: ["openai-codex/good", "noprovider", "", "  ", "/bad-id", 42 as unknown as string, "openai-codex/good"],
				blocklist: ["openai-codex/deepseek-v4-flash", "garbage"],
			});
			const config = resolveConfig(dir);
			expect(config.allowlist.map((m) => `${m.provider}/${m.id}`)).toEqual(["openai-codex/good"]);
			expect(config.blocklist.map((m) => `${m.provider}/${m.id}`)).toEqual(["openai-codex/deepseek-v4-flash"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("multipliers without a provider/model key or a finite positive rate are dropped", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, {
				multipliers: {
					"openai-codex/good": 2.5,
					"bare-id": 2.5,
					"openai-codex/zero": 0,
					"openai-codex/string": "2.5" as unknown as number,
				},
			});
			expect(resolveConfig(dir).multipliers).toEqual({ "openai-codex/good": 2.5 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("project multipliers replace the global map", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const agentDir = join(dir, "agent");
			writeConfig(join(agentDir, "extensions", CONFIG_BASENAME), {
				multipliers: { "openai-codex/inherited-model": 3 },
			});
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, { multipliers: { "openai-codex/project-model": 2 } });
			expect(resolveConfig(dir, agentDir).multipliers).toEqual({ "openai-codex/project-model": 2 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("invalid serviceTier value falls back to default", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, { serviceTier: "turbo" as never });
			expect(resolveConfig(dir).serviceTier).toBe("priority");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("project config wins over global per key", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const agentDir = join(dir, "agent");
			writeConfig(join(agentDir, "extensions", CONFIG_BASENAME), { active: false, blocklist: ["openai-codex/global-block"], allowlist: ["openai-codex/inherited-model"] });
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, { active: true, blocklist: ["openai-codex/gpt-5.4"] });
			const config = resolveConfig(dir, agentDir);
			expect(config.active).toBe(true);
			expect(config.allowlist).toEqual([{ provider: "openai-codex", id: "inherited-model" }]);
			expect(config.blocklist.map((m) => `${m.provider}/${m.id}`)).toEqual(["openai-codex/gpt-5.4"]);
			expect(config.configPath).toBe(projectPath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function captureWarnings(fn: () => void): string[] {
	const original = console.warn;
	const captured: string[] = [];
	console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return captured;
}

describe("withFastModePricing", () => {
	const model = {
		id: "gpt-5.6-luna",
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, tiers: [] },
	};

	test.each([1, 2.5])("recomputes cost from raw tokens with multiplier %s, replacing prior pricing", async multiplier => {
		const raw = createAssistantMessageEventStream();
		// Simulates pi-ai's flow: base cost 1e6×$0.2/1e6 + 0.5e6×$1.2/1e6 = $0.8, then its builtin ×2 = $1.6.
		const usage = {
			input: 1_000_000,
			output: 500_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_500_000,
			cost: { input: 0.4, output: 1.2, cacheRead: 0, cacheWrite: 0, total: 1.6 },
		};
		raw.push({ type: "done", reason: "stop", message: { content: [], usage } } as never);
		raw.end();

		const wrapped = withFastModePricing(raw as never, model as never, multiplier);
		const events: unknown[] = [];
		for await (const event of wrapped) events.push(event);

		const done = events[0] as { message: { usage: { cost: { input: number; total: number } } } };
		expect(done.message.usage.cost.input).toBeCloseTo(0.2 * multiplier);
		expect(done.message.usage.cost.total).toBeCloseTo(0.8 * multiplier);
	});
	test("surfaces a mid-stream throw as an error event instead of hanging", async () => {
		// A raw iterator that throws before any terminal event, mimicking an
		// upstream failure pi-ai did not convert to an error event. The wrapper
		// must still resolve result() with an AssistantMessage-shaped error.
		const throwing = {
			async *[Symbol.asyncIterator]() {
				yield { type: "message_start" };
				throw new Error("transport exploded");
			},
			result: () => new Promise<never>(() => {}),
		};
		const wrapped = withFastModePricing(throwing as never, model as never, 2.5);
		const events: unknown[] = [];
		const outcome = await Promise.race([
			wrapped.result().then((message) => ({ resolved: message })),
			new Promise((_, reject) => setTimeout(() => reject(new Error("HUNG")), 500)),
		]).catch((error: Error) => ({ hung: error.message }));
		for await (const event of wrapped) events.push(event);
		const result = outcome as { resolved?: { errorMessage?: string; stopReason?: string }; hung?: string };
		expect(result.hung).toBeUndefined();
		expect(result.resolved?.errorMessage).toBe("transport exploded");
		expect(result.resolved?.stopReason).toBe("error");
		expect((events.at(-1) as { type: string }).type).toBe("error");
	});

	test("resolves a source that ends without a terminal event", async () => {
		// A source can end after non-terminal events, leaving result() pending
		// forever. The wrapper must synthesize the terminal error itself.
		const silent = {
			async *[Symbol.asyncIterator]() {
				yield { type: "message_start" };
			},
			result: () => new Promise<never>(() => {}),
		};
		const wrapped = withFastModePricing(silent as never, model as never, 2.5);
		const outcome = await Promise.race([
			wrapped.result().then((message) => ({ resolved: message })),
			new Promise((_, reject) => setTimeout(() => reject(new Error("HUNG")), 500)),
		]).catch((error: Error) => ({ hung: error.message }));
		const events: unknown[] = [];
		for await (const event of wrapped) events.push(event);
		const result = outcome as { resolved?: { errorMessage?: string }; hung?: string };
		expect(result.hung).toBeUndefined();
		expect(result.resolved?.errorMessage).toContain("without a done or error event");
		expect((events.at(-1) as { type: string }).type).toBe("error");
	});
});

/** Send one request through the overlaid Codex provider and capture the wire body. */
async function captureCodexRequestBody(
	dir: string,
	config: Parameters<typeof writeConfig>[1],
	modelId: string,
): Promise<Record<string, unknown> | undefined> {
	const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
	mkdirSync(dirname(configPath), { recursive: true });
	writeConfig(configPath, config);
	let body: Record<string, unknown> | undefined;
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response(JSON.stringify({ error: { message: "captured" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		}),
	});
	try {
		const model = {
			id: modelId,
			name: modelId,
			provider: "openai-codex",
			api: "openai-codex-responses" as const,
			baseUrl: `http://127.0.0.1:${server.port}`,
			maxTokens: 32_000,
			contextWindow: 272_000,
			reasoning: true,
			thinkingLevelMap: { minimal: "low" as const },
			input: ["text" as const],
			cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		};
		const { ctx, runtime, credentials, events, commands } = await extensionHarness({ cwd: dir, model });
		await events.session_start?.({}, ctx);
		await commands.fast?.handler("on", ctx);

		const payloadToken = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
		})).toString("base64url");
		await credentials.modify("openai-codex", async () => ({
			type: "oauth", access: `e30.${payloadToken}.sig`, refresh: "test", expires: Date.now() + 3_600_000,
		}));
		const stream = runtime.streamSimple(model, {
			systemPrompt: "test",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		}, {
			apiKey: `e30.${payloadToken}.sig`,
			transport: "sse",
			reasoning: "minimal",
			onPayload(payload) {
				body = payload as Record<string, unknown>;
				return payload;
			},
		});
		for await (const _event of stream) {}
		return body;
	} finally {
		server.stop();
	}
}

describe("extension registration", () => {
	test("does not register a provider during extension loading", () => {
		const registrations: Array<{ name: string; config: { api?: string } }> = [];
		const pi = {
			registerFlag() {},
			registerProvider(name: string, config: { api?: string }) {
				registrations.push({ name, config });
			},
			registerCommand() {},
			on() {},
			getFlag() {
				return false;
			},
		};

		piFastMode(pi as never);

		expect(registrations).toHaveLength(0);
	});

	test("completes the supported command arguments", () => {
		let command: { getArgumentCompletions?: (prefix: string) => unknown } | undefined;
		const pi = {
			registerProvider() {},
			registerCommand(_name: string, value: { getArgumentCompletions?: (prefix: string) => unknown }) {
				command = value;
			},
			on() {},
		};

		piFastMode(pi as never);

		expect(command?.getArgumentCompletions?.(" ")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
			{ value: "status", label: "status" },
		]);
	});

	test("updates the current session and default when enabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-state-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: false, serviceTier: "priority" });

			const { ctx, events, commands, statuses, notices } = await extensionHarness({
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				entries: [{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } }],
			});
			await events.session_start?.({}, ctx);
			await commands.fast?.handler("on", ctx);
			await commands.fast?.handler("status", ctx);

			expect(statuses).toEqual([undefined, "· ⚡ FAST · $ 2.5×", "· ⚡ FAST · $ 2.5×"]);
			expect(notices.at(-1)?.message).toContain("Fast mode: priority service tier");
			expect(readConfig(configPath)?.active).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("status distinguishes an unsupported configured tier from an unlisted model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-tier-status-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: false, serviceTier: "flex" });

			const { ctx, events, commands, notices } = await extensionHarness({
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
			});
			await events.session_start?.({}, ctx);
			await commands.fast?.handler("on", ctx);

			const last = notices.at(-1);
			expect(last?.level).toBe("warning");
			expect(last?.message).toContain('"flex" is not accepted by openai-codex-responses');
			expect(last?.message).not.toContain("not tierable");
			expect(readConfig(configPath)?.active).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("status explains how to establish a rate for a listed model without one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-rate-status-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, {
				active: false,
				persistState: false,
				serviceTier: "priority",
				allowlist: ["openai-codex/custom-model"],
			});

			const { ctx, events, commands, statuses, notices } = await extensionHarness({
				cwd: dir,
				model: codexModel("custom-model"),
			});
			await events.session_start?.({}, ctx);
			await commands.fast?.handler("on", ctx);
			await commands.fast?.handler("status", ctx);

			const last = notices.at(-1);
			expect(last?.level).toBe("warning");
			expect(last?.message).toContain("no established fast-mode rate");
			expect(last?.message).toContain('"multipliers": { "openai-codex/custom-model"');
			expect(statuses.at(-1)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps existing sessions off when the global default is enabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-session-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: true, persistState: true, serviceTier: "priority" });

			const { ctx, events, entries } = await extensionHarness({
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				entries: [{ type: "message", message: { role: "user", content: "old" } }],
			});
			await events.session_start?.({ reason: "resume" }, ctx);

			expect(entries).toEqual([
				{ type: "message", message: { role: "user", content: "old" } },
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: false, serviceTier: "priority" } },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("uses the global default for a new session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-session-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: true, persistState: true, serviceTier: "priority" });

			const initialEntries = [
				{ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" },
				{ type: "thinking_level_change", thinkingLevel: "off" },
			];
			const { ctx, events, statuses, entries } = await extensionHarness({
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				entries: initialEntries,
				buildContextEntries: () => entries,
			});
			await events.session_start?.({ reason: "startup" }, ctx);

			expect(statuses).toEqual(["· \u26a1 FAST \u00b7 $ 2.5\u00d7"]);
			expect(entries).toEqual([
				{ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" },
				{ type: "thinking_level_change", thinkingLevel: "off" },
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("restores a persisted state instead of using the global default", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-session-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: true, serviceTier: "priority" });

			const { ctx, events, statuses } = await extensionHarness({
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				entries: [
					{ type: "message", message: { role: "user", content: "old" } },
					{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
				],
			});
			await events.session_start?.({ reason: "resume" }, ctx);

			expect(statuses).toEqual(["· \u26a1 FAST \u00b7 $ 2.5\u00d7"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sends priority service_tier through the overlaid Codex provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-live-"));
		try {
			const body = await captureCodexRequestBody(
				dir,
				{ active: false, persistState: false, serviceTier: "priority" },
				"gpt-5.6-luna",
			);
			expect(body?.model).toBe("gpt-5.6-luna");
			expect(body?.service_tier).toBe("priority");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sends no service_tier for a listed model without an established rate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-live-"));
		try {
			const body = await captureCodexRequestBody(
				dir,
				{ active: false, persistState: false, serviceTier: "priority", allowlist: ["openai-codex/custom-model"] },
				"custom-model",
			);
			expect(body?.model).toBe("custom-model");
			expect(body?.service_tier).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("statusText", () => {
	const policy = buildFastModePolicy(SPECS, {});
	test("shows a compact fast indicator when applied", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), stateOn, SPECS, policy)).toBe("⚡ FAST · $ 2.5×");
	});
	test("shows the established configured multiplier", () => {
		const f = buildFastModePolicy(SPECS, {
			allowlist: [parseModelKey("openai-codex/custom-model")!],
			multipliers: { "openai-codex/custom-model": 3 },
		});
		expect(statusText(codexModel("custom-model"), stateOn, SPECS, f)).toBe("⚡ FAST · $ 3×");
	});
	test("stays empty whenever no fast mode resolves", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), stateOff, SPECS, policy)).toBe("");
		expect(statusText(codexModel("deepseek-v4-flash"), stateOn, SPECS, policy)).toBe("");
	});
});

describe("session_tree", () => {
	test("restores the branch state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-tree-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: true, serviceTier: "priority" });

			const { ctx, events, statuses } = await extensionHarness({
				cwd: dir,
			model: codexModel("gpt-5.6-luna"),
				entries: [
					{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
				],
			});
			await events.session_tree?.({}, ctx);

			expect(statuses).toEqual(["· \u26a1 FAST \u00b7 $ 2.5\u00d7"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resets to off when the branch has no saved state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-tree-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: true, persistState: true, serviceTier: "priority" });

			const { ctx, events, statuses } = await extensionHarness({
				cwd: dir,
			model: codexModel("gpt-5.6-luna"),
				entries: [{ type: "message", message: { role: "user", content: "old" } }],
			});
			await events.session_tree?.({}, ctx);

			expect(statuses).toEqual([undefined]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("config write preservation", () => {
	test("/fast preserves unknown config keys", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-write-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					active: false,
					persistState: false,
					serviceTier: "priority",
					note: "keep me",
					allowlist: ["openai-codex/custom", "bogus"],
				}),
			);

			const { ctx, events, commands } = await extensionHarness({
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
			});
			await events.session_start?.({}, ctx);
			await commands.fast?.handler("on", ctx);

			const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
			expect(raw.active).toBe(true);
			expect(raw.note).toBe("keep me");
			expect(raw.allowlist).toEqual(["openai-codex/custom", "bogus"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("option shaping", () => {
	const model = {
		id: "gpt-6-astra",
		provider: "openai-codex",
		api: "openai-codex-responses" as const,
		reasoning: true,
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	} as never;

	// Pi's legacy provider composer routes both stream() and streamSimple() through
	// the registered streamSimple, so an API-specific reasoningEffort must survive.
	test("preserves an API-specific reasoningEffort and applies the tier", () => {
		const options = buildFullOpenAIOptions(model, { reasoningEffort: "high" } as never, "priority");
		expect(options.reasoningEffort).toBe("high");
		expect(options.serviceTier).toBe("priority");
	});

	test("derives reasoningEffort from the provider-neutral reasoning option", () => {
		expect(buildFullOpenAIOptions(model, { reasoning: "off" } as never, undefined).reasoningEffort).toBeUndefined();
		expect(buildFullOpenAIOptions(model, { reasoningEffort: "high", reasoning: "off" } as never, undefined).reasoningEffort).toBeUndefined();
	});
});

describe("project trust", () => {
	test("an untrusted project cannot steer config or receive the /fast write", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, { active: true, blocklist: ["openai-codex/gpt-5.6-luna"] });
			const agentDir = join(dir, "home", ".pi", "agent");

			const untrusted = resolveConfig(dir, agentDir, false);
			expect(untrusted.active).toBe(false);
			expect(untrusted.blocklist).toEqual([]);
			expect(untrusted.configPath).toBe(join(agentDir, "extensions", CONFIG_BASENAME));

			const trusted = resolveConfig(dir, agentDir, true);
			expect(trusted.active).toBe(true);
			expect(trusted.configPath).toBe(projectPath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});