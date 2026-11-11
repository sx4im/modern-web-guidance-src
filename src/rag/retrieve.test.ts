import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { retrieveUseCase, OriginTrialGateError, VolatileFeatureGateError, FeatureGateError, splitGuideSections, normalizeHeadingText } from './retrieve.ts';
import { searchUseCases } from './search.ts';
import { USE_CASES } from './guides.ts';

const cliPath = path.resolve(import.meta.dirname, '../cli/modern-web.ts');

function runCli(args: string[], options: { cwd: string }): child_process.SpawnSyncReturns<string> {
  return child_process.spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: options.cwd,
      DISABLE_TELEMETRY: '1',
    },
  });
}

const otGuide = USE_CASES.find((u) => (u.originTrials?.length ?? 0) > 0 && !(u.volatileSections?.length ?? 0))!;
const volatileGuide = USE_CASES.find((u) => (u.volatileFeatures?.length ?? 0) > 0 && !(u.volatileSections?.length ?? 0))!;
const regularGuide = USE_CASES.find((u) => !u.originTrials?.length && !u.volatileFeatures?.length && u.tokenCount < 1500)!;
// A guide that is only partly gated: most sections cover stable features, and
// the guide declares the volatile sections in `volatile-sections` so retrieve
// can serve the stable subset without opting in.
const partialGuide = USE_CASES.find((u) => u.id === 'custom-text-decorations')!;

describe('retrieveUseCase and Origin Trial gate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-ot-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects un-opted-in Origin Trial guide with CAUTION message', async () => {
    await assert.rejects(
      () => retrieveUseCase(otGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof OriginTrialGateError);
        assert.ok(err.message.includes('> [!CAUTION]'));
        assert.ok(err.message.includes(otGuide.originTrials![0].id!));
        assert.ok(err.message.includes(otGuide.originTrials![0].chromestatus_url!));
        assert.ok(err.message.includes('npx modern-web-guidance@latest set-allow-origin-trials'));
        return true;
      }
    );
  });

  test('succeeds on Origin Trial guides when .mwgrc has allowOriginTrials: true', async () => {
    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ allowOriginTrials: true }));
    const guide = await retrieveUseCase(otGuide.id, { cwd: tempDir });
    assert.ok(guide.length > 0);
  });

  test('distinguishes explicit allowOriginTrials: false opt-out in CAUTION message', async () => {
    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ allowOriginTrials: false }));
    await assert.rejects(
      () => retrieveUseCase(otGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof OriginTrialGateError);
        assert.ok(err.message.includes('"allowOriginTrials": false'));
        assert.ok(err.message.includes(`do not adopt ${otGuide.originTrials![0].id!}`));
        assert.ok(!err.message.includes('If you still write'));
        return true;
      }
    );
  });

  test('succeeds on regular non-OT, non-volatile guides without .mwgrc', async () => {
    const guide = await retrieveUseCase(regularGuide.id, { cwd: tempDir });
    assert.ok(guide.length > 0);
  });

  test('succeeds on exempt anchor-positioning guides without .mwgrc', async () => {
    const guide = await retrieveUseCase('css-layout', { cwd: tempDir });
    assert.ok(guide.length > 0);
  });

  test('CLI retrieve comma-separated IDs prints regular guide, gates OT guide, without unhandled stack trace', () => {
    const res = runCli(['retrieve', `${regularGuide.id},${otGuide.id}`], { cwd: tempDir });

    assert.strictEqual(res.status, 1);
    assert.ok(res.stdout.includes(`--- Guide for ${regularGuide.id} ---`));
    assert.ok(res.stderr.includes('> [!CAUTION]'));
    assert.ok(!res.stderr.includes('at retrieveUseCase'));
  });

  test('CLI list includes Origin Trial guides when .mwgrc is absent', () => {
    const res = runCli(['list'], { cwd: tempDir });

    assert.strictEqual(res.status, 0);
    const ids = (JSON.parse(res.stdout) as Array<{ id: string }>).map((u) => u.id);
    assert.ok(ids.includes(otGuide.id));
    assert.ok(ids.includes(regularGuide.id));
  });

  test('searchUseCases discovers Origin Trial guides when .mwgrc is absent', async () => {
    const results = await searchUseCases(otGuide.description);
    assert.ok(results.map((r) => r.id).includes(otGuide.id));
  });

  test('retrieveUseCase prepends Baseline target banner when .mwgrc specifies non-default baseline', async () => {
    const defaultGuide = await retrieveUseCase(regularGuide.id, { cwd: tempDir });
    assert.ok(!defaultGuide.includes('Project Baseline Target'));

    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ baseline: 'widely' }));
    const widelyGuide = await retrieveUseCase(regularGuide.id, { cwd: tempDir });
    assert.strictEqual(widelyGuide, defaultGuide);

    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ baseline: 'newly' }));
    const newlyGuide = await retrieveUseCase(regularGuide.id, { cwd: tempDir });
    assert.ok(newlyGuide.startsWith('> [!IMPORTANT]\n> **Project Baseline Target (`.mwgrc`):** `newly`'));

    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ baseline: 'limited' }));
    const limitedGuide = await retrieveUseCase(regularGuide.id, { cwd: tempDir });
    assert.ok(limitedGuide.startsWith('> [!IMPORTANT]\n> **Project Baseline Target (`.mwgrc`):** `limited`'));

    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ baseline: '2024' }));
    const yearGuide = await retrieveUseCase(regularGuide.id, { cwd: tempDir });
    assert.ok(yearGuide.startsWith('> [!IMPORTANT]\n> **Project Baseline Target (`.mwgrc`):** `Baseline 2024`'));
  });

  test('CLI set-baseline writes normalized baseline target to .mwgrc and rejects invalid values', () => {
    const okRes = runCli(['set-baseline', 'newly'], { cwd: tempDir });
    assert.strictEqual(okRes.status, 0);
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, '.mwgrc'), 'utf8'));
    assert.deepStrictEqual(config, { baseline: 'newly' });

    const badRes = runCli(['set-baseline', 'bogus'], { cwd: tempDir });
    assert.strictEqual(badRes.status, 1);
    assert.ok(badRes.stderr.includes('Invalid baseline target'));
  });
});

