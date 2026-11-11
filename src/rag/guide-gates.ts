import fs from "node:fs";
import path from "node:path";
import { FEATURE_GATES, type FeatureGateId } from "../core/feature-gates.ts";
import { resolveSkillsCliDataDir } from "./data-dir.ts";

/**
 * What `retrieve <guideId>` will demand before returning a guide.
 * Mirrors the gate checks in `retrieveUseCase` (`./retrieve.ts`) so
 * `legacy-scan` can warn about a gated guide instead of sending the
 * consumer to a retrieve that exits 1. The gate itself is unchanged:
 * this only reports it; opting in still requires the unlock command.
 */
export interface GuideGateInfo {
  readonly gate: FeatureGateId;
  readonly features: readonly string[];
  readonly optInKey: "allowOriginTrials" | "allowVolatileFeatures";
  readonly unlockCommand: string;
  readonly headingLabel: string;
}

interface GuideGateEntry {
  id: string;
  originTrials?: Array<{ id: string }>;
  volatileFeatures?: Array<{ id: string }>;
}

function readGuideEntries(dataDir: string): GuideGateEntry[] | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir, "gen", "guides.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GuideGateEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the retrieve gate for a guide, or `undefined` when the guide is
 * retrievable without opt-in, unknown, or the built guide data is absent.
 * Never throws: a scan must stay usable without a build.
 */
export function getGuideGateInfo(guideId: string, dataDir?: string): GuideGateInfo | undefined {
  const entries = readGuideEntries(dataDir ?? resolveSkillsCliDataDir());
  const useCase = entries?.find((entry) => entry?.id === guideId);
  if (!useCase) {
    return undefined;
  }
  // Same precedence as retrieveUseCase: origin trials first, then volatile features.
  for (const gate of ["origin-trials", "volatile-features"] as const) {
    const spec = FEATURE_GATES[gate];
    const items = gate === "origin-trials" ? useCase.originTrials : useCase.volatileFeatures;
    const ids = (items ?? []).map((feature) => feature.id).filter(Boolean);
    if (ids.length > 0) {
      return {
        gate,
        features: ids,
        optInKey: spec.optInKey,
        unlockCommand: `npx modern-web-guidance@latest ${spec.cliCommand}`,
        headingLabel: spec.headingLabel,
      };
    }
  }
  return undefined;
}
