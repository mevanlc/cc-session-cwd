#!/usr/bin/env node
// cc-session-setcwd — reassociate a Claude Code session with a new working directory.
//
// Automates what the interactive /cd command does, via the Agent SDK's set_cwd
// control request (the same CLI-side handler /cd uses, including relocating the
// session transcript to the new directory's project storage so --resume and
// --continue find it there).
//
// Usage:
//   cc-session-setcwd [--olddir <dir>] [--no-trust] [--verbose] <sessionid> <newdir>
//   cc-session-setcwd --all [--dry-run] [--no-trust] [--verbose] <olddir> <newdir>
//   cc-session-setcwd --get <sessionid>

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { query, getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Usage:
  cc-session-setcwd [options] <sessionid> <newdir>
  cc-session-setcwd --all [options] <olddir> <newdir>
  cc-session-setcwd --get <sessionid>

Reassociate a Claude Code session with a new working directory (automated /cd).

Arguments:
  sessionid            UUID of the session to move
  olddir               Directory whose sessions should move in --all mode
  newdir               Directory the session should live in from now on

Options:
  --all                Move every session associated with <olddir>.
  --get <sessionid>    Print the session's current working directory and exit.
  --olddir <dir>       Sanity check: fail unless the session currently belongs
                       to this directory. Without it, the session is located by
                       scanning all project directories. Single-session mode only.
  --dry-run            In --all mode, print matching sessions without moving them.
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
        all: { type: 'boolean', default: false },
        get: { type: 'string' },
        olddir: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
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
  if (parsed.values.get !== undefined) {
    if (parsed.values.all || parsed.values['dry-run'] || parsed.positionals.length !== 0) {
      console.error(`cc-session-setcwd: --get takes a session UUID and no other arguments\n\n${USAGE}`);
      process.exit(2);
    }
    if (!SESSION_UUID_RE.test(parsed.values.get)) {
      fail(`"${parsed.values.get}" does not look like a session UUID`, 2);
    }
    return {
      mode: 'get',
      sessionId: parsed.values.get,
      olddir: parsed.values.olddir,
      verbose: parsed.values.verbose,
    };
  }

  if (parsed.positionals.length !== 2) {
    console.error(`cc-session-setcwd: expected exactly two arguments\n\n${USAGE}`);
    process.exit(2);
  }

  const trust = !parsed.values['no-trust'];
  if (parsed.values.all) {
    if (parsed.values.olddir) {
      console.error(`cc-session-setcwd: --olddir cannot be used with --all; pass <olddir> as the first argument\n\n${USAGE}`);
      process.exit(2);
    }
    const [oldDir, newDir] = parsed.positionals;
    return {
      mode: 'bulk',
      oldDir,
      newDir,
      trust,
      dryRun: parsed.values['dry-run'],
      verbose: parsed.values.verbose,
    };
  }

  if (parsed.values['dry-run']) {
    console.error(`cc-session-setcwd: --dry-run requires --all\n\n${USAGE}`);
    process.exit(2);
  }

  const [sessionId, newDir] = parsed.positionals;
  if (!SESSION_UUID_RE.test(sessionId)) {
    fail(`"${sessionId}" does not look like a session UUID`, 2);
  }
  return {
    mode: 'single',
    sessionId,
    newDir,
    olddir: parsed.values.olddir,
    trust,
    verbose: parsed.values.verbose,
  };
}

function canonicalDir(dir, label) {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) fail(`${label} does not exist: ${abs}`);
  if (!statSync(abs).isDirectory()) fail(`${label} is not a directory: ${abs}`);
  return realpathSync(abs);
}

// Unlike newdir, olddir may legitimately no longer exist (the project was
// moved) — canonicalize as far as the filesystem allows.
function canonicalMaybeMissingDir(dir) {
  const abs = path.resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function sameDir(left, right) {
  return path.resolve(left) === path.resolve(right);
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
    throw new Error(
      `Claude Code has not trusted "${dir}" yet and stdin is not a TTY.\n` +
      `Re-run without --no-trust to accept, or run claude interactively in that directory once.`
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`Trust directory "${dir}"? [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

const withTimeout = (promise, what) => Promise.race([
  promise,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${what} timed out after 60s`)), 60_000).unref()),
]);

function errorMessage(err) {
  return err?.message ?? String(err);
}