describe('retrieveUseCase and Volatile Feature gate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-volatile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects un-opted-in volatile guide with CAUTION message', async () => {
    await assert.rejects(
      () => retrieveUseCase(volatileGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof VolatileFeatureGateError);
        assert.ok(err.message.includes('> [!CAUTION]'));
        assert.ok(err.message.includes(volatileGuide.volatileFeatures![0].id!));
        assert.ok(err.message.includes('npx modern-web-guidance@latest set-allow-volatile-features'));
        return true;
      }
    );
  });

  test('succeeds on volatile guides when .mwgrc has allowVolatileFeatures: true', async () => {
    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ allowVolatileFeatures: true }));
    const guide = await retrieveUseCase(volatileGuide.id, { cwd: tempDir });
    assert.ok(guide.length > 0);
  });

  test('distinguishes explicit allowVolatileFeatures: false opt-out in CAUTION message', async () => {
    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ allowVolatileFeatures: false }));
    await assert.rejects(
      () => retrieveUseCase(volatileGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof VolatileFeatureGateError);
        assert.ok(err.message.includes('"allowVolatileFeatures": false'));
        assert.ok(err.message.includes(`do not adopt ${volatileGuide.volatileFeatures![0].id!}`));
        assert.ok(!err.message.includes('If you still write'));
        return true;
      }
    );
  });

  test('unconfigured volatile gate requires unlock command for both memory and external docs', async () => {
    await assert.rejects(
      () => retrieveUseCase(volatileGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof VolatileFeatureGateError);
        const featureIds = volatileGuide.volatileFeatures!.map((vf) => vf.id).filter(Boolean).join(', ');
        assert.ok(err.message.includes('explicitly named that specific API/feature'));
        assert.ok(err.message.includes('whether from model memory or external documentation'));
        assert.ok(err.message.includes(`noting that unverified ${featureIds} code risks being outdated or incomplete.`));
        assert.ok(err.message.includes('npx modern-web-guidance@latest set-allow-volatile-features'));
        return true;
      }
    );
  });

  test('pluralizes gate summary and verb for multi-feature Origin Trial guides', async () => {
    const multiOtGuide = USE_CASES.find((u) => (u.originTrials?.length ?? 0) > 1);
    if (!multiOtGuide) return;
    await assert.rejects(
      () => retrieveUseCase(multiOtGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof OriginTrialGateError);
        assert.ok(err.message.includes('covers active Origin Trials ('));
        assert.ok(err.message.includes(', which are experimental and may still change.'));
        return true;
      }
    );
  });

  test('CLI retrieve comma-separated IDs prints regular guide, gates volatile guide, without unhandled stack trace', () => {
    const res = runCli(['retrieve', `${regularGuide.id},${volatileGuide.id}`], { cwd: tempDir });

    assert.strictEqual(res.status, 1);
    assert.ok(res.stdout.includes(`--- Guide for ${regularGuide.id} ---`));
    assert.ok(res.stderr.includes('> [!CAUTION]'));
    assert.ok(!res.stderr.includes('at retrieveUseCase'));
  });

  test('CLI list and searchUseCases discover volatile guides when .mwgrc is absent', async () => {
    const res = runCli(['list'], { cwd: tempDir });
    assert.strictEqual(res.status, 0);
    const ids = (JSON.parse(res.stdout) as Array<{ id: string }>).map((u) => u.id);
    assert.ok(ids.includes(volatileGuide.id));

    const results = await searchUseCases(volatileGuide.description);
    assert.ok(results.map((r) => r.id).includes(volatileGuide.id));
  });
});

