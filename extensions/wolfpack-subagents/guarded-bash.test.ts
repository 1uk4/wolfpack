import { beforeEach, describe, expect, it, vi } from "vitest";

const bashExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashTool: () => ({ execute: bashExecute }),
}));
vi.mock("typebox", () => {
  const t: any = new Proxy(() => ({}), { get: () => t, apply: () => ({}) });
  return { Type: t };
});

import { checkReadOnlyCommand } from "./tools/command-guard.ts";
import registerBashTools from "./tools/safe-bash.ts";

const blocked = (cmd: string) => checkReadOnlyCommand(cmd);

describe("guarded_bash: blocks writes", () => {
  it.each([
    ["git clone https://github.com/a/b"],
    ["git clone https://github.com/a/b ./b"],
    ["git clone https://github.com/a/b /tmp/../etc/b"],
    ["ssh host 'git clone https://github.com/a/b /tmp/b'"],
  ])("blocks git clone outside a local /tmp/ destination: %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/git clone/);
  });

  it("blocks the incident command", () => {
    const reason = blocked(
      "ssh root@host 'journalctl -u x | grep y; rm -f /dev/null 2>/dev/null; grep z /var/log/a'",
    );
    expect(reason).toMatch(/Blocked by guarded_bash: `rm`/);
    expect(reason).toMatch(/remote/);
    expect(reason).toMatch(/read-only/);
  });

  it.each([
    ["ssh host 'rm /var/log/x'"],
    ["ssh -i key -o BatchMode=yes root@host mv a b"],
    ["ssh host 'sed -i s/a/b/ f'"],
    ["ssh host 'cat f | tee out.txt'"],
    ["ssh host 'journalctl -u x > out.log'"],
    ["ssh host 'grep a f > /tmp/x'"],
    ["bash -c 'rm x'"],
    ['sh -c "echo hi; rm x"'],
    ["su -c 'rm x' root"],
    ["sudo rm x"],
    ["sudo -u root bash -c 'mv a b'"],
    ["echo $(rm x)"],
    ["echo `rm x`"],
    ['echo "$(sed -i s/a/b/ f)"'],
    ["ls | xargs rm"],
    ["ls | xargs -n1 -I{} mv {} /x"],
    ["find . -name x -delete"],
    ["find . -name x -exec rm {} \\;"],
    ["find . -execdir sh -c 'rm x' \\;"],
    ["echo x > file.txt"],
    ["echo x >> file.txt"],
    ["echo x &> file.txt"],
    ["echo x 2> err.txt"],
    ["ls > /tmp/../etc/x"],
    ["rmdir d; unlink f; shred f; truncate -s0 f; dd if=a of=b"],
    ["perl -pi -e 's/a/b/' f"],
    ["sed --in-place s/a/b/ f"],
    ["sed -ni 1p f"],
    ["tee out.txt"],
    ["chmod 600 f"],
    ["chown a b"],
    ["ln -sf a b"],
    ["systemctl restart x"],
    ["service x stop"],
    ["systemctl --user -n 20 stop x"],
    ["kill 1"],
    ["pkill x"],
    ["reboot"],
    ["useradd bob"],
    ["apt-get install -y x"],
    ["npm install x"],
    ["python3 -m pip install x"],
    ["crontab -r"],
    ["crontab -e"],
    ["mkfs.ext4 /dev/sda1"],
    ["mount /dev/sda1 /mnt"],
    ["iptables -A INPUT -j DROP"],
    ["ufw allow 22"],
    ["git commit -m x"],
    ["git -C repo push"],
    ["git reset --hard"],
    ["git checkout main"],
    ["git clean -fd"],
    ["git stash"],
    ["git branch -D x"],
    ["git tag -d x"],
    ["curl -o out http://h/x"],
    ["curl -sSLO http://h/x"],
    ["curl -X POST http://h/x"],
    ["curl --request=DELETE http://h/x"],
    ["curl -d a=b http://h/x"],
    ["curl --data-binary @f http://h/x"],
    ["wget http://h/x"],
    ["journalctl --vacuum-size=1M"],
    ["journalctl --rotate"],
    ["docker rm x"],
    ["$CMD x"],
    ["cd /tmp && FOO=1 /bin/rm x"],
    ["nohup timeout 5 rm x"],
    ["bash script.sh"],
  ])("blocks %s", (cmd) => {
    const reason = blocked(cmd);
    expect(reason).toMatch(/^Blocked by guarded_bash:/);
  });

  it("blocks a remote redirect to /tmp but allows it locally", () => {
    expect(blocked("ssh host 'echo x > /tmp/x'")).toMatch(/remote/);
    expect(blocked("echo x > /tmp/scratch.txt")).toBeNull();
  });

  it("fails closed with a clear message on unparseable input", () => {
    expect(blocked("echo 'unterminated")).toMatch(/couldn't parse; simplify the command/);
    expect(blocked("echo $(rm x")).toMatch(/couldn't parse; simplify the command/);
    expect(blocked("cat <<EOF\nhi\nEOF")).toMatch(/couldn't parse; simplify the command/);
  });
});

describe("guarded_bash: allows read-only investigation", () => {
  it.each([
    ["ssh host 'journalctl -u x | grep y | tail'"],
    ["git clone --depth 1 https://github.com/a/b /tmp/b-src"],
    ["mkdir -p /tmp/b-src && git clone --depth 1 -b main https://github.com/a/b /tmp/b-src"],
    ["ssh host 'grep -c foo /tmp/x 2>/dev/null'"],
    ["ssh -i k -o BatchMode=yes wolfpack-ro@host 'systemctl status wolf-1 --no-pager -n 20; df -h; free -m'"],
    [`python3 -c "import json; print(json.dumps({'a': 1}))"`],
    ["python3 -c 'import os; print(os.getcwd())'"],
    ["sed -n 1,5p f"],
    ["sed -n -e '1,5p' f"],
    ["find . -name x"],
    ["find . -name '*.log' -exec grep -l foo {} \\;"],
    ["echo x > /tmp/scratch.txt"],
    ["echo x 2>&1 | tee /dev/null"],
    ["ls -la >/dev/null 2>&1"],
    ["systemctl status x"],
    ["systemctl show x -p ActiveState; systemctl is-active x; systemctl list-units 'wolf*' --no-pager"],
    ["curl -s http://host/health"],
    ["curl -sS -o /dev/null -w '%{http_code}' http://host/health"],
    ["curl -X GET http://h/x"],
    ["curl -I http://h/x"],
    ["wget -qO- http://h/x"],
    ["cat f | head -5 | awk '{print $1}' | wc -l"],
    ["stat f; ls -l d; tail -n 50 f; jq .a f.json"],
    ["ss -ltnp; ps aux | grep foo | grep -v grep"],
    ["docker ps; docker logs --tail 50 c"],
    ["git log --oneline -5; git show HEAD; git diff; git status; git stash list"],
    ["git branch -a; git tag -l; git config --get user.name"],
    ["crontab -l"],
    ["mount"],
    ["grep -r 'rm -rf' src | head"],
    ["echo 'a; rm b'"],
    ["echo hi # rm x"],
    ["sqlite3 -readonly db 'select 1'"],
    ["for f in a b; do cat $f; done"],
    ["xargs grep foo < list.txt"],
    ["ls | xargs -n1 stat"],
    ["bash -c 'ls -la'"],
    ["sudo -u root journalctl -u x"],
    ["diff <(ls a) <(ls b)"],
    ["echo $(date)"],
    ["FOO=1 env BAR=2 ls"],
    ["journalctl -u x --since '1 hour ago' --no-pager -n 100"],
  ])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("guarded_bash tool wiring", () => {
  const tools = new Map<string, any>();
  beforeEach(() => {
    bashExecute.mockClear();
    tools.clear();
    registerBashTools({ registerTool: (t: any) => tools.set(t.name, t) } as any);
  });

  it("registers guarded_bash alongside safe_bash", () => {
    expect([...tools.keys()].sort()).toEqual(["guarded_bash", "safe_bash"]);
  });

  it("does not execute a blocked command and throws the reason", async () => {
    const t = tools.get("guarded_bash");
    await expect(t.execute("id", { command: "ssh root@h 'rm -f /dev/null'" })).rejects.toThrow(/Blocked by guarded_bash/);
    expect(bashExecute).not.toHaveBeenCalled();
  });

  it("delegates an allowed command to the real bash tool", async () => {
    const t = tools.get("guarded_bash");
    await t.execute("id", { command: "journalctl -u x | tail" });
    expect(bashExecute).toHaveBeenCalledTimes(1);
  });
});
