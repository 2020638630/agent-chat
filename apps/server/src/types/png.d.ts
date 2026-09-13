declare module 'png-chunks-extract' {
  export default function extract(data: Buffer | Uint8Array): Array<{ name: string; data: Uint8Array }>;
}
declare module 'png-chunk-text' {
  export function encode(keyword: string, text: string): { name: string; data: Uint8Array };
  export function decode(data: Uint8Array): { keyword: string; text: string };
}
