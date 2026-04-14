// Converts a resume file (PDF/DOCX/TXT/MD) into raw text. The structuring
// into skills.md / experience.md / projects.md is performed by the user's
// own MCP client model via the `onboard_profile` prompt — we only handle
// the binary-to-text step here.

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export async function parseResume(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".pdf":
      return parsePdf(path);
    case ".docx":
      return parseDocx(path);
    case ".txt":
    case ".md":
      return (await readFile(path, "utf-8")).trim();
    default:
      throw new Error(
        `Unsupported resume format: ${ext}. Use .pdf, .docx, .txt, or .md.`,
      );
  }
}

async function parsePdf(path: string): Promise<string> {
  const mod = await import("pdf-parse");
  const pdfParse = (mod.default ?? mod) as (buf: Buffer) => Promise<{ text: string }>;
  const buf = await readFile(path);
  const result = await pdfParse(buf);
  return result.text.trim();
}

async function parseDocx(path: string): Promise<string> {
  const mammoth = await import("mammoth");
  const buf = await readFile(path);
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value.trim();
}
