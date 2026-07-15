/**
 * FinalVideoHost — OpusClip is URL-in, not file-in, so the approved final
 * render must be reachable by URL first. Pluggable interface; one concrete
 * S3-compatible implementation to start (works with AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO — anything speaking the S3 API).
 *
 * The AWS SDK is imported lazily inside upload() so it never loads at shell
 * startup. Credentials come from the shell key vault (s3-access / s3-secret).
 */
import fs from 'fs'
import path from 'path'
import { getSettingsStore } from '../settings'
import { getSecret } from '../keys'

export interface FinalVideoHost {
  readonly id: string
  readonly label: string
  /** Upload the file; return a URL OpusClip can fetch (public or signed). */
  upload(filePath: string, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<string>
}

export class S3Host implements FinalVideoHost {
  readonly id = 's3'
  readonly label = 'S3-compatible bucket'

  async upload(filePath: string, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<string> {
    const settings = getSettingsStore().getSettings().hosting
    const access = getSecret('s3-access')
    const secret = getSecret('s3-secret')
    if (!settings.bucket || !access || !secret) {
      throw new Error(
        'Video hosting is not configured. OpusClip needs your final video reachable by URL — set the bucket in this module\'s Settings → Hosting and the S3 keys in the shell Settings → API Keys.'
      )
    }

    const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    const client = new S3Client({
      region: settings.region || 'us-east-1',
      ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: access, secretAccessKey: secret }
    })

    const key = `automatic-editing/${Date.now()}-${path.basename(filePath)}`
    onProgress?.(0.05)
    // Stream from disk — final renders can be multi-GB; buffering the whole
    // file would block the main process and can OOM.
    const { size } = fs.statSync(filePath)
    await client.send(
      new PutObjectCommand({
        Bucket: settings.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: size,
        ContentType: 'video/mp4'
      }),
      { abortSignal: signal }
    )
    onProgress?.(0.9)

    if (settings.publicBaseUrl) {
      return `${settings.publicBaseUrl.replace(/\/$/, '')}/${key}`
    }
    // Signed GET valid for 24h — enough for OpusClip ingestion.
    return getSignedUrl(client, new GetObjectCommand({ Bucket: settings.bucket, Key: key }), { expiresIn: 86400 })
  }
}

export function getHost(): FinalVideoHost {
  // Pluggable: switch on settings.hosting.kind when more hosts exist.
  return new S3Host()
}
