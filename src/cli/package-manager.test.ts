import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectPackageManager, getSkillsRunner } from "./package-manager.ts";

function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwg-pm-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("detectPackageManager", () => {
  it("prefers devEngines.packageManager.name from the working directory over the invoking runner", () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({
        devEngines: { packageManager: { name: "pnpm", version: "^11.17.0", onFail: "download" } },
      }),
    });
    try {
      // Reproduces #3617: invoked via npx inside a pnpm-enforced repo.
      assert.strictEqual(
        detectPackageManager(dir, { npm_config_user_agent: "npm/12.0.2 node/v24.21.0" }),
        "pnpm",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads devEngines.packageManager.name for yarn repos", () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({
        devEngines: { packageManager: { name: "yarn", version: "^4.0.0", onFail: "error" } },
      }),
    });
    try {
      assert.strictEqual(detectPackageManager(dir, {}), "yarn");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the corepack packageManager field when devEngines is absent", () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({ packageManager: "pnpm@10.30.3" }),
    });
    try {
      assert.strictEqual(detectPackageManager(dir, {}), "pnpm");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to lockfiles in the working directory", () => {
    const pnpmDir = makeTempDir({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const yarnDir = makeTempDir({ "yarn.lock": "# yarn lockfile v1\n" });
    const npmDir = makeTempDir({ "package-lock.json": "{\"lockfileVersion\": 3}" });
    try {
      assert.strictEqual(detectPackageManager(pnpmDir, {}), "pnpm");
      assert.strictEqual(detectPackageManager(yarnDir, {}), "yarn");
      assert.strictEqual(detectPackageManager(npmDir, {}), "npm");
    } finally {
      fs.rmSync(pnpmDir, { recursive: true, force: true });
      fs.rmSync(yarnDir, { recursive: true, force: true });
      fs.rmSync(npmDir, { recursive: true, force: true });
    }
  });

  it("falls back to npm_config_user_agent when the directory gives no signal", () => {
    const dir = makeTempDir({});
    try {
      assert.strictEqual(
        detectPackageManager(dir, { npm_config_user_agent: "pnpm/11.25.0 npm/? node/v24.21.0" }),
        "pnpm",
      );
      assert.strictEqual(
        detectPackageManager(dir, { npm_config_user_agent: "yarn/4.0.0 npm/? node/v24.21.0" }),
        "yarn",
      );
      assert.strictEqual(
        detectPackageManager(dir, { npm_config_user_agent: "npm/12.0.2 node/v24.21.0" }),
        "npm",
      );
      assert.strictEqual(detectPackageManager(dir, {}), "npm");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores unknown package managers and malformed package.json files", () => {
    const unknownDir = makeTempDir({
      "package.json": JSON.stringify({ devEngines: { packageManager: { name: "bun", version: "1.0.0" } } }),
    });
    const malformedDir = makeTempDir({ "package.json": "{ not json" });
    try {
      assert.strictEqual(detectPackageManager(unknownDir, {}), "npm");
      assert.strictEqual(detectPackageManager(malformedDir, {}), "npm");
    } finally {
      fs.rmSync(unknownDir, { recursive: true, force: true });
      fs.rmSync(malformedDir, { recursive: true, force: true });
    }
  });
});

describe("getSkillsRunner", () => {
  it("keeps npx -y for npm", () => {
    assert.deepStrictEqual(getSkillsRunner("npm", ["update", "modern-web-guidance"]), {
      command: "npx",
      args: ["-y", "skills", "update", "modern-web-guidance"],
    });
  });

  it("uses pnpm dlx without -y for pnpm", () => {
    assert.deepStrictEqual(getSkillsRunner("pnpm", ["update", "modern-web-guidance"]), {
      command: "pnpm",
      args: ["dlx", "skills", "update", "modern-web-guidance"],
    });
  });

  it("uses yarn dlx without -y for yarn", () => {
    assert.deepStrictEqual(getSkillsRunner("yarn", ["update", "modern-web-guidance"]), {
      command: "yarn",
      args: ["dlx", "skills", "update", "modern-web-guidance"],
    });
  });
});
