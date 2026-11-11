import { getGuide, getUseCase, type UseCase } from "./guides.ts";
import { logToolResult } from "./logger.ts";
import { readMwgrc, normalizeBaselineTarget } from "../core/mwgrc.ts";
import { FEATURE_GATES, type FeatureGateId } from "../core/feature-gates.ts";

export class FeatureGateError extends Error {
  readonly gateKey: "allowOriginTrials" | "allowVolatileFeatures";

  constructor(message: string, gateKey: "allowOriginTrials" | "allowVolatileFeatures") {
    super(message);
    this.name = "FeatureGateError";
    this.gateKey = gateKey;
  }
}

export class OriginTrialGateError extends FeatureGateError {
  constructor(message: string) {
    super(message, "allowOriginTrials");
    this.name = "OriginTrialGateError";
  }
}

export class VolatileFeatureGateError extends FeatureGateError {
  constructor(message: string) {
    super(message, "allowVolatileFeatures");
    this.name = "VolatileFeatureGateError";
  }
}

export function formatBaselineTargetBanner(rawBaseline: string | undefined): string {
  const normalized = normalizeBaselineTarget(rawBaseline);
  if (!normalized || normalized === "widely") {
    return "";
  }
  if (normalized === "newly") {
    return `> [!IMPORTANT]\n> **Project Baseline Target (\`.mwgrc\`):** \`newly\` (Baseline Newly available). Features that are **Baseline Newly available** or **Widely available** satisfy this project's browser support target — **omit** compatibility fallbacks, \`@supports not (...)\` blocks, and polyfills for them. Only implement fallbacks for features with **Limited availability**.\n\n`;
  }
  if (normalized === "limited") {
    return `> [!IMPORTANT]\n> **Project Baseline Target (\`.mwgrc\`):** \`limited\` (Limited availability). All features covered in this guide (including **Limited availability** and **Newly available** features) satisfy this project's browser support target. **Skip the \`## Fallback strategies\` section** — **do not** add compatibility fallbacks, \`@supports not (...)\` blocks, or polyfills.\n\n`;
  }
  return `> [!IMPORTANT]\n> **Project Baseline Target (\`.mwgrc\`):** \`Baseline ${normalized}\`. Features with a "Baseline since" date of \`${normalized}-12-31\` or earlier satisfy this project's browser support target — **omit** compatibility fallbacks, \`@supports not (...)\` blocks, and polyfills for them.\n\n`;
}

interface GateMessageParams {
  guideId: string;
  featureIds: string;
  optInKey: "allowOriginTrials" | "allowVolatileFeatures";
  cliCommand: "set-allow-origin-trials" | "set-allow-volatile-features";
  headingLabel: string;
  guideSummary: string;
  verb: "is" | "are";
  riskAdjective: string;
  explicitOptOut: boolean;
}

function formatGateMessage({
  guideId,
  featureIds,
  optInKey,
  cliCommand,
  headingLabel,
  guideSummary,
  verb,
  riskAdjective,
  explicitOptOut,
}: GateMessageParams): string {
  const fullCommand = `npx modern-web-guidance@latest ${cliCommand}`;
  if (explicitOptOut) {
    return `> [!CAUTION]
>
> **Project policy explicitly disables ${headingLabel} (\`.mwgrc\` sets \`"${optInKey}": false\`).** Never bypass this gate (do not edit \`.mwgrc\`, run \`${cliCommand}\` yourself, or read raw \`.md\` guide files from disk), and do not adopt ${featureIds}.
>
> Guide \`${guideId}\` covers ${guideSummary}, which ${verb} disabled by this project's \`.mwgrc\` configuration. Implement a standard cross-browser approach instead, and add a bullet for \`${guideId}\` under \`### Modern Web Guidance\` noting that ${featureIds} ${verb} disabled by \`.mwgrc\` (a human developer can enable it via \`${fullCommand}\`).`;
  }
  return `> [!CAUTION]
>
> **${headingLabel.charAt(0).toUpperCase()}${headingLabel.slice(1)} require explicit project opt-in.** Never bypass this gate (do not run \`${cliCommand}\` yourself, edit \`.mwgrc\`, or read raw \`.md\` guide files from disk). Only adopt ${featureIds} without this guide if the user explicitly named that specific API/feature — if the user only described a general product or UX goal, implement a standard cross-browser solution instead without using ${featureIds}.
>
> Guide \`${guideId}\` covers ${guideSummary}, which ${verb} ${riskAdjective} and may still change. Ask the user if they want to opt in by running this command in their terminal:
>
> \`\`\`sh
> ${fullCommand}
> \`\`\`
>
> If you still write ${featureIds} code without this guide (whether from model memory or external documentation), you MUST still add a bullet for \`${guideId}\` under your final \`### Modern Web Guidance\` section including the exact unlock command \`${fullCommand}\` and noting that unverified ${featureIds} code risks being outdated or incomplete.`;
}

