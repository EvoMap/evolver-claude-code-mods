import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function freshHome(prefix) {
  const keys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = home;
  if (process.platform === 'win32') {
    process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = home.slice(0, 2);
    process.env.HOMEPATH = home.slice(2);
  }
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}
