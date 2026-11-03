/**
 * Fit an image under a byte budget before upload: downscale (longest side <= 2048 px) and recompress (JPEG, or WebP
 * for PNG-like sources that keep alpha is not needed: photos), stepping quality then size down until it fits.
 * The planning is pure (`planSteps`); the canvas work is injected (`FitDeps`) so tests need no DOM.
 */

export const MAX_SIDE = 2048;
const QUALITIES = [0.82, 0.7, 0.58, 0.46];
const SCALES = [1, 0.75, 0.55, 0.4];

export interface FitStep {
	width: number;
	height: number;
	quality: number;
}

/** Dimensions after capping the longest side. */
export function scaledSize(w: number, h: number, maxSide: number): { width: number; height: number } {
	const k = Math.min(1, maxSide / Math.max(w, h));
	return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** The ordered attempts: quality steps at the capped size, then smaller sizes with the quality steps again. */
export function planSteps(w: number, h: number, maxSide = MAX_SIDE): FitStep[] {
	const base = scaledSize(w, h, maxSide);
	const out: FitStep[] = [];
	for (const s of SCALES) {
		const width = Math.max(1, Math.round(base.width * s));
		const height = Math.max(1, Math.round(base.height * s));
		for (const quality of QUALITIES) out.push({ width, height, quality });
	}
	return out;
}

export interface FitDeps {
	/** Decode with EXIF orientation applied (createImageBitmap(file, { imageOrientation: "from-image" })). */
	decode(file: Blob): Promise<{ width: number; height: number }>;
	/** Draw the decoded image at the size and encode as JPEG at the quality. */
	encode(step: FitStep): Promise<Blob | null>;
}

/**
 * The file itself when it already fits; otherwise the first re-encoding that fits `budget`; otherwise the smallest
 * attempt's failure (undefined = could not get under the budget, or the browser cannot decode it).
 */
export async function fitImage(file: File, budget: number, deps: FitDeps): Promise<File | undefined> {
	if (file.size <= budget) return file;
	if (file.type === "image/gif") return undefined; // re-encoding would drop the animation: refuse instead
	let dims: { width: number; height: number };
	try {
		dims = await deps.decode(file);
	} catch {
		return undefined;
	}
	for (const step of planSteps(dims.width, dims.height)) {
		const blob = await deps.encode(step);
		if (blob && blob.size > 0 && blob.size <= budget) {
			const name = file.name.replace(/\.[^.\/]+$/, "") || "image";
			return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
		}
	}
	return undefined;
}

/** Browser deps: createImageBitmap + canvas (OffscreenCanvas when present). Orientation is applied at decode, so the output has no EXIF to lose. */
export function browserFitDeps(): FitDeps {
	let bitmap: ImageBitmap | undefined;
	return {
		async decode(file) {
			bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
			return { width: bitmap.width, height: bitmap.height };
		},
		async encode({ width, height, quality }) {
			if (!bitmap) return null;
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.fillStyle = "#fff"; // JPEG has no alpha
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(bitmap, 0, 0, width, height);
			return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
		},
	};
}
