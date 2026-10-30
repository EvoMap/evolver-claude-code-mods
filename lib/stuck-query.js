// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from './redact.js';

const MAX_QUERY_CHARS = 512;
const MAX_ERROR_LINES = 6;
const ERROR_LINE_MAX_CHARS = 160;
const MAX_FAILING_TESTS = 4;
const MAX_FILES = 6;
const MAX_CHANGED_IDENTIFIERS = 12;

const ANSI = /\x1b\[[0-9;]*m/g;
const ERROR_LINE = /(Error|Exception|assert|FAIL|panic:|undefined:|cannot use|expected|E {3})/i;
const FAILING_TEST = /(?:FAIL(?:ED)?:?\s+|--- FAIL: |✕ |● )([\w./:[\]<>-]{4,120})/g;
const ABSOLUTE_PATH = /(?<![\w.])(?:\/[\w.@-]+)+\/([\w.@-]+)/g;
const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;
const KEYWORDS = new Set([
  'null', 'true', 'false', 'None', 'True', 'False', 'self', 'this', 'super', 'return', 'const', 'function', 'async', 'await',
  'import', 'export', 'from', 'class', 'struct', 'func', 'pass', 'elif', 'else', 'while', 'yield', 'void', 'static', 'public',
  'private', 'string', 'number', 'boolean', 'undefined', 'with', 'type', 'interface', 'package', 'defer', 'range', 'lambda',
]);

const LANGUAGES = {
  '.go': 'Go', '.py': 'Python', '.ts': 'TypeScript', '.tsx': 'TypeScript React', '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.java': 'Java', '.rs': 'Rust', '.rb': 'Ruby', '.cs': 'C#', '.php': 'PHP', '.kt': 'Kotlin', '.swift': 'Swift',
};

function baseName(path) {
  return String(path).split(/[\\/]/).pop() ?? '';
}

function languageOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? LANGUAGES[name.slice(dot)] : undefined;
}

function distinct(items) {
  return [...new Set(items)];
}

function identifiersAddedBy(before, after) {
  const known = new Set(String(before ?? '').match(IDENTIFIER) ?? []);
  return distinct((String(after ?? '').match(IDENTIFIER) ?? []).filter((word) => !known.has(word) && !KEYWORDS.has(word)));
}

/** Identifiers a successful edit call introduced, across every edit a MultiEdit carries. */
export function addedIdentifiersOf(input) {
  const edits = Array.isArray(input?.edits) ? input.edits : [input];
  return edits.flatMap((edit) => identifiersAddedBy(edit?.old_string, edit?.new_string ?? edit?.content ?? edit?.new_source));
}

function mostFrequent(words, limit) {
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([word]) => word);
}

function errorLinesOf(output) {
  const lines = output.split('\n').map((line) => line.replace(ABSOLUTE_PATH, '$1').trim());
  return distinct(lines.filter((line) => line.length > 8 && ERROR_LINE.test(line)).map((line) => line.slice(0, ERROR_LINE_MAX_CHARS))).slice(0, MAX_ERROR_LINES);
}

function failingTestsOf(output) {
  return distinct([...output.matchAll(FAILING_TEST)].map((match) => match[1])).slice(0, MAX_FAILING_TESTS);
}

/**
 * What the agent is stuck on, from what a failed check printed and what the turn touched: the language of the files,
 * the identifiers the edits introduced, the error lines and failing tests, and the files' base names. Paths are cut
 * to base names and secrets redacted, since the query leaves the machine.
 * @param {{ output: string, paths?: string[], addedIdentifiers?: string[] }} input
 */
export function stuckQueryOf({ output, paths = [], addedIdentifiers = [] }) {
  const text = withoutSecrets(String(output ?? '').replace(ANSI, ''));
  const errors = errorLinesOf(text);
  if (errors.length === 0) return '';
  const files = distinct(paths.map(baseName).filter(Boolean)).slice(-MAX_FILES);
  const languages = distinct(paths.map(languageOf).filter(Boolean)).sort();
  const changed = mostFrequent(addedIdentifiers, MAX_CHANGED_IDENTIFIERS);
  const tests = failingTestsOf(text);
  return [
    languages.length > 0 ? `language: ${languages.join(', ')}` : '',
    changed.length > 0 ? `changed: ${changed.join(', ')}` : '',
    errors.join('; '),
    tests.length > 0 ? `failing: ${tests.join(', ')}` : '',
    files.length > 0 ? `files: ${files.join(', ')}` : '',
  ].filter(Boolean).join(' | ').slice(0, MAX_QUERY_CHARS);
}
