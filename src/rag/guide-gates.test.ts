import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getGuideGateInfo } from './guide-gates.ts';

function writeGuidesJson(dir: string, content: string): void {
  fs.mkdirSync(path.join(dir, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen', 'guides.json'), content, 'utf8');
}

const GATED_VOLATILE = [
  {
    id: 'custom-text-decorations',
    description: 'Add text decorations such as underlines.',
    category: 'visual-design',
    featuresUsed: ['text-decoration'],
    tokenCount: 4000,
    volatileFeatures: [{ id: 'text-decoration-skip-spaces', reason: 'recent-single-engine' }],
  },
  {
    id: 'autofill-sign-in-form',
    description: 'Autofill for sign-in forms.',
    category: 'forms',
    featuresUsed: ['autofill'],
    tokenCount: 1200,
  },
];

const GATED_ORIGIN_TRIAL = [
  {
    id: 'gated-ot-guide',
    description: 'A guide behind an Origin Trial.',
    category: 'built-in-ai',
    featuresUsed: ['summarizer'],
    tokenCount: 2000,
    originTrials: [{ id: 'summarizer-api', chromestatus_url: 'https://chromestatus.com/feature/1' }],
    volatileFeatures: [{ id: 'summarizer', reason: 'built-in-ai' }],
  },
];

describe('getGuideGateInfo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-gates-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns volatile gate info for a volatile-gated guide', () => {
    writeGuidesJson(tempDir, JSON.stringify(GATED_VOLATILE));
    assert.deepEqual(getGuideGateInfo('custom-text-decorations', tempDir), {
      gate: 'volatile-features',
      features: ['text-decoration-skip-spaces'],
      optInKey: 'allowVolatileFeatures',
      unlockCommand: 'npx modern-web-guidance@latest set-allow-volatile-features',
      headingLabel: 'volatile features',
    });
  });

  test('returns undefined for an ungated guide', () => {
    writeGuidesJson(tempDir, JSON.stringify(GATED_VOLATILE));
    assert.equal(getGuideGateInfo('autofill-sign-in-form', tempDir), undefined);
  });

  test('returns undefined for an unknown guide id', () => {
    writeGuidesJson(tempDir, JSON.stringify(GATED_VOLATILE));
    assert.equal(getGuideGateInfo('no-such-guide', tempDir), undefined);
  });

  test('origin trials take precedence over volatile features, matching retrieve', () => {
    writeGuidesJson(tempDir, JSON.stringify(GATED_ORIGIN_TRIAL));
    assert.deepEqual(getGuideGateInfo('gated-ot-guide', tempDir), {
      gate: 'origin-trials',
      features: ['summarizer-api'],
      optInKey: 'allowOriginTrials',
      unlockCommand: 'npx modern-web-guidance@latest set-allow-origin-trials',
      headingLabel: 'Origin Trial features',
    });
  });

  test('returns undefined when guides.json is absent instead of throwing', () => {
    assert.equal(getGuideGateInfo('custom-text-decorations', tempDir), undefined);
  });

  test('returns undefined for malformed guides.json instead of throwing', () => {
    writeGuidesJson(tempDir, '{not json');
    assert.equal(getGuideGateInfo('custom-text-decorations', tempDir), undefined);
  });
});
