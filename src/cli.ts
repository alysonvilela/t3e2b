// t3e2b CLI: the same operations as the MCP tools, plus pairing the desktop app and building templates.
//   t3e2b create [--repo <url|none>] [--ref <ref>] [--pair] [--template t3] [--idle <min>] [--ttl <min>] [--access <mode>] [--no-setup] [--keep-alive]
//   t3e2b list | pause <id> | resume <id> | pair <id> | destroy <id> | exec <id> <command> | reap | doctor
//   t3e2b template <t3|desktop> [--memory <MB>] [--cpu <n>]
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { SandboxManager } from "./sandboxes.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    ref: { type: "string" },
    template: { type: "string" },
    idle: { type: "string" },
    ttl: { type: "string" },
    access: { type: "string" },
    pair: { type: "boolean" },
    "no-setup": { type: "boolean" },
    "keep-alive": { type: "boolean" },
    memory: { type: "string" },
    cpu: { type: "string" },
  },
});
const [cmd, ...rest] = positionals;
const log = (m: string) => process.stderr.write(`[t3e2b] ${m}\n`);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

if (!process.env.E2B_API_KEY) {
  log("E2B_API_KEY is not set (self-hosted E2B: also E2B_API_URL and E2B_SANDBOX_URL)");
  process.exit(1);
}
const m = new SandboxManager();

/** On macOS, hand a t3code://pair link to the desktop app. */
function openPairLink(link: string) {
  log(`pair link (valid 10 min):\n${link}`);
  if (process.platform === "darwin") {
    try {
      execFileSync("open", [link]);
    } catch {
      // the link is printed above
    }
  }
}

switch (cmd) {
  case "doctor": {
    const out: Record<string, unknown> = { t3Cli: m.t3.cli, t3Home: m.t3.home };
    out.t3Version = await m.t3.version().catch((e) => `error: ${e.message}`);
    out.linkedEnvironmentsEnabled = m.t3.linkedEnvironmentsEnabled();
    out.links = await m.t3.list().catch((e) => `error: ${e.message}`);
    out.e2b = {
      apiUrl: process.env.E2B_API_URL ?? "(E2B Cloud)",
      sandboxUrl: process.env.E2B_SANDBOX_URL ?? "(E2B Cloud)",
      sandboxes: await m.e2b.list().then((s) => `ok, ${s.length} labelled sandbox(es)`, (e) => `error: ${e.message}`),
    };
    out.credentials = Object.fromEntries(
      ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN"].map((k) => [k, process.env[k] ? "set" : "unset"]),
    );
    print(out);
    break;
  }
  case "create": {
    const s = await m.create(
      {
        repo: values.repo === "none" ? undefined : values.repo,
        ref: values.ref,
        template: values.template,
        idleMinutes: values.idle ? Number(values.idle) : undefined,
        ttlMinutes: values.ttl ? Number(values.ttl) : undefined,
        access: values.access as any,
        setup: !values["no-setup"],
        keepAlive: values["keep-alive"],
        pairOnly: values.pair,
      },
      log,
    );
    print(s);
    if (s.pairLink) openPairLink(s.pairLink);
    break;
  }
  case "list":
    await Promise.all(m.list().filter((s) => s.phase === "ready").map((s) => m.refresh(s).catch(() => {})));
    print({ sandboxes: m.list(), untracked: await m.orphans().catch(() => []) });
    break;
  case "pause":
    print(await m.pause(rest[0]!));
    break;
  case "resume":
    print(await m.resume(rest[0]!, values.ttl ? Number(values.ttl) : undefined));
    break;
  case "pair":
    openPairLink(await m.pair(rest[0]!));
    break;
  case "destroy":
    print(await m.destroy(rest[0]!));
    break;
  case "exec":
    print(await m.exec(rest[0]!, rest.slice(1).join(" "), 600));
    break;
  case "reap":
    await m.reap(log);
    break;
  case "template": {
    const { buildTemplate, templates } = await import("./templates.ts");
    const name = rest[0] as keyof typeof templates;
    if (!(name in templates)) {
      log(`usage: t3e2b template <${Object.keys(templates).join("|")}> [--memory <MB>] [--cpu <n>]`);
      process.exit(2);
    }
    print(await buildTemplate(name, { memoryMB: values.memory ? Number(values.memory) : undefined, cpuCount: values.cpu ? Number(values.cpu) : undefined }));
    break;
  }
  default:
    log("usage: t3e2b create|list|pause <id>|resume <id>|pair <id>|destroy <id>|exec <id> <cmd>|reap|doctor|template <t3|desktop>");
    process.exit(2);
}

// SDK keep-alive connections must not hold the CLI open once the command is done.
process.exit(0);
