import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

// Ranking is HTTP-free and deterministic, but it reads and converts every
// candidate CV, so give it room without giving it the discovery budget.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 45_000;
const MAX_JD_BYTES = 200_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 20;
const ALLOWED = new Set([".pdf", ".md", ".markdown", ".txt", ".tex", ".html", ".htm"]);

/**
 * Rank CVs against a pasted posting.
 *
 * Accepts either JSON ({ jd, dir }) or multipart/form-data ({ jd, cv: File[] }).
 * Uploaded files are written to a temp directory and the core script is pointed
 * at it with --dir, so the upload path and the folder path run the exact same
 * ranking code. Nothing is written into the user's project.
 *
 * The core script is spawned rather than imported, matching lib/core/scan.ts:
 * the web app is a VIEW over the same logic the CLI and the tests use.
 */
export async function POST(req: NextRequest) {
  let jd = "";
  let dir: string | undefined;
  let uploadDir: string | null = null;
  let uploadedNames: string[] = [];
  const rejected: { name: string; reason: string }[] = [];

  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      jd = String(form.get("jd") ?? "");
      const files = form.getAll("cv").filter((f): f is File => f instanceof File);
      if (files.length > MAX_FILES) {
        return Response.json({ error: `Too many files — ${MAX_FILES} at a time.` }, { status: 400 });
      }
      if (files.length) {
        uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-upload-"));
        for (const file of files) {
          const ext = path.extname(file.name).toLowerCase();
          if (!ALLOWED.has(ext)) {
            rejected.push({ name: file.name, reason: `${ext || "no extension"} is not supported` });
            continue;
          }
          if (file.size > MAX_FILE_BYTES) {
            rejected.push({ name: file.name, reason: "larger than 10MB" });
            continue;
          }
          // basename() so a crafted "../../etc/passwd" cannot escape the temp
          // directory — the name arrives from the browser and is untrusted.
          const safe = path.basename(file.name);
          fs.writeFileSync(
            path.join(uploadDir, safe),
            Buffer.from(await file.arrayBuffer()),
          );
          uploadedNames.push(safe);
        }
        dir = uploadDir;
      }
      const typedDir = String(form.get("dir") ?? "").trim();
      if (!dir && typedDir) dir = typedDir;
    } else {
      const body = (await req.json()) as Record<string, unknown>;
      jd = typeof body.jd === "string" ? body.jd : "";
      const d = typeof body.dir === "string" ? body.dir.trim() : "";
      if (d) dir = d;
    }
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  try {
    if (!jd.trim()) {
      return Response.json({ error: "Paste a job description first." }, { status: 400 });
    }
    if (Buffer.byteLength(jd, "utf8") > MAX_JD_BYTES) {
      return Response.json({ error: "That job description is too long." }, { status: 400 });
    }
    if (uploadDir && !uploadedNames.length) {
      return Response.json(
        {
          error:
            rejected.map((r) => `${r.name}: ${r.reason}`).join(" · ") ||
            "No usable files were uploaded.",
        },
        { status: 400 },
      );
    }

    const script = rootScript("cv-pick");
    if (!fs.existsSync(script)) {
      return Response.json(
        { error: "cv-pick.mjs is not present in this checkout." },
        { status: 400 },
      );
    }

    // The script takes a file path, so the pasted posting becomes a temp file.
    const jdDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-fit-"));
    const jdPath = path.join(jdDir, "posting.txt");
    fs.writeFileSync(jdPath, jd, "utf8");

    const args = [script, jdPath, "--json"];
    if (dir) args.push("--dir", dir);

    try {
      const result = await new Promise<{ code: number | null; out: string; err: string }>(
        (resolve) => {
          const child = spawn(process.execPath, args, { cwd: careerOpsRoot() });
          let out = "";
          let err = "";
          const killer = setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch {
              /* already gone */
            }
          }, TIMEOUT_MS);
          child.stdout.on("data", (d: Buffer) => {
            out += d.toString();
          });
          child.stderr.on("data", (d: Buffer) => {
            err = (err + d.toString()).slice(-4000);
          });
          child.on("error", (e) => {
            clearTimeout(killer);
            resolve({ code: 1, out, err: e instanceof Error ? e.message : String(e) });
          });
          child.on("close", (code) => {
            clearTimeout(killer);
            resolve({ code, out, err });
          });
        },
      );

      // cv-pick exits 1 when the recommendation is "regenerate", which is a real
      // answer rather than a failure. Only treat the run as failed when nothing
      // parseable came back.
      try {
        const parsed = JSON.parse(result.out.trim());
        return Response.json({ ...parsed, rejected, uploaded: uploadedNames });
      } catch {
        const reason =
          result.err.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" · ") ||
          `the ranking script exited with code ${result.code}`;
        return Response.json({ error: `Could not rank your CVs: ${reason}` }, { status: 500 });
      }
    } finally {
      try {
        fs.rmSync(jdDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  } finally {
    // Uploads are the user's own documents and must not outlive the request.
    if (uploadDir) {
      try {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
