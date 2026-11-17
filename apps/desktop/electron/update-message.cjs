"use strict";
// One plain sentence for a failed manual update check (work-wolfpack-SzoWaBZ). electron-updater's HttpError
// message carries the feed URL, an auth-token hint and every response header; none of that helps the person
// clicking "Check now". The same text goes to the dialog and to the inline block in Pack → Machines.

const FEED_MISSING = /Cannot find channel|HttpError: 404|\b404\b/;
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/;

function updateCheckMessage(err, version) {
	const raw = err == null ? "" : typeof err === "string" ? err : String(err.message ?? err);
	const first = raw.split("\n")[0].trim();
	if (!first) return "Couldn't check for updates.";
	if (FEED_MISSING.test(raw)) return `No update is published yet. Wolfpack ${version} is the newest version.`;
	if (OFFLINE.test(raw)) return "Couldn't reach the update server. Check your internet connection and try again.";
	return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

module.exports = { updateCheckMessage };
