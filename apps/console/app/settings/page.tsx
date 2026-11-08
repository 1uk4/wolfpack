import { WolfSettingsView } from "@/components/wolf-settings-view";

export const dynamic = "force-dynamic";

/** The per-wolf Settings page. The dialog (Keys, Agent, Appearance...) stays reachable from the sidebar's Settings row. */
export default function SettingsPage() {
	return <WolfSettingsView />;
}
