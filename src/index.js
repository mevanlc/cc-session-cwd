#!/usr/bin/env node
// cc-session-setcwd — reassociate a Claude Code session with a new working directory.
//
// Automates what the interactive /cd command does, via the Agent SDK's set_cwd
// control request (the same CLI-side handler /cd uses, including relocating the
// session transcript to the new directory's project storage so --resume and
// --continue find it there).
//
// Usage: cc-session-setcwd [--originaldir <dir>] [--no-trust] [--verbose] <sessionid> <newdir>

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

const USAGE = `Usage: cc-session-setcwd [options] <sessionid> <newdir>

Reassociate a Claude Code session with a new working directory (automated /cd).

Arguments:
  sessionid            UUID of the session to move
  newdir               Directory the session should live in from now on

Options:
  --originaldir <dir>  Sanity check: fail unless the session currently belongs
                       to this directory. Without it, the session is located by
                       scanning all project directories.
  --trust              Accept the trust prompt for <newdir> without asking
                       (default).
  --no-trust           Ask interactively before accepting the trust prompt.
  --verbose            Print progress details.
  -h, --help           Show this help.

Exit codes: 0 moved (or already there), 1 error, 2 usage error.`;

function fail(msg, code = 1) {
  console.error(`cc-session-setcwd: ${msg}`);
  process.exit(code);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        originaldir: { type: 'string' },
        trust: { type: 'boolean' },
        'no-trust': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`cc-session-setcwd: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (parsed.values.trust && parsed.values['no-trust']) {
    console.error(`cc-session-setcwd: --trust and --no-trust cannot be combined\n\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.positionals.length !== 2) {
    console.error(`cc-session-setcwd: expected <sessionid> and <newdir>\n\n${USAGE}`);
    process.exit(2);
  }
  const [sessionId, newDir] = parsed.positionals;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    fail(`"${sessionId}" does not look like a session UUID`, 2);
  }
  return {
    sessionId,
    newDir,
    originaldir: parsed.values.originaldir,
    trust: !parsed.values['no-trust'],
    verbose: parsed.values.verbose,
  };
}

function canonicalDir(dir, label) {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) fail(`${label} does not exist: ${abs}`);
  if (!statSync(abs).isDirectory()) fail(`${label} is not a directory: ${abs}`);
  return realpathSync(abs);
}

