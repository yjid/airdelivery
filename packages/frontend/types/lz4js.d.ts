/**
 * `lz4js` ships no type declarations.
 *
 * It was previously pulled in with `// @ts-ignore`, which disables checking for
 * the whole file and hid real errors. These declarations are narrow and match
 * the API actually used.
 */
declare module 'lz4js' {
  /** Returns a new Uint8Array. Throws if the input is not valid LZ4. */
  export function compress(input: Uint8Array): Uint8Array;
  export function decompress(input: Uint8Array): Uint8Array;
}
