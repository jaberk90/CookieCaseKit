import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { boundedBody, type AttachmentStorage } from './storage.js';
export function s3Storage(client: S3Client, bucket: string): AttachmentStorage {
  return {
    async put(key, data) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: 'application/octet-stream',
          IfNoneMatch: '*',
        }),
      );
    },
    async get(key, maxBytes) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) throw new Error('Missing attachment body');
      return boundedBody(r.Body as AsyncIterable<Uint8Array>, maxBytes);
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