// Unlike newdir, originaldir may legitimately no longer exist (the project was
// moved) — canonicalize as far as the filesystem allows.
function canonicalMaybeMissingDir(dir) {
  const abs = path.resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// The CLI must be spawned with cwd = the session's current home so resume can
// find the transcript. If the project was moved, that directory may be gone —
// recreate it for the duration of the move and clean up whatever we created.
function ensureSpawnDir(dir) {
  if (existsSync(dir)) return null;
  let firstMissing = dir;
  for (let parent = path.dirname(firstMissing); !existsSync(parent); parent = path.dirname(parent)) {
    firstMissing = parent;
  }
  mkdirSync(dir, { recursive: true });
  return firstMissing;
}

async function confirmTrust(dir) {
  if (!process.stdin.isTTY) {
    fail(
      `Claude Code has not trusted "${dir}" yet and stdin is not a TTY.\n` +
      `Re-run without --no-trust to accept, or run claude interactively in that directory once.`
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`Trust directory "${dir}"? [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

async function main() {
  const args = parseCli();
  const log = args.verbose ? (m) => console.error(`[cc-session-setcwd] ${m}`) : () => {};

  const newDir = canonicalDir(args.newDir, 'newdir');

  // Locate the session. Without --originaldir the SDK scans every project dir.
  const lookupOpts = args.originaldir
    ? { dir: canonicalMaybeMissingDir(args.originaldir) }
    : undefined;
  log(`looking up session ${args.sessionId}${lookupOpts ? ` in ${lookupOpts.dir}` : ' (all projects)'}`);
  const info = await getSessionInfo(args.sessionId, lookupOpts);
  if (!info) {
    fail(
      `session ${args.sessionId} not found` +
      (args.originaldir
        ? ` under ${args.originaldir} (try omitting --originaldir to search everywhere)`
        : '')
    );
  }

  const oldCwd = info.cwd;
  if (!oldCwd) fail(`session ${args.sessionId} has no recorded working directory`);
  log(`session found; current home: ${oldCwd}`);

  if (args.originaldir) {
    const expected = canonicalMaybeMissingDir(args.originaldir);
    // The recorded cwd may not exist anymore, so compare without realpath on it.
    if (path.resolve(oldCwd) !== expected) {
      fail(`session ${args.sessionId} belongs to "${oldCwd}", not "${expected}" (seatbelt --originaldir mismatch)`);
    }
  }

  if (path.resolve(oldCwd) === newDir) {
    console.log(`Session ${args.sessionId} already lives in ${newDir}; nothing to do.`);
    return;
  }

  const createdDir = ensureSpawnDir(oldCwd);
  if (createdDir) log(`recreated missing original directory ${oldCwd} (will remove ${createdDir})`);

  let exitCode = 0;
  try {
    // Resume headlessly with a held-open streaming input so no turn ever runs;
    // we only use the control channel.
    let closeInput;
    const inputClosed = new Promise((resolve) => { closeInput = resolve; });
    async function* heldOpenInput() { await inputClosed; }

    log(`resuming session (spawn cwd: ${oldCwd})`);
    const q = query({
      prompt: heldOpenInput(),
      options: { resume: args.sessionId, cwd: oldCwd },
    });

    if (typeof q.setCwd !== 'function') {
      closeInput();
      fail(
        'this @anthropic-ai/claude-agent-sdk version does not expose Query.setCwd(); ' +
        'upgrade the SDK (>= 0.3.201) or use /cd interactively'
      );
    }

    // Drain messages so the transport keeps flowing; no init wait — the CLI
    // only emits system/init once a prompt is sent, which we never do. Control
    // requests are ordered behind the SDK's internal initialize handshake.
    const consumer = (async () => {
      for await (const msg of q) {
        log(`message: ${msg.type}${msg.subtype ? `/${msg.subtype}` : ''}`);
      }
    })();

    const withTimeout = (promise, what) => Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${what} timed out after 60s`)), 60_000).unref()),
    ]);

    try {
      log(`sending set_cwd -> ${newDir}`);
      let res = await withTimeout(q.setCwd(newDir), 'set_cwd');

      if (res.status === 'needs_trust') {
        log(`directory needs trust: ${res.directory}`);
        const accepted = args.trust || (await confirmTrust(res.directory));
        if (!accepted) fail('trust declined; session left unchanged');
        res = await withTimeout(
          q.setCwd(newDir, { trustAccepted: true, trustedDirectory: res.directory }),
          'set_cwd (trusted)');
      }

      if (res.status !== 'ok') {
        fail(`set_cwd failed (${res.status}${res.reason ? `/${res.reason}` : ''}): ${res.message ?? 'no detail'}`);
      }

      console.log(`Session ${args.sessionId} moved: ${oldCwd} -> ${res.cwd}`);
      if (res.transcript_relocated === false) {
        console.error('warning: CLI reported the transcript was NOT relocated; verify with --verbose');
        exitCode = 1;
      }
    } finally {
      closeInput();
      await consumer.catch(() => {});
    }

    // Independent verification: the session must now be discoverable from newdir.
    const moved = await getSessionInfo(args.sessionId, { dir: newDir });
    if (moved) {
      log(`verified: session is now discoverable under ${newDir}`);
    } else {
      console.error(`warning: could not verify session under ${newDir} after the move`);
      exitCode = 1;
    }
  } finally {
    if (createdDir) {
      log(`removing recreated directory ${createdDir}`);
      rmSync(createdDir, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

main().catch((err) => fail(err?.stack ?? String(err)));
