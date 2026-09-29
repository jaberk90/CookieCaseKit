import type { ContainerClient } from '@azure/storage-blob';
import { boundedBody, type AttachmentStorage } from './storage.js';
export function blobStorage(container: ContainerClient): AttachmentStorage {
  return {
    async put(key, data) {
      await container.getBlockBlobClient(key).uploadData(data, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
      });
    },
    async get(key, maxBytes) {
      const r = await container.getBlobClient(key).download();
      if (!r.readableStreamBody) throw new Error('Missing attachment body');
      return boundedBody(r.readableStreamBody, maxBytes);
    },
    async delete(key) {
      await container.getBlobClient(key).deleteIfExists();
    },
  };
}
