import { writeFileSync, rmSync } from "node:fs";
import { uploadScreenshotToGcs } from "../src/lib/gcs.js";

async function main() {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    console.error("Error: GCS_BUCKET_NAME environment variable is not set.");
    process.exit(1);
  }

  console.log(`Testing GCS upload to bucket: ${bucketName}...`);
  const tempFile = "gcs-test-temp.txt";
  writeFileSync(tempFile, `JobsSync GCS Test Upload - ${new Date().toISOString()}`);

  try {
    const url = await uploadScreenshotToGcs(tempFile);
    if (url) {
      console.log(`✓ Upload successful! Public URL: ${url}`);
    } else {
      console.error("✗ Upload failed. Check the console error logs.");
    }
  } catch (err) {
    console.error("✗ Fatal error during GCS upload test:", err);
  } finally {
    try {
      rmSync(tempFile);
    } catch {}
  }
}

main();
