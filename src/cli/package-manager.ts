import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface SkillsRunner {
  command: string;
  args: string[];
}

const KNOWN_MANAGERS: readonly string[] = ["npm", "pnpm", "yarn"];

function asPackageManager(name: unknown): PackageManager | undefined {
  return typeof name === "string" && (KNOWN_MANAGERS as readonly string[]).includes(name)
    ? (name as PackageManager)
    : undefined;
}

/**
 * Reads the package manager declared by the working directory's package.json:
 * `devEngines.packageManager.name` first, then the corepack `packageManager`
 * field (e.g. "pnpm@10.30.3"). Returns undefined when nothing usable is declared.
 */
function readPackageJsonManager(cwd: string): PackageManager | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      devEngines?: { packageManager?: { name?: unknown } };
      packageManager?: unknown;
    };
    return (
      asPackageManager(pkg.devEngines?.packageManager?.name) ??
      asPackageManager(
        typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined,
      )
    );
  } catch {
    return undefined;
  }
}

/** Infers the package manager from the lockfile present in the working directory. */
function readLockfileManager(cwd: string): PackageManager | undefined {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return undefined;
}

/**
 * Infers the package manager that invoked the current process from
 * `npm_config_user_agent` (e.g. "pnpm/11.25.0 npm/? node/v24.21.0").
 */
function readUserAgentManager(userAgent: string | undefined): PackageManager | undefined {
  return asPackageManager(userAgent?.split(" ")[0]?.split("/")[0]);
}

/**
 * Detects the package manager that owns the current working directory.
 *
 * Precedence is deliberate: the spawned `skills` runner executes in `cwd`, so
 * `cwd`'s own declarations win over how this CLI was invoked. A repo whose
 * package.json declares `devEngines.packageManager: pnpm` fails under a
 * hardcoded `npx` spawn with npm's EBADDEVENGINES check (issue #3617) even
 * when the user ran this CLI via `pnpm dlx` — the user agent alone cannot
 * fix that case. Falls back to the invoking runner, then npm.
 */
export function detectPackageManager(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  return (
    readPackageJsonManager(cwd) ??
    readLockfileManager(cwd) ??
    readUserAgentManager(env.npm_config_user_agent) ??
    "npm"
  );
}

/**
 * Builds the command that runs the `skills` CLI under the given package
 * manager. npm needs `-y` so `npx` does not prompt before installing;
 * `pnpm dlx` / `yarn dlx` take no such flag (pnpm's `pnpx` does not use
 * `-y` — see SKILL.md), so it is omitted for them.
 */
export function getSkillsRunner(pm: PackageManager, skillsArgs: string[]): SkillsRunner {
  switch (pm) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", "skills", ...skillsArgs] };
    case "yarn":
      return { command: "yarn", args: ["dlx", "skills", ...skillsArgs] };
    default:
      return { command: "npx", args: ["-y", "skills", ...skillsArgs] };
  }
}
