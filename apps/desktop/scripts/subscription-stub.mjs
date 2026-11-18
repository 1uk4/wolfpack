// Stands in for the Claude subscription provider in the desktop app build (work-wolfpack-66JSDus): the app is API-key only.
// build-runtime.mjs aliases the subscription provider's module to this file, so none of its code is in the bundle.
export function createStatelessProvider() {
	throw new Error("The Claude subscription isn't built into this app; install it as a plug-in");
}
