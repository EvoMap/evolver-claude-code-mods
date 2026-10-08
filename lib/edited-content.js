// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export const EDIT_TOOL_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const CONTENT_KEYS = ['content', 'new_string', 'new_source'];

function firstString(input, keys) {
  for (const key of keys) {
    if (typeof input?.[key] === 'string' && input[key].length > 0) return input[key];
  }
  return '';
}

export function editedContent(input) {
  if (Array.isArray(input?.edits)) {
    return input.edits.map((edit) => firstString(edit, CONTENT_KEYS)).filter(Boolean).join('\n');
  }
  return firstString(input, CONTENT_KEYS);
}

export function editedPath(input) {
  return firstString(input, ['file_path', 'notebook_path']);
}

function lineCount(text) {
  return typeof text === 'string' && text.length > 0 ? text.split('\n').length : 0;
}

// Lines a successful edit touched, removed plus written: the blast radius the
// savings estimator is sized by.
export function changedLinesOf(input) {
  const edits = Array.isArray(input?.edits) ? input.edits : [input];
  return edits.reduce((total, edit) => total + lineCount(edit?.old_string) + lineCount(edit?.new_string ?? edit?.content ?? edit?.new_source), 0);
}
