export interface WrittenImage { label: string; target: string }
export function writtenImage(value: string): WrittenImage | null;
export function localWrittenImages(value: string): WrittenImage[];
export function outsideWrittenCode(value: string, transform: (part: string) => string): string;
export function normalizeWrittenOutput(value: string): string;
