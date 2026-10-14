import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
// Re-export extension loader
export { loadExtensions, listBundledExtensions } from "./extensions.js";
export async function loadWolfConfig() {
    const wolfDen = process.env.WOLF_DEN;
    if (!wolfDen) {
        throw new Error("WOLF_DEN environment variable is required");
    }
    // wolf.yaml is in the home directory (parent of den), not in den itself
    // VPS layout: /home/wolf-<id>/{wolf.yaml, den/, agent/}
    const homeDir = join(wolfDen, "..");
    const configPath = join(homeDir, "wolf.yaml");
    const content = await readFile(configPath, "utf-8");
    const config = parseYaml(content);
    if (!config.name) {
        throw new Error("wolf.yaml must specify 'name'");
    }
    if (!config.model) {
        throw new Error("wolf.yaml must specify 'model'");
    }
    return config;
}
// Extension loading moved to extensions.ts
//# sourceMappingURL=config.js.map