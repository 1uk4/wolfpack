"use client";
/** The Pack's Devices section (work-wolfpack-Rqmr32h): the old Settings Devices tab's list, Revoke confirm and pairing, plus a QR of the pairing link. */
import { DevicesSection } from "@/components/settings/devices-section";
import { QrCode } from "@/components/pack/pack-qr";
import { useSingleMac } from "@/components/shell/single-mac";

export function DevicesBody() {
	const singleMac = useSingleMac();
	return (
		<div data-testid="pack-devices" className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">Every paired browser and phone has full control. Revoke any you don&apos;t recognise.</p>
			<DevicesSection
				singleMac={singleMac}
				renderQr={(url) => <QrCode text={url} />}
				pairNote="This Mac runs its own wolves. Other devices can't pair with it."
				emptyText={singleMac ? "This device isn't in the list yet." : undefined}
			/>
		</div>
	);
}
