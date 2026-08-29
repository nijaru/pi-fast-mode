import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import piFastMode, {
	buildModelFilter,
	applyFastModePricing,
	fastModeMultiplier,
	CODEX_PROVIDER,
	CONFIG_BASENAME,
	DEFAULT_FAST_MODE_MODELS,
	isModelAllowed,
	OFFICIAL_FAST_MULTIPLIER,
	parseModelKey,
	readConfig,
	resolveConfig,
	resolveServiceTierForModel,
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
			});
			const read = readConfig(path);
			expect(read?.active).toBe(true);
			expect(read?.serviceTier).toBe("priority");
			expect(read?.allowlist).toEqual(["openai-codex/custom-model"]);
			expect(read?.blocklist).toEqual(["openai-codex/gpt-5.5"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults resolve with empty overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
		try {
			const config = resolveConfig(dir, join(dir, "home"));
			expect(config.active).toBe(false);
			expect(config.serviceTier).toBe("priority");
			expect(config.allowlist).toEqual([]);
			expect(config.blocklist).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildModelFilter", () => {
	test("defaults come from spec defaultModels", () => {
		const filter = buildModelFilter(SPECS, {});
		expect(filter.defaults.map((m) => `${m.provider}/${m.id}`)).toEqual([...DEFAULT_FAST_MODE_MODELS]);
		expect(filter.allowlist).toEqual([]);
		expect(filter.blocklist).toEqual([]);
	});
	test("surfaces allowlist and blocklist", () => {
		const filter = buildModelFilter(SPECS, {
			allowlist: [parseModelKey("openai-codex/custom")!],
			blocklist: [parseModelKey("openai-codex/gpt-5.5")!],
		});
		expect(filter.allowlist).toHaveLength(1);
		expect(filter.blocklist).toHaveLength(1);
	});
});

describe("isModelAllowed", () => {
	const filter = buildModelFilter(SPECS, {});

	test("built-in default model is allowed", () => {
		expect(isModelAllowed(codexModel("gpt-5.6-luna"), SPECS, filter)).toBe(true);
	});
	test("blocklist excludes a default", () => {
		const f = buildModelFilter(SPECS, { blocklist: [parseModelKey("openai-codex/gpt-5.5")!] });
		expect(isModelAllowed(codexModel("gpt-5.5"), SPECS, f)).toBe(false);
		expect(isModelAllowed(codexModel("gpt-5.6-luna"), SPECS, f)).toBe(true);
	});
	test("allowlist adds a custom model on a spec'd api", () => {
		const f = buildModelFilter(SPECS, { allowlist: [parseModelKey("openai-codex/custom-model")!] });
		expect(isModelAllowed(codexModel("custom-model"), SPECS, f)).toBe(true);
	});
	test("blocklist wins over allowlist", () => {
		const f = buildModelFilter(SPECS, {
			allowlist: [parseModelKey("openai-codex/contested")!],
			blocklist: [parseModelKey("openai-codex/contested")!],
		});
		expect(isModelAllowed(codexModel("contested"), SPECS, f)).toBe(false);
	});
	test("allowed model on wrong api is rejected", () => {
		expect(isModelAllowed({ ...codexModel("gpt-5.6-luna"), api: "anthropic-messages" }, SPECS, filter)).toBe(false);
	});
	test("non-listed model is rejected", () => {
		expect(isModelAllowed(codexModel("deepseek-v4-flash"), SPECS, filter)).toBe(false);
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

describe("resolveServiceTierForModel", () => {
	const filter = buildModelFilter(SPECS, {});

	test("applies priority for allowlisted model when active", () => {
		expect(resolveServiceTierForModel(codexModel("gpt-5.6-luna"), stateOn, SPECS, filter)).toBe("priority");
	});
	test("no tier when inactive", () => {
		expect(resolveServiceTierForModel(codexModel("gpt-5.6-luna"), stateOff, SPECS, filter)).toBeUndefined();
	});
	test("no tier for non-listed model", () => {
		expect(resolveServiceTierForModel(codexModel("deepseek-v4-flash"), stateOn, SPECS, filter)).toBeUndefined();
	});
	test("no tier when the api rejects the configured tier", () => {
		expect(
			resolveServiceTierForModel(codexModel("gpt-5.6-luna"), { active: true, serviceTier: "flex" }, SPECS, filter),
		).toBeUndefined();
	});
	test("no tier for a blocked default", () => {
		const f = buildModelFilter(SPECS, { blocklist: [parseModelKey("openai-codex/gpt-5.6-sol")!] });
		expect(resolveServiceTierForModel(codexModel("gpt-5.6-sol"), stateOn, SPECS, f)).toBeUndefined();
	});
});

describe("fast-mode pricing", () => {
	test("official multipliers per rate card", () => {
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.6-sol"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.6-terra"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.6-luna"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.5"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.4"]).toBe(2);
	});

	test("unknown models fall back to the 2x default", () => {
		expect(fastModeMultiplier("gpt-5.6-luna")).toBe(2.5);
		expect(fastModeMultiplier("gpt-5.5")).toBe(2.5);
		expect(fastModeMultiplier("gpt-5.4")).toBe(2);
		expect(fastModeMultiplier("deepseek-v4-flash")).toBe(2);
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
			const config = resolveConfig(dir, join(dir, "home"));
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
			// create a project-level .pi/extensions file that flips active and adds a block
			const projectPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(projectPath), { recursive: true });
			writeConfig(projectPath, { active: true, blocklist: ["openai-codex/gpt-5.4"] });
			const config = resolveConfig(dir);
			expect(config.active).toBe(true);
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

	test("recomputes cost from raw tokens on the done event, replacing prior pricing", async () => {
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

		const wrapped = withFastModePricing(raw as never, model as never, 2.5);
		const events: unknown[] = [];
		for await (const event of wrapped) events.push(event);

		const done = events[0] as { message: { usage: { cost: { input: number; total: number } } } };
		expect(done.message.usage.cost.input).toBeCloseTo(0.5); // 1e6 × 0.2/1e6 × 2.5
		expect(done.message.usage.cost.total).toBeCloseTo(2.0);
	});

	test("returns the stream untouched when multiplier is 1", () => {
		const raw = createAssistantMessageEventStream();
		expect(withFastModePricing(raw, model as never, 1)).toBe(raw);
	});
});

describe("extension registration", () => {
	test("overlays the existing Codex provider instead of registering a new provider", () => {
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

		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.name).toBe(CODEX_PROVIDER);
		expect(registrations[0]?.config.api).toBe("openai-codex-responses");
	});

	test("preserves the command scope when completing default arguments", () => {
		let command: { getArgumentCompletions?: (prefix: string) => unknown } | undefined;
		const pi = {
			registerProvider() {},
			registerCommand(_name: string, value: { getArgumentCompletions?: (prefix: string) => unknown }) {
				command = value;
			},
			on() {},
		};

		piFastMode(pi as never);

		expect(command?.getArgumentCompletions?.("default ")).toEqual([
			{ value: "default on", label: "on" },
			{ value: "default off", label: "off" },
			{ value: "default status", label: "status" },
		]);
	});

	test("keeps /fast on enabled for a session-only config across /fast status", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-state-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: false, serviceTier: "priority" });

			const entries: unknown[] = [
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
			];
			const events: Record<string, Function> = {};
			const commands: Record<string, { handler: Function }> = {};
			const statuses: Array<string | undefined> = [];
			const notices: string[] = [];
			const pi = {
				registerProvider() {},
				appendEntry() {},
				registerCommand(name: string, command: { handler: Function }) {
					commands[name] = command;
				},
				on(name: string, handler: Function) {
					events[name] = handler;
				},
			};
			piFastMode(pi as never);

			const ctx = {
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				ui: {
					setStatus(_key: string, value: string | undefined) {
						statuses.push(value);
					},
					notify(message: string) {
						notices.push(message);
					},
				},
				sessionManager: {
					getEntries: () => entries,
					getBranch: () => entries,
				},
			};
			await events.session_start?.({}, ctx);
			await commands.fast?.handler("on", ctx);
			await commands.fast?.handler("status", ctx);

			expect(statuses).toEqual([undefined, "⚡ FAST · $ 2.5×", "⚡ FAST · $ 2.5×"]);
			expect(notices.at(-1)).toContain("Fast mode: priority service tier");
			expect(readConfig(configPath)?.active).toBe(false);
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

			const entries: unknown[] = [{ type: "message", message: { role: "user", content: "old" } }];
			const appended: unknown[] = [];
			const events: Record<string, Function> = {};
			const pi = {
				registerProvider() {},
				appendEntry(type: string, data: unknown) {
					const entry = { type: "custom", customType: type, data };
					entries.push(entry);
					appended.push(entry);
				},
				registerCommand() {},
				on(name: string, handler: Function) {
					events[name] = handler;
				},
			};
			piFastMode(pi as never);

			const ctx = {
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				ui: { setStatus() {}, notify() {} },
				sessionManager: {
					getEntries: () => entries,
					getBranch: () => entries,
				},
			};
			await events.session_start?.({ reason: "resume" }, ctx);

			expect(appended).toEqual([
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

			const entries: unknown[] = [
				{ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" },
				{ type: "thinking_level_change", thinkingLevel: "off" },
			];
			const statuses: Array<string | undefined> = [];
			const events: Record<string, Function> = {};
			const pi = {
				registerProvider() {},
				appendEntry(type: string, data: unknown) {
					entries.push({ type: "custom", customType: type, data });
				},
				registerCommand() {},
				on(name: string, handler: Function) {
					events[name] = handler;
				},
			};
			piFastMode(pi as never);

			const ctx = {
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				ui: {
					setStatus(_key: string, value: string | undefined) {
						statuses.push(value);
					},
					notify() {},
				},
				sessionManager: {
					getEntries: () => entries,
					getBranch: () => entries,
					buildContextEntries: () => entries,
				},
			};
			await events.session_start?.({ reason: "startup" }, ctx);

			expect(statuses).toEqual(["⚡ FAST · $ 2.5×"]);
			expect(entries).toEqual([
				{ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" },
				{ type: "thinking_level_change", thinkingLevel: "off" },
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("persists /fast changes in the session without changing the global default", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-session-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: true, serviceTier: "priority" });

			const entries: unknown[] = [];
			const commands: Record<string, { handler: Function }> = {};
			const events: Record<string, Function> = {};
			const pi = {
				registerProvider() {},
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
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				ui: { setStatus() {}, notify() {} },
				sessionManager: {
					getEntries: () => entries,
					getBranch: () => entries,
				},
			};
			await events.session_start?.({ reason: "new" }, ctx);
			await commands.fast?.handler("on", ctx);

			expect(entries.at(-1)).toEqual({
				type: "custom",
				customType: SESSION_STATE_TYPE,
				data: { active: true, serviceTier: "priority" },
			});
			expect(readConfig(configPath)?.active).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("toggles the new-session default without changing the current session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-default-"));
		try {
			const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(dirname(configPath), { recursive: true });
			writeConfig(configPath, { active: false, persistState: false, serviceTier: "priority" });

			const entries: unknown[] = [];
			const commands: Record<string, { handler: Function }> = {};
			const events: Record<string, Function> = {};
			const notices: string[] = [];
			const pi = {
				registerProvider() {},
				appendEntry() {},
				registerCommand(name: string, command: { handler: Function }) {
					commands[name] = command;
				},
				on(name: string, handler: Function) {
					events[name] = handler;
				},
			};
			piFastMode(pi as never);

			const ctx = {
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				ui: {
					setStatus() {},
					notify(message: string) {
						notices.push(message);
					},
				},
				sessionManager: {
					getEntries: () => entries,
					getBranch: () => entries,
				},
			};
			await events.session_start?.({ reason: "new" }, ctx);
			await commands.fast?.handler("default on", ctx);

			expect(readConfig(configPath)?.active).toBe(true);
			expect(notices.at(-1)).toContain("default: on");
			expect(notices.at(-1)).toContain("for new sessions");
			await commands.fast?.handler("status", ctx);
			expect(notices.at(-1)).toContain("Fast mode is off");
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

			const entries: unknown[] = [
				{ type: "message", message: { role: "user", content: "old" } },
				{ type: "custom", customType: SESSION_STATE_TYPE, data: { active: true, serviceTier: "priority" } },
			];
			const statuses: Array<string | undefined> = [];
			const events: Record<string, Function> = {};
			const pi = {
				registerProvider() {},
				appendEntry() {},
				registerCommand() {},
				on(name: string, handler: Function) {
					events[name] = handler;
				},
			};
			piFastMode(pi as never);

			const ctx = {
				cwd: dir,
				model: codexModel("gpt-5.6-luna"),
				ui: {
					setStatus(_key: string, value: string | undefined) {
						statuses.push(value);
					},
					notify() {},
				},
				sessionManager: {
					getEntries: () => entries,
					getBranch: () => entries,
				},
			};
			await events.session_start?.({ reason: "resume" }, ctx);

			expect(statuses).toEqual(["⚡ FAST · $ 2.5×"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sends priority service_tier through the overlaid Codex provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-fast-mode-live-"));
		const configPath = join(dir, ".pi", "extensions", CONFIG_BASENAME);
		mkdirSync(dirname(configPath), { recursive: true });
		writeConfig(configPath, { active: false, persistState: false, serviceTier: "priority" });
		let body: Record<string, unknown> | undefined;
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(JSON.stringify({ error: { message: "captured" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		});
		try {
			const registrations: Array<{ config: { streamSimple: Function } }> = [];
			const commands: Record<string, { handler: Function }> = {};
			const events: Record<string, Function> = {};
			const pi = {
				registerFlag() {},
				appendEntry() {},
				registerProvider(_name: string, config: { streamSimple: Function }) {
					registrations.push({ config });
				},
				registerCommand(name: string, command: { handler: Function }) {
					commands[name] = command;
				},
				on(name: string, handler: Function) {
					events[name] = handler;
				},
				getFlag() {
					return true;
				},
			};
			piFastMode(pi as never);

			const model = {
				id: "gpt-5.6-luna",
				provider: "openai-codex",
				api: "openai-codex-responses" as const,
				baseUrl: `http://127.0.0.1:${server.port}`,
				maxTokens: 32_000,
				contextWindow: 272_000,
				reasoning: true,
				thinkingLevelMap: { minimal: "low" },
				input: ["text" as const],
				cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
			};
			const ctx = {
				cwd: dir,
				model,
				systemPrompt: "test",
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
				tools: [],
				ui: { setStatus() {}, notify() {} },
				sessionManager: {
					getEntries: () => [],
					getBranch: () => [],
				},
			};
			await events.session_start?.({}, ctx);
			await commands.fast?.handler("on", ctx);

			const payloadToken = Buffer.from(JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
			})).toString("base64url");
			const stream = registrations[0]!.config.streamSimple(model, ctx, {
				apiKey: `e30.${payloadToken}.sig`,
				transport: "sse",
				reasoning: "minimal",
				onPayload(payload: Record<string, unknown>) {
					body = payload;
					return payload;
				},
			});
			for await (const _event of stream) {}

			expect(body?.model).toBe("gpt-5.6-luna");
			expect(body?.service_tier).toBe("priority");
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("statusText", () => {
	const filter = buildModelFilter(SPECS, {});
	test("shows a compact fast indicator when applied", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), stateOn, SPECS, filter)).toBe("⚡ FAST · $ 2.5×");
	});
	test("stays empty when active but model is not allowed", () => {
		const f = buildModelFilter(SPECS, {});
		expect(statusText(codexModel("deepseek-v4-flash"), stateOn, SPECS, f)).toBe("");
	});
	test("empty when off", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), stateOff, SPECS, filter)).toBe("");
	});
	test("stays empty when the configured tier is unsupported", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), { active: true, serviceTier: "flex" }, SPECS, filter)).toBe("");
	});
});