import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankOutsideRange,
  blankPreprocessorLineComments,
  blankRanges,
  extractScriptBlocks,
  extractStyleBlocks,
  prepareHtmlForDomScan,
} from './sfc-extractor.ts';

void test('sfc-extractor: Astro frontmatter extraction', async (t) => {
  await t.test('extracts frontmatter containing internal --- comments without premature termination', () => {
    const astro = [
      '---',
      '// --- Helpers ---',
      'import { helper } from "./utils.js";',
      '// --- Data ---',
      'const title = "Astro Page";',
      '---',
      '<h1>{title}</h1>',
    ].join('\n');

    const blocks = extractScriptBlocks('src/pages/index.astro', astro);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.ok(block);
    assert.equal(block.virtualPath, 'src/pages/index.astro.ts');
    assert.equal(block.blankedContent.includes('// --- Helpers ---'), true);
    assert.equal(block.blankedContent.includes('const title = "Astro Page";'), true);
    assert.equal(block.blankedContent.includes('import { helper } from "./utils.js";'), true);
    // Content outside frontmatter must be blanked
    assert.equal(block.blankedContent.includes('<h1>'), false);
  });

  await t.test('extracts standard Astro frontmatter cleanly', () => {
    const astro = '---\nconst x = 42;\n---\n<p>{x}</p>';
    const blocks = extractScriptBlocks('src/pages/test.astro', astro);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.ok(block);
    assert.equal(block.virtualPath, 'src/pages/test.astro.ts');
    assert.equal(block.blankedContent.includes('const x = 42;'), true);
  });
});

void test('sfc-extractor: preprocessor // line comments in style blocks', async (t) => {
  await t.test('blankPreprocessorLineComments blanks // comments but preserves offsets', () => {
    const scss = '// header comment\n.box { color: red; }\n// trailing';
    const blanked = blankPreprocessorLineComments(scss);
    assert.equal(blanked.length, scss.length);
    assert.equal(blanked.split('\n').length, scss.split('\n').length);
    assert.equal(blanked.includes('//'), false);
    assert.equal(blanked.includes('.box { color: red; }'), true);
  });

  await t.test('blankPreprocessorLineComments leaves URLs, strings, and block comments alone', () => {
    const scss = [
      '.a { background: url(https://example.com/a.png); }',
      '.b { background: url(//cdn.example.com/b.png); }',
      '.c { content: "// not a comment"; }',
      '/* // also not a comment */',
      '.d { color: blue; } // real comment',
    ].join('\n');
    const blanked = blankPreprocessorLineComments(scss);
    assert.equal(blanked.includes('https://example.com/a.png'), true);
    assert.equal(blanked.includes('url(//cdn.example.com/b.png)'), true);
    assert.equal(blanked.includes('"// not a comment"'), true);
    assert.equal(blanked.includes('/* // also not a comment */'), true);
    assert.equal(blanked.includes('// real comment'), false);
    assert.equal(blanked.includes('.d { color: blue; }'), true);
  });

  await t.test('extractStyleBlocks blanks // comments in scss/less blocks, not plain css', () => {
    const scssVue =
      '<template><div/></template>\n<style lang="scss">\n// comment\n.box { color: red; }\n</style>';
    const scssBlocks = extractStyleBlocks('src/App.vue', scssVue);
    assert.equal(scssBlocks.length, 1);
    assert.equal(scssBlocks[0]?.includes('// comment'), false);
    assert.equal(scssBlocks[0]?.includes('.box { color: red; }'), true);
    assert.equal(scssBlocks[0]?.length, scssVue.length);

    const lessVue =
      '<template><div/></template>\n<style lang="less">\n// comment\n.box { color: red; }\n</style>';
    const lessBlocks = extractStyleBlocks('src/App.vue', lessVue);
    assert.equal(lessBlocks.length, 1);
    assert.equal(lessBlocks[0]?.includes('// comment'), false);
    assert.equal(lessBlocks[0]?.includes('.box { color: red; }'), true);

    const plainVue =
      '<template><div/></template>\n<style>\n// comment\n.box { color: red; }\n</style>';
    const plainBlocks = extractStyleBlocks('src/App.vue', plainVue);
    assert.equal(plainBlocks.length, 1);
    assert.equal(plainBlocks[0]?.includes('// comment'), true);
  });
});

void test('sfc-extractor: Vue and Svelte script & style extraction', async (t) => {
  await t.test('extracts Vue scripts and styles', () => {
    const vue = '<template><div></div></template>\n<script>\nexport default {};\n</script>\n<style>\n.btn { color: red; }\n</style>';
    const scriptBlocks = extractScriptBlocks('src/App.vue', vue);
    assert.equal(scriptBlocks.length, 1);
    assert.equal(scriptBlocks[0]?.blankedContent.includes('export default {};'), true);

    const styleBlocks = extractStyleBlocks('src/App.vue', vue);
    assert.equal(styleBlocks.length, 1);
    assert.equal(styleBlocks[0]?.includes('.btn { color: red; }'), true);
  });

  await t.test('disambiguates virtual paths for multiple script blocks in one HTML file', () => {
    const html = [
      '<!DOCTYPE html>',
      '<html><body>',
      '<script>',
      'const a = 1;',
      '</script>',
      '<div>middle</div>',
      '<script lang="ts">',
      'const b: number = 2;',
      '</script>',
      '<script>',
      'const c = 3;',
      '</script>',
      '</body></html>',
    ].join('\n');

    const blocks = extractScriptBlocks('src/index.html', html);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0]?.virtualPath, 'src/index.html.js');
    assert.equal(blocks[1]?.virtualPath, 'src/index.html.block1.ts');
    assert.equal(blocks[2]?.virtualPath, 'src/index.html.block2.js');
  });

  await t.test('blankOutsideRange, blankRanges, prepareHtmlForDomScan, and Lit css extraction', () => {
    const raw = 'line 1\nline 2: target\nline 3\n';
    const start = raw.indexOf('line 2: target');
    const end = start + 'line 2: target'.length;
    const blanked = blankOutsideRange(raw, start, end);
    assert.equal(blanked.length, raw.length);
    assert.equal(blanked.split('\n').length, raw.split('\n').length);
    assert.equal(blanked.slice(start, end), 'line 2: target');

    const multi = 'aaa\nbbb\nccc\nddd\n';
    const bbbStart = multi.indexOf('bbb');
    const blankedRanges = blankRanges(multi, [{ start: bbbStart, end: bbbStart + 3 }]);
    assert.equal(blankedRanges.length, multi.length);
    assert.equal(blankedRanges.includes('bbb'), false);
    assert.equal(blankedRanges.includes('ccc'), true);

    const vue =
      '<script>\nconst a = 1;\n</script>\n<template>\n  <button>Click</button>\n</template>\n<style>\nbutton { color: red; }\n</style>';
    const prepared = prepareHtmlForDomScan('App.vue', vue);
    assert.equal(prepared.length, vue.length);
    assert.equal(prepared.includes('<script>'), false);
    assert.equal(prepared.includes('<style>'), false);
    assert.equal(prepared.includes('<template>'), false);
    assert.equal(prepared.includes('<button>Click</button>'), true);

    const litTs = 'import { css } from "lit";\nconst s = css`\n  .card { color: ${"red"}; }\n`;';
    const litBlocks = extractStyleBlocks('card.ts', litTs);
    assert.equal(litBlocks.length, 1);
    assert.equal(litBlocks[0]?.includes('.card { color:'), true);
    assert.equal(litBlocks[0]?.includes('${"red"}'), false);
  });
});
