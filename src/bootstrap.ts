// Shell scripts that turn an E2B sandbox into a T3 Code environment.
// The "t3" template (templates/) already has T3 Code, Claude Code, gh and mise; on any other
// template the install script fetches what is missing with the official installers.
// E2B runs commands as `user` (home /home/user) in a login shell; sudo is not assumed.

export const T3_PORT = 3773;
export const T3_HOME = "$HOME/.t3";
export const SCRIPT_DIR = "/home/user/.t3e2b";

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const installScript = `#!/usr/bin/env bash
# t3e2b: install the T3 Code server and provider CLIs. Idempotent.
# $1 = exact T3 Code version (match the local client), or empty for the latest stable.
set -euo pipefail
T3_VERSION="\${1:-}"
export PATH="$HOME/.local/bin:$PATH"
log() { echo "[t3e2b] $*"; }

# 0. Swap: parallel agents spike memory; a swap file turns an OOM kill into a slowdown. Needs passwordless sudo.
if [ "$(swapon --show --noheadings | wc -l)" = 0 ] && sudo -n true 2>/dev/null; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile || log "swap setup skipped"
fi

# 1. T3 Code, via the official installer (checks the release's SHA256SUMS).
have="$(t3 --version 2>/dev/null | sed -n 's/^t3 v//p' || true)"
if [ -z "$have" ] || { [ -n "$T3_VERSION" ] && [ "$have" != "$T3_VERSION" ]; }; then
  log "installing t3 \${T3_VERSION:-stable} (had \${have:-none})"
  curl -fsSL --retry 5 https://t3.codes/install.sh | T3CODE_VERSION="$T3_VERSION" T3CODE_INSTALL_BIN_DIR="$HOME/.local/bin" sh
fi
t3 --version

# 2. Claude Code (native installer: no Node version requirement).
command -v claude >/dev/null || { log "installing claude"; curl -fsSL --retry 5 https://claude.ai/install.sh | bash; }

# 3. Server settings: peer links must be enabled on this side too.
mkdir -p "${T3_HOME}/userdata"
settings="${T3_HOME}/userdata/settings.json"
if [ -s "$settings" ] && command -v jq >/dev/null; then
  jq '.linkedEnvironmentsEnabled = true' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
else
  echo '{"linkedEnvironmentsEnabled":true}' > "$settings"
fi

# 4. Supervisor: restarts t3 serve if it exits. Credentials are the sandbox's env vars.
cat > "$HOME/.t3e2b/serve.sh" <<'SERVE'
#!/usr/bin/env bash
# One supervisor per sandbox: a second start exits at once.
exec 9>"$HOME/.t3e2b/serve.lock"
flock -n 9 || exit 0
export PATH="$HOME/.local/bin:$PATH"
while true; do
  t3 serve --host 0.0.0.0 --port ${T3_PORT} --base-dir "$HOME/.t3" --no-browser >> "$HOME/.t3e2b/serve.log" 2>&1
  echo "[t3e2b] t3 serve exited with $?, restarting" >> "$HOME/.t3e2b/serve.log"
  sleep 2
done
SERVE
chmod +x "$HOME/.t3e2b/serve.sh"
log "install done"
`;

export const startServerCommand = `bash "$HOME/.t3e2b/serve.sh"`;

export const healthCommand = `curl -fsS -m 5 http://127.0.0.1:${T3_PORT}/.well-known/t3/environment`;

/** git author from this machine; GH_TOKEN (if set) as git's credential helper for clone/push/PR. */
export function gitSetupCommand(name?: string, email?: string): string {
  return [
    name ? `git config --global user.name ${sh(name)}` : "true",
    email ? `git config --global user.email ${sh(email)}` : "true",
    `if [ -n "\${GH_TOKEN:-}" ] && command -v gh >/dev/null; then gh auth setup-git; fi`,
  ].join(" && ");
}

/** Clones the repo (same origin URL as locally, so T3 matches the project by repository identity) and registers it. */
export function projectSetupCommand(repo: string, ref: string | undefined, dir: string): string {
  const checkout = ref ? ` && git -C ${sh(dir)} checkout ${sh(ref)}` : "";
  return [
    `export PATH="$HOME/.local/bin:$PATH"`,
    `if [ ! -d ${sh(dir)}/.git ]; then git clone ${sh(repo)} ${sh(dir)}${checkout}; fi`,
    // Prints "Added project <id> (<title>) at <path>."; an already-added path is not an error.
    `{ t3 project add ${sh(dir)} --base-dir "$HOME/.t3" 2>&1 || true; }`,
  ].join(" && ");
}

/**
 * Installs the repo's toolchain and dependencies before any agent starts, so agents don't spend
 * tokens (and minutes) on it. Run in the clone. Stops at the first failing step.
 * mise is in the "t3" template; elsewhere that line is skipped.
 */
export const dependencySetupScript = `
set -ex
if command -v mise >/dev/null; then mise install; fi   # repo's mise.toml/.tool-versions/.nvmrc/...
{ [ -f bun.lock ] || [ -f bun.lockb ]; } && bun install
[ -f pnpm-lock.yaml ] && pnpm install --frozen-lockfile
[ -f yarn.lock ] && yarn install
[ -f package-lock.json ] && npm ci
[ -f package.json ] && [ ! -d node_modules ] && npm install
[ -f uv.lock ] && uv sync
[ -f requirements.txt ] && [ ! -f uv.lock ] && uv venv && uv pip install -r requirements.txt
[ -f go.mod ] && go mod download
[ -f Cargo.toml ] && cargo fetch
true`;

/** baseUrl: where clients reach this server; it makes the output include a pairUrl. */
export function pairingCommand(label: string, baseUrl: string): string {
  return `export PATH="$HOME/.local/bin:$PATH" && t3 auth pairing create --base-dir "$HOME/.t3" --json --ttl 10m --label ${sh(label)} --base-url ${sh(baseUrl)}`;
}

/** Thread statuses in the sandbox; busy ones keep it running. */
export const threadListCommand = [
  `export PATH="$HOME/.local/bin:$PATH";`,
  // \`t3 thread list\` is per project: try every checkout under $HOME (depth 1-2), merge, dedupe.
  `{ for d in $(find "$HOME" -mindepth 2 -maxdepth 3 -name .git -not -path "*/.*/*" -printf "%h\\n" 2>/dev/null | sort -u); do`,
  `t3 thread list --json --project "$d" --base-dir "$HOME/.t3" 2>/dev/null; done; echo "[]"; }`,
  `| jq -s "add | unique_by(.threadId)"`,
].join(" ");

export const BUSY_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function shellQuote(s: string): string {
  return sh(s);
}
