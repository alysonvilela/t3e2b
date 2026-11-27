# t3e2b

MCP server and CLI that let [T3 Code](https://github.com/pingdotgg/t3code) run its agents in
[E2B](https://e2b.dev) sandboxes (Firecracker microVMs), on E2B Cloud or on your own E2B. The repo,
its worktrees, its dependencies and the agent all live in the sandbox; your machine only runs the
T3 Code app. Built on T3 Code's peer links (the *Linked environments* beta), like
[t3boat](https://github.com/trevize-dev/t3boat) is for boat.dev.

```
orchestrator thread ──e2b_sandbox_create──▶ t3e2b ──E2B SDK──▶ sandbox (template "t3": t3 + claude + gh + mise)
                                                   │              t3 serve :3773 → E2B proxy URL
                                                   │              git clone <repo> + t3 project add + deps install
                                                   └─local t3 CLI──▶ t3 environment link <url> --pairing-code …
orchestrator ──delegate_task(target.environmentId)──▶ thread runs in the sandbox, wakes the parent when done
t3e2b (every 60 s) ──t3 thread list──▶ idle ≥ idleMinutes → pause (memory + disk kept) · resume in seconds
```

What it adds over deleting sandboxes when idle:

- **Pause instead of delete.** Idle sandboxes are paused (memory snapshot: files, installed dependencies and
  the running T3 server survive), and `resume` brings them back in a few seconds. The first, costly install
  happens once per project. Paused sandboxes are deleted after 7 days.
- **Dependencies installed before the agent starts.** After cloning, the repo's toolchain (mise:
  `.nvmrc`, `.python-version`, `mise.toml`, ...) and dependencies (bun/pnpm/yarn/npm, uv, go, cargo) are
  installed by a script, so agents don't spend tokens or time on setup.
- **Desktop app pairing without linking.** `create --pair` and `pair <id>` print (and on macOS open) a
  `t3code://pair` link: the sandbox shows up in the T3 Code app as a remote environment.
- **Self-hosted E2B.** `selfhost/` installs E2B on a single-node k3s; point t3e2b at it with two env vars.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3 and T3 Code 0.1.7 or later.

1. **E2B credentials.** E2B Cloud: an API key from the dashboard. Self-hosted: see [selfhost/](selfhost/README.md).

   ```bash
   export E2B_API_KEY=e2b_…
   # self-hosted only (LAN IP, or the node's Tailscale 100.x IP when away):
   export E2B_API_URL=http://192.168.1.10:3000 E2B_SANDBOX_URL=http://192.168.1.10:3002
   ```

2. **Build the template once** (5-15 min): `bunx t3e2b template t3`. It has T3 Code, Claude Code, gh and
   mise with node, bun, pnpm, yarn, deno, python, uv, go and rust ([templates/mise.toml](templates/mise.toml)).
3. **Logins for the agents.** Generate a long-lived Claude token once and export it; your GitHub login is
   picked up from `gh` for cloning private repos, pushing and opening PRs:

   ```bash
   claude setup-token                       # prints a token; then:
   export CLAUDE_CODE_OAUTH_TOKEN=…
   gh auth login                            # if not already
   ```

4. **Pick a way to use it.**

   - *Orchestrator (like t3boat):* turn on *Settings → Labs → Linked environments* in T3 Code and register the MCP
     server with the provider your threads use:

     ```bash
     claude mcp add t3e2b --scope user -e E2B_API_KEY=e2b_… -e CLAUDE_CODE_OAUTH_TOKEN=… -- bunx t3e2b
     # self-hosted: also -e E2B_API_URL=… -e E2B_SANDBOX_URL=…
     ```

     Then ask a thread: *"Boot an E2B sandbox and delegate the test fixes to it."*
   - *Just the app:* `bunx t3e2b create --repo git@github.com:you/repo.git --pair` opens the T3 Code app on the
     pairing screen; the project is in the sandbox.

5. **Check the setup:** `bunx t3e2b doctor`.

## Credentials in the sandbox

Forwarded from your environment when set: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GH_TOKEN` (falls back to `gh auth token`), plus anything listed in `T3E2B_FORWARD_ENV`
(comma-separated). Your `git config user.name/email` is copied too. GitHub SSH URLs are cloned over HTTPS
with the token; the sandbox gets no SSH keys. Everything forwarded is readable by code running in the sandbox.

## Tools

| Tool | What it does |
| - | - |
| `e2b_sandbox_create` | Boots, sets up and links a sandbox. Returns `environmentId` and `projectId` for `delegate_task`'s `target`. 1-5 min. |
| `e2b_sandbox_list` | Managed sandboxes (running and paused), their threads and statuses. |
| `e2b_sandbox_pause` | Freeze now. |
| `e2b_sandbox_resume` | Resume a paused sandbox (seconds) and check its T3 server. |
| `e2b_sandbox_destroy` | Unlink + permanently delete. |
| `e2b_sandbox_configure` | Change `keepAlive` / `idleMinutes`. |
| `e2b_sandbox_exec` | Run a shell command in the sandbox (debugging). |

## CLI

`bunx t3e2b` with no arguments starts the MCP server on stdio. With arguments it is a CLI:

```
t3e2b create [--repo <url|none>] [--ref main] [--pair] [--template t3] [--idle 10] [--ttl 120] [--access full-access] [--no-setup] [--keep-alive]
t3e2b list | pause <id> | resume <id> [--ttl <min>] | pair <id> | destroy <id> | exec <id> <cmd> | reap | doctor
t3e2b template <t3|desktop> [--memory 1536] [--cpu 2]
```

`<id>` is a sandbox id, environment id or name. Idle pausing runs inside the MCP server; without it, E2B
still pauses each sandbox at `--ttl`, and `t3e2b reap` applies the idle policy once.

The `desktop` template is a small Linux desktop (Xfce, Firefox, noVNC on port 6080) for computer-use
experiments with the [e2b-desktop](https://github.com/e2b-dev/desktop) SDK.

## Lifecycle policy

- **Idle:** once a thread has run and none is busy (`preparing/queued/starting/running/waiting`) for
  `idleMinutes` (default 10), the sandbox is paused (`T3E2B_IDLE_ACTION=kill` deletes instead). A sandbox where
  no thread ever started is paused after `3 × idleMinutes`.
- **TTL:** E2B pauses the sandbox at `ttlMinutes` (default 120) after each start or resume, even if t3e2b is
  gone. There is no auto-resume: T3's connection attempts would wake it right back up. Resume explicitly.
- **Cleanup:** paused for `T3E2B_PAUSED_MAX_DAYS` (default 7) → deleted. Failed setups are deleted right away.
- **Crash-safe:** state lives in `~/.t3e2b/state.json`. Sandboxes carry the E2B metadata `t3e2b=1`; `list`
  reports labelled sandboxes the state file doesn't know.

## Configuration

| Env var | Default |
| - | - |
| `E2B_API_KEY` | required |
| `E2B_API_URL`, `E2B_SANDBOX_URL` | E2B Cloud. Set both for self-hosted E2B (read by the E2B SDK). |
| `T3E2B_TEMPLATE` | `t3` |
| `T3E2B_T3_VERSION` | local `t3 --version`, so both ends match |
| `T3E2B_T3_CLI` / `T3E2B_T3_HOME` | `t3` on PATH, else `~/.t3/bin/t3` / the CLI's default `~/.t3` |
| `T3E2B_FORWARD_ENV` | extra comma-separated local env vars to inject into each sandbox |
| `T3E2B_IDLE_ACTION` | `pause` (or `kill`) |
| `T3E2B_PAUSED_MAX_DAYS` | `7` |
| `T3E2B_REAP_INTERVAL_SECONDS` | `60` |
| `T3E2B_STATE_DIR` | `~/.t3e2b` |
| `T3E2B_SKIP_LINK` | `1` = set up and pair, but don't link locally |
| `T3E2B_KEEP_FAILED` | `1` = keep a sandbox whose setup failed, for debugging |

## Known limits

This is a proof of concept.

- `delegate_task` to a remote environment does not support `isolation: "worktree"`.
- A paused sandbox doesn't answer `delegate_task` until it is resumed.
- Self-hosted E2B serves plain HTTP on its ports; keep it on a private network (LAN, Tailscale). The T3 server
  still requires pairing (10-minute, one-time code).
- `t3 environment link` writes your live `~/.t3` database (that's how T3 links without the UI).
- Self-hosted E2B: sandboxes cannot reach the node's own IP.

## Development

```bash
git clone https://github.com/alysonvilela/t3e2b && cd t3e2b && bun install
cp selfhost/sdk.env .env 2>/dev/null || echo 'E2B_API_KEY=e2b_…' > .env   # Bun loads .env from the cwd
bun bin/t3e2b.ts doctor
bun run typecheck
```

Release: `npm publish` (runs the typecheck first).

## License

[Apache 2.0](LICENSE). Derived from [t3boat](https://github.com/trevize-dev/t3boat); see [NOTICE](NOTICE).