export async function retrieveUseCase(useCaseId: string, options?: { cwd?: string }): Promise<string> {
  const useCase = getUseCase(useCaseId);
  if (!useCase) {
    throw new Error(`No guide found for use case: ${useCaseId}`);
  }

  const originTrials = useCase.originTrials ?? [];
  const volatileFeatures = useCase.volatileFeatures ?? [];
  const config = readMwgrc(options?.cwd);

  if (originTrials.length > 0 || volatileFeatures.length > 0) {
    const gateChecks = [
      {
        spec: FEATURE_GATES["origin-trials"],
        items: originTrials,
        ErrorClass: OriginTrialGateError,
      },
      {
        spec: FEATURE_GATES["volatile-features"],
        items: volatileFeatures,
        ErrorClass: VolatileFeatureGateError,
      },
    ] as const;

    // Gates the project has not opted into. An explicit opt-out (`false`) still
    // rejects outright; an unconfigured gate may serve the guide's stable
    // sections instead (see serveStableSubset).
    const pendingGates: GateCheck[] = [];
    for (const { spec, items, ErrorClass } of gateChecks) {
      if (items.length === 0 || config[spec.optInKey] === true) {
        continue;
      }
      if (config[spec.optInKey] === false) {
        throw new ErrorClass(
          formatGateMessage({
            guideId: useCaseId,
            featureIds: items.map((f) => f.id).join(", "),
            optInKey: spec.optInKey,
            cliCommand: spec.cliCommand,
            headingLabel: spec.headingLabel,
            guideSummary: spec.formatSummary(items as any),
            verb: items.length === 1 ? "is" : "are",
            riskAdjective: spec.riskAdjective,
            explicitOptOut: true,
          }),
        );
      }
      pendingGates.push({ spec, items, ErrorClass });
    }
    if (pendingGates.length > 0) {
      const partial = await serveStableSubset(useCase, pendingGates, config);
      if (partial !== null) {
        return partial;
      }
      const { spec, items, ErrorClass } = pendingGates[0];
      throw new ErrorClass(
        formatGateMessage({
          guideId: useCaseId,
          featureIds: items.map((f) => f.id).join(", "),
          optInKey: spec.optInKey,
          cliCommand: spec.cliCommand,
          headingLabel: spec.headingLabel,
          guideSummary: spec.formatSummary(items as any),
          verb: items.length === 1 ? "is" : "are",
          riskAdjective: spec.riskAdjective,
          explicitOptOut: false,
        }),
      );
    }
  }

  const guide = await getGuide(useCaseId);
  if (!guide) {
    throw new Error(`No guide found for use case: ${useCaseId}`);
  }

  logToolResult("get_best_practices", [{ id: useCaseId }]);

  const banner = formatBaselineTargetBanner(
    typeof config.baseline === "string" ? config.baseline : undefined
  );
  return banner + guide;
}

interface GateCheck {
  spec: (typeof FEATURE_GATES)[FeatureGateId];
  items: readonly { id: string }[];
  ErrorClass: new (message: string) => FeatureGateError;
}

/**
 * Normalizes a heading text for comparison with a `volatile-sections` entry:
 * strips inline code / emphasis / link markup, collapses whitespace, lowercases.
 * Mirrors `normalizeHeadingText` in `src/core/guide-validation.ts`; keep the
 * two in sync.
 */
export function normalizeHeadingText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface GuideSection {
  /** Normalized texts of the headings in the section, in order. */
  headings: string[];
  /** Raw markdown of the section, byte-identical to the source slice. */
  text: string;
}

