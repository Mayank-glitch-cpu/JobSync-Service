import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Uploads a local screenshot file to a GCS bucket if GCS_BUCKET_NAME is set.
 * Returns the public URL of the uploaded object, or null if GCS is not configured or fails.
 */
export async function uploadScreenshotToGcs(localFilePath: string): Promise<string | null> {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    return null;
  }

  if (!localFilePath || !existsSync(localFilePath)) {
    return null;
  }

  try {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    const bucket = storage.bucket(bucketName);
    const filename = basename(localFilePath);
    const destination = `screenshots/${filename}`;

    await bucket.upload(localFilePath, {
      destination,
      metadata: {
        cacheControl: "public, max-age=31536000",
      },
    });

    return `https://storage.googleapis.com/${bucketName}/${destination}`;
  } catch (error) {
    console.error("Failed to upload screenshot to GCS:", error);
    return null;
  }
}

/**
 * Upload an arbitrary buffer to GCS under the given object path (e.g.
 * "resumes/<uid>/resume.pdf"). Returns the gs-relative object path on success, or
 * null if GCS is not configured or the upload fails. Unlike screenshots these are
 * NOT made public — they're read back server-side via downloadGcsObject.
 */
export async function uploadBufferToGcs(
  buffer: Buffer,
  destination: string,
): Promise<string | null> {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) return null;
  try {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    await storage.bucket(bucketName).file(destination).save(buffer, {
      resumable: false,
      metadata: { cacheControl: "private, max-age=0" },
    });
    return destination;
  } catch (error) {
    console.error("Failed to upload buffer to GCS:", error);
    return null;
  }
}

/** Download a GCS object (by the object path returned from uploadBufferToGcs) into
 *  a Buffer, or null when GCS is unconfigured / the object is missing. */
export async function downloadGcsObject(destination: string): Promise<Buffer | null> {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) return null;
  try {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    const [contents] = await storage.bucket(bucketName).file(destination).download();
    return contents;
  } catch (error) {
    console.error("Failed to download object from GCS:", error);
    return null;
  }
}

/**
 * Resolve a local screenshot file to something a browser can render: a durable GCS
 * URL when a bucket is configured (preferred — small, persistable), otherwise an
 * inline base64 data URL fallback for local dev. Returns {} if the file is gone.
 */
export async function screenshotToData(
  localFilePath: string,
): Promise<{ url?: string; base64?: string }> {
  if (!localFilePath || !existsSync(localFilePath)) return {};
  const gcsUrl = await uploadScreenshotToGcs(localFilePath);
  if (gcsUrl) return { url: gcsUrl };
  try {
    return { base64: readFileSync(localFilePath).toString("base64") };
  } catch {
    return {};
  }
}
