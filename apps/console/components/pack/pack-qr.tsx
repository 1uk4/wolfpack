"use client";
/** A QR code as inline SVG (qrcode-generator, no DOM or canvas needed). Black on white with a 4-module quiet zone so phones scan it in any theme. */
import { useMemo } from "react";
import qrcode from "qrcode-generator";

const QUIET = 4;
const PX = 4; // pixels per module, so every module is a whole number of pixels

export function QrCode({ text }: { text: string }) {
	const { d, total } = useMemo(() => {
		const qr = qrcode(0, "M");
		qr.addData(text); // byte mode is ISO-8859-1, fine for the ASCII pairing URL
		qr.make();
		const n = qr.getModuleCount();
		let path = "";
		for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
		return { d: path, total: n + QUIET * 2 };
	}, [text]);
	return (
		<svg data-testid="device-qr" role="img" aria-label="Pairing QR code" width={total * PX} height={total * PX} viewBox={`0 0 ${total} ${total}`} shapeRendering="crispEdges" className="rounded-sm">
			<rect width={total} height={total} fill="#fff" />
			<path d={d} fill="#000" />
		</svg>
	);
}
