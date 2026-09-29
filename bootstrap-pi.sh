#!/usr/bin/env bash
# Wolfpack PI bootstrap — provisions PI-based wolves (experimental).
#
# Mirrors bootstrap.sh but targets the `pi_wolves` inventory group and runs
# playbooks/pi-wolf.yml. It NEVER touches the Claude `wolves`. Safe to re-run.
#
#   ./bootstrap-pi.sh                 # provision all pi_wolves
#   ./bootstrap-pi.sh --limit pi-wolf-01

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
rule()  { printf '%s\n' "================================================================"; }
fail()  { red ""; red "  ERROR: $*"; red ""; exit 1; }

rule
bold "  🐺 WOLFPACK PI BOOTSTRAP (experimental agent type)"
rule
cat <<'EOF'

  Provisions a PI-based wolf: a Linux host running the pi coding agent +
  @llblab/pi-telegram bridge, DM-able on Telegram. Same Tailscale + Syncthing
  + den model as the Claude wolves. This script only touches hosts in the
  `pi_wolves` inventory group.

EOF
rule
echo

###############################################################################
# 1. ansible-playbook present
###############################################################################
bold "▸ Checking for ansible-playbook..."
command -v ansible-playbook >/dev/null 2>&1 || fail "ansible-playbook not found.
  Install with:   brew install ansible   (macOS)   or   pipx install ansible"
green "  ✓ ansible-playbook $(ansible-playbook --version | head -1 | awk '{print $2}')"
echo

###############################################################################
# 2. SSH keypair
###############################################################################
bold "▸ Checking for SSH keypair at ~/.ssh/wolfpack..."
if [[ ! -f "$HOME/.ssh/wolfpack" || ! -f "$HOME/.ssh/wolfpack.pub" ]]; then
  fail "~/.ssh/wolfpack keypair missing. Generate with:
    ssh-keygen -t ed25519 -f ~/.ssh/wolfpack -C \"wolfpack\" -N \"\""
fi
green "  ✓ ~/.ssh/wolfpack keypair present"
echo

###############################################################################
# 3. .env with the values a pi-wolf needs
###############################################################################
bold "▸ Checking .env..."
[[ -f "$REPO_ROOT/.env" ]] || fail ".env not found. Copy .env.example to .env and fill it in."

set -a
# shellcheck disable=SC1091
source "$REPO_ROOT/.env"
set +a

missing=()
[[ "${TAILSCALE_AUTHKEY:-}" == "" || "${TAILSCALE_AUTHKEY:-}" == *REPLACE_ME* ]] && missing+=("TAILSCALE_AUTHKEY")
[[ "${MAC_SYNCTHING_DEVICE_ID:-}" == "" || "${MAC_SYNCTHING_DEVICE_ID:-}" == *REPLACE_ME* ]] && missing+=("MAC_SYNCTHING_DEVICE_ID")
if (( ${#missing[@]} > 0 )); then
  fail ".env has placeholder/empty values for: ${missing[*]}"
fi
green "  ✓ .env has TAILSCALE_AUTHKEY and MAC_SYNCTHING_DEVICE_ID"

# Auth advisory (not fatal — you can /login on the droplet instead).
if [[ "${ANTHROPIC_API_KEY:-}" == "" || "${ANTHROPIC_API_KEY:-}" == *REPLACE_ME* ]]; then
  yellow "  ! ANTHROPIC_API_KEY not set. pi will pause for a one-time /login on"
  yellow "    the droplet (Claude subscription). Set the key in .env to skip that."
else
  green "  ✓ ANTHROPIC_API_KEY present (headless auth)"
fi
echo

###############################################################################
# 3b. Syncthing on the Mac (reuse the same hub as Claude wolves)
###############################################################################
bold "▸ Checking Syncthing on this Mac..."
if command -v nc >/dev/null 2>&1 && nc -z localhost 8384 2>/dev/null; then
  green "  ✓ Syncthing listening on localhost:8384"
else
  yellow "  ! Syncthing not detected on localhost:8384 — start it:  brew services start syncthing"
fi
mkdir -p "$REPO_ROOT/shared" "$REPO_ROOT/dens"
green "  ✓ shared/ and dens/ hub folders present"
echo

###############################################################################
# 4. pi_wolves in inventory — confirm/update each IP
###############################################################################
bold "▸ Reading pi_wolves from inventory/hosts.yml..."
pi_wolves=()
while IFS= read -r _line; do
  [[ -n "$_line" ]] && pi_wolves+=("$_line")
done < <(python3 - <<'PY'
import yaml
with open("inventory/hosts.yml") as f:
    data = yaml.safe_load(f)
grp = (data.get("all", {}).get("children", {}).get("pi_wolves") or {})
hosts = grp.get("hosts") or {}
for host_name, cfg in hosts.items():
    cfg = cfg or {}
    print(f'{host_name}\t{cfg.get("wolf_name","?")}\t{cfg.get("ansible_host","?")}')
PY
)

if (( ${#pi_wolves[@]} == 0 )); then
  fail "No hosts in the pi_wolves group.
  Add one under inventory/hosts.yml → all.children.pi_wolves.hosts
  (see the commented example there), then re-run this script."
fi

echo
echo "  Confirm or update each pi-wolf's IP (public IPv4; switched to Tailscale"
echo "  automatically after bootstrap). Press ENTER to keep the current value."
echo

old_hosts=(); new_hosts=()
for line in "${pi_wolves[@]}"; do
  IFS=$'\t' read -r host_name wolf_name current_ip <<< "$line"
  printf "    %s (wolf_name=%s) — current: \033[1m%s\033[0m\n" "$host_name" "$wolf_name" "$current_ip"
  printf "    new IP (or Enter to keep): "
  read -r new_ip
  new_ip="${new_ip:-$current_ip}"
  old_hosts+=("$current_ip"); new_hosts+=("$new_ip")
  if [[ "$new_ip" != "$current_ip" ]]; then
    python3 - "$host_name" "$new_ip" <<'PY'
import sys, re
host, new_ip = sys.argv[1], sys.argv[2]
with open("inventory/hosts.yml") as f:
    content = f.read()
pattern = re.compile(
    rf'(^\s*{re.escape(host)}:\s*\n(?:\s+[^\n]*\n)*?\s+ansible_host:\s*)\S+',
    re.MULTILINE,
)
new_content, n = pattern.subn(rf'\g<1>{new_ip}', content, count=1)
if n == 0:
    sys.exit(f"could not locate ansible_host for {host}")
with open("inventory/hosts.yml", "w") as f:
    f.write(new_content)
PY
    green "      ✓ updated $host_name → $new_ip"
  fi
done
echo

###############################################################################
# 5. Clear stale SSH host keys
###############################################################################
bold "▸ Clearing stale SSH host keys..."
for h in "${old_hosts[@]}" "${new_hosts[@]}"; do
  [[ -z "$h" || "$h" == "?" ]] && continue
  ssh-keygen -R "$h" >/dev/null 2>&1 || true
done
green "  ✓ known_hosts cleaned"
echo

###############################################################################
# 6. Run the pi playbook
###############################################################################
rule
bold "  ▸ Running ansible-playbook (playbooks/pi-wolf.yml)..."
rule
cat <<'EOF'

  During the run:
    - If a pi-wolf has no credential (no ANTHROPIC_API_KEY, no prior /login),
      the playbook PAUSES with instructions to SSH in and run pi + /login.
    - At the end it prints Syncthing/Telegram steps that still need a human.

  Press ENTER to start, or Ctrl-C to abort.
EOF
read -r

exec ansible-playbook playbooks/pi-wolf.yml "$@"
