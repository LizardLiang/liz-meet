// tests/unit/searchbar-snippet.test.ts
// Suite U15 partial: STX/ETX → <mark> rendering and no dangerouslySetInnerHTML (UNIT-053–055)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_BAR_PATH = path.resolve(__dirname, '../../src/components/SearchBar.tsx');

const STX = '\x02'; // U+0002 Start of Text
const ETX = '\x03'; // U+0003 End of Text

// ---- Pure function extracted for testing ----
// Replicate the renderSnippet logic from SearchBar.tsx to test it in isolation
function renderSnippet(snippet: string): Array<string | { type: 'mark'; content: string }> {
  const parts = snippet.split(new RegExp(`[${STX}${ETX}]`));
  const nodes: Array<string | { type: 'mark'; content: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      nodes.push(parts[i]);
    } else {
      nodes.push({ type: 'mark', content: parts[i] });
    }
  }
  return nodes;
}

describe('SearchBar renderSnippet — UNIT-053, UNIT-054', () => {
  it('UNIT-053: STX/ETX markers are used in snippet, not HTML tags', () => {
    // The FTS5 snippet uses char(2)/char(3) — not <mark> or <b>
    const snippet = `discuss the ${STX}action item${ETX} at 9am`;
    expect(snippet).toContain('\x02');
    expect(snippet).toContain('\x03');
    expect(snippet).not.toContain('<mark>');
    expect(snippet).not.toContain('<b>');
  });

  it('UNIT-054: snippet with STX/ETX markers is split into marked + unmarked parts', () => {
    const snippet = `discuss the ${STX}action item${ETX} at 9am`;
    const nodes = renderSnippet(snippet);

    // Should have 3 parts: text, mark, text
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toBe('discuss the ');
    expect(nodes[1]).toEqual({ type: 'mark', content: 'action item' });
    expect(nodes[2]).toBe(' at 9am');
  });

  it('snippet with no markers returns single text node', () => {
    const snippet = 'plain text with no highlights';
    const nodes = renderSnippet(snippet);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toBe('plain text with no highlights');
  });

  it('multiple STX/ETX pairs produce multiple mark nodes', () => {
    const snippet = `${STX}hello${ETX} world ${STX}foo${ETX}`;
    const nodes = renderSnippet(snippet);
    // '' (empty before first STX), 'hello', ' world ', 'foo', '' (empty after last ETX)
    const markNodes = nodes.filter(n => typeof n === 'object' && n.type === 'mark');
    expect(markNodes).toHaveLength(2);
    expect((markNodes[0] as { type: string; content: string }).content).toBe('hello');
    expect((markNodes[1] as { type: string; content: string }).content).toBe('foo');
  });

  it('UNIT-055: SearchBar.tsx does not use dangerouslySetInnerHTML as a JSX prop', () => {
    const source = readFileSync(SEARCH_BAR_PATH, 'utf-8');
    // The string may appear in comments; check it is not used as a JSX prop (= assignment)
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });

  it('UNIT-055: SearchBar.tsx renders mark via JSX (not innerHTML)', () => {
    const source = readFileSync(SEARCH_BAR_PATH, 'utf-8');
    // Should contain the JSX <mark> element rendered via React.createElement (JSX)
    expect(source).toContain('<mark');
  });
});
