// E2B templates t3e2b uses, built into the E2B team of E2B_API_KEY with `t3e2b template <name>`.
//   t3       T3 Code + Claude Code + gh + mise toolchains (templates/mise.toml). The default for create.
//   desktop  Small Linux desktop (Xfce + Firefox + noVNC on :6080) for the e2b-desktop SDK / computer use.
// Rebuild to update T3, Claude Code or the toolchains. Builds can take 5-15 minutes.

import { fileURLToPath } from "node:url";
import { Template, type TemplateClass } from "e2b";

const filesDir = fileURLToPath(new URL("../templates/", import.meta.url));

function t3(): TemplateClass {
  return (
    Template({ fileContextPath: filesDir })
      // Not fromTemplate("base"): a template built on another keeps its parent's disk size.
      .fromBaseImage()
      .aptInstall(["libatomic1", "jq", "build-essential", "pkg-config", "libssl-dev"]) // libatomic1: T3's Linux binaries
      // Claude Code, native installer (no Node version requirement). Retries: the download sometimes drops.
      .runCmd(
        "for i in 1 2 3; do curl -fsSL --retry 5 https://claude.ai/install.sh | bash && break; sleep 5; done; $HOME/.local/bin/claude --version",
        { user: "user" },
      )
      .runCmd(
        "curl -fsSL --retry 5 https://t3.codes/install.sh | T3CODE_INSTALL_BIN_DIR=$HOME/.local/bin sh && $HOME/.local/bin/t3 --version",
        { user: "user" },
      )
      // Current gh (the base image's Debian one is old) for clone/push/PRs of private repos.
      .runCmd(
        "mkdir -p /etc/apt/keyrings && curl -fsSL --retry 5 https://cli.github.com/packages/githubcli-archive-keyring.gpg" +
          " -o /etc/apt/keyrings/githubcli-archive-keyring.gpg" +
          " && echo 'deb [signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main'" +
          " > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh && gh --version",
        { user: "root" },
      )
      .runCmd(
        "ln -sf /home/user/.local/bin/t3 /usr/local/bin/t3 && ln -sf /home/user/.local/bin/claude /usr/local/bin/claude",
        { user: "root" },
      )
      .runCmd("git config --global init.defaultBranch main", { user: "user" })
      // Toolchains: mise with a global config (node, bun, pnpm, yarn, deno, python, uv, go, rust).
      .copy("mise.toml", "/etc/mise/config.toml", { user: "root" })
      .runCmd("curl -fsSL --retry 5 https://mise.run | sh && ~/.local/bin/mise install && ~/.local/bin/mise ls", { user: "user" })
      // Commands run in a login shell, which rebuilds PATH from /etc/profile (set_envs PATH is lost);
      // put mise's shims there so every tool works for commands, t3 and the agents it starts.
      .runCmd(
        `printf '%s\\n' 'export PATH="/home/user/.local/share/mise/shims:$PATH"' 'export MISE_YES=1' > /etc/profile.d/mise.sh`,
        { user: "root" },
      )
  );
}

function desktop(): TemplateClass {
  // A trimmed copy of github.com/e2b-dev/desktop/template (no Chrome/VS Code/LibreOffice), same
  // paths, so the e2b-desktop SDK works unchanged (it starts Xvfb, xfce4 and x11vnc itself).
  return Template()
    .fromImage("ubuntu:22.04")
    .setUser("root")
    .setWorkdir("/")
    .setEnvs({ DEBIAN_FRONTEND: "noninteractive" })
    .aptInstall([
      "xserver-xorg", "x11-xserver-utils", "xvfb", "x11-utils", "xauth",
      "xfce4", "xfce4-terminal", "dbus-x11",
      "x11vnc", "xdotool", "scrot", "ffmpeg", "wmctrl", "websockify",
      "sudo", "curl", "git", "wget", "net-tools", "netcat", "python3-pip",
      "software-properties-common", "libgtk-3-bin",
    ])
    .gitClone("https://github.com/e2b-dev/noVNC.git", "/opt/noVNC", { branch: "e2b-desktop" })
    .makeSymlink("/opt/noVNC/vnc.html", "/opt/noVNC/index.html")
    .gitClone("https://github.com/novnc/websockify.git", "/opt/noVNC/utils/websockify", { branch: "v0.12.0" })
    // Firefox as a real .deb (Ubuntu's is a snap, which doesn't run in a sandbox).
    .runCmd(
      "add-apt-repository -y ppa:mozillateam/ppa && apt-get update && apt-get install -y firefox-esr" +
        " && update-alternatives --set x-www-browser /usr/bin/firefox-esr",
    )
    .makeSymlink("/usr/bin/xfce4-terminal.wrapper", "/etc/alternatives/x-terminal-emulator", { force: true })
    .setUser("user")
    .setWorkdir("/home/user");
}

export const templates = { t3, desktop };
export type TemplateName = keyof typeof templates;

export async function buildTemplate(name: TemplateName, opts: { cpuCount?: number; memoryMB?: number } = {}) {
  return Template.build(templates[name](), name, {
    cpuCount: opts.cpuCount ?? 4,
    // One sandbox runs the T3 server plus up to 3 Claude Code sessions (one worktree each): 1.5 GB
    // starved it, 2.5 GB with swap holds. Self-hosted E2B takes sandbox RAM from the node's hugepage pool and a build needs
    // about twice this, so a 16 GB node needs the pool raised (selfhost/README.md).
    memoryMB: opts.memoryMB ?? 2560,
    onBuildLogs: (entry) => process.stderr.write(`${entry.toString()}\n`),
  });
}
