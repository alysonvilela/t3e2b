// Thin layer over the E2B SDK: the handful of sandbox operations t3e2b needs.
// Works with E2B Cloud and self-hosted E2B: the SDK reads E2B_API_KEY, E2B_API_URL,
// E2B_SANDBOX_URL and E2B_DOMAIN from the environment itself.

import { CommandExitError, Sandbox, type SandboxInfo } from "e2b";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const METADATA_KEY = "t3e2b";

export interface CreateInput {
  template: string;
  timeoutMs: number;
  envs: Record<string, string>;
  metadata: Record<string, string>;
}

export class E2BClient {
  async create(input: CreateInput): Promise<string> {
    const sbx = await Sandbox.create(input.template, {
      envs: input.envs,
      timeoutMs: input.timeoutMs,
      metadata: { [METADATA_KEY]: "1", ...input.metadata },
      // At the end of its lifetime the sandbox is paused, not deleted: the repo, installed
      // dependencies and running t3 server survive. No autoResume: T3's own connection
      // attempts would otherwise wake it straight back up. `resume` does it on purpose.
      lifecycle: { onTimeout: "pause", autoResume: false },
    });
    return sbx.sandboxId;
  }

  /** Connects to a running sandbox. Connecting to a paused one resumes it. */
  async connect(id: string, timeoutMs?: number): Promise<Sandbox> {
    return Sandbox.connect(id, timeoutMs ? { timeoutMs } : undefined);
  }

  /** "running" | "paused" | "gone" */
  async state(id: string): Promise<string> {
    try {
      return (await Sandbox.getInfo(id)).state;
    } catch (e: any) {
      if (e?.name === "NotFoundError" || e?.name === "SandboxNotFoundError" || /not found|404/i.test(e?.message ?? "")) return "gone";
      throw e;
    }
  }

  /** Runs a command and waits for it. Throws on transport errors, not on a non-zero exit. */
  async exec(id: string, command: string, timeoutSeconds = 60, cwd?: string): Promise<CommandResult> {
    const sbx = await this.connect(id);
    return run(sbx, command, timeoutSeconds, cwd);
  }

  /** Starts a background command; it keeps running in the sandbox after this call returns. */
  async execDetached(id: string, command: string): Promise<void> {
    const sbx = await this.connect(id);
    const handle = await sbx.commands.run(command, { background: true, timeoutMs: 0 });
    // Stop streaming its output: an open stream would keep this process alive.
    await handle.disconnect();
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const sbx = await this.connect(id);
    await sbx.files.write(path, content);
  }

  /** URL where this machine reaches `port` inside the sandbox. */
  async publicUrl(id: string, port: number): Promise<string> {
    const sbx = await this.connect(id);
    const self = process.env.E2B_SANDBOX_URL;
    if (!self) return `https://${sbx.getHost(port)}`; // E2B Cloud (or a custom E2B_DOMAIN with TLS)
    // Self-hosted: the client-proxy routes <port>-<id>.<anything> to the sandbox. For an IP
    // (LAN or Tailscale 100.x), sslip.io makes those names resolve to it.
    const u = new URL(self);
    const host = /^[\d.]+$/.test(u.hostname) ? `${u.hostname}.sslip.io` : u.hostname;
    return `${u.protocol}//${port}-${id}.${host}${u.port ? `:${u.port}` : ""}`;
  }

  async pause(id: string): Promise<void> {
    await Sandbox.pause(id);
  }

  /** Resumes a paused sandbox and gives it a new lifetime. */
  async resume(id: string, timeoutMs: number): Promise<void> {
    await this.connect(id, timeoutMs);
  }

  /** Permanently deletes the sandbox. A missing sandbox is not an error. */
  async kill(id: string): Promise<void> {
    await Sandbox.kill(id).catch((e: any) => {
      if (!/not found|404/i.test(e?.message ?? "")) throw e;
    });
  }

  /** Running and paused sandboxes that carry our metadata label. */
  async list(): Promise<SandboxInfo[]> {
    const out: SandboxInfo[] = [];
    const pages = Sandbox.list({ query: { metadata: { [METADATA_KEY]: "1" } } });
    while (pages.hasNext) out.push(...(await pages.nextItems()));
    return out;
  }
}

export async function run(sbx: Sandbox, command: string, timeoutSeconds = 60, cwd?: string): Promise<CommandResult> {
  try {
    const r = await sbx.commands.run(command, { timeoutMs: timeoutSeconds * 1000, ...(cwd ? { cwd } : {}) });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
    throw e;
  }
}
