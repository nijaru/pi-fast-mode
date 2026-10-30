import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("loads the package through Pi's Node extension loader", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fast-node-load-"));
	try {
		const result = spawnSync("node", ["--input-type=module", "--eval", `
			import assert from "node:assert/strict";
			import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
			const loader = new DefaultResourceLoader({
				cwd: process.env.PI_CODING_AGENT_DIR, agentDir: process.env.PI_CODING_AGENT_DIR,
				settingsManager: SettingsManager.inMemory({ packages: [process.cwd()] }),
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			assert.deepEqual(loaded.warnings ?? [], []);
			assert.equal(loaded.extensions.length, 1);
			assert.ok(loaded.extensions[0].commands.has("fast"));
		`], {
			cwd: resolve(import.meta.dir, ".."),
			env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8", timeout: 15_000,
		});
		expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
