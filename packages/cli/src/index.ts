/**
 * @wolfpack/cli — pack management CLI.
 *
 * Commands:
 *   wolfpack host add <name> --ip <ip>   Bootstrap a VPS
 *   wolfpack host list                   Show registered hosts
 *   wolfpack host status [name]          Health of a host
 *
 *   wolfpack add wolf <name> [--host]    Create a wolf
 *   wolfpack list                        Show all wolves
 *   wolfpack status <wolf> [--host]      Wolf status
 *   wolfpack logs <wolf> [-f] [--host]   Wolf logs
 *   wolfpack restart <wolf> [--host]     Restart wolf
 *   wolfpack config <wolf> --set k=v     Update wolf config
 */

export { hostAdd } from "./commands/host-add.js";
export { hostList } from "./commands/host-list.js";
export { hostStatus } from "./commands/host-status.js";
export { wolfAdd } from "./commands/wolf-add.js";
export { wolfList } from "./commands/wolf-list.js";
export { wolfStatus } from "./commands/wolf-status.js";
export { wolfLogs } from "./commands/wolf-logs.js";
export { wolfRestart } from "./commands/wolf-restart.js";
export { wolfConfig } from "./commands/wolf-config.js";