const HEADING_LINE_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/;

/**
 * Splits built guide markdown into heading-grouped sections, mirroring
 * `chunkMarkdown` in `src/core/guide-chunks.ts`: a heading starts a new
 * section only once the current section already has body text, so consecutive
 * headings without body text stay together. Headings inside fenced code blocks
 * never split. Joining every section's text with "\n" reproduces the input
 * exactly. Deliberately dependency-free so the retrieve path stays free of
 * the `marked` / `web-features` import graph.
 */
export function splitGuideSections(markdown: string): GuideSection[] {
  const sections: GuideSection[] = [];
  let lines: string[] = [];
  let headings: string[] = [];
  let hasBody = false;
  let inFence = false;

  const flush = () => {
    if (lines.length > 0) {
      sections.push({ headings, text: lines.join("\n") });
      lines = [];
      headings = [];
      hasBody = false;
    }
  };

  for (const line of markdown.split("\n")) {
    if (FENCE_LINE_PATTERN.test(line)) {
      inFence = !inFence;
    }
    const headingMatch = !inFence ? line.match(HEADING_LINE_PATTERN) : null;
    if (headingMatch) {
      if (hasBody) {
        flush();
      }
      headings.push(normalizeHeadingText(headingMatch[2]));
      lines.push(line);
      continue;
    }
    lines.push(line);
    if (line.trim().length > 0) {
      hasBody = true;
    }
  }
  flush();
  return sections;
}

function formatPartialGuideNotice(
  guideId: string,
  withheldSections: readonly string[],
  gates: readonly GateCheck[],
): string {
  const sectionList = withheldSections.map((s) => `"${s}"`).join(", ");
  const plural = withheldSections.length === 1 ? "" : "s";
  const verb = withheldSections.length === 1 ? "was" : "were";
  const coverage = gates
    .map(({ spec, items }) => {
      const summary = spec.formatSummary(items as any);
      const isAre = items.length === 1 ? "is" : "are";
      return `They cover ${summary}, which ${isAre} ${spec.riskAdjective} and may still change.`;
    })
    .join(" ");
  const commands = gates
    .map(({ spec }) => `npx modern-web-guidance@latest ${spec.cliCommand}`)
    .join("\n");
  return `> [!CAUTION]\n>\n> **Partial guide: the ${sectionList} section${plural} of guide \`${guideId}\` ${verb} withheld.** ${coverage} This project has not opted in. The sections below cover stable features only; do not read the raw guide file from disk to recover the withheld sections. To read them, ask the user if they want to opt in by running this command in their terminal:\n>\n> \`\`\`sh\n> ${commands}\n> \`\`\`\n\n`;
}

/**
 * Serves the stable subset of a gated guide: the sections the guide declares
 * (frontmatter `volatile-sections`) as covering the gated features are
 * withheld, and the remaining sections are returned with a notice naming the
 * withheld sections and the opt-in command. Returns null when the guide has
 * no such declaration, when no section was actually withheld (stale
 * declaration), or when nothing stable remains — in all of those cases the
 * caller falls back to rejecting the guide, so the opt-in safeguard is never
 * weakened by this path.
 */
async function serveStableSubset(
  useCase: UseCase,
  gates: readonly GateCheck[],
  config: ReturnType<typeof readMwgrc>,
): Promise<string | null> {
  const declared = useCase.volatileSections ?? [];
  if (declared.length === 0) {
    return null;
  }
  const guide = await getGuide(useCase.id);
  if (!guide) {
    return null;
  }
  const withheld = new Set(declared.map(normalizeHeadingText));
  const sections = splitGuideSections(guide);
  const kept = sections.filter(
    (section) => !section.headings.some((heading) => withheld.has(heading)),
  );
  if (kept.length === sections.length) {
    return null;
  }
  const remaining = kept.map((section) => section.text).join("\n");
  if (remaining.trim().length === 0) {
    return null;
  }

  logToolResult("get_best_practices", [{ id: useCase.id }]);

  const banner = formatBaselineTargetBanner(
    typeof config.baseline === "string" ? config.baseline : undefined,
  );
  return formatPartialGuideNotice(useCase.id, declared, gates) + banner + remaining;
}