function sessionLine(session) {
  const summary = (session.customTitle || session.summary || '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = summary.length > 100 ? `${summary.slice(0, 97)}...` : summary;
  return clipped ? `${session.sessionId}  ${clipped}` : session.sessionId;
}

async function listAllProjectSessions(dir) {
  const pageSize = 200;
  const sessions = [];
  for (let offset = 0;; offset += pageSize) {
    const page = await listSessions({
      dir,
      includeWorktrees: false,
      limit: pageSize,
      offset,
    });
    sessions.push(...page);
    if (page.length < pageSize) return sessions;
  }
}

async function moveSession({ sessionId, newDir, oldDir, oldDirLabel, trust, log, info }) {
  let sessionInfo = info;
  if (!sessionInfo) {
    // Without oldDir the SDK scans every project dir.
    const lookupOpts = oldDir ? { dir: oldDir } : undefined;
    log(`looking up session ${sessionId}${lookupOpts ? ` in ${lookupOpts.dir}` : ' (all projects)'}`);
    sessionInfo = await getSessionInfo(sessionId, lookupOpts);
    if (!sessionInfo) {
      throw new Error(
        `session ${sessionId} not found` +
        (oldDirLabel ? ` under ${oldDirLabel} (try omitting --olddir to search everywhere)` : '')
      );
    }
  }

  const oldCwd = sessionInfo.cwd;
  if (!oldCwd) throw new Error(`session ${sessionId} has no recorded working directory`);
  log(`session found; current home: ${oldCwd}`);

  if (oldDir && !sameDir(oldCwd, oldDir)) {
    throw new Error(`session ${sessionId} belongs to "${oldCwd}", not "${oldDir}" (seatbelt olddir mismatch)`);
  }

  if (sameDir(oldCwd, newDir)) {
    console.log(`Session ${sessionId} already lives in ${newDir}; nothing to do.`);
    return { changed: false, exitCode: 0 };
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
      options: { resume: sessionId, cwd: oldCwd },
    });

    if (typeof q.setCwd !== 'function') {
      closeInput();
      throw new Error(
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

    try {
      log(`sending set_cwd -> ${newDir}`);
      let res = await withTimeout(q.setCwd(newDir), 'set_cwd');

      if (res.status === 'needs_trust') {
        log(`directory needs trust: ${res.directory}`);
        const accepted = trust || (await confirmTrust(res.directory));
        if (!accepted) throw new Error('trust declined; session left unchanged');
        res = await withTimeout(
          q.setCwd(newDir, { trustAccepted: true, trustedDirectory: res.directory }),
          'set_cwd (trusted)');
      }

      if (res.status !== 'ok') {
        throw new Error(`set_cwd failed (${res.status}${res.reason ? `/${res.reason}` : ''}): ${res.message ?? 'no detail'}`);
      }

      console.log(`Session ${sessionId} moved: ${oldCwd} -> ${res.cwd}`);
      if (res.transcript_relocated === false) {
        console.error('warning: CLI reported the transcript was NOT relocated; verify with --verbose');
        exitCode = 1;
      }
    } finally {
      closeInput();
      await consumer.catch(() => {});
    }

    // Independent verification: the session must now be discoverable from newdir.
    const moved = await getSessionInfo(sessionId, { dir: newDir });
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

  return { changed: true, exitCode };
}

// Pure metadata read — no CLI spawn, no resume. With no --olddir the SDK scans
// every project directory for the session.
async function runGet(args, log) {
  const lookupOpts = args.olddir ? { dir: canonicalMaybeMissingDir(args.olddir) } : undefined;
  log(`looking up session ${args.sessionId}${lookupOpts ? ` in ${lookupOpts.dir}` : ' (all projects)'}`);
  const info = await getSessionInfo(args.sessionId, lookupOpts);
  if (!info) {
    throw new Error(
      `session ${args.sessionId} not found` +
      (args.olddir ? ` under ${args.olddir} (try omitting --olddir to search everywhere)` : '')
    );
  }
  if (!info.cwd) throw new Error(`session ${args.sessionId} has no recorded working directory`);
  console.log(info.cwd);
  return 0;
}

async function runSingle(args, log) {
  const newDir = canonicalDir(args.newDir, 'newdir');
  const oldDir = args.olddir ? canonicalMaybeMissingDir(args.olddir) : undefined;
  const result = await moveSession({
    sessionId: args.sessionId,
    newDir,
    oldDir,
    oldDirLabel: args.olddir,
    trust: args.trust,
    log,
  });
  return result.exitCode;
}

async function runBulk(args, log) {
  const oldDir = canonicalMaybeMissingDir(args.oldDir);
  const newDir = canonicalDir(args.newDir, 'newdir');

  if (sameDir(oldDir, newDir)) {
    console.log(`olddir and newdir are both ${newDir}; nothing to do.`);
    return 0;
  }

  log(`listing sessions for ${oldDir}`);
  const sessions = await listAllProjectSessions(oldDir);
  const targets = sessions.filter((session) => session.cwd && sameDir(session.cwd, oldDir));

  if (targets.length === 0) {
    console.log(`No sessions found for ${oldDir}.`);
    return 0;
  }

  if (args.dryRun) {
    console.log(`Would move ${targets.length} session${targets.length === 1 ? '' : 's'}: ${oldDir} -> ${newDir}`);
    for (const session of targets) console.log(`  ${sessionLine(session)}`);
    return 0;
  }

  console.error(`Found ${targets.length} session${targets.length === 1 ? '' : 's'} for ${oldDir}.`);
  if (args.verbose) {
    for (const session of targets) console.error(`  ${sessionLine(session)}`);
  }

  let moved = 0;
  let alreadyThere = 0;
  let warnings = 0;
  let failures = 0;
  for (const session of targets) {
    try {
      const result = await moveSession({
        sessionId: session.sessionId,
        newDir,
        oldDir,
        oldDirLabel: args.oldDir,
        trust: args.trust,
        log,
        info: session,
      });
      if (result.changed) moved += 1;
      else alreadyThere += 1;
      if (result.exitCode !== 0) warnings += 1;
    } catch (err) {
      failures += 1;
      console.error(`cc-session-setcwd: session ${session.sessionId} failed: ${errorMessage(err)}`);
    }
  }

  const summary = `Moved ${moved} session${moved === 1 ? '' : 's'}` +
    (alreadyThere ? `; ${alreadyThere} already there` : '') +
    (warnings ? `; ${warnings} warning${warnings === 1 ? '' : 's'}` : '') +
    (failures ? `; ${failures} failed` : '');
  if (warnings || failures) {
    console.error(summary);
    return 1;
  }
  console.log(summary);
  return 0;
}

async function main() {
  const args = parseCli();
  const log = args.verbose ? (m) => console.error(`[cc-session-setcwd] ${m}`) : () => {};
  const exitCode = args.mode === 'get'
    ? await runGet(args, log)
    : args.mode === 'bulk'
      ? await runBulk(args, log)
      : await runSingle(args, log);
  process.exit(exitCode);
}

main().catch((err) => fail(errorMessage(err)));
