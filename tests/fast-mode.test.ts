import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	buildModelFilter,
	builtinServiceTierMultiplier,
	costCorrectionFactor,
	CONFIG_BASENAME,
	DEFAULT_FAST_MODE_MODELS,
	isModelAllowed,
	OFFICIAL_FAST_MULTIPLIER,
	parseModelKey,
	readConfig,
	resolveConfig,
	resolveServiceTierForModel,
	SPECS,
	statusText,
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
			const config = resolveConfig(dir);
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

describe("pricing correction", () => {
	test("official multipliers per rate card", () => {
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.6-sol"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.6-terra"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.6-luna"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.5"]).toBe(2.5);
		expect(OFFICIAL_FAST_MULTIPLIER["gpt-5.4"]).toBe(2);
	});

	test("builtin multiplier mirrors pi-ai (2.5 only for gpt-5.5)", () => {
		expect(builtinServiceTierMultiplier("gpt-5.5")).toBe(2.5);
		expect(builtinServiceTierMultiplier("gpt-5.6-luna")).toBe(2);
		expect(builtinServiceTierMultiplier("gpt-5.4")).toBe(2);
	});

	test("correction factor is 1.25 for GPT-5.6, 1 for 5.4/5.5, 1 for non-rated models", () => {
		expect(costCorrectionFactor("gpt-5.6-luna", "priority")).toBe(1.25);
		expect(costCorrectionFactor("gpt-5.6-sol", "priority")).toBe(1.25);
		expect(costCorrectionFactor("gpt-5.5", "priority")).toBe(1);
		expect(costCorrectionFactor("gpt-5.4", "priority")).toBe(1);
		expect(costCorrectionFactor("deepseek-v4-flash", "priority")).toBe(1);
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
			const config = resolveConfig(dir);
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

describe("statusText", () => {
	const filter = buildModelFilter(SPECS, {});
	test("shows FAST with model and multiplier when applied", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), stateOn, SPECS, filter)).toBe("FAST gpt-5.6-luna 2.5x");
	});
	test("shows unsupported-model notice when active but not allowed", () => {
		const f = buildModelFilter(SPECS, {});
		expect(statusText(codexModel("deepseek-v4-flash"), stateOn, SPECS, f)).toBe(
			"fast mode: unsupported model (openai-codex/deepseek-v4-flash)",
		);
	});
	test("empty when off", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), stateOff, SPECS, filter)).toBe("");
	});
	test("tier-unsupported message when model is allowed but api rejects the configured tier", () => {
		expect(statusText(codexModel("gpt-5.6-luna"), { active: true, serviceTier: "flex" }, SPECS, filter)).toBe(
			"fast mode: flex tier unsupported on openai-codex-responses",
		);
	});
});