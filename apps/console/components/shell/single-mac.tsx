"use client";

import { createContext, useContext } from "react";

/** Whether the console runs inside the single-Mac app. Set once by the root layout from the server env (src/core/single-mac.ts). */
const SingleMacContext = createContext(false);

export const SingleMacProvider = SingleMacContext.Provider;
export const useSingleMac = (): boolean => useContext(SingleMacContext);
