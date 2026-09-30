import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('vignette layouts use an exact 60/40 context-to-question split', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /\.practice-layout,\.review\{[^}]*grid-template-columns:minmax\(0,3fr\) minmax\(0,2fr\)/,
  );
  assert.match(
    css,
    /@media\(max-width:800px\)\{[^}]*\.practice-layout,\.review\{grid-template-columns:1fr\}/,
  );
});
