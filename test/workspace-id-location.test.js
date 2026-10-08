import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import { resolveWorkspaceId, workspaceIdPath } from '../lib/workspace.js';

function gitRepo() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-wsid-')));
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

function withHome(home, run) {
  const previousHome = process.env.HOME;
  const previousId = process.env.EVOLVER_WORKSPACE_ID;
  delete process.env.EVOLVER_WORKSPACE_ID;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousId !== undefined) process.env.EVOLVER_WORKSPACE_ID = previousId;
  }
}

test('a new workspace id is minted under the home state directory, not in the repository', () => {
  const repo = gitRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-home-')));

  // workspaceIdPath reads the home directory too, so it has to be resolved under the same HOME.
  const { id, stored } = withHome(home, () => ({
    id: resolveWorkspaceId(repo),
    stored: workspaceIdPath(repo),
  }));

  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(existsSync(join(repo, '.evolver', 'workspace-id')), false, 'the repository stays clean');
  assert.equal(readFileSync(stored, 'utf8'), id);
});

test('an id the command-hook plugin keeps in the repository is adopted, not replaced', () => {
  const repo = gitRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-home-')));
  const repoIdDir = join(repo, '.evolver');
  mkdirSync(repoIdDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(repoIdDir, 'workspace-id'), 'a'.repeat(32), { mode: 0o600 });

  const { id, stored } = withHome(home, () => ({
    id: resolveWorkspaceId(repo),
    stored: workspaceIdPath(repo),
  }));

  // Minting a fresh id here would silently orphan every memory row this workspace already wrote.
  assert.equal(id, 'a'.repeat(32));
  assert.equal(readFileSync(stored, 'utf8'), id, 'the repository id is copied beside the capture state');
});

test('the same workspace resolves to the same id across calls', () => {
  const repo = gitRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-home-')));

  const first = withHome(home, () => resolveWorkspaceId(repo));
  const second = withHome(home, () => resolveWorkspaceId(repo));

  assert.equal(first, second);
});

test('two workspaces never share an id', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-home-')));
  const first = withHome(home, () => resolveWorkspaceId(gitRepo()));
  const second = withHome(home, () => resolveWorkspaceId(gitRepo()));

  assert.notEqual(first, second);
});
