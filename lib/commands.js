// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MIN_EVOLVER_VERSION } from './onboarding.js';

// Commands are how a person reaches Evolver, so nothing about them sits in the model's context: each one
// runs in the plugin and answers in the transcript. Only /evolver-evolve hands the agent a one-off prompt,
// because reflecting on the current work is the agent's job.

const NAME_PREFIX = 'evolver-';
const OUTPUT_MAX_CHARS = 4_000;
// The fallback runs whatever npm resolves, so it is held to the range this plugin is built against.
const CLI_PACKAGE = `@evomap/evolver@^${MIN_EVOLVER_VERSION}`;

const success = (text) => ({ kind: 'success', text });
const failure = (text) => ({ kind: 'error', text });

function shown(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text;
}

/**
 * Quotes group words the way a shell would (`--summary="two words"` stays one argument) and a backslash
 * escapes the character after it, so a quote can be part of a value; nothing else is expanded.
 */
export function argumentsOf(rawInput) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  let escaped = false;
  for (const char of rawInput) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/**
 * The installed `evolver` when there is one, else the published package through npx. `run` takes an argv and
 * resolves `{ error, output }`, with `error.code === 'ENOENT'` when the executable is missing.
 */
export async function runEvolverCli(args, run) {
  let { error, output } = await run(['evolver', ...args]);
  if (error?.code === 'ENOENT') ({ error, output } = await run(['npx', '-y', CLI_PACKAGE, ...args]));
  return error ? failure(shown(output || String(error.message))) : success(shown(output || 'done'));
}

function cliCommand(subcommand, description, argumentHint, runCli) {
  return {
    name: `${NAME_PREFIX}${subcommand}`,
    description,
    argumentHint,
    handler: ({ rawInput }) => runCli([subcommand, ...argumentsOf(rawInput)]),
  };
}

function evolveCommand(evolveText, followup) {
  return {
    name: `${NAME_PREFIX}evolve`,
    description: 'Run an evolution checkpoint — recall relevant past outcomes, reflect on the current task, and record what was learned.',
    argumentHint: 'optional focus',
    handler: async ({ rawInput }) => {
      const focus = rawInput.trim();
      const body = await evolveText();
      await followup(focus ? `${body}\n\nFocus: ${focus}` : body);
      return success(`Running /${NAME_PREFIX}evolve.`);
    },
  };
}

/**
 * `status` and `search` answer from the Proxy, `distill` distills the session's latest verified turn now,
 * and the engine commands run the `evolver` executable. A command that takes no argument has no hint.
 */
export function evolverCommands({ status, search, distillNow, evolveText, followup, runCli }) {
  return [
    {
      name: `${NAME_PREFIX}status`,
      description: 'Show Evolver health: the Proxy, Hub auth, recent recalls and reuse reports.',
      handler: async () => success(shown(await status())),
    },
    {
      name: `${NAME_PREFIX}search`,
      description: 'Search the EvoMap network for reusable assets.',
      argumentHint: '<task description or error text>',
      handler: async ({ rawInput }) => {
        const text = rawInput.trim();
        if (!text) return failure(`Usage: /${NAME_PREFIX}search <task description or error text>`);
        const result = await search(text);
        return result.ok ? success(shown(result.data)) : failure(String(result.error));
      },
    },
    {
      name: `${NAME_PREFIX}distill`,
      description: "Distill this session's latest verified turn into a reusable Gene now, instead of at the next session start.",
      argumentHint: 'optional focus',
      handler: async ({ rawInput }) => {
        const outcome = await distillNow(rawInput.trim());
        if (outcome.status === 'nothing') return failure('Nothing to distill yet: no turn of this session finished verified.');
        return outcome.status === 'sent' ? success(shown(outcome.data ?? 'distilled')) : failure(`Distillation ${outcome.status}: ${outcome.error ?? ''}`.trim());
      },
    },
    evolveCommand(evolveText, followup),
    cliCommand('sync', 'Sync assets between the local store and the EvoMap Hub (evolver sync).', '[--scope=…] [--type=…] [--dry-run]', runCli),
    cliCommand('review', "Review Evolver's pending evolved changes, then approve or reject them (evolver review).", '[--approve | --reject]', runCli),
    cliCommand('run', 'Run one Evolver self-evolution cycle on this repository (evolver run).', '[--loop] [--dry-run] [--strategy=…]', runCli),
    cliCommand('solidify', 'Solidify the working changes into a durable Gene or Capsule (evolver solidify).', '[--dry-run] [--intent=…] [--summary=…]', runCli),
  ];
}
