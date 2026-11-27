// Lifecycle of E2B sandboxes that act as linked T3 Code environments:
// create → install → serve → clone → install deps → pair → link, pause ↔ resume, and unlink → kill.
// State is persisted so a restarted MCP server still manages what it started.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BUSY_STATUSES,
  SCRIPT_DIR,
  T3_PORT,
  dependencySetupScript,
  gitSetupCommand,
  healthCommand,
  installScript,
  pairingCommand,
  projectSetupCommand,
  shellQuote,
  startServerCommand,
  threadListCommand,
} from "./bootstrap.ts";
import { E2BClient } from "./e2b.ts";
import { type LinkAccess, LocalT3 } from "./t3local.ts";

export type Phase =
  | "creating"
  | "installing"
  | "starting"
  | "cloning"
  | "linking"
  | "ready"
  | "paused"
  | "destroying"
  | "failed";

export interface ManagedSandbox {
  sandboxId: string;
  name: string;
  phase: Phase;
  template: string;
  createdAt: string;
  url?: string;
  environmentId?: string;
  repo?: string;
  workspacePath?: string;
  /** T3 project id of the clone in the sandbox; pass as delegate_task target.projectId. */
  projectId?: string;
  access: LinkAccess;
  idleMinutes: number;
  ttlMinutes: number;
  keepAlive: boolean;
  lastBusyAt?: string;
  pausedAt?: string;
  sawThread: boolean;
  error?: string;
  threads?: { threadId: string; title?: string; status: string }[];
}

export interface CreateOptions {
  repo?: string;
  ref?: string;
  name?: string;
  template?: string;
  ttlMinutes?: number;
  idleMinutes?: number;
  access?: LinkAccess;
  env?: Record<string, string>;
  keepAlive?: boolean;
  /** Install the repo's toolchain and dependencies after cloning. Default true. */
  setup?: boolean;
  /** Don't link with the local t3 CLI; return a t3code://pair link for the desktop app instead. */
  pairOnly?: boolean;
}

type Progress = (message: string) => void;

