import {
  activeRoles,
  readProfileFile,
  readRawResume,
  readRoles,
  writeProfileFile,
  writeRawResume,
  writeRoles,
  type ProfileFile,
  type Roles,
} from "../lib/profile.js";
import { parseResume } from "../lib/resume-parser.js";
import { errorResult, textResult, type ToolDefinition } from "./index.js";

const PROFILE_FILES: ProfileFile[] = ["skills", "experience", "projects"];

export const profileReadTool: ToolDefinition = {
  name: "profile_read",
  description:
    "Read the user's profile: skills.md, experience.md, projects.md, roles.json, and the raw resume text (if any). Use this at the start of every scrape run so role targeting reflects the user's actual background. Returns { skills, experience, projects, roles, activeRoles, rawResume }.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    try {
      const roles = readRoles();
      return textResult({
        skills: readProfileFile("skills"),
        experience: readProfileFile("experience"),
        projects: readProfileFile("projects"),
        roles,
        activeRoles: activeRoles(roles),
        rawResume: readRawResume(),
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const profileWriteFileTool: ToolDefinition = {
  name: "profile_write_file",
  description:
    "Write one of the profile markdown files (skills, experience, or projects). Used by the onboarding agent after extracting structured content from the raw resume. Overwrites existing content — pass the full new file body.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        enum: PROFILE_FILES,
        description: "Which profile file to write.",
      },
      content: { type: "string", description: "Full markdown content." },
    },
    required: ["file", "content"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const file = String(args.file) as ProfileFile;
      if (!PROFILE_FILES.includes(file)) {
        return errorResult(`Invalid file: ${file}. Must be one of ${PROFILE_FILES.join(", ")}.`);
      }
      writeProfileFile(file, String(args.content ?? ""));
      return textResult({ file, written: true });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const profileUpdateRolesTool: ToolDefinition = {
  name: "profile_update_roles",
  description:
    "Update the user's role lists in roles.json. Pass any of `detected`, `custom`, `excluded` to replace that list, or `addCustom`/`addExcluded`/`removeCustom`/`removeExcluded` to mutate incrementally. Returns the updated roles plus the computed activeRoles (detected ∪ custom − excluded).",
  inputSchema: {
    type: "object",
    properties: {
      detected: { type: "array", items: { type: "string" } },
      custom: { type: "array", items: { type: "string" } },
      excluded: { type: "array", items: { type: "string" } },
      addCustom: { type: "array", items: { type: "string" } },
      addExcluded: { type: "array", items: { type: "string" } },
      removeCustom: { type: "array", items: { type: "string" } },
      removeExcluded: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const roles: Roles = readRoles();
      if (Array.isArray(args.detected)) roles.detected = args.detected as string[];
      if (Array.isArray(args.custom)) roles.custom = args.custom as string[];
      if (Array.isArray(args.excluded)) roles.excluded = args.excluded as string[];

      const dedupeAppend = (list: string[], add: string[]) => {
        const seen = new Set(list.map((s) => s.toLowerCase()));
        for (const r of add) {
          if (!seen.has(r.toLowerCase())) {
            list.push(r);
            seen.add(r.toLowerCase());
          }
        }
      };
      const removeFrom = (list: string[], remove: string[]): string[] => {
        const rm = new Set(remove.map((s) => s.toLowerCase()));
        return list.filter((r) => !rm.has(r.toLowerCase()));
      };

      if (Array.isArray(args.addCustom)) dedupeAppend(roles.custom, args.addCustom as string[]);
      if (Array.isArray(args.addExcluded)) dedupeAppend(roles.excluded, args.addExcluded as string[]);
      if (Array.isArray(args.removeCustom)) roles.custom = removeFrom(roles.custom, args.removeCustom as string[]);
      if (Array.isArray(args.removeExcluded)) roles.excluded = removeFrom(roles.excluded, args.removeExcluded as string[]);

      writeRoles(roles);
      return textResult({ roles, activeRoles: activeRoles(roles) });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

export const profileParseResumeTool: ToolDefinition = {
  name: "profile_parse_resume",
  description:
    "Parse a resume file (PDF/DOCX/TXT/MD) at the given path, extract its raw text, and save it to ~/.jobsync/profile/raw-resume.txt. After this runs, the agent should read the raw text (via profile_read) and structure it into skills/experience/projects via profile_write_file, then suggest detected roles via profile_update_roles.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the resume file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  handler: async (args) => {
    try {
      const path = String(args.path);
      const text = await parseResume(path);
      writeRawResume(text);
      return textResult({ path, chars: text.length, preview: text.slice(0, 500) });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};
