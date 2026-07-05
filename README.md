# cc-session-setcwd

Reassociate a Claude Code session with a new working directory from the command
line — an automated, non-interactive version of the TUI `/cd` command.

When you move or rename a project directory, `claude --resume` can no longer
find the sessions that belong to it: session transcripts are stored under
`~/.claude/projects/<slugified-cwd>/<sessionid>.jsonl`, and the slugification is
lossy and undocumented. The supported fix is the `/cd` command, but it only
exists in the interactive TUI. This tool drives the same underlying mechanism
headlessly.

## Usage

```
cc-session-setcwd [--originaldir <dir>] [--no-trust] [--verbose] <sessionid> <newdir>
```

- `<sessionid>` — UUID of the session to move.
- `<newdir>` — directory the session should live in from now on (must exist).
- `--originaldir <dir>` — optional seatbelt: fail unless the session currently
  belongs to this directory. It may no longer exist on disk (that's the point).
  Without it, the session is located by scanning all project directories.
- `--trust` — accept Claude Code's trust prompt for `<newdir>` without asking
  (this is the default).
- `--no-trust` — prompt on the terminal before accepting the trust prompt (or
  fail if stdin is not a TTY).
- `--verbose` — progress details on stderr.

Exit codes: `0` moved (or already there), `1` error, `2` usage error.

## Install

```
npm install
npm link      # or: node src/index.js ...
```

## How it works

There is no documented SDK API for rehoming a session, and `/cd` is not
dispatchable as a prompt in `-p`/SDK mode (`/cd isn't available in this
environment`). However, the CLI's control protocol has a `set_cwd` request that
is handled by the *same* code path as interactive `/cd` — including physically
relocating the transcript to the new directory's project storage and honoring
the directory-trust latch. The Agent SDK (>= 0.3.201) implements it as
`Query.setCwd(path, { trustAccepted, trustedDirectory })`, currently
undocumented and absent from the published `Query` typings.

The tool:

1. Locates the session with `getSessionInfo(sessionId, { dir? })` (with no
   `dir`, the SDK searches every project directory).
2. Resumes it headlessly with `query({ prompt: <held-open stream>, options:
   { resume, cwd: <old dir> } })`. The input stream never yields, so no turn
   runs and no tokens are spent. Resume-by-id is scoped to the spawn cwd's
   slug, so the CLI must be spawned in the session's old directory — if that
   directory no longer exists it is recreated for the duration of the move and
   removed afterwards.
3. Sends `setCwd(newdir)`. A `needs_trust` response triggers the trust
   round-trip (`trustAccepted: true`, echoing the returned canonical
   directory) by default; `--no-trust` switches this to an interactive
   confirmation.
4. Verifies the response (`status: "ok"`, `transcript_relocated: true`) and
   independently confirms the session is now discoverable under the new
   directory before exiting 0.

The move appends only a small `relocated` marker to the transcript; no user or
assistant messages are added and no API calls are made.

### Caveats

- `Query.setCwd` is internal/untyped as of `@anthropic-ai/claude-agent-sdk`
  0.3.201 (the tool checks for its presence and fails cleanly if a future SDK
  removes it). Verified against Claude Code CLI 2.1.201.
- `set_cwd` is rejected while a turn is running; that can't happen here since
  the tool never sends a prompt.