/** Env vars forwarded to every sandbox when set locally; T3E2B_FORWARD_ENV adds more. */
const DEFAULT_FORWARD = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN"];
const skipLink = process.env.T3E2B_SKIP_LINK === "1";
const idleAction = process.env.T3E2B_IDLE_ACTION === "kill" ? "kill" : "pause";
const pausedMaxDays = Number(process.env.T3E2B_PAUSED_MAX_DAYS ?? 7);
const stateDir = process.env.T3E2B_STATE_DIR ?? join(homedir(), ".t3e2b");
const stateFile = join(stateDir, "state.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesSince = (iso: string) => (Date.now() - Date.parse(iso)) / 60_000;

/** Repo URL → directory name, e.g. git@github.com:a/b.git → b */
const repoDirName = (repo: string) =>
  repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "workspace";

/** There are no SSH keys in the sandbox: clone GitHub/GitLab SSH URLs over HTTPS (GH_TOKEN). */
const httpsUrl = (repo: string) => repo.replace(/^git@([^:]+):/, "https://$1/");

const local = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

export const appLink = (pairUrl: string) => `t3code://pair?${new URLSearchParams({ pairingUrl: pairUrl })}`;

export class SandboxManager {
  readonly e2b: E2BClient;
  readonly t3 = new LocalT3();
  private sandboxes = new Map<string, ManagedSandbox>();
  private reaping = false;

  constructor(e2b = new E2BClient()) {
    this.e2b = e2b;
    try {
      const saved: ManagedSandbox[] = JSON.parse(readFileSync(stateFile, "utf8"));
      for (const s of saved) this.sandboxes.set(s.sandboxId, s);
    } catch {
      // first run
    }
  }

  private save() {
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.sandboxes.values()], null, 2));
    renameSync(tmp, stateFile);
  }

  update(s: ManagedSandbox, patch: Partial<ManagedSandbox>) {
    Object.assign(s, patch);
    this.save();
  }

  list(): ManagedSandbox[] {
    return [...this.sandboxes.values()];
  }

  find(idOrEnv: string): ManagedSandbox | undefined {
    return (
      this.sandboxes.get(idOrEnv) ??
      this.list().find((s) => s.environmentId === idOrEnv || s.name === idOrEnv)
    );
  }

  private get(idOrEnv: string): ManagedSandbox {
    const s = this.find(idOrEnv);
    if (!s) throw new Error(`no managed sandbox ${idOrEnv}`);
    return s;
  }

  async preflight(pairOnly: boolean): Promise<void> {
    if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is not set");
    if (!skipLink && !pairOnly && !this.t3.linkedEnvironmentsEnabled()) {
      throw new Error(
        `Linked environments are off in ${this.t3.home}/userdata/settings.json. ` +
          `Turn on the Linked environments beta in T3 Code settings ("linkedEnvironmentsEnabled": true) and retry, ` +
          `or use pairOnly to pair the desktop app instead.`,
      );
    }
  }

  /** Credentials and settings from this machine that the sandbox's agents need. */
  private credentials(extra: Record<string, string> = {}): Record<string, string> {
    const keys = [...DEFAULT_FORWARD, ...(process.env.T3E2B_FORWARD_ENV ?? "").split(",")].map((k) => k.trim());
    const env: Record<string, string> = {};
    for (const k of keys) if (k && process.env[k]) env[k] = process.env[k]!;
    env.GH_TOKEN ||= local("gh", ["auth", "token"]);
    if (!env.GH_TOKEN) delete env.GH_TOKEN;
    return { ...env, ...extra };
  }

  async create(opts: CreateOptions, progress: Progress = () => {}): Promise<ManagedSandbox & { pairLink?: string }> {
    const pairOnly = opts.pairOnly ?? false;
    await this.preflight(pairOnly);
    // Match the local client's version so both ends speak the same protocol.
    const t3Version = process.env.T3E2B_T3_VERSION ?? (await this.t3.version().catch(() => ""));
    const ttlMinutes = opts.ttlMinutes ?? 120;
    const template = opts.template ?? process.env.T3E2B_TEMPLATE ?? "t3";
    const name = opts.name ?? `t3e2b-${randomUUID().slice(0, 8)}`;

    progress(`creating E2B sandbox ${name} from template ${template}`);
    const env = this.credentials(opts.env);
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
      progress("warning: no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / OPENAI_API_KEY set; agents there can't log in (run `claude setup-token`)");
    }
    const sandboxId = await this.e2b.create({
      template,
      timeoutMs: ttlMinutes * 60_000,
      envs: env,
      metadata: { t3e2bName: name, ...(opts.repo ? { repo: opts.repo } : {}) },
    });

    const s: ManagedSandbox = {
      sandboxId,
      name,
      template,
      phase: "creating",
      createdAt: new Date().toISOString(),
      repo: opts.repo,
      access: opts.access ?? "full-access",
      idleMinutes: opts.idleMinutes ?? 10,
      ttlMinutes,
      keepAlive: opts.keepAlive ?? false,
      sawThread: false,
    };
    this.sandboxes.set(s.sandboxId, s);
    this.save();

    try {
      const pairLink = await this.provision(s, opts, t3Version, pairOnly, progress);
      return { ...s, ...(pairLink ? { pairLink } : {}) };
    } catch (e: any) {
      this.update(s, { phase: "failed", error: e.message });
      if (process.env.T3E2B_KEEP_FAILED === "1") {
        progress(`setup failed, keeping sandbox ${s.sandboxId} for debugging (the reaper deletes it later)`);
      } else {
        progress(`setup failed, deleting sandbox: ${e.message}`);
        await this.destroy(s.sandboxId).catch(() => {});
      }
      throw e;
    }
  }

  private async provision(
    s: ManagedSandbox,
    opts: CreateOptions,
    t3Version: string,
    pairOnly: boolean,
    progress: Progress,
  ): Promise<string | undefined> {
    const id = s.sandboxId;

    this.update(s, { phase: "installing" });
    progress(`checking t3 ${t3Version || "(latest)"} and provider CLIs`);
    await this.e2b.writeFile(id, `${SCRIPT_DIR}/install.sh`, installScript);
    const install = await this.e2b.exec(id, `bash ${SCRIPT_DIR}/install.sh ${shellQuote(t3Version)} 2>&1 | tail -40`, 600);
    if (install.exitCode !== 0 || !/install done/.test(install.stdout)) {
      throw new Error(`install failed:\n${install.stdout}${install.stderr}`);
    }
    await this.e2b.exec(id, gitSetupCommand(local("git", ["config", "user.name"]), local("git", ["config", "user.email"])));

    this.update(s, { phase: "starting" });
    progress("starting t3 serve");
    await this.e2b.execDetached(id, startServerCommand);
    await this.waitForHealth(id);

    if (opts.repo) {
      this.update(s, { phase: "cloning" });
      const dir = `/home/user/${repoDirName(opts.repo)}`;
      progress(`cloning ${opts.repo}`);
      const r = await this.e2b.exec(id, projectSetupCommand(httpsUrl(opts.repo), opts.ref, dir), 600);
      if (r.exitCode !== 0) throw new Error(`clone failed:\n${r.stdout}${r.stderr}`);
      const projectId = r.stdout.match(/Added project ([0-9a-f-]{36})/)?.[1];
      this.update(s, { workspacePath: dir, ...(projectId ? { projectId } : {}) });

      if (opts.setup !== false) {
        progress("installing the repo's toolchain and dependencies");
        const d = await this.e2b.exec(id, dependencySetupScript, 1800, dir);
        // A failed install doesn't stop the sandbox: an agent there can fix it.
        if (d.exitCode !== 0) progress(`dependency install failed (continuing):\n${(d.stdout + d.stderr).slice(-2000)}`);
      }
    }

    const url = await this.e2b.publicUrl(id, T3_PORT);
    this.update(s, { url, phase: "linking" });

    progress("pairing");
    const pairing = await this.pairing(id, `t3e2b ${s.name}`, url);
    if (pairOnly || skipLink) {
      this.update(s, { phase: "ready", lastBusyAt: new Date().toISOString() });
      progress("pair link created (open it on the machine running the T3 Code app)");
      return appLink(pairing.pairUrl);
    }
    const linked = await this.linkWithRetry(url, pairing.credential, s.access);
    this.update(s, { environmentId: linked.environmentId, phase: "ready", lastBusyAt: new Date().toISOString() });
    progress(`ready as environment ${linked.environmentId}`);
    return undefined;
  }

  private async pairing(id: string, label: string, url: string): Promise<{ credential: string; pairUrl: string }> {
    const r = await this.e2b.exec(id, pairingCommand(label, url), 60);
    const out = r.stdout;
    try {
      const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      if (j.credential) return { credential: j.credential, pairUrl: j.pairUrl ?? `${url}/pair#token=${j.credential}` };
    } catch {
      // fall through
    }
    throw new Error(`could not create pairing code:\n${r.stdout}${r.stderr}`);
  }

  /** A new 10-minute pairing link for the T3 Code desktop app (t3code://pair?...). */
  async pair(idOrEnv: string): Promise<string> {
    const s = this.get(idOrEnv);
    const url = s.url ?? (await this.e2b.publicUrl(s.sandboxId, T3_PORT));
    return appLink((await this.pairing(s.sandboxId, `t3e2b ${s.name}`, url)).pairUrl);
  }

  private async waitForHealth(id: string, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.e2b.exec(id, healthCommand, 15).catch(() => undefined);
      if (r?.exitCode === 0) return;
      if (Date.now() > deadline) {
        const log = await this.e2b.exec(id, "tail -40 ~/.t3e2b/serve.log", 15).catch(() => undefined);
        throw new Error(`t3 serve did not come up:\n${log?.stdout ?? ""}`);
      }
      await sleep(2_000);
    }
  }

  /** The sandbox's proxy route can take a few seconds to answer. */
  private async linkWithRetry(url: string, code: string, access: LinkAccess) {
    let last: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        return await this.t3.link(url, code, access);
      } catch (e: any) {
        last = e;
        // A refused/consumed pairing code will not succeed on retry.
        if (/pairing|scope|denied|disabled|refus/i.test(e.message)) throw e;
        await sleep(3_000 * (i + 1));
      }
    }
    throw last;
  }

  /** Freezes the sandbox (memory, disk, processes). The link stays; resume brings it back. */
  async pause(idOrEnv: string): Promise<ManagedSandbox> {
    const s = this.get(idOrEnv);
    await this.e2b.pause(s.sandboxId);
    this.update(s, { phase: "paused", pausedAt: new Date().toISOString() });
    return s;
  }

  /** Resumes a paused sandbox with a fresh ttlMinutes and makes sure t3 serve answers. */
  async resume(idOrEnv: string, ttlMinutes?: number): Promise<ManagedSandbox> {
    const s = this.get(idOrEnv);
    if (ttlMinutes) s.ttlMinutes = ttlMinutes;
    await this.e2b.resume(s.sandboxId, s.ttlMinutes * 60_000);
    const healthy = await this.e2b.exec(s.sandboxId, healthCommand, 15).then((r) => r.exitCode === 0, () => false);
    if (!healthy) {
      await this.e2b.execDetached(s.sandboxId, startServerCommand);
      await this.waitForHealth(s.sandboxId);
    }
    this.update(s, { phase: "ready", pausedAt: undefined, lastBusyAt: new Date().toISOString() });
    return s;
  }

  /** Unlinks locally first (so delegation followers stop), then deletes the sandbox. */
  async destroy(idOrEnv: string): Promise<ManagedSandbox> {
    const s = this.get(idOrEnv);
    this.update(s, { phase: "destroying" });
    if (s.environmentId) await this.t3.unlink(s.environmentId);
    await this.e2b.kill(s.sandboxId);
    this.sandboxes.delete(s.sandboxId);
    this.save();
    return s;
  }

  async exec(idOrEnv: string, command: string, timeoutSeconds = 60) {
    const s = this.get(idOrEnv);
    return this.e2b.exec(s.sandboxId, command, timeoutSeconds);
  }

  /** Reads thread statuses in the sandbox and records activity. */
  async refresh(s: ManagedSandbox): Promise<void> {
    const r = await this.e2b.exec(s.sandboxId, threadListCommand, 30);
    if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout);
    const rows: any[] = JSON.parse(r.stdout || "[]");
    const threads = rows.map((t) => ({ threadId: t.threadId, title: t.title, status: String(t.status) }));
    const busy = threads.some((t) => BUSY_STATUSES.has(t.status));
    this.update(s, {
      threads,
      sawThread: s.sawThread || threads.length > 0,
      ...(busy ? { lastBusyAt: new Date().toISOString() } : {}),
    });
  }

  /**
   * Housekeeping. A ready sandbox is paused (or killed, T3E2B_IDLE_ACTION=kill) when:
   *  - it ran at least one thread, none is busy now, and the last activity was idleMinutes ago; or
   *  - no thread ever started within idleMinutes * 3 of becoming ready (forgotten sandbox).
   * E2B pauses it by itself at ttlMinutes. Sandboxes paused for T3E2B_PAUSED_MAX_DAYS (default 7)
   * are deleted, as are sandboxes that failed or got stuck during setup.
   */
  async reap(log: (msg: string) => void = () => {}): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      for (const s of this.list()) {
        try {
          if (s.phase === "failed" || s.phase === "destroying") {
            await this.destroy(s.sandboxId);
            log(`deleted ${s.name} (${s.phase})`);
            continue;
          }
          if (s.phase !== "ready" && s.phase !== "paused") {
            if (minutesSince(s.createdAt) > 45) {
              await this.destroy(s.sandboxId);
              log(`deleted ${s.name} (stuck in ${s.phase})`);
            }
            continue;
          }
          const state = await this.e2b.state(s.sandboxId);
          if (state === "gone") {
            if (s.environmentId) await this.t3.unlink(s.environmentId);
            this.sandboxes.delete(s.sandboxId);
            this.save();
            log(`forgot ${s.name} (no longer in E2B)`);
            continue;
          }
          if (state === "paused") {
            if (s.phase !== "paused") this.update(s, { phase: "paused", pausedAt: new Date().toISOString() });
            if (minutesSince(s.pausedAt!) > pausedMaxDays * 24 * 60) {
              await this.destroy(s.sandboxId);
              log(`deleted ${s.name}: paused for more than ${pausedMaxDays} days`);
            }
            continue;
          }
          if (s.phase === "paused") this.update(s, { phase: "ready", pausedAt: undefined }); // resumed elsewhere
          if (s.keepAlive) continue;
          await this.refresh(s);
          const busy = s.threads?.some((t) => BUSY_STATUSES.has(t.status));
          if (busy) continue;
          const idleFor = minutesSince(s.lastBusyAt ?? s.createdAt);
          const limit = s.sawThread ? s.idleMinutes : s.idleMinutes * 3;
          if (idleFor < limit) continue;
          if (idleAction === "kill") {
            await this.destroy(s.sandboxId);
            log(`deleted ${s.name}: idle ${idleFor.toFixed(1)} min`);
          } else {
            await this.pause(s.sandboxId);
            log(`paused ${s.name}: idle ${idleFor.toFixed(1)} min`);
          }
        } catch (e: any) {
          log(`check failed for ${s.name}: ${e.message}`);
        }
      }
    } finally {
      this.reaping = false;
    }
  }

  /** Sandboxes carrying our metadata label that this state file does not know (e.g. lost state). */
  async orphans(): Promise<string[]> {
    const live = await this.e2b.list();
    return live.filter((b) => !this.sandboxes.has(b.sandboxId)).map((b) => `${b.sandboxId} (${b.state})`);
  }
}
