/** The text to put back after a failed send: the sent text, then whatever was typed meanwhile (never dropped). */
export const mergeRestored = (sent: string, current: string): string => (current.trim() === "" ? sent : sent.trim() === "" ? current : `${sent}\n${current}`);
