import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream, InMemoryCredentialStore,
	type AssistantMessage, type Model, type Provider, type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import piFastMode, { CONFIG_BASENAME, STATUS_KEY, writeConfig, type ConfigFile } from "../extensions/index.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-luna", name: "Luna", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://example.invalid", input: ["text"], reasoning: true,
	contextWindow: 272_000, maxTokens: 32_000,
	cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
};
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function response(text: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text }], api: model.api,
		provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
		usage: {
			input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500_000,
			cost: { input: 7, output: 10, cacheRead: 0, cacheWrite: 0, total: 17 },
		},
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

async function fixture(
	factories: ExtensionFactory[], config: boolean | ConfigFile = false,
	setup?: (runtime: ModelRuntime) => void, selectedModel = model,
) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-fast-ownership-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	writeConfig(join(cwd, ".pi", "extensions", CONFIG_BASENAME), {
		persistState: false, ...(typeof config === "boolean" ? { active: config } : config),
	});
	const credentials = new InMemoryCredentialStore();
	const token = `e30.${Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "test" },
	})).toString("base64url")}.sig`;
	await credentials.modify(model.provider, async () => ({
		type: "oauth", access: token, refresh: "test", expires: Date.now() + 3_600_000,
	}));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	setup?.(runtime);
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", transport: "sse" }, { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: join(cwd, "agent"), settingsManager, extensionFactories: factories,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd, agentDir: join(cwd, "agent"), resourceLoader: loader, modelRuntime: runtime,
		model: selectedModel, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: "all",
	});
	cleanups.push(() => session.dispose());
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	const errors: unknown[] = [];
	await session.bindExtensions({
		uiContext: {
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			notify: (message: string) => { notices.push(message); },
		} as ExtensionUIContext,
		onError: error => { errors.push(error); },
	});
	return { session, runtime, credentials, registry: new ModelRegistry(runtime), statuses, notices, errors };
}

/** A native owner with receiver-sensitive methods and header-only auth. */
function nativeProvider() {
	const catalog = [model];
	const calls: StreamOptions[] = [];
	const owner: Provider = {
		id: model.provider,
		get name() { return `Native ${this.getModels().length}`; },
		auth: { apiKey: {
			name: "Workload identity",
			login: async () => ({ type: "api_key", key: "unused" }),
			check: async () => ({ type: "api_key", source: "workload identity" }),
			resolve: async () => ({
				auth: { headers: { Authorization: "workload" }, baseUrl: "https://native.invalid" },
				env: { NATIVE_ENV: "preserved" }, source: "workload identity",
			}),
		}, oauth: {
			name: "Native OAuth",
			login: async () => ({ type: "oauth", access: "unused", refresh: "unused", expires: Infinity }),
			refresh: async credential => credential,
			toAuth: async () => ({ headers: { Authorization: "workload" }, baseUrl: "https://native.invalid" }),
		} },
		getModels() { expect(this).toBe(owner); return catalog; },
		getAllModels() { expect(this).toBe(owner); return catalog; },
		refreshModels: async function () { expect(this).toBe(owner); },
		filterModels: function (models) { expect(this).toBe(owner); return models; },
		stream: function (request, _context, options) {
			expect(this).toBe(owner);
			expect(request.baseUrl).toBe("https://native.invalid");
			calls.push(options ?? {});
			return response("native full");
		},
		streamSimple: function (_model, _context, options) {
			expect(this).toBe(owner);
			calls.push(options ?? {});
			return response("native simple");
		},
		fetchDeferred: function () { expect(this).toBe(owner); return response("deferred"); },
		cancelDeferred: async function () { expect(this).toBe(owner); },
	};
	return { owner, catalog, calls };
}

