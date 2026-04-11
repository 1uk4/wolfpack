#!/usr/bin/env bash
# Wolfpack bootstrap — the one command you run to set up a wolf.
#
# Run from the repo root:
#   ./bootstrap.sh
#
# This script checks prerequisites, guides you through any missing pieces,
# then runs the Ansible playbook. All further instructions (including the
# one-time Claude OAuth login) are printed by the playbook itself.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
rule()  { printf '%s\n' "================================================================"; }

fail() {
  red ""
  red "  ERROR: $*"
  red ""
  exit 1
}

rule
bold "  🐺 WOLFPACK BOOTSTRAP"
rule
cat <<'EOF'

  This script provisions a "wolf" — a Linux host running Claude Code that
  you can DM on Telegram. It will:

    1. Check your prerequisites (SSH key, .env, ansible, etc.)
    2. Clean up stale SSH host keys for hosts in inventory
    3. Run the Ansible playbook against every wolf in inventory/hosts.yml
    4. Pause mid-run to let you complete Claude OAuth login (once per wolf)
    5. Print a post-run checklist of any manual steps remaining

  You can re-run this script safely — Ansible is idempotent.

EOF
rule
echo

###############################################################################
# 1. Prerequisite: ansible-playbook is installed
###############################################################################
bold "▸ Checking for ansible-playbook..."
if ! command -v ansible-playbook >/dev/null 2>&1; then
  fail "ansible-playbook not found.
  Install with:   brew install ansible     (macOS)
              or: pipx install ansible     (any platform)"
fi
green "  ✓ ansible-playbook $(ansible-playbook --version | head -1 | awk '{print $2}')"
echo

###############################################################################
# 2. Prerequisite: ~/.ssh/wolfpack keypair
###############################################################################
bold "▸ Checking for SSH keypair at ~/.ssh/wolfpack..."
if [[ ! -f "$HOME/.ssh/wolfpack" || ! -f "$HOME/.ssh/wolfpack.pub" ]]; then
  red "  ✗ ~/.ssh/wolfpack or ~/.ssh/wolfpack.pub missing."
  cat <<EOF

  Generate one with:
    ssh-keygen -t ed25519 -f ~/.ssh/wolfpack -C "wolfpack" -N ""

  Then add ~/.ssh/wolfpack.pub to your DigitalOcean account SSH keys
  (Settings → Security → Add SSH Key) BEFORE creating the droplet, so
  DO bakes it into /root/.ssh/authorized_keys on first boot.

EOF
  exit 1
fi
green "  ✓ ~/.ssh/wolfpack keypair present"
echo

###############################################################################
# 3. Prerequisite: .env file with real values
###############################################################################
bold "▸ Checking .env..."
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  yellow "  ! .env not found — creating from .env.example"
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  cat <<EOF

  A template .env has been created. Open it, fill in real values, then
  re-run this script:

    $EDITOR .env   (or: code .env, nano .env, etc.)

  You'll need:
    - A Tailscale reusable auth key
        → https://login.tailscale.com/admin/settings/keys
    - A Telegram bot token per wolf
        → DM @BotFather on Telegram, send /newbot

EOF
  exit 1
fi

# Source .env, exporting every variable defined in it.
set -a
# shellcheck disable=SC1091
source "$REPO_ROOT/.env"
set +a

missing=()
[[ "${TAILSCALE_AUTHKEY:-}" == "" || "${TAILSCALE_AUTHKEY:-}" == *REPLACE_ME* ]] && missing+=("TAILSCALE_AUTHKEY")
[[ "${TELEGRAM_BOT_TOKEN_SCOUT:-}" == "" || "${TELEGRAM_BOT_TOKEN_SCOUT:-}" == *REPLACE_ME* ]] && missing+=("TELEGRAM_BOT_TOKEN_SCOUT")