describe('retrieveUseCase serves the stable subset of a partly gated guide', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-partial-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('serves the stable sections of custom-text-decorations without opting in', async () => {
    assert.ok((partialGuide.volatileFeatures?.length ?? 0) > 0);
    assert.deepStrictEqual(partialGuide.volatileSections, ['Skip spaces']);

    const guide = await retrieveUseCase(partialGuide.id, { cwd: tempDir });

    // Stable content is served: the core recommendation and the stable
    // ink-skipping sections.
    assert.ok(guide.includes('## Style the line'));
    assert.ok(guide.includes('text-underline-offset'));
    assert.ok(guide.includes('### Ink skipping'));
    // The withheld sections are gone: neither Skip spaces heading nor the
    // gated declaration survives.
    assert.ok(!guide.includes('#### Skip spaces'));
    assert.ok(!guide.includes('### Skip spaces'));
    assert.ok(!guide.includes('text-decoration-skip-spaces: all'));
    assert.ok(!guide.includes('Do not declare `text-decoration-skip-spaces`'));
    // The notice says what was withheld and how to opt in.
    assert.ok(guide.includes('> [!CAUTION]'));
    assert.ok(guide.includes('Partial guide'));
    assert.ok(guide.includes('"Skip spaces"'));
    assert.ok(guide.includes('text-decoration-skip-spaces'));
    assert.ok(guide.includes('npx modern-web-guidance@latest set-allow-volatile-features'));
  });

  test('serves the full guide when opted into volatile features', async () => {
    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ allowVolatileFeatures: true }));
    const guide = await retrieveUseCase(partialGuide.id, { cwd: tempDir });
    assert.ok(guide.includes('#### Skip spaces'));
    assert.ok(guide.includes('text-decoration-skip-spaces: all'));
    assert.ok(!guide.includes('Partial guide'));
  });

  test('still rejects the partly gated guide on an explicit opt-out', async () => {
    fs.writeFileSync(path.join(tempDir, '.mwgrc'), JSON.stringify({ allowVolatileFeatures: false }));
    await assert.rejects(
      () => retrieveUseCase(partialGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof VolatileFeatureGateError);
        assert.ok(err.message.includes('"allowVolatileFeatures": false'));
        return true;
      }
    );
  });

  test('still rejects a fully gated guide with no declared stable subset', async () => {
    assert.ok(!(volatileGuide.volatileSections?.length ?? 0));
    await assert.rejects(
      () => retrieveUseCase(volatileGuide.id, { cwd: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof FeatureGateError);
        assert.ok(err instanceof VolatileFeatureGateError);
        return true;
      }
    );
  });

  test('CLI retrieve exits 0 for the partly gated guide and 1 for a fully gated one', () => {
    const partialRes = runCli(['retrieve', partialGuide.id], { cwd: tempDir });
    assert.strictEqual(partialRes.status, 0);
    // The partial guide exceeds the inline stdout limit, so the CLI saves it
    // to a file and prints the path instead of inlining it.
    const savedMatch = partialRes.stdout.match(/saved to (\S+) to prevent/);
    assert.ok(savedMatch, `expected a saved-file notice, got: ${partialRes.stdout.slice(0, 200)}`);
    const savedContent = fs.readFileSync(savedMatch[1], 'utf8');
    fs.rmSync(savedMatch[1], { force: true });
    assert.ok(savedContent.includes(`--- Guide for ${partialGuide.id} ---`));
    assert.ok(savedContent.includes('Partial guide'));
    assert.ok(savedContent.includes('## Style the line'));
    assert.ok(!savedContent.includes('#### Skip spaces'));

    const gatedRes = runCli(['retrieve', volatileGuide.id], { cwd: tempDir });
    assert.strictEqual(gatedRes.status, 1);
    assert.ok(gatedRes.stderr.includes('> [!CAUTION]'));
  });
});

describe('splitGuideSections', () => {
  test('groups consecutive headings and reproduces the input exactly', () => {
    const markdown = [
      '# Title',
      '',
      'Intro text.',
      '',
      '## First',
      '',
      'Body one.',
      '',
      '## Second',
      '### Nested',
      '',
      'Body two.',
      '',
    ].join('\n');
    const sections = splitGuideSections(markdown);
    assert.strictEqual(sections.length, 3);
    assert.deepStrictEqual(sections[0].headings, ['title']);
    assert.deepStrictEqual(sections[1].headings, ['first']);
    assert.deepStrictEqual(sections[2].headings, ['second', 'nested']);
    assert.strictEqual(sections.map((s) => s.text).join('\n'), markdown);
  });

  test('does not split on heading-like lines inside fenced code blocks', () => {
    const markdown = [
      '# Title',
      '',
      '```css',
      '# not a heading',
      '```',
      '',
      '## Real',
      '',
      'Body.',
      '',
    ].join('\n');
    const sections = splitGuideSections(markdown);
    assert.strictEqual(sections.length, 2);
    assert.deepStrictEqual(sections[0].headings, ['title']);
    assert.deepStrictEqual(sections[1].headings, ['real']);
    assert.strictEqual(sections.map((s) => s.text).join('\n'), markdown);
  });

  test('normalizeHeadingText strips inline markup and lowercases', () => {
    assert.strictEqual(normalizeHeadingText('Ink skipping `all`'), 'ink skipping all');
    assert.strictEqual(normalizeHeadingText('  Skip Spaces  '), 'skip spaces');
  });
});
