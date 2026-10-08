// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';

const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024;

export function git(args, cwd, options = {}) {
  const {
    signal,
    timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer = DEFAULT_GIT_MAX_BUFFER,
  } = options;

  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        shell: false,
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8',
        signal,
      },
      (error, stdout) => resolve({
        ok: !error,
        stdout: typeof stdout === 'string' ? stdout : '',
        error: error ?? null,
      }),
    );
  });
}

export async function gitText(args, cwd, options) {
  return (await git(args, cwd, options)).stdout;
}
