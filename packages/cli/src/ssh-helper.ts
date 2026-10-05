/**
 * SSH utilities — auto-detection, connectivity testing, command execution
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { HostEntry } from "./config.js";

export interface SshConfig {
  user: string;
  key: string;
  port: number;
}

/**
 * Auto-detect SSH keys in common locations
 */
export function detectSshKeys(): string[] {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, ".ssh/wolfpack"),
    path.join(homeDir, ".ssh/id_ed25519"),
    path.join(homeDir, ".ssh/id_rsa"),
    path.join(homeDir, ".ssh/id_ecdsa"),
  ];

  return candidates.filter((keyPath) => {
    try {
      return fs.existsSync(keyPath) && fs.statSync(keyPath).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Test SSH connectivity with given credentials
 */
export async function testSshConnection(
  host: string,
  config: SshConfig,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      "-i",
      config.key,
      "-p",
      config.port.toString(),
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "BatchMode=yes",
      `${config.user}@${host}`,
      "echo",
      "OK",
    ];

    const proc = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim() === "OK") {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: stderr || `Connection failed with code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Execute a command over SSH and return output
 */
export function execSsh(
  host: HostEntry,
  command: string,
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(
      `ssh -i ${host.ssh.key} -p ${host.ssh.port} ${host.ssh.user}@${host.address} "${command}"`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { stdout, stderr: "", code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || err.message,
      code: err.status || 1,
    };
  }
}

/**
 * Execute a command over SSH and stream output
 */
export async function execSshStream(
  host: HostEntry,
  command: string,
  onData?: (data: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ssh",
      [
        "-i",
        host.ssh.key,
        "-p",
        host.ssh.port.toString(),
        `${host.ssh.user}@${host.address}`,
        command,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      if (onData) onData(text);
      else process.stdout.write(text);
    });

    proc.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    proc.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * Copy files to remote host
 */
export function scpToHost(
  host: HostEntry,
  localPath: string,
  remotePath: string,
): { success: boolean; error?: string } {
  try {
    execSync(
      `scp -i ${host.ssh.key} -P ${host.ssh.port} -r ${localPath} ${host.ssh.user}@${host.address}:${remotePath}`,
      {
        stdio: "inherit",
      },
    );
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Copy files from remote host
 */
export function scpFromHost(
  host: HostEntry,
  remotePath: string,
  localPath: string,
): { success: boolean; error?: string } {
  try {
    execSync(
      `scp -i ${host.ssh.key} -P ${host.ssh.port} -r ${host.ssh.user}@${host.address}:${remotePath} ${localPath}`,
      {
        stdio: "inherit",
      },
    );
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
