export const QUIET_ZONE: number;

export function formatBits(ecLevel: number, maskIndex: number): number;
export function encodeQr(text: string): {
  version: number;
  mask: number;
  size: number;
  matrix: number[][];
};
export function qrPath(matrix: number[][]): string;
