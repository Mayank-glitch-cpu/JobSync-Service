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