if (( ${#missing[@]} > 0 )); then
  red "  ✗ .env has placeholder values for: ${missing[*]}"
  cat <<EOF

  Open .env and replace the REPLACE_ME values:
    - TAILSCALE_AUTHKEY
        Get at https://login.tailscale.com/admin/settings/keys
        (Generate auth key → enable "Reusable")
    - TELEGRAM_BOT_TOKEN_SCOUT
        DM @BotFather → /newbot → copy the token

EOF
  exit 1
fi
green "  ✓ .env has TAILSCALE_AUTHKEY and all bot tokens set"
echo

###############################################################################
# 4. Prerequisite: inventory has at least one wolf + confirm/update each IP
###############################################################################
bold "▸ Checking inventory/hosts.yml..."
if ! grep -q "ansible_host:" inventory/hosts.yml; then
  fail "inventory/hosts.yml has no ansible_host entries."
fi

# Parse wolves (host_name, wolf_name, current IP) from the YAML using python.
# PyYAML ships with ansible so it's guaranteed to be available here.
# Use a portable while-read loop (macOS bash 3.2 has no `mapfile`).
wolves=()
while IFS= read -r _line; do
  wolves+=("$_line")
done < <(python3 - <<'PY'
import yaml
with open("inventory/hosts.yml") as f:
    data = yaml.safe_load(f)
hosts = data["all"]["children"]["wolves"]["hosts"]
for host_name, cfg in hosts.items():
    print(f'{host_name}\t{cfg.get("wolf_name","?")}\t{cfg.get("ansible_host","?")}')
PY
)

echo
echo "  For each wolf, confirm or update the IP that Ansible will connect to."
echo "  (Your DigitalOcean droplet's PUBLIC ipv4, not the Tailscale IP — the"
echo "   playbook will switch to Tailscale automatically after bootstrap.)"
echo "  Press ENTER to keep the current value."
echo

old_hosts=()
new_hosts=()
for line in "${wolves[@]}"; do
  IFS=$'\t' read -r host_name wolf_name current_ip <<< "$line"
  printf "    %s (wolf_name=%s) — current: \033[1m%s\033[0m\n" "$host_name" "$wolf_name" "$current_ip"
  printf "    new IP (or Enter to keep): "
  read -r new_ip
  new_ip="${new_ip:-$current_ip}"
  old_hosts+=("$current_ip")
  new_hosts+=("$new_ip")
  if [[ "$new_ip" != "$current_ip" ]]; then
    # Targeted regex replace — preserves formatting and comments.
    python3 - "$host_name" "$new_ip" <<'PY'
import sys, re
host, new_ip = sys.argv[1], sys.argv[2]
with open("inventory/hosts.yml") as f:
    content = f.read()
# Find the "<host>:" line and the first "ansible_host:" under it, replace its value.
pattern = re.compile(
    rf'(^\s*{re.escape(host)}:\s*\n(?:\s+[^\n]*\n)*?\s+ansible_host:\s*)\S+',
    re.MULTILINE,
)
new_content, n = pattern.subn(rf'\g<1>{new_ip}', content, count=1)
if n == 0:
    sys.exit(f"could not locate ansible_host for {host} in inventory/hosts.yml")
with open("inventory/hosts.yml", "w") as f:
    f.write(new_content)
PY
    green "      ✓ updated $host_name → $new_ip"
  fi
done
echo

###############################################################################
# 5. Clean up stale SSH host keys (old + new, in case of rebuild)
###############################################################################
bold "▸ Clearing stale SSH host keys for inventory hosts..."
for h in "${old_hosts[@]}" "${new_hosts[@]}"; do
  [[ -z "$h" ]] && continue
  ssh-keygen -R "$h" >/dev/null 2>&1 || true
  printf "    cleared: %s\n" "$h"
done
green "  ✓ known_hosts cleaned"
echo

###############################################################################
# 6. Run the playbook
###############################################################################
rule
bold "  ▸ Running ansible-playbook..."
rule
cat <<'EOF'

  During the run:
    - If a wolf has no Claude login yet, the playbook will PAUSE with
      exact instructions: open a second terminal, SSH in, run
      'claude auth login', complete the browser flow, then press ENTER
      back here to continue.
    - Each role prints its own output (tailscale IP, syncthing device ID,
      telegram status, wolf-service status) as it finishes.
    - At the end, a checklist prints any remaining manual steps.

  Press ENTER to start the playbook, or Ctrl-C to abort.
EOF
read -r

exec ansible-playbook playbooks/bootstrap.yml "$@"