/** The real stock API serializes requests; only the HTTP boundary is replaced. */
async function stockRequest(runtime: ModelRuntime, full = false) {
	let body: Record<string, unknown> | undefined;
	let headers = new Headers();
	const fetch = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
		headers = new Headers(init?.headers);
		return new Response(`data: ${JSON.stringify({
			type: "response.completed", response: {
				id: "resp_test", status: "completed", output: [], service_tier: body?.service_tier ?? "default",
				usage: { input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000 },
			},
		})}\n\n`, { headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof globalThis.fetch;
	const options = {
		fetch, transport: "sse" as const, reasoningEffort: "high" as const,
		onPayload(payload: unknown) { body = payload as Record<string, unknown>; },
	};
	const stream = full ? runtime.stream(model, context, options) : runtime.streamSimple(model, context, options);
	const result = await stream.result();
	expect(result.errorMessage).toBeUndefined();
	expect(result.stopReason).toBe("stop");
	return { body, headers, result };
}

describe("ModelRuntime provider ownership", () => {
	test.each(["existing", "before", "after"])("preserves a native owner (%s registration), even while /fast is off", async order => {
		const native = nativeProvider();
		const register: ExtensionFactory = pi => { pi.registerProvider(native.owner); };
		const f = await fixture(
			order === "existing" ? [piFastMode] : order === "before" ? [register, piFastMode] : [piFastMode, register],
			false,
			order === "existing" ? runtime => { runtime.registerNativeProvider(native.owner); } : undefined,
		);
		expect(f.runtime.getRegisteredNativeProvider(model.provider)).toBe(native.owner);
		expect(f.runtime.getProvider(model.provider)).toBe(native.owner);
		await f.credentials.delete(model.provider);
		expect((await f.runtime.stream(model, context).result()).content).toEqual([{ type: "text", text: "native full" }]);
		expect((await f.runtime.streamSimple(model, context).result()).usage.cost.total).toBe(17);
		expect(native.calls[0]?.headers).toEqual({ Authorization: "workload" });
		expect(native.calls[0]?.env).toEqual({ NATIVE_ENV: "preserved" });
		await f.session.prompt("/fast on");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		expect(f.runtime.getRegisteredNativeProvider(model.provider)).toBe(native.owner);
		native.catalog.push({ ...model, id: "dynamic" });
		await f.runtime.refresh({ allowNetwork: false, providers: [model.provider] });
		expect(f.runtime.getModel(model.provider, "dynamic")?.id).toBe("dynamic");
		const handle = { provider: model.provider, modelId: model.id, api: model.api, id: "test" };
		expect((await f.runtime.fetchDeferred(model, handle)).content).toEqual([{ type: "text", text: "deferred" }]);
		await f.runtime.cancelDeferred(model, handle);
		f.session.dispose();
		expect(f.runtime.getRegisteredNativeProvider(model.provider)).toBe(native.owner);
		expect(f.errors).toEqual([]);
	});

	test.each(["before", "after"])("does not replace a legacy stream registered %s loading", async order => {
		const streamSimple = () => response("legacy");
		const register: ExtensionFactory = pi => {
			pi.registerProvider(model.provider, { api: model.api, apiKey: "legacy-key", streamSimple });
		};
		const f = await fixture(order === "before" ? [register, piFastMode] : [piFastMode, register]);
		expect(f.registry.getRegisteredProviderConfig(model.provider)?.streamSimple).toBe(streamSimple);
		expect((await f.runtime.stream(model, context).result()).usage.cost.total).toBe(17);
		expect((await f.runtime.streamSimple(model, context).result()).content).toEqual([{ type: "text", text: "legacy" }]);
		await f.session.prompt("/fast on");
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.errors).toEqual([]);
	});

	test("standard Codex tiers/prices both entry points only while on and restores on SDK dispose", async () => {
		const f = await fixture([piFastMode]);
		const initial = await stockRequest(f.runtime, true);
		expect(initial.body?.service_tier).toBeUndefined();
		expect(initial.result.usage.cost.total).toBeCloseTo(0.8);
		await f.session.prompt("/fast on");
		for (const full of [false, true]) {
			const { body, result } = await stockRequest(f.runtime, full);
			expect(body?.service_tier).toBe("priority");
			if (full) expect(body?.reasoning).toEqual({ effort: "high", summary: "auto" });
			expect(result.usage.cost.total).toBeCloseTo(2);
			expect(result.usage.input).toBe(1_000_000);
		}
		expect(f.statuses.get(STATUS_KEY)).toContain("2.5×");
		await f.session.prompt("/fast off");
		const inactive = await stockRequest(f.runtime, true);
		expect(inactive.body?.service_tier).toBeUndefined();
		expect(inactive.result.usage.cost.total).toBeCloseTo(0.8);
		expect(inactive.body?.reasoning).toEqual({ effort: "high", summary: "auto" });
		await f.session.prompt("/fast on");
		f.session.dispose(); // No session_shutdown event on this SDK path.
		expect(f.registry.getRegisteredProviderConfig(model.provider)).toBeUndefined();
		expect((await stockRequest(f.runtime, true)).body?.service_tier).toBeUndefined();
		expect(f.errors).toEqual([]);
	});

	test.each([
		["included-quota", 2.5], ["credits", 2],
	] as const)("%s pricing precedes independent usage adjustments and survives session accounting", async (billingBasis, multiplier) => {
		let body: Record<string, unknown> | undefined;
		const server = Bun.serve({ port: 0, async fetch(request) {
			const bytes = new Uint8Array(await request.arrayBuffer());
			body = JSON.parse(new TextDecoder().decode(
				request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes,
			)) as Record<string, unknown>;
			return new Response(`data: ${JSON.stringify({
				type: "response.completed", response: {
					id: "resp_basis", status: "completed", output: [], service_tier: "priority",
					usage: { input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000 },
				},
			})}\n\n`, { headers: { "content-type": "text/event-stream" } });
		} });
		cleanups.push(() => server.stop(true));
		const beforeAdjustment: number[] = [];
		const adjustUsage: ExtensionFactory = pi => {
			pi.on("message_end", event => {
				if (event.message.role !== "assistant") return;
				const { cost } = event.message.usage;
				beforeAdjustment.push(cost.total);
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) cost[key] *= 1.3;
			});
		};
		const f = await fixture([piFastMode, adjustUsage], { active: true, billingBasis }, undefined, {
			...model, id: "gpt-6-luna", baseUrl: `http://127.0.0.1:${server.port}`,
		});
		await f.session.prompt("hello");
		expect(body?.model).toBe("gpt-6-luna");
		expect(body?.service_tier).toBe("priority");
		expect(beforeAdjustment).toHaveLength(1);
		expect(beforeAdjustment[0]).toBeCloseTo(0.8 * multiplier);
		const message = f.session.messages.findLast(message => message.role === "assistant");
		expect(message?.role).toBe("assistant");
		if (message?.role !== "assistant") throw new Error("Missing assistant result");
		expect(message.usage.cost.total).toBeCloseTo(0.8 * multiplier * 1.3);
		expect(message.usage.input).toBe(1_000_000);
		await f.session.prompt("/fast status");
		expect(f.session.getSessionStats().cost).toBeCloseTo(0.8 * multiplier * 1.3);
		expect(f.statuses.get(STATUS_KEY)).toBe(`· ⚡ FAST · ${multiplier}×`);
		expect(f.notices.at(-1)).toContain(billingBasis === "credits" ? "credits/Enterprise PAYG" : "included quota");
		expect(f.errors).toEqual([]);
	});

	test("eligibility follows the dispatched Codex model, not the selected model", async () => {
		const f = await fixture([piFastMode], true, undefined, { ...model, id: "non-listed" });
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect((await stockRequest(f.runtime)).body?.service_tier).toBe("priority");
		expect(f.errors).toEqual([]);
	});

	test("static legacy configuration and later metadata changes survive activation and cleanup", async () => {
		const original = {
			api: model.api, apiKey: "configured", name: "Static Codex",
			headers: { "x-provider": "preserved" },
			models: [{ ...model, headers: { "x-model": "preserved" } }],
		};
		const f = await fixture([pi => { pi.registerProvider(model.provider, original); }, piFastMode]);
		await f.session.prompt("/fast on");
		const { body, headers } = await stockRequest(f.runtime, true);
		expect(body?.service_tier).toBe("priority");
		expect(headers.get("x-provider")).toBe("preserved");
		expect(headers.get("x-model")).toBe("preserved");
		f.runtime.registerProvider(model.provider, { name: "Updated Codex" });
		await f.session.prompt("/fast off");
		expect(f.registry.getRegisteredProviderConfig(model.provider)).toMatchObject({ ...original, name: "Updated Codex" });
		const inactive = await stockRequest(f.runtime, true);
		expect(inactive.body?.service_tier).toBeUndefined();
		expect(inactive.result.usage.cost.total).toBeCloseTo(0.8);
		await f.session.prompt("/fast on");
		f.session.dispose();
		expect(f.registry.getRegisteredProviderConfig(model.provider)).toEqual({ ...original, name: "Updated Codex" });
		expect(f.errors).toEqual([]);
	});

	test("an active startup leaves mutable legacy catalogs alone", async () => {
		let generation = 0;
		const refreshModels = async () => [{ ...model, name: `Catalog ${++generation}` }];
		const f = await fixture([
			pi => { pi.registerProvider(model.provider, { api: model.api, refreshModels }); }, piFastMode,
		], true);
		const registered = f.registry.getRegisteredProviderConfig(model.provider);
		expect(registered?.refreshModels).toBe(refreshModels);
		expect(registered?.streamSimple).toBeUndefined();
		await f.runtime.refresh({ allowNetwork: false, providers: [model.provider] });
		expect(f.runtime.getModel(model.provider, model.id)?.name).toMatch(/^Catalog /);
		await f.session.prompt("/fast status");
		expect(f.registry.getRegisteredProviderConfig(model.provider)).toBe(registered);
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.errors).toEqual([]);
	});

	test("an active startup reports a queued native owner instead of claiming priority", async () => {
		const native = nativeProvider();
		const f = await fixture([piFastMode, pi => { pi.registerProvider(native.owner); }], true);
		expect(f.registry.getRegisteredNativeProvider(model.provider)).toBe(native.owner);
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		expect(f.errors).toEqual([]);
	});

	test("a native replacement before a real agent turn clears the fast footer", async () => {
		const native = nativeProvider();
		const f = await fixture([piFastMode, pi => {
			pi.on("before_agent_start", () => { pi.registerProvider(native.owner); });
		}], true);
		await f.session.prompt("hello");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.registry.getRegisteredNativeProvider(model.provider)).toBe(native.owner);
		expect(f.session.getLastAssistantText()).toBe("native simple");
		expect(f.errors).toEqual([]);
	});

	test("changing the legacy API deactivates the handler without erasing the successor", async () => {
		const f = await fixture([piFastMode], true);
		f.runtime.registerProvider(model.provider, { api: "openai-responses" });
		await f.session.prompt("/fast status");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		expect((await stockRequest(f.runtime, true)).body?.service_tier).toBeUndefined();
		f.session.dispose();
		expect(f.registry.getRegisteredProviderConfig(model.provider)?.api).toBe("openai-responses");
		expect(f.errors).toEqual([]);
	});

	test("a late native replacement is not reclaimed and status reports the conflict", async () => {
		const f = await fixture([piFastMode], true);
		const native = nativeProvider();
		f.runtime.registerNativeProvider(native.owner);
		await f.credentials.delete(model.provider);
		await f.session.prompt("/fast status");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		expect((await f.runtime.streamSimple(model, context).result()).usage.cost.total).toBe(17);
		f.session.dispose();
		expect(f.runtime.getRegisteredNativeProvider(model.provider)).toBe(native.owner);
		expect(f.errors).toEqual([]);
	});

	test("a temporary ownership conflict retains the overlay for recovery and disposal", async () => {
		const f = await fixture([piFastMode], true);
		const original = f.registry.getRegisteredProviderConfig(model.provider)!;
		const temporary: NonNullable<typeof original.streamSimple> = (request, transcript, options) =>
			original.streamSimple!(request, transcript, options);
		f.runtime.registerProvider(model.provider, { api: model.api, streamSimple: temporary });
		await f.session.prompt("/fast status");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect((await stockRequest(f.runtime)).body?.service_tier).toBeUndefined();
		f.runtime.registerProvider(model.provider, { api: model.api, streamSimple: original.streamSimple });
		await f.session.prompt("/fast status");
		expect(f.statuses.get(STATUS_KEY)).toContain("2.5×");
		expect(f.notices.at(-1)).toContain("Fast mode: priority service tier");
		const recovered = await stockRequest(f.runtime);
		expect(recovered.body?.service_tier).toBe("priority");
		expect(recovered.result.usage.cost.total).toBeCloseTo(2);
		f.session.dispose();
		expect(f.registry.getRegisteredProviderConfig(model.provider)).toBeUndefined();
		expect((await stockRequest(f.runtime)).body?.service_tier).toBeUndefined();
		expect(f.errors).toEqual([]);
	});

	test.each([
		["shutdown", "fast-first"], ["dispose", "fast-first"],
		["shutdown", "observer-first"], ["dispose", "observer-first"],
	] as const)("cooperates with the marked observer through toggles and %s (%s)", async (lifecycle, order) => {
		const baseline = { name: "Configured Codex", headers: { "x-config": "preserved" } };
		const f = await fixture([pi => { pi.registerProvider(model.provider, baseline); }, piFastMode]);
		const delegate = f.registry.getRegisteredProviderConfig(model.provider)!.streamSimple!;
		let observed = 0;
		let released = 0;
		const observer: typeof delegate = (request, transcript, options) => delegate(request, transcript, {
			...options, onPayload: async (payload, requestModel) => {
				observed += 1;
				return await options?.onPayload?.(payload, requestModel) ?? payload;
			},
		});
		const release = () => {
			if (f.registry.getRegisteredProviderConfig(model.provider)?.streamSimple !== observer) return;
			released += 1;
			f.runtime.registerProvider(model.provider, { api: model.api, streamSimple: delegate });
		};
		Object.defineProperty(observer, Symbol.for("@nijaru/pi-provider-compaction/stream-observer"), {
			value: { delegate, release },
		});
		f.runtime.registerProvider(model.provider, { api: model.api, streamSimple: observer });

		// Compaction must be able to observe ordinary requests before /fast on.
		const initial = await stockRequest(f.runtime);
		expect(initial.body?.service_tier).toBeUndefined();
		expect(initial.result.usage.cost.total).toBeCloseTo(0.8);
		expect(observed).toBe(1);
		await f.session.prompt("/fast on");
		for (const full of [false, true]) {
			const { body, result } = await stockRequest(f.runtime, full);
			expect(body?.service_tier).toBe("priority");
			expect(result.usage.cost.total).toBeCloseTo(2);
			expect(result.usage.input).toBe(1_000_000);
		}
		await f.session.prompt("/fast status");
		expect(f.statuses.get(STATUS_KEY)).toContain("2.5×");
		expect(f.notices.at(-1)).toContain("Fast mode: priority service tier");
		await f.session.prompt("/fast off");
		const inactive = await stockRequest(f.runtime);
		expect(inactive.body?.service_tier).toBeUndefined();
		expect(inactive.result.usage.cost.total).toBeCloseTo(0.8);
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		await f.session.prompt("/fast on");
		const activeAgain = await stockRequest(f.runtime);
		expect(activeAgain.body?.service_tier).toBe("priority");
		expect(activeAgain.result.usage.cost.total).toBeCloseTo(2);
		expect(f.statuses.get(STATUS_KEY)).toContain("2.5×");
		expect(observed).toBe(5);
		expect(released).toBe(0);
		expect(f.registry.getRegisteredProviderConfig(model.provider)?.streamSimple).toBe(observer);

		f.runtime.registerProvider(model.provider, { name: "Later metadata" });
		if (order === "observer-first") release();
		if (lifecycle === "shutdown") {
			await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		}
		f.session.dispose(); // Also proves cleanup is idempotent after shutdown.
		expect(released).toBe(1);
		expect(f.registry.getRegisteredProviderConfig(model.provider)).toEqual({ ...baseline, name: "Later metadata" });
		const retired = await stockRequest(f.runtime);
		expect(retired.body?.service_tier).toBeUndefined();
		expect(retired.result.usage.cost.total).toBeCloseTo(0.8);
		expect(observed).toBe(5);
		expect(f.errors).toEqual([]);
	});

	test.each(["unmarked", "different delegate"])("a %s legacy observer fails closed without being overwritten", async marker => {
		const f = await fixture([piFastMode], true);
		const previous = f.registry.getRegisteredProviderConfig(model.provider)!;
		let observed = false;
		const observer: NonNullable<typeof previous.streamSimple> = (request, transcript, options) =>
			previous.streamSimple!(request, transcript, {
				...options, onPayload: async (payload, requestModel) => {
					observed = true;
					return await options?.onPayload?.(payload, requestModel) ?? payload;
				},
			});
		let released = false;
		if (marker === "different delegate") {
			Object.defineProperty(observer, Symbol.for("@nijaru/pi-provider-compaction/stream-observer"), {
				value: { delegate: previous.streamSimple!.bind(undefined), release() { released = true; } },
			});
		}
		f.runtime.registerProvider(model.provider, { api: model.api, streamSimple: observer });
		const { body, result } = await stockRequest(f.runtime);
		expect(observed).toBe(true);
		expect(body?.service_tier).toBeUndefined();
		expect(result.usage.cost.total).toBeCloseTo(0.8);
		await f.session.prompt("/fast status");
		expect(f.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(f.notices.at(-1)).toContain("inactive: another provider or stream owns");
		f.session.dispose();
		expect(f.registry.getRegisteredProviderConfig(model.provider)?.streamSimple).toBe(observer);
		expect(released).toBe(false);
		expect(f.errors).toEqual([]);
	});
});
