# Working on t3e2b

- Runtime is Bun: `bun install`, `bun bin/t3e2b.ts <cmd>`, `bun run typecheck`. No build step; the package
  ships `src/` as TypeScript.
- `src/e2b.ts` is the only file that talks to E2B. `src/sandboxes.ts` owns the lifecycle and the state file,
  `src/bootstrap.ts` the shell that runs inside sandboxes, `src/t3local.ts` the local `t3` CLI.
- `src/index.ts` (MCP instructions) and `skills/orchestrate-e2b-sandboxes/SKILL.md` describe the same flow:
  change them together.
- Test against a real E2B (Cloud, or `selfhost/`): `create --pair --ttl 30`, `exec`, `pause`, `resume`,
  `pair`, `destroy`. Self-hosted E2B is not reachable from inside its own sandboxes, so run the CLI from the
  host, another machine, or a pod.
- Template changes (`src/templates.ts`, `templates/mise.toml`) need a rebuild: `bun bin/t3e2b.ts template t3`.
