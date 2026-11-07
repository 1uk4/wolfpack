import { migrateLegacyKeys } from "./legacy-storage.ts";

// Side-effect module: ES modules evaluate once, before any importer's body, so importing this first in every
// module that defines a persisted key guarantees the copy precedes the first read. No-op on the server.
try {
	if (typeof localStorage !== "undefined") migrateLegacyKeys(localStorage);
} catch {
	// localStorage access itself can throw (blocked cookies)
}
