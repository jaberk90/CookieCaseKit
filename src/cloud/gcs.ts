import type { Bucket } from '@google-cloud/storage';
import { boundedBody, type AttachmentStorage } from './storage.js';
export function gcsStorage(bucket: Bucket): AttachmentStorage {
  return {
    async put(key, data) {
      await bucket.file(key).save(data, {
        resumable: false,
        contentType: 'application/octet-stream',
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    },
    async get(key, maxBytes) {
      return boundedBody(bucket.file(key).createReadStream(), maxBytes);
    },
    async delete(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}
