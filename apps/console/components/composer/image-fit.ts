/**
 * Fit an image under a byte budget before upload: downscale (longest side <= 2048 px) and recompress, stepping quality
 * then size down until it fits. A PNG that fits at its capped size stays a PNG; everything else (and any PNG that does
 * not fit) becomes a JPEG, which has no alpha: transparency is flattened onto white.
 * The planning is pure (`planSteps`); the decode/encode work is injected (`FitDeps`) so tests need no DOM.
 */
import { ATTACHMENT_IMAGE_TYPES } from "@wolfpack/protocol/attachments";

export const MAX_SIDE = 2048;
const QUALITIES = [0.82, 0.7, 0.58, 0.46];
const SCALES = [1, 0.75, 0.55, 0.4];

export interface FitStep {
	width: number;
	height: number;
	quality: number;
	type: "image/jpeg" | "image/png";
}

/** Dimensions after capping the longest side. */
export function scaledSize(w: number, h: number, maxSide: number): { width: number; height: number } {
	const k = Math.min(1, maxSide / Math.max(w, h));
	return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** The ordered attempts: (PNG sources) one PNG at the capped size; then JPEG quality steps at that size, then smaller sizes with the quality steps again. */
export function planSteps(w: number, h: number, opts: { maxSide?: number; png?: boolean } = {}): FitStep[] {
	const base = scaledSize(w, h, opts.maxSide ?? MAX_SIDE);
	const out: FitStep[] = opts.png ? [{ ...base, quality: 1, type: "image/png" }] : [];
	for (const s of SCALES) {
		const width = Math.max(1, Math.round(base.width * s));
		const height = Math.max(1, Math.round(base.height * s));
		for (const quality of QUALITIES) out.push({ width, height, quality, type: "image/jpeg" });
	}
	return out;
}

export interface FitDeps {
	/** Decode with EXIF orientation applied; throws when the browser cannot read the image. */
	decode(file: Blob): Promise<{ width: number; height: number }>;
	/** Draw the decoded image at the size and encode it as the step's type. */
	encode(step: FitStep): Promise<Blob | null>;
	/** Release the decoded image and the canvas (called once, even after a failure). */
	dispose?(): void;
}

export type FitFailure = "too-large" | "gif-too-large" | "undecodable" | "unsupported";
export type FitResult = { ok: true; file: File } | { ok: false; reason: FitFailure };

/** The file itself when it already fits; otherwise the first re-encoding that fits `budget`; otherwise the reason it cannot be sent. */
export async function fitImage(file: File, budget: number, deps: FitDeps): Promise<FitResult> {
	const mime = file.type.split(";")[0]!.trim().toLowerCase();
	if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) return { ok: false, reason: "unsupported" };
	if (file.size <= budget) return { ok: true, file };
	if (mime === "image/gif") return { ok: false, reason: "gif-too-large" }; // re-encoding would drop the animation
	try {
		let dims: { width: number; height: number };
		try {
			dims = await deps.decode(file);
		} catch {
			return { ok: false, reason: "undecodable" };
		}
		const base = file.name.replace(/\.[^./]+$/, "") || "image";
		for (const step of planSteps(dims.width, dims.height, { png: mime === "image/png" })) {
			const blob = await deps.encode(step);
			if (blob && blob.size > 0 && blob.size <= budget) {
				return { ok: true, file: new File([blob], `${base}.${step.type === "image/png" ? "png" : "jpg"}`, { type: step.type }) };
			}
		}
		return { ok: false, reason: "too-large" };
	} finally {
		deps.dispose?.();
	}
}

/**
 * Browser deps. Decode chain: createImageBitmap with imageOrientation "from-image", then without options (older Safari rejects
 * the option), then an <img> from an object URL (which applies EXIF orientation itself). One canvas is reused by every step
 * and zeroed at dispose, so iOS gets the memory back; the bitmap is closed and the object URL revoked.
 */
export function browserFitDeps(): FitDeps {
	let source: ImageBitmap | HTMLImageElement | undefined;
	let url: string | undefined;
	let canvas: HTMLCanvasElement | undefined;
	return {
		async decode(file) {
			try {
				source = await createImageBitmap(file, { imageOrientation: "from-image" });
			} catch {
				try {
					source = await createImageBitmap(file);
				} catch {
					url = URL.createObjectURL(file);
					const img = new Image();
					img.src = url;
					await img.decode(); // rejects on an unreadable image
					source = img;
				}
			}
			const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
			const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
			if (!w || !h) throw new Error("empty image");
			return { width: w, height: h };
		},
		async encode({ width, height, quality, type }) {
			if (!source) return null;
			canvas ??= document.createElement("canvas");
			canvas.width = width; // resizing also clears it
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			if (type === "image/jpeg") {
				ctx.fillStyle = "#fff"; // JPEG has no alpha
				ctx.fillRect(0, 0, width, height);
			}
			ctx.drawImage(source, 0, 0, width, height);
			const c = canvas;
			return new Promise((resolve) => c.toBlob(resolve, type, quality));
		},
		dispose() {
			if (source && "close" in source) source.close();
			source = undefined;
			if (url) URL.revokeObjectURL(url);
			url = undefined;
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
			canvas = undefined;
		},
	};
}

/** Fit timeout: a stuck decode must not block the files queued behind it. */
export const FIT_TIMEOUT_MS = 30_000;

/** `fitImage` that gives up after `ms` as "undecodable" (the late result is ignored). */
export function fitImageWithTimeout(file: File, budget: number, deps: FitDeps, ms = FIT_TIMEOUT_MS): Promise<FitResult> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ ok: false, reason: "undecodable" }), ms);
		fitImage(file, budget, deps).then(
			(r) => {
				clearTimeout(timer);
				resolve(r);
			},
			() => {
				clearTimeout(timer);
				resolve({ ok: false, reason: "undecodable" });
			},
		);
	});
}
