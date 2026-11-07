import {
	Geist,
	Geist_Mono,
	IBM_Plex_Mono,
	IBM_Plex_Sans,
	Inter,
	Instrument_Serif,
	JetBrains_Mono,
	Newsreader,
	Source_Sans_3,
} from "next/font/google";
import type { ReactNode } from "react";

const geist = Geist({ subsets: ["latin"], display: "swap", variable: "--f-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], display: "swap", variable: "--f-geist-mono" });
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--f-inter" });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", display: "swap", variable: "--f-instrument" });
const jb = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--f-jb" });
const newsreader = Newsreader({ subsets: ["latin"], display: "swap", variable: "--f-newsreader" });
const source = Source_Sans_3({ subsets: ["latin"], display: "swap", variable: "--f-source" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap", variable: "--f-plex" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--f-plex-mono" });

export default function LooksLayout({ children }: { children: ReactNode }) {
	const cls = [geist, geistMono, inter, instrument, jb, newsreader, source, plexSans, plexMono].map((f) => f.variable).join(" ");
	return <div className={cls}>{children}</div>;
}
