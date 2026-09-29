/** Private object store. Never expose bucket credentials or public object URLs to clients. */
export interface AttachmentStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string, maxBytes: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export async function boundedBody(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > maxBytes) throw new Error('Attachment exceeds configured size');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}
