#!/usr/bin/env bash
# Root, on the VPS (or in the systemd test container). Idempotent. Creates everything a wolf needs EXCEPT the release and the token:
#   provision-wolf.sh <name> [MEMORY_MAX=700M] [SUBAGENT_MAX=3]
# user wolf-<name> (home /home/wolf-<name>, 0750, group wolf-<name>), workerd-wolves in that group, registry stub
# /etc/wolfpack/wolves/<name>/wolf.yaml, per-wolf drop-in with the memory cap. Does not start anything.
set -euo pipefail
name=${1:?usage: provision-wolf.sh <name> [memory-max] [subagent-max]}; mem=${2:-700M}; sub=${3:-3}
[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad wolf name" >&2; exit 2; }
u=wolf-$name; h=/home/$u
id "$u" >/dev/null 2>&1 || useradd --create-home --home-dir "$h" --shell /usr/sbin/nologin "$u"
id workerd-wolves >/dev/null 2>&1 || useradd --system --home-dir /var/lib/workerd-wolves --shell /usr/sbin/nologin workerd-wolves
usermod -aG "$u" workerd-wolves
chown "$u:$u" "$h"; chmod 0750 "$h"
install -d -o "$u" -g "$u" -m 0750 "$h/release" "$h/den" "$h/claude-stateless" "$h/work"
install -d -m 0755 /etc/wolfpack /etc/wolfpack/wolves "/etc/wolfpack/wolves/$name"
# The registry stub: workerd reads only name + serve.socket. The wolf's own config is $h/wolf.yaml (read by wolfd, invisible to workerd).
printf 'name: %s\nserve:\n  socket: /run/wolfd-%s/serve.sock\n' "$name" "$name" > "/etc/wolfpack/wolves/$name/wolf.yaml"
install -d "/etc/systemd/system/wolfd@$name.service.d"
printf '[Service]\nMemoryMax=%s\nEnvironment=WOLFPACK_SUBAGENT_HOST_MAX=%s\n' "$mem" "$sub" > "/etc/systemd/system/wolfd@$name.service.d/limits.conf"
systemctl daemon-reload 2>/dev/null || true
echo "provisioned $u (MemoryMax=$mem SUBAGENT_HOST_MAX=$sub). Still needed: $h/.env (600, owned by $u), $h/wolf.yaml (serve.socket: /run/wolfd-$name/serve.sock), $h/release (wolfpack sync --release)."
