#!/usr/bin/env node
"use strict";

const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.APPLICATION_TAILOR_PORT || 17366);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(
  process.env.SKILLBRIDGE_WORKSPACE_ROOT ||
  process.env.APPLICATION_TAILOR_WORKSPACE_ROOT ||
  discoverWorkspaceRoot()
);
const APPLICATION_OUTPUT_DIR = path.resolve(process.env.APPLICATION_OUTPUT_DIR || path.join(WORKSPACE_ROOT, "generated-applications-v2"));
const KNOWLEDGE_BASE_PATH = path.join(APPLICATION_OUTPUT_DIR, "profile_knowledge_base.json");
const STORY_DRAFT_DIR = path.join(APPLICATION_OUTPUT_DIR, "story-drafts");
const CODEX_BIN = process.env.CODEX_BIN || "/Applications/Codex.app/Contents/Resources/codex";
const DOCX_BUILDER_PATH = path.join(__dirname, "docx_builder.py");
const STORY_DRAFT_OUTPUT_LIMIT = 1024 * 1024;
const STORY_TEXT_LIMIT = 12000;
const STORY_QUESTIONS_LIMIT = 6000;
const STORY_USER_PROMPT_LIMIT = 8000;
const TAILOR_OUTPUT_LIMIT = 2 * 1024 * 1024;
const TAILOR_PROGRESS_MARKER = "APPLICATION_TAILOR_PROGRESS:";
const TAILOR_JSON_BEGIN = "APPLICATION_TAILOR_JSON_BEGIN";
const TAILOR_JSON_END = "APPLICATION_TAILOR_JSON_END";
const MAX_TAILOR_REPAIR_ATTEMPTS = 1;
const DEFAULT_APPLICANT_FILE_BASENAME = getDefaultApplicantFileBasename();
const RESUME_FILE_NAME = process.env.SKILLBRIDGE_RESUME_FILE_NAME || `${DEFAULT_APPLICANT_FILE_BASENAME}_resume.docx`;
const COVER_LETTER_FILE_NAME = process.env.SKILLBRIDGE_COVER_LETTER_FILE_NAME || `${DEFAULT_APPLICANT_FILE_BASENAME}_cover_letter.docx`;
const LEGACY_RESUME_FILE_PATTERN = /(?:^|[_\s-])resume\.docx$/i;
const LEGACY_COVER_LETTER_FILE_PATTERN = /cover[_\s-]*letter\.docx$/i;

const JOB_DISPOSITIONS = new Set(["", "applied", "dont_qualify"]);
const KNOWLEDGE_STATUSES = new Set(["pending", "approved", "rejected"]);
const SKILL_CANDIDATES = [
  "academic support",
  "administrative support",
  "attention to detail",
  "Canva",
  "cash handling",
  "communication",
  "confidentiality",
  "content creation",
  "CSS",
  "customer service",
  "customer support",
  "data analysis",
  "data entry",
  "documentation",
  "editing",
  "event support",
  "Excel",
  "GitHub",
  "Google Workspace",
  "HTML",
  "inventory",
  "JavaScript",
  "leadership",
  "marketing",
  "Microsoft Office",
  "Node.js",
  "PowerPoint",
  "project management",
  "public speaking",
  "Python",
  "React",
  "research",
  "scheduling",
  "social media",
  "SQL",
  "student support",
  "teamwork",
  "technical support",
  "training",
  "troubleshooting",
  "time management",
  "writing"
];
const EXPERIENCE_TOPICS = [
  {
    topic: "customer-service",
    title: "Customer or student support story",
    aliases: ["customer service", "customer support", "student support", "front desk", "service excellence", "assist students"],
    prompt: "Add a concrete story where you helped a student, customer, teammate, or user solve a problem. Include the situation, your action, and the result."
  },
  {
    topic: "communication",
    title: "Communication and collaboration story",
    aliases: ["communication", "collaboration", "teamwork", "interpersonal", "public speaking", "written and verbal"],
    prompt: "Add a story that proves clear written or verbal communication with teammates, students, users, or stakeholders."
  },
  {
    topic: "leadership",
    title: "Leadership or ownership story",
    aliases: ["leadership", "supervise", "mentor", "coordinate", "lead", "initiative", "independently"],
    prompt: "Add a story where you owned a project, coordinated others, mentored someone, or improved a process."
  },
  {
    topic: "technical-support",
    title: "Technical support or troubleshooting story",
    aliases: ["technical support", "troubleshooting", "help desk", "software support", "hardware", "systems", "resolve issues"],
    prompt: "Add a story where you diagnosed a technical issue, supported a user, documented a fix, or kept a system working."
  },
  {
    topic: "documentation-training",
    title: "Documentation or training story",
    aliases: ["documentation", "training", "train", "manual", "instructions", "procedures", "knowledge base"],
    prompt: "Add a story where you created documentation, trained someone, taught a concept, or made a process easier to follow."
  },
  {
    topic: "data-research",
    title: "Research or data analysis story",
    aliases: ["research", "data analysis", "excel", "reporting", "analytics", "evaluate", "metrics", "survey"],
    prompt: "Add a story where you gathered information, analyzed data, used spreadsheets, measured results, or turned findings into a decision."
  },
  {
    topic: "content-marketing",
    title: "Content, marketing, or audience-growth story",
    aliases: ["social media", "marketing", "content creation", "copywriting", "promotion", "audience", "community engagement"],
    prompt: "Add a story where you created content, explained a product, grew an audience, supported a community, or promoted an initiative."
  },
  {
    topic: "administrative-accuracy",
    title: "Administrative accuracy story",
    aliases: ["administrative", "data entry", "records", "scheduling", "confidentiality", "attention to detail", "filing"],
    prompt: "Add a story where accuracy, records, scheduling, confidentiality, or reliable follow-through mattered."
  }
];
const JOB_SKILL_ALIASES = {
  "academic support": ["student support", "assist students", "tutoring", "instructional support"],
  "administrative support": ["administrative", "office support", "records", "scheduling"],
  "attention to detail": ["detail oriented", "detail-oriented", "accuracy", "accurate"],
  "canva": ["design tools", "adobe express"],
  "communication": ["communicate", "communications", "plain language", "plain-language", "interpersonal"],
  "content creation": ["copywriting", "write copy", "create content", "digital content", "content"],
  "customer service": ["customer-facing", "service excellence", "assist customers", "assist students"],
  "customer support": ["customer-facing", "service excellence", "assist customers", "assist students"],
  "data analysis": ["analytics", "analytic reports", "analyze data", "reporting", "metrics", "insights"],
  "editing": ["edit", "copy editing", "grammar", "spelling"],
  "event support": ["event", "events", "attend events", "capture photos", "capture video", "interviews"],
  "excel": ["spreadsheets", "spreadsheet", "microsoft excel"],
  "google workspace": ["google docs", "google sheets", "google drive"],
  "leadership": ["supervise", "supervisory", "mentor", "coordinate", "lead"],
  "marketing": ["marketing and communications", "promotion", "campaigns", "brand"],
  "microsoft office": ["office suite", "word", "powerpoint", "microsoft word", "microsoft powerpoint"],
  "project management": ["project management tools", "airtable", "wrike", "manage multiple projects"],
  "research": ["researching", "researches", "literature reviews", "trend research"],
  "social media": ["online presence", "social platforms", "platform changes", "social media platforms"],
  "student support": ["assist students", "student services", "student success"],
  "technical support": ["help desk", "technical assistance", "software support"],
  "training": ["train", "webinars", "learning opportunities", "teaching"],
  "troubleshooting": ["troubleshoot", "diagnose", "resolve issues"],
  "writing": ["write", "copywriting", "copy", "grammar", "spelling", "plain language", "plain-language"]
};
const EXTRACTED_SKILL_STOPLIST = new Set([
  "including",
  "language",
  "languages",
  "others",
  "programs",
  "preferred",
  "required"
]);
const NON_TECH_PROGRAMMING_DETAIL_TERMS = [
  "C++",
  "C#",
  "CSS",
  "Git",
  "GitHub",
  "GitLab",
  "Golang",
  "HTML",
  "JavaScript",
  "KeyDB",
  "Linux",
  "Node.js",
  "PostgreSQL",
  "Python",
  "React",
  "Redis",
  "SQL",
  "TimescaleDB",
  "TypeScript",
  "Unix"
];
const CANONICAL_RESUME_ROLE_TITLES = [
  "XDAO.app, Singapore: Software Engineering / Team Lead",
  "DYOR.io, Limassol, Cyprus: Co-Founder (successfully exited) / Software Engineer",
  [
    "Private Teaching Experience, Baku, Azerbaijan: C/C++/C# Tutor",
    "Private Teaching Experience, Baku, Azerbaijan: Programming Tutor"
  ],
  "CoderWorld MCPE, Baku, Azerbaijan: Founder (successfully exited) / Software Engineer",
  "United Nations (COP29): ICT Support Engineer"
];
const NON_TECH_RESUME_ROLE_TITLES = [
  "XDAO.app, Singapore: Software Engineering / Team Lead",
  "DYOR.io, Limassol, Cyprus: Co-Founder (successfully exited) / Software Engineer",
  [
    "Private Teaching Experience, Baku, Azerbaijan: Programming Tutor",
    "Private Teaching Experience, Baku, Azerbaijan: C/C++/C# Tutor"
  ],
  "CoderWorld MCPE, Baku, Azerbaijan: Founder (successfully exited) / Software Engineer",
  "United Nations (COP29): ICT Support Engineer"
];

function discoverWorkspaceRoot() {
  const candidates = [
    process.cwd(),
    EXTENSION_ROOT,
    path.resolve(EXTENSION_ROOT, "..")
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "Master Resume.md")) ||
      fs.existsSync(path.join(candidate, "AGENTS.md"))
    ) {
      return candidate;
    }
  }
  return EXTENSION_ROOT;
}

function getDefaultApplicantFileBasename() {
  const explicitBase = normalizeFileNameBase(
    process.env.SKILLBRIDGE_APPLICANT_FILE_BASENAME ||
    process.env.APPLICATION_TAILOR_FILE_BASENAME ||
    ""
  );
  return explicitBase || extractApplicantFileBasename() || "Applicant_Name";
}

function extractApplicantFileBasename() {
  const candidates = [
    path.join(WORKSPACE_ROOT, "Master Resume.md"),
    path.join(EXTENSION_ROOT, "Master Resume.example.md")
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const resumeMarkdown = fs.readFileSync(candidate, "utf8");
      const heading = resumeMarkdown.match(/^#\s+(.+?)\s*$/m);
      const basename = normalizeFileNameBase(heading && heading[1]);
      if (basename) {
        return basename;
      }
    } catch (_error) {
      // Keep startup resilient; filename choice should not block the bridge.
    }
  }
  return "";
}

function normalizeFileNameBase(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['"]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

const runningJobs = new Map();
const queuedTailoringJobs = new Map();
const tailoringQueue = [];
const storyDraftJobs = new Map();

startHttpServer();

function startHttpServer() {
  const server = http.createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${PORT}`}`);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          name: "application-tailor-bridge",
          port: PORT,
          outputDir: APPLICATION_OUTPUT_DIR,
          knowledgeBasePath: KNOWLEDGE_BASE_PATH,
          storyTextLimit: STORY_TEXT_LIMIT,
          storyQuestionsLimit: STORY_QUESTIONS_LIMIT,
          runningJobIds: Array.from(runningJobs.keys()),
          queuedJobIds: getQueuedTailoringJobIds()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/knowledge") {
        sendJson(response, 200, { ok: true, knowledge: getKnowledgeBaseForClient() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/knowledge/item") {
        const body = await readJsonBody(request);
        const knowledge = upsertKnowledgeItem(body.item || body);
        sendJson(response, 200, { ok: true, knowledge });
        return;
      }

      if (request.method === "POST" && url.pathname === "/knowledge/action") {
        const body = await readJsonBody(request);
        const knowledge = applyKnowledgeAction(body);
        sendJson(response, 200, { ok: true, knowledge });
        return;
      }

      if (request.method === "POST" && url.pathname === "/knowledge/story-draft") {
        const body = await readJsonBody(request);
        const draftJob = startStoryDraft(body);
        sendJson(response, 200, { ok: true, draftJob });
        return;
      }

      if (request.method === "GET" && url.pathname === "/knowledge/story-draft/status") {
        const draftId = String(url.searchParams.get("draftId") || "");
        const draftJob = getStoryDraftStatus(draftId);
        sendJson(response, 200, { ok: true, draftJob });
        return;
      }

      if (request.method === "POST" && url.pathname === "/knowledge/story-questions") {
        const body = await readJsonBody(request);
        const draftJob = startStoryQuestions(body);
        sendJson(response, 200, { ok: true, draftJob });
        return;
      }

      if (request.method === "GET" && url.pathname === "/knowledge/story-questions/status") {
        const draftId = String(url.searchParams.get("draftId") || "");
        const draftJob = getStoryDraftStatus(draftId);
        sendJson(response, 200, { ok: true, draftJob });
        return;
      }

      if (request.method === "GET" && url.pathname === "/job/status") {
        const jobId = normalizeJobId(url.searchParams.get("jobId"));
        if (!jobId) {
          sendJson(response, 400, { ok: false, error: "Missing JR job ID." });
          return;
        }

        sendJson(response, 200, { ok: true, job: getJobPostStatus(jobId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/job/process") {
        const body = await readJsonBody(request);
        const processed = processJobPost(body);
        sendJson(response, 200, { ok: true, ...processed });
        return;
      }

      if (request.method === "POST" && url.pathname === "/job/disposition") {
        const body = await readJsonBody(request);
        const marked = setJobDisposition(body);
        sendJson(response, 200, { ok: true, ...marked });
        return;
      }

      if (request.method === "POST" && url.pathname === "/application/tailor") {
        const body = await readJsonBody(request);
        const application = startTailoring(body);
        sendJson(response, 200, { ok: true, application });
        return;
      }

      if (request.method === "POST" && url.pathname === "/application/open") {
        const body = await readJsonBody(request);
        const opened = openApplicationArtifacts(body);
        sendJson(response, 200, { ok: true, opened });
        return;
      }

      if (request.method === "GET" && url.pathname === "/application/resume") {
        if (request.headers["x-application-tailor-upload"] !== "resume") {
          sendJson(response, 403, { ok: false, error: "Missing extension upload header." });
          return;
        }

        const jobId = normalizeJobId(url.searchParams.get("jobId"));
        if (!jobId) {
          sendJson(response, 400, { ok: false, error: "Missing JR job ID." });
          return;
        }

        const resume = getApplicationResumeForUpload(jobId);
        sendJson(response, 200, { ok: true, resume });
        return;
      }

      if (request.method === "GET" && url.pathname === "/application/upload-package") {
        if (request.headers["x-application-tailor-upload"] !== "resume") {
          sendJson(response, 403, { ok: false, error: "Missing extension upload header." });
          return;
        }

        const jobId = normalizeJobId(url.searchParams.get("jobId"));
        if (!jobId) {
          sendJson(response, 400, { ok: false, error: "Missing JR job ID." });
          return;
        }

        const uploadPackage = getApplicationUploadPackage(jobId);
        sendJson(response, 200, { ok: true, uploadPackage });
        return;
      }

      if (request.method === "GET" && url.pathname === "/application/status") {
        const jobId = normalizeJobId(url.searchParams.get("jobId"));
        if (!jobId) {
          sendJson(response, 400, { ok: false, error: "Missing JR job ID." });
          return;
        }

        sendJson(response, 200, { ok: true, application: getApplicationStatus(jobId) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/application/statuses") {
        const requestedJobIds = parseJobIds([
          url.searchParams.get("jobIds"),
          ...url.searchParams.getAll("jobId")
        ].filter(Boolean).join(" "));
        const applications = getKnownApplicationStatuses(requestedJobIds);
        sendJson(response, 200, {
          ok: true,
          applications,
          byJobId: Object.fromEntries(applications.map((application) => [application.jobId, application]))
        });
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: getErrorMessage(error) });
    }
  });

  server.on("error", (error) => {
    log(`HTTP bridge failed on port ${PORT}: ${getErrorMessage(error)}`);
  });

  fs.mkdirSync(APPLICATION_OUTPUT_DIR, { recursive: true });
  server.listen(PORT, "127.0.0.1", () => {
    log(`Application tailor bridge listening at http://127.0.0.1:${PORT}`);
  });
}

function processJobPost(body) {
  const job = normalizeJob(body.job || body);
  if (!job.jobId) {
    throw new Error("I could not find a JR job ID. Open a supported job page and try again.");
  }

  const currentStatus = getJobPostStatus(job.jobId);
  if (currentStatus.processed) {
    return {
      job: currentStatus,
      alreadyProcessed: true,
      pendingAdded: 0,
      knowledge: getKnowledgeStatusForJob(readKnowledgeBase(), job.jobId, 0)
    };
  }

  const result = persistJobKnowledgeInputs(job);
  return {
    job: {
      ...getJobPostStatus(job.jobId),
      jobId: job.jobId,
      title: job.title,
      url: job.url,
      pageTitle: job.pageTitle,
      timestamp: job.timestamp,
      jobDir: result.jobDir,
      jobContextPath: result.jobContextPath,
      knowledgeSnapshotPath: result.knowledgeSnapshotPath,
      descriptionLength: job.description.length,
      requirementsLength: job.requirements.length
    },
    pendingAdded: result.knowledgeUpdate.pendingAdded,
    knowledge: result.knowledgeUpdate.status
  };
}

function getJobPostStatus(jobId) {
  const paths = getApplicationPaths(jobId);
  const exists = fs.existsSync(paths.jobContextPath);
  const context = exists ? readJobContext(jobId) : null;
  const meta = readJobMeta(jobId);
  return {
    jobId: normalizeJobId(jobId),
    processed: exists,
    title: context ? String(context.title || "") : String(meta.title || ""),
    url: context ? String(context.url || "") : String(meta.url || ""),
    pageTitle: context ? String(context.pageTitle || "") : String(meta.pageTitle || ""),
    timestamp: context ? String(context.timestamp || "") : String(meta.updatedAt || ""),
    disposition: meta.disposition || "",
    dispositionLabel: getJobDispositionLabel(meta.disposition),
    dispositionUpdatedAt: meta.dispositionUpdatedAt || "",
    jobDir: paths.jobDir,
    jobContextPath: paths.jobContextPath,
    knowledgeSnapshotPath: paths.knowledgeSnapshotPath,
    descriptionLength: context ? String(context.description || "").length : 0,
    requirementsLength: context ? String(context.requirements || "").length : 0
  };
}

function setJobDisposition(body) {
  const rawJob = body && body.job && typeof body.job === "object" ? body.job : null;
  const job = rawJob ? normalizeJob(rawJob) : null;
  const jobId = normalizeJobId(body && (body.jobId || body.id)) || (job && job.jobId);
  if (!jobId) {
    throw new Error("Missing JR job ID.");
  }

  const disposition = normalizeJobDisposition(body && (body.disposition || body.status || body.action));
  if (!JOB_DISPOSITIONS.has(disposition)) {
    throw new Error("Job mark must be applied or dont_qualify.");
  }

  const currentMeta = readJobMeta(jobId);
  const context = readJobContext(jobId);
  const now = nowIso();
  const nextMeta = {
    schemaVersion: 1,
    jobId,
    title: cleanKnowledgeText((job && job.title) || (context && context.title) || currentMeta.title || "", 180),
    url: String((job && job.url) || (context && context.url) || currentMeta.url || ""),
    pageTitle: cleanKnowledgeText((job && job.pageTitle) || (context && context.pageTitle) || currentMeta.pageTitle || "", 220),
    disposition,
    dispositionLabel: getJobDispositionLabel(disposition),
    dispositionUpdatedAt: now,
    appliedAt: disposition === "applied" ? now : currentMeta.appliedAt || "",
    dontQualifyAt: disposition === "dont_qualify" ? now : currentMeta.dontQualifyAt || "",
    updatedAt: now
  };

  writeJobMeta(jobId, nextMeta);

  return {
    job: getJobPostStatus(jobId),
    application: getApplicationStatus(jobId)
  };
}

function startTailoring(body) {
  const job = normalizeJob(body.job || body);
  const jobId = job.jobId;
  if (!jobId) {
    throw new Error("I could not find a JR job ID. Open a supported job page and try again.");
  }

  if (runningJobs.has(jobId) || queuedTailoringJobs.has(jobId)) {
    return getApplicationStatus(jobId);
  }

  const {
    jobDir,
    statusPath,
    jobContextPath,
    knowledgeSnapshotPath,
    progressPath,
    promptPath,
    stdoutPath,
    stderrPath,
    knowledgeUpdate
  } = persistJobKnowledgeInputs(job, { resetProgress: true, trackProgress: true });

  const prompt = buildCodexPrompt({
    job,
    jobDir,
    jobContextPath,
    knowledgeSnapshotPath,
    progressPath,
    statusPath
  });
  fs.writeFileSync(promptPath, prompt, "utf8");
  appendProgress(jobId, "Wrote Codex prompt and local job files.");

  const activeJobId = getActiveTailoringJobId();
  const queuePosition = activeJobId ? getQueuedTailoringJobIds().length + 1 : 0;
  writeJson(statusPath, {
    schemaVersion: 1,
    jobId,
    title: job.title,
    status: "queued",
    progressMessage: queuePosition > 0
      ? `Queued behind ${queuePosition} tailoring run(s).`
      : "Queued Codex tailoring run.",
    jobDir,
    updatedAt: new Date().toISOString(),
    artifacts: [],
    documentCount: 0,
    queuePosition,
    activeJobId,
    repairAttemptCount: 0,
    validationErrors: [],
    validationWarnings: [],
    knowledge: knowledgeUpdate.status,
    error: ""
  });

  enqueueTailoringJob({
    job,
    jobDir,
    jobContextPath,
    knowledgeSnapshotPath,
    progressPath,
    prompt,
    promptPath,
    statusPath,
    stdoutPath,
    stderrPath,
    contentPath: path.join(jobDir, "tailored_content.json")
  });

  return getApplicationStatus(jobId);
}

function persistJobKnowledgeInputs(job, options = {}) {
  const paths = getApplicationPaths(job.jobId);
  fs.mkdirSync(paths.jobDir, { recursive: true });

  if (options.resetProgress) {
    resetApplicationRunFiles(paths);
  }

  writeJson(paths.jobContextPath, job);
  if (options.trackProgress) {
    appendProgress(job.jobId, "Captured job description and requirements.");
  }

  const knowledgeUpdate = collectKnowledgeSuggestions(job);
  writeJson(paths.knowledgeSnapshotPath, buildKnowledgeSnapshot(job.jobId));
  if (options.trackProgress) {
    appendProgress(
      job.jobId,
      knowledgeUpdate.pendingAdded > 0
        ? `Added ${knowledgeUpdate.pendingAdded} pending skills/stories to review.`
        : "Knowledge base checked for missing skills and stories."
    );
  }

  return {
    ...paths,
    knowledgeUpdate
  };
}

function resetApplicationRunFiles(paths) {
  for (const filePath of [
    paths.progressPath,
    paths.stdoutPath,
    paths.stderrPath,
    paths.contentPath,
    ...getPossibleApplicationFilePaths(paths.jobDir)
  ]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (_error) {
      // Best effort cleanup; stale-file checks below still protect readiness.
    }
  }
  fs.writeFileSync(paths.progressPath, "", "utf8");
}

function getApplicationPaths(jobId) {
  const jobDir = getJobDir(jobId);
  return {
    jobDir,
    statusPath: path.join(jobDir, "status.json"),
    jobMetaPath: path.join(jobDir, "job_meta.json"),
    jobContextPath: path.join(jobDir, "job_context.json"),
    knowledgeSnapshotPath: path.join(jobDir, "knowledge_snapshot.json"),
    progressPath: path.join(jobDir, "progress.jsonl"),
    promptPath: path.join(jobDir, "codex_prompt.md"),
    contentPath: path.join(jobDir, "tailored_content.json"),
    stdoutPath: path.join(jobDir, "codex_stdout.log"),
    stderrPath: path.join(jobDir, "codex_stderr.log")
  };
}

function enqueueTailoringJob(record) {
  queuedTailoringJobs.set(record.job.jobId, record);
  tailoringQueue.push(record.job.jobId);
  updateQueuedTailoringStatuses();
  drainTailoringQueue();
}

function drainTailoringQueue() {
  if (runningJobs.size > 0) {
    return;
  }

  while (tailoringQueue.length > 0) {
    const jobId = tailoringQueue.shift();
    const record = queuedTailoringJobs.get(jobId);
    if (!record) {
      continue;
    }

    queuedTailoringJobs.delete(jobId);
    const runStartedAt = Date.now();
    runningJobs.set(jobId, {
      child: null,
      startedAt: new Date(runStartedAt).toISOString(),
      statusPath: record.statusPath
    });
    updateQueuedTailoringStatuses();
    runTailoringJob(record, runStartedAt).finally(() => {
      runningJobs.delete(jobId);
      updateQueuedTailoringStatuses();
      drainTailoringQueue();
    });
    return;
  }
}

async function runTailoringJob(record, runStartedAt) {
  const jobId = record.job.jobId;
  markStatus(jobId, {
    status: "running",
    progressMessage: "Launching Codex.",
    updatedAt: nowIso(),
    activeJobId: jobId,
    queuePosition: 0,
    validationErrors: [],
    validationWarnings: [],
    repairAttemptCount: 0,
    error: ""
  });
  appendProgress(jobId, "Launching Codex.");

  let repairAttemptCount = 0;
  let lastErrors = [];
  let lastRawOutput = "";
  let lastContent = null;

  for (let attempt = 0; attempt <= MAX_TAILOR_REPAIR_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 0
      ? record.prompt
      : buildTailorRepairPrompt({
        job: record.job,
        originalPrompt: record.prompt,
        previousContent: lastContent,
        rawOutput: lastRawOutput,
        errors: lastErrors
      });
    if (attempt > 0) {
      repairAttemptCount = attempt;
      markStatus(jobId, {
        progressMessage: "Repairing tailored content JSON.",
        repairAttemptCount,
        validationErrors: lastErrors,
        updatedAt: nowIso()
      });
      appendProgress(jobId, "Repairing tailored content JSON.");
    }

    const result = await runCodexProcess(jobId, record, prompt, attempt);
    lastRawOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.error) {
      failTailoringJob(jobId, {
        exitCode: result.code,
        error: result.error,
        validationErrors: [result.error],
        repairAttemptCount
      });
      return;
    }
    if (result.code !== 0) {
      const message = `Codex exited with code ${result.code}. ${visibleTextSnippet(result.stderr || result.stdout, 600)}`;
      failTailoringJob(jobId, {
        exitCode: result.code,
        error: message,
        validationErrors: [message],
        repairAttemptCount
      });
      return;
    }

    try {
      lastContent = extractTailorContentJson(lastRawOutput);
      lastErrors = validateTailorContent(lastContent, record.job);
    } catch (error) {
      lastContent = null;
      lastErrors = [getErrorMessage(error)];
    }

    if (lastErrors.length === 0) {
      try {
        writeJson(record.contentPath, lastContent);
        appendProgress(jobId, "Generating deterministic DOCX files.");
        generateTailoredDocxFiles(lastContent, record);
        appendProgress(jobId, "Validating generated DOCX files.");
        lastErrors = collectResumeOutputErrors(jobId, record.jobDir, runStartedAt);
      } catch (error) {
        lastErrors = [getErrorMessage(error)];
      }
    }

    if (lastErrors.length === 0) {
      const validationWarnings = collectResumeOutputWarnings(jobId, record.jobDir);
      appendProgress(jobId, "Resume and cover letter documents are ready.");
      for (const warning of validationWarnings) {
        appendProgress(jobId, `Validation warning: ${warning}`);
      }
      markStatus(jobId, {
        status: "ready",
        exitCode: result.code,
        progressMessage: "Documents are ready for review.",
        updatedAt: nowIso(),
        artifacts: discoverArtifacts(record.jobDir, []),
        documentCount: 2,
        queuePosition: 0,
        activeJobId: "",
        validationErrors: [],
        validationWarnings,
        repairAttemptCount,
        error: ""
      });
      return;
    }
  }

  failTailoringJob(jobId, {
    exitCode: 0,
    error: `Tailoring validation failed: ${lastErrors.join("; ")}`,
    validationErrors: lastErrors,
    repairAttemptCount
  });
}

function runCodexProcess(jobId, record, prompt, attempt) {
  return new Promise((resolve) => {
    const command = fs.existsSync(CODEX_BIN) ? CODEX_BIN : "codex";
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--full-auto",
      "-C",
      WORKSPACE_ROOT,
      "-c",
      "mcp_servers={}",
      prompt
    ];
    const flags = attempt === 0 ? "w" : "a";
    const stdoutStream = fs.createWriteStream(record.stdoutPath, { flags });
    const stderrStream = fs.createWriteStream(record.stderrPath, { flags });
    if (attempt > 0) {
      stdoutStream.write(`\n\n--- repair attempt ${attempt} stdout ---\n`);
      stderrStream.write(`\n\n--- repair attempt ${attempt} stderr ---\n`);
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const active = runningJobs.get(jobId);
      if (active) {
        runningJobs.set(jobId, { ...active, child });
      }
    } catch (error) {
      stdoutStream.end();
      stderrStream.end();
      resolve({ code: null, stdout: "", stderr: "", error: getErrorMessage(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutStream.write(chunk);
      stdout = appendLimitedTailorOutput(stdout, text);
      stdoutBuffer = captureProgressFromOutput(jobId, stdoutBuffer + text, "codex");
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrStream.write(chunk);
      stderr = appendLimitedTailorOutput(stderr, text);
    });

    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr, error: getErrorMessage(error) });
    });

    child.on("close", (code) => {
      stdoutStream.end();
      stderrStream.end();
      resolve({ code, stdout, stderr, error: "" });
    });
  });
}

function failTailoringJob(jobId, details) {
  const validationErrors = Array.isArray(details.validationErrors) ? details.validationErrors.filter(Boolean) : [];
  const error = details.error || validationErrors.join("; ") || "Codex run failed.";
  appendProgress(jobId, error);
  markStatus(jobId, {
    status: "failed",
    exitCode: details.exitCode,
    progressMessage: "Codex run failed.",
    updatedAt: nowIso(),
    queuePosition: 0,
    activeJobId: "",
    validationErrors,
    validationWarnings: [],
    repairAttemptCount: Number(details.repairAttemptCount || 0),
    error
  });
}

function getQueuedTailoringJobIds() {
  return tailoringQueue.filter((jobId) => queuedTailoringJobs.has(jobId));
}

function getActiveTailoringJobId() {
  return Array.from(runningJobs.keys())[0] || "";
}

function getTailoringQueuePosition(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized || !queuedTailoringJobs.has(normalized)) {
    return 0;
  }
  const index = getQueuedTailoringJobIds().indexOf(normalized);
  return index < 0 ? 0 : Math.max(1, runningJobs.size + index);
}

function updateQueuedTailoringStatuses() {
  const activeJobId = getActiveTailoringJobId();
  for (const jobId of getQueuedTailoringJobIds()) {
    const queuePosition = getTailoringQueuePosition(jobId);
    markStatus(jobId, {
      status: "queued",
      progressMessage: `Queued behind ${queuePosition} tailoring run(s).`,
      updatedAt: nowIso(),
      queuePosition,
      activeJobId
    });
  }
}

function appendLimitedTailorOutput(current, next) {
  const combined = `${current || ""}${next || ""}`;
  return combined.length > TAILOR_OUTPUT_LIMIT
    ? combined.slice(combined.length - TAILOR_OUTPUT_LIMIT)
    : combined;
}

function getApplicationStatus(jobId) {
  const jobDir = getJobDir(jobId);
  const jobContext = readJobContext(jobId);
  const jobMeta = readJobMeta(jobId);
  const processedOnly = Boolean(jobContext);
  const savedStatus = readStatus(jobId);
  const knowledgeStatus = processedOnly || savedStatus && savedStatus.knowledge
    ? getKnowledgeStatusForJob(readKnowledgeBase(), jobId, 0)
    : null;
  const jobDisposition = normalizeJobDisposition(jobMeta.disposition);
  const status = savedStatus || {
    schemaVersion: 1,
    jobId,
    title: processedOnly ? String(jobContext.title || "") : String(jobMeta.title || ""),
    status: processedOnly ? "processed" : "not_started",
    jobDir,
    updatedAt: processedOnly ? jobContext.timestamp || null : jobMeta.updatedAt || null,
    artifacts: [],
    documentCount: 0,
    knowledge: knowledgeStatus,
    error: ""
  };

  const running = runningJobs.has(jobId);
  const queued = queuedTailoringJobs.has(jobId);
  const artifacts = discoverArtifacts(jobDir, status.artifacts);
  const documentCount = countReadyDocuments(jobDir);
  const progressEvents = readProgressEvents(jobId);
  const pendingKnowledgeForJobCount = Number(knowledgeStatus && knowledgeStatus.pendingForJobCount || 0);

  if (!running && !queued && ["queued", "running"].includes(status.status)) {
    const validationError = hasRequiredReadyFiles(jobDir) ? validateResumeOutput(jobId, jobDir) : "";
    if (hasRequiredReadyFiles(jobDir) && !validationError) {
      const validationWarnings = collectResumeOutputWarnings(jobId, jobDir);
      const updatedAt = new Date().toISOString();
      appendProgress(jobId, "Recovered existing resume and cover letter documents as ready.");
      const recovered = {
        ...status,
        jobId,
        jobDir,
        status: "ready",
        updatedAt,
        artifacts,
        documentCount: 2,
        knowledge: knowledgeStatus || status.knowledge || null,
        progressMessage: "Documents are ready for review.",
        progressEvents,
        validationWarnings,
        error: ""
      };
      markStatus(jobId, {
        status: "ready",
        progressMessage: "Documents are ready for review.",
        updatedAt,
        artifacts,
        documentCount: 2,
        validationWarnings,
        error: ""
      });
      return recovered;
    }

    const interrupted = {
      ...status,
      jobId,
      jobDir,
      status: "failed",
      artifacts,
      documentCount,
      knowledge: knowledgeStatus || status.knowledge || null,
      progressMessage: "Tailoring run was interrupted.",
      progressEvents,
      error: validationError || "The bridge restarted or the Codex process stopped before creating valid resume and cover letter DOCX files."
    };
    markStatus(jobId, {
      status: "failed",
      progressMessage: "Tailoring run was interrupted.",
      artifacts,
      documentCount,
      error: interrupted.error
    });
    return interrupted;
  }

  if (!running && isRecoverableFailedStatus(status) && hasRequiredReadyFiles(jobDir)) {
    const validationError = validateResumeOutput(jobId, jobDir);
    if (!validationError) {
      const validationWarnings = collectResumeOutputWarnings(jobId, jobDir);
      const updatedAt = new Date().toISOString();
      appendProgress(jobId, "Recovered existing resume and cover letter documents as ready.");
      const recovered = {
        ...status,
        jobId,
        jobDir,
        status: "ready",
        updatedAt,
        artifacts,
        documentCount: 2,
        knowledge: knowledgeStatus || status.knowledge || null,
        progressMessage: "Documents are ready for review.",
        progressEvents,
        validationWarnings,
        error: ""
      };
      markStatus(jobId, {
        status: "ready",
        progressMessage: "Documents are ready for review.",
        updatedAt,
        artifacts,
        documentCount: 2,
        validationWarnings,
        error: ""
      });
      return recovered;
    }
  }

  const normalizedStatus = getNormalizedApplicationStatus({
    status: status.status,
    running,
    queued,
    pendingKnowledgeForJobCount
  });
  const queuePosition = getTailoringQueuePosition(jobId);
  const normalized = {
    ...status,
    jobId,
    jobDir,
    title: status.title || (jobContext && jobContext.title) || jobMeta.title || "",
    url: (jobContext && jobContext.url) || jobMeta.url || "",
    pageTitle: (jobContext && jobContext.pageTitle) || jobMeta.pageTitle || "",
    jobDisposition,
    jobDispositionLabel: getJobDispositionLabel(jobDisposition),
    jobDispositionUpdatedAt: jobMeta.dispositionUpdatedAt || "",
    status: normalizedStatus,
    artifacts,
    documentCount,
    queuePosition,
    activeJobId: getActiveTailoringJobId(),
    knowledge: knowledgeStatus || status.knowledge || null,
    progressMessage: jobDisposition
      ? `Marked ${getJobDispositionLabel(jobDisposition)}.`
      : getApplicationProgressMessage({
        status,
        normalizedStatus,
        progressEvents
      }),
    progressEvents
  };

  if (normalized.status === "ready" && !hasRequiredReadyFiles(jobDir)) {
    return {
      ...normalized,
      status: "failed",
      progressMessage: "Ready check failed.",
      error: `Codex marked this job ready, but ${RESUME_FILE_NAME} or ${COVER_LETTER_FILE_NAME} is missing.`
    };
  }

  return normalized;
}

function getNormalizedApplicationStatus({ status, running, queued, pendingKnowledgeForJobCount }) {
  if (queued) {
    return "queued";
  }

  if (running && !["ready", "failed"].includes(status)) {
    return "running";
  }

  if (!["ready", "failed", "queued", "running"].includes(status) && pendingKnowledgeForJobCount > 0) {
    return "needs_review_of_skills";
  }

  return status;
}

function isRecoverableFailedStatus(status) {
  if (!status || status.status !== "failed") {
    return false;
  }

  if (status.exitCode === 0) {
    return true;
  }

  return /Resume relevance check failed|role title check failed/i.test(String(status.error || ""));
}

function getApplicationProgressMessage({ status, normalizedStatus, progressEvents }) {
  if (normalizedStatus !== status.status) {
    return defaultProgressMessage(normalizedStatus);
  }

  return status.progressMessage || getLastProgressMessage(progressEvents) || defaultProgressMessage(status.status);
}

function getKnownApplicationStatuses(requestedJobIds = []) {
  const knownJobIds = new Set();
  const normalizedRequestedJobIds = requestedJobIds.map(normalizeJobId).filter(Boolean);

  if (normalizedRequestedJobIds.length > 0) {
    for (const jobId of normalizedRequestedJobIds) {
      if (hasKnownApplication(jobId)) {
        knownJobIds.add(jobId);
      }
    }
  } else {
    if (fs.existsSync(APPLICATION_OUTPUT_DIR)) {
      for (const entry of fs.readdirSync(APPLICATION_OUTPUT_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        const jobId = normalizeJobId(entry.name);
        if (jobId && hasKnownApplication(jobId)) {
          knownJobIds.add(jobId);
        }
      }
    }
  }

  for (const jobId of runningJobs.keys()) {
    if (normalizedRequestedJobIds.length === 0 || normalizedRequestedJobIds.includes(jobId)) {
      knownJobIds.add(jobId);
    }
  }
  for (const jobId of queuedTailoringJobs.keys()) {
    if (normalizedRequestedJobIds.length === 0 || normalizedRequestedJobIds.includes(jobId)) {
      knownJobIds.add(jobId);
    }
  }

  return Array.from(knownJobIds).sort().map((jobId) => getApplicationStatus(jobId));
}

function hasKnownApplication(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    return false;
  }

  const jobDir = getJobDir(normalized);
  return (
    runningJobs.has(normalized) ||
    queuedTailoringJobs.has(normalized) ||
    fs.existsSync(path.join(jobDir, "job_meta.json")) ||
    fs.existsSync(path.join(jobDir, "job_context.json")) ||
    fs.existsSync(path.join(jobDir, "status.json")) ||
    countReadyDocuments(jobDir) > 0
  );
}

function openApplicationArtifacts(body) {
  const jobId = normalizeJobId(body && body.jobId);
  if (!jobId) {
    throw new Error("Missing JR job ID.");
  }

  const jobDir = getJobDir(jobId);
  const files = [
    getResumeFilePath(jobDir),
    getCoverLetterFilePath(jobDir)
  ];
  const missing = files.filter((filePath) => !fs.existsSync(filePath));

  if (missing.length > 0) {
    throw new Error(`Documents for ${jobId} are not ready yet.`);
  }

  const child = spawn(getFileOpenCommand(), files, {
    cwd: WORKSPACE_ROOT,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return files;
}

function getApplicationResumeForUpload(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    throw new Error("Missing JR job ID.");
  }

  const resumePath = getResumeFilePath(getJobDir(normalized));
  if (!fs.existsSync(resumePath)) {
    throw new Error(`Tailored resume for ${normalized} is not ready yet.`);
  }

  const stat = fs.statSync(resumePath);
  const maxUploadBytes = 5 * 1024 * 1024;
  if (stat.size > maxUploadBytes) {
    throw new Error(`Tailored resume for ${normalized} is larger than the application portal's 5MB upload limit.`);
  }

  return {
    jobId: normalized,
    fileName: path.basename(resumePath),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: stat.size,
    path: resumePath,
    base64: fs.readFileSync(resumePath).toString("base64")
  };
}

function getApplicationUploadPackage(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    throw new Error("Missing JR job ID.");
  }
  const resumeProfile = extractWorkdayResumeProfileForJob(normalized);

  return {
    jobId: normalized,
    files: [
      getApplicationFileForUpload(normalized, "resume-docx", RESUME_FILE_NAME, LEGACY_RESUME_FILE_PATTERN),
      getApplicationFileForUpload(normalized, "cover-letter-docx", COVER_LETTER_FILE_NAME, LEGACY_COVER_LETTER_FILE_PATTERN)
    ],
    skills: resumeProfile.skillsText,
    resumeProfile
  };
}

function getApplicationFileForUpload(jobId, kind, fileName, legacyFilePattern = null) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    throw new Error("Missing JR job ID.");
  }

  const filePath = findApplicationFilePath(getJobDir(normalized), fileName, legacyFilePattern);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${fileName} for ${normalized} is not ready yet.`);
  }

  const stat = fs.statSync(filePath);
  const maxUploadBytes = 5 * 1024 * 1024;
  if (stat.size > maxUploadBytes) {
    throw new Error(`${fileName} for ${normalized} is larger than the application portal's 5MB upload limit.`);
  }

  return {
    jobId: normalized,
    kind,
    fileName: path.basename(filePath),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: stat.size,
    path: filePath,
    base64: fs.readFileSync(filePath).toString("base64")
  };
}

function extractWorkdaySkillsForJob(jobId) {
  const resumePath = getResumeFilePath(getJobDir(jobId));
  const resumeText = extractDocxText(resumePath);
  return extractWorkdaySkillsFromResumeText(resumeText);
}

function extractWorkdayResumeProfileForJob(jobId) {
  const resumePath = getResumeFilePath(getJobDir(jobId));
  const resumeText = extractDocxText(resumePath);
  const skillsText = extractWorkdaySkillsFromResumeText(resumeText);

  return {
    schemaVersion: 1,
    source: "generated_resume_docx",
    skillsText,
    education: parseResumeEducationForWorkday(resumeText),
    experiences: parseResumeExperiencesForWorkday(resumeText)
  };
}

function extractWorkdaySkillsFromResumeText(resumeText) {
  const section = extractResumeSectionText(resumeText, "TECHNICAL SKILLS", ["EDUCATION"]);
  if (!section) {
    return "";
  }

  const skills = [];
  const seen = new Set();
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    const withoutLabel = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
    const parts = withoutLabel.split(/,\s*|;\s*/).map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const cleaned = part.replace(/[.;]+$/g, "").trim();
      const key = normalizeKnowledgeText(cleaned);
      if (!cleaned || !key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      skills.push(cleaned);
    }
  }

  return skills.slice(0, 35).join(", ").slice(0, 1200);
}

function parseResumeEducationForWorkday(resumeText) {
  const section = extractResumeSectionText(resumeText, "EDUCATION", [
    "PROFESSIONAL EXPERIENCE",
    "VOLUNTEERING EXPERIENCE"
  ]);
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const items = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsedLine = parseResumeHeadingWithDateRange(line);
    if (!parsedLine) {
      continue;
    }

    const parsedEducation = parseResumeEducationHeading(parsedLine.title, lines[index + 1] || "");
    const degreeFull = parsedEducation.degreeFull;
    const school = parsedEducation.school;
    const fieldOfStudy = inferFieldOfStudyFromDegree(degreeFull);
    items.push({
      degreeFull,
      degree: inferDegreeLabel(degreeFull),
      fieldOfStudy,
      school,
      startMonth: parsedLine.start.month,
      startYear: parsedLine.start.year,
      endMonth: parsedLine.end.month,
      endYear: parsedLine.end.year,
      expectedGraduationYear: parsedLine.end.year || null
    });
  }

  return items;
}

function parseResumeEducationHeading(heading, nextLine) {
  const parts = splitResumeHeadingParts(heading);
  if (parts.length >= 2) {
    return {
      degreeFull: parts[0],
      school: parts.slice(1).join(" | ")
    };
  }

  return {
    degreeFull: String(heading || "").trim(),
    school: isResumeSectionHeading(nextLine) ? "" : String(nextLine || "").trim()
  };
}

function parseResumeExperiencesForWorkday(resumeText) {
  const sections = getResumeExperienceSectionsInDocumentOrder(resumeText);
  const experiences = [];

  for (const section of sections) {
    const lines = section.text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    let current = null;

    for (const line of lines) {
      const parsedLine = parseResumeHeadingWithDateRange(line);
      if (parsedLine) {
        if (current) {
          experiences.push(finalizeResumeExperience(current));
        }
        current = {
          section: section.name,
          heading: parsedLine.title,
          ...parseResumeExperienceHeading(parsedLine.title),
          startMonth: parsedLine.start.month,
          startYear: parsedLine.start.year,
          endMonth: parsedLine.end.month,
          endYear: parsedLine.end.year,
          bullets: []
        };
        continue;
      }

      if (current && /^[-*]\s+/.test(line)) {
        current.bullets.push(line.replace(/^[-*]\s+/, "").trim());
      }
    }

    if (current) {
      experiences.push(finalizeResumeExperience(current));
    }
  }

  return experiences;
}

function getResumeExperienceSectionsInDocumentOrder(resumeText) {
  const headings = ["PROFESSIONAL EXPERIENCE", "VOLUNTEERING EXPERIENCE"];
  const lines = String(resumeText || "").split(/\r?\n/);
  return headings
    .map((heading) => {
      const normalizedHeading = normalizeKnowledgeText(heading);
      const lineIndex = lines.findIndex((line) => normalizeKnowledgeText(line) === normalizedHeading);
      return {
        name: heading,
        lineIndex,
        text: extractResumeSectionText(
          resumeText,
          heading,
          headings.filter((candidate) => candidate !== heading)
        )
      };
    })
    .filter((section) => section.lineIndex >= 0)
    .sort((a, b) => a.lineIndex - b.lineIndex)
    .map(({ name, text }) => ({ name, text }));
}

function finalizeResumeExperience(experience) {
  const bullets = Array.isArray(experience.bullets) ? experience.bullets.filter(Boolean) : [];
  return {
    section: experience.section,
    heading: experience.heading,
    organization: experience.organization,
    organizationFull: experience.organizationFull || experience.organization,
    location: experience.location || "",
    jobTitle: experience.jobTitle,
    startMonth: experience.startMonth,
    startYear: experience.startYear,
    endMonth: experience.endMonth,
    endYear: experience.endYear,
    description: bullets.map((bullet, index) => index === 0 ? bullet : `- ${bullet}`).join("\n")
  };
}

function parseResumeExperienceHeading(value) {
  const heading = String(value || "").trim();
  const colonIndex = heading.lastIndexOf(":");
  if (colonIndex < 0) {
    const organization = parseResumeOrganizationAndLocation(heading);
    return {
      ...organization,
      jobTitle: heading
    };
  }

  const organization = parseResumeOrganizationAndLocation(heading.slice(0, colonIndex).trim());
  return {
    ...organization,
    jobTitle: heading.slice(colonIndex + 1).trim()
  };
}

function splitResumeHeadingParts(value) {
  return String(value || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isResumeSectionHeading(value) {
  const normalized = normalizeKnowledgeText(value);
  return [
    "technical skills",
    "education",
    "professional experience",
    "volunteering experience",
    "volunteer experience",
    "projects"
  ].includes(normalized);
}

function parseResumeOrganizationAndLocation(value) {
  const full = String(value || "").trim();
  const parts = full.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return {
      organization: full,
      organizationFull: full,
      location: ""
    };
  }

  return {
    organization: parts[0],
    organizationFull: full,
    location: parts.slice(1).join(", ")
  };
}

function parseResumeHeadingWithDateRange(line) {
  const match = String(line || "").match(
    /^(.*?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z.]*\s+\d{4})\s*[-–]\s*((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z.]*\s+\d{4})|Present)$/i
  );
  if (!match) {
    return null;
  }

  const start = parseResumeMonthYear(match[2]);
  const end = parseResumeMonthYear(match[3]);
  if (!start.year) {
    return null;
  }

  return {
    title: match[1].replace(/\s*\|\s*$/g, "").trim(),
    start,
    end
  };
}

function parseResumeMonthYear(value) {
  const raw = String(value || "").trim();
  if (/^present$/i.test(raw)) {
    return { month: null, year: null, present: true };
  }

  const match = raw.match(/^([A-Za-z.]+)\s+(\d{4})$/);
  if (!match) {
    return { month: null, year: null, present: false };
  }

  return {
    month: monthNameToNumber(match[1]),
    year: Number(match[2]),
    present: false
  };
}

function monthNameToNumber(value) {
  const normalized = String(value || "").toLowerCase().replace(/\./g, "").slice(0, 3);
  return {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  }[normalized] || null;
}

function inferFieldOfStudyFromDegree(degreeFull) {
  const match = String(degreeFull || "").match(/\bin\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function inferDegreeLabel(degreeFull) {
  const normalized = normalizeKnowledgeText(degreeFull);
  if (/\bmaster/.test(normalized)) {
    return "Master";
  }
  if (/\bbachelor/.test(normalized)) {
    return "Bachelor";
  }
  return String(degreeFull || "").trim();
}

function getFileOpenCommand() {
  if (process.platform === "darwin") {
    return "open";
  }

  if (process.platform === "win32") {
    return "start";
  }

  return "xdg-open";
}

function readStatus(jobId) {
  const statusPath = path.join(getJobDir(jobId), "status.json");
  if (!fs.existsSync(statusPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch (error) {
    return {
      schemaVersion: 1,
      jobId,
    title: "",
    status: "failed",
    jobDir: getJobDir(jobId),
    updatedAt: new Date().toISOString(),
    artifacts: [],
    documentCount: 0,
    error: `Could not parse status.json: ${getErrorMessage(error)}`
  };
  }
}

function readJobMeta(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    return createDefaultJobMeta("");
  }

  const metaPath = path.join(getJobDir(normalized), "job_meta.json");
  if (!fs.existsSync(metaPath)) {
    return createDefaultJobMeta(normalized);
  }

  try {
    return normalizeJobMeta(JSON.parse(fs.readFileSync(metaPath, "utf8")), normalized);
  } catch (_error) {
    return createDefaultJobMeta(normalized);
  }
}

function writeJobMeta(jobId, meta) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    throw new Error("Missing JR job ID.");
  }
  writeJson(path.join(getJobDir(normalized), "job_meta.json"), normalizeJobMeta(meta, normalized));
}

function createDefaultJobMeta(jobId) {
  return {
    schemaVersion: 1,
    jobId: normalizeJobId(jobId),
    title: "",
    url: "",
    pageTitle: "",
    disposition: "",
    dispositionLabel: "",
    dispositionUpdatedAt: "",
    appliedAt: "",
    dontQualifyAt: "",
    updatedAt: ""
  };
}

function normalizeJobMeta(raw, fallbackJobId) {
  const source = raw && typeof raw === "object" ? raw : {};
  const disposition = normalizeJobDisposition(source.disposition || source.status || "");
  return {
    ...createDefaultJobMeta(fallbackJobId),
    schemaVersion: 1,
    jobId: normalizeJobId(source.jobId) || normalizeJobId(fallbackJobId),
    title: cleanKnowledgeText(source.title || "", 180),
    url: String(source.url || ""),
    pageTitle: cleanKnowledgeText(source.pageTitle || "", 220),
    disposition,
    dispositionLabel: getJobDispositionLabel(disposition),
    dispositionUpdatedAt: source.dispositionUpdatedAt || "",
    appliedAt: source.appliedAt || "",
    dontQualifyAt: source.dontQualifyAt || "",
    updatedAt: source.updatedAt || source.dispositionUpdatedAt || ""
  };
}

function markStatus(jobId, patch) {
  const jobDir = getJobDir(jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const statusPath = path.join(jobDir, "status.json");
  const current = readStatus(jobId) || {
    schemaVersion: 1,
    jobId,
    title: "",
    status: "not_started",
    jobDir,
    artifacts: [],
    documentCount: 0,
    error: ""
  };

  writeJson(statusPath, {
    ...current,
    ...patch,
    jobId,
    jobDir
  });
}

function appendProgress(jobId, message, source = "bridge") {
  const normalized = normalizeProgressMessage(message);
  if (!normalized) {
    return;
  }

  const jobDir = getJobDir(jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const event = {
    at: new Date().toISOString(),
    source,
    message: normalized
  };
  fs.appendFileSync(path.join(jobDir, "progress.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

function captureProgressFromOutput(jobId, bufferedText, source) {
  const lines = bufferedText.split(/\r?\n/);
  const remainder = lines.pop() || "";

  for (const line of lines) {
    const raw = stripAnsi(line);
    if (!raw.trim().toUpperCase().startsWith(TAILOR_PROGRESS_MARKER)) {
      continue;
    }
    const message = normalizeProgressMessage(raw.trim().slice(TAILOR_PROGRESS_MARKER.length));
    if (!message || shouldIgnoreCodexOutput(message)) {
      continue;
    }
    appendProgress(jobId, message, source);
    markStatus(jobId, {
      progressMessage: message,
      updatedAt: new Date().toISOString()
    });
  }

  return remainder;
}

function readProgressEvents(jobId) {
  const progressPath = path.join(getJobDir(jobId), "progress.jsonl");
  if (!fs.existsSync(progressPath)) {
    return [];
  }

  try {
    return fs.readFileSync(progressPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .map((line) => JSON.parse(line))
      .filter((event) => event && event.message);
  } catch (_error) {
    return [];
  }
}

function getLastProgressMessage(events) {
  const last = Array.isArray(events) && events.length > 0 ? events[events.length - 1] : null;
  return last ? last.message : "";
}

function defaultProgressMessage(status) {
  if (status === "ready") {
    return "Ready for review.";
  }

  if (status === "running") {
    return "Codex is working.";
  }

  if (status === "queued") {
    return "Queued Codex tailoring run.";
  }

  if (status === "processed") {
    return "Job post processed. Review pending skills and stories.";
  }

  if (status === "needs_review_of_skills") {
    return "Needs review of skills for this job.";
  }

  return "";
}

function normalizeProgressMessage(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function shouldIgnoreCodexOutput(message) {
  return (
    message.length < 6 ||
    /^[{}[\],:"0-9.\s-]+$/.test(message) ||
    /^(content-length|debug|trace):/i.test(message)
  );
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function discoverArtifacts(jobDir, existingArtifacts) {
  const artifacts = [];
  const known = [
    ["resume-docx", RESUME_FILE_NAME, LEGACY_RESUME_FILE_PATTERN],
    ["cover-letter-docx", COVER_LETTER_FILE_NAME, LEGACY_COVER_LETTER_FILE_PATTERN]
  ];
  const seen = new Set(artifacts.map((artifact) => artifact && artifact.path).filter(Boolean));

  for (const [kind, fileName, legacyFilePattern] of known) {
    const artifactPath = findApplicationFilePath(jobDir, fileName, legacyFilePattern);
    if (fs.existsSync(artifactPath) && !seen.has(artifactPath)) {
      artifacts.push({ kind, path: artifactPath });
      seen.add(artifactPath);
    }
  }

  return artifacts;
}

function hasRequiredReadyFiles(jobDir, minimumMtimeMs = 0) {
  return [
    [RESUME_FILE_NAME, LEGACY_RESUME_FILE_PATTERN],
    [COVER_LETTER_FILE_NAME, LEGACY_COVER_LETTER_FILE_PATTERN]
  ].every(([fileName, legacyFilePattern]) => {
    const filePath = findApplicationFilePath(jobDir, fileName, legacyFilePattern);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    return minimumMtimeMs === 0 || fs.statSync(filePath).mtimeMs >= minimumMtimeMs;
  });
}

function countReadyDocuments(jobDir) {
  return [
    [RESUME_FILE_NAME, LEGACY_RESUME_FILE_PATTERN],
    [COVER_LETTER_FILE_NAME, LEGACY_COVER_LETTER_FILE_PATTERN]
  ]
    .filter(([fileName, legacyFilePattern]) => fs.existsSync(findApplicationFilePath(jobDir, fileName, legacyFilePattern)))
    .length;
}

function getPossibleApplicationFilePaths(jobDir) {
  return [
    path.join(jobDir, RESUME_FILE_NAME),
    path.join(jobDir, COVER_LETTER_FILE_NAME),
    ...findApplicationFilesByPattern(jobDir, LEGACY_RESUME_FILE_PATTERN),
    ...findApplicationFilesByPattern(jobDir, LEGACY_COVER_LETTER_FILE_PATTERN)
  ];
}

function getResumeFilePath(jobDir) {
  return findApplicationFilePath(jobDir, RESUME_FILE_NAME, LEGACY_RESUME_FILE_PATTERN);
}

function getCoverLetterFilePath(jobDir) {
  return findApplicationFilePath(jobDir, COVER_LETTER_FILE_NAME, LEGACY_COVER_LETTER_FILE_PATTERN);
}

function findApplicationFilePath(jobDir, preferredFileName, legacyFilePattern = null) {
  const preferredPath = path.join(jobDir, preferredFileName);
  if (fs.existsSync(preferredPath)) {
    return preferredPath;
  }
  const legacyFiles = findApplicationFilesByPattern(jobDir, legacyFilePattern);
  if (legacyFiles.length > 0) {
    return legacyFiles[0];
  }
  return preferredPath;
}

function findApplicationFilesByPattern(jobDir, pattern) {
  if (!pattern || !fs.existsSync(jobDir)) {
    return [];
  }
  try {
    return fs.readdirSync(jobDir)
      .filter((fileName) => pattern.test(fileName))
      .map((fileName) => path.join(jobDir, fileName));
  } catch (_error) {
    return [];
  }
}

function validateResumeOutput(jobId, jobDir) {
  const errors = collectResumeOutputErrors(jobId, jobDir, 0);
  return errors.length > 0 ? errors.join("; ") : "";
}

function collectResumeOutputErrors(_jobId, jobDir, minimumMtimeMs = 0) {
  const errors = [];
  for (const [fileName, legacyFileNames] of [
    [RESUME_FILE_NAME, LEGACY_RESUME_FILE_PATTERN],
    [COVER_LETTER_FILE_NAME, LEGACY_COVER_LETTER_FILE_PATTERN]
  ]) {
    const filePath = findApplicationFilePath(jobDir, fileName, legacyFileNames);
    if (!fs.existsSync(filePath)) {
      errors.push(`${fileName} is missing`);
      continue;
    }
    if (minimumMtimeMs > 0 && fs.statSync(filePath).mtimeMs < minimumMtimeMs) {
      errors.push(`${fileName} was not regenerated for this run`);
      continue;
    }
    const zipCheck = spawnSync("unzip", ["-t", filePath], {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      maxBuffer: MAX_BODY_BYTES
    });
    if (zipCheck.error || zipCheck.status !== 0) {
      errors.push(`${fileName} is not a valid DOCX archive`);
    }
  }

  const structureError = validateResumeStructure(jobDir);
  if (structureError) {
    errors.push(structureError);
  }
  return errors;
}

function collectResumeOutputWarnings(jobId, jobDir) {
  const warnings = [];
  const resumePath = getResumeFilePath(jobDir);
  const resumeText = extractDocxText(resumePath);
  if (!resumeText) {
    return warnings;
  }

  const job = readJobContext(jobId);
  if (!job || !isNonProgrammingJob(job)) {
    return warnings;
  }

  const technicalSkillsText = extractResumeSectionText(resumeText, "TECHNICAL SKILLS", [
    "EDUCATION",
    "PROFESSIONAL EXPERIENCE",
    "VOLUNTEERING EXPERIENCE"
  ]);
  const normalizedSkills = normalizeKnowledgeText(technicalSkillsText);
  const normalizedResume = normalizeKnowledgeText(resumeText);
  const forbiddenTerms = getForbiddenProgrammingDetailTermsForJob(job);
  const forbiddenSkillTerms = forbiddenTerms.filter((term) => {
    return containsNormalizedPhrase(normalizedSkills, normalizeKnowledgeText(term));
  });
  const forbiddenResumeTerms = forbiddenTerms.filter((term) => {
    return containsNormalizedPhrase(normalizedResume, normalizeKnowledgeText(term));
  });

  if (/\bgithub\b|github\.com/i.test(resumeText)) {
    warnings.push("contains GitHub");
  }
  if (forbiddenSkillTerms.length > 0) {
    warnings.push(`TECHNICAL SKILLS contains possibly non-relevant programming/developer terms: ${forbiddenSkillTerms.join(", ")}`);
  }
  if (forbiddenResumeTerms.length > 0) {
    warnings.push(`resume contains possibly non-relevant named programming/developer terms: ${forbiddenResumeTerms.join(", ")}`);
  }
  return warnings;
}

function validateResumeRoleTitles(resumeText, expectedTitles) {
  const normalizedResume = normalizeRoleTitleText(resumeText);
  const missing = (expectedTitles || []).filter((title) => {
    const alternatives = Array.isArray(title) ? title : [title];
    return !alternatives.some((alternative) => {
      return normalizedResume.includes(normalizeRoleTitleText(alternative));
    });
  }).map((title) => {
    return Array.isArray(title) ? title[0] : title;
  });
  return missing.length > 0
    ? `role title check failed: missing ${missing.join("; ")}`
    : "";
}

function getForbiddenProgrammingDetailTermsForJob(job) {
  const normalizedJobText = normalizeKnowledgeText(`${job.title || ""}\n${job.description || ""}\n${job.requirements || ""}`);
  const isSupportRole = isTechnicalSupportOrSystemsJob(job);

  return NON_TECH_PROGRAMMING_DETAIL_TERMS.filter((term) => {
    const normalizedTerm = normalizeKnowledgeText(term);
    if (containsNormalizedPhrase(normalizedJobText, normalizedTerm)) {
      return false;
    }
    if (isSupportRole && ["linux", "unix"].includes(normalizedTerm)) {
      return false;
    }
    return true;
  });
}

function validateResumeStructure(jobDir) {
  const resumePath = getResumeFilePath(jobDir);
  const resumeText = extractDocxText(resumePath);
  if (!resumeText) {
    return "Resume structure check failed: could not extract readable text from resume DOCX.";
  }

  const normalized = normalizeStructureText(resumeText);
  const missing = ["TECHNICAL SKILLS", "EDUCATION"]
    .filter((heading) => !normalized.includes(heading));
  if (!normalized.includes("PROFESSIONAL EXPERIENCE") && !normalized.includes("VOLUNTEERING EXPERIENCE")) {
    missing.push("PROFESSIONAL EXPERIENCE or VOLUNTEERING EXPERIENCE");
  }

  const forbidden = [
    "TARGETED SUMMARY",
    "QUALIFICATIONS MATCH",
    "DESIRED QUALIFICATIONS MATCH",
    "RELEVANT EXPERIENCE"
  ].filter((heading) => normalized.includes(heading));

  const issues = [];
  if (missing.length > 0) {
    issues.push(`missing ${missing.join(", ")}`);
  }
  if (forbidden.length > 0) {
    issues.push(`contains disallowed ${forbidden.join(", ")}`);
  }

  return issues.length > 0 ? `Resume structure check failed: ${issues.join("; ")}.` : "";
}

function extractResumeSectionText(text, heading, nextHeadings) {
  const lines = String(text || "").split(/\r?\n/);
  const normalizedHeading = normalizeKnowledgeText(heading);
  const normalizedNextHeadings = new Set((nextHeadings || []).map(normalizeKnowledgeText));
  const output = [];
  let inSection = false;

  for (const line of lines) {
    const normalizedLine = normalizeKnowledgeText(line);
    if (!inSection) {
      if (normalizedLine === normalizedHeading) {
        inSection = true;
      }
      continue;
    }
    if (normalizedNextHeadings.has(normalizedLine)) {
      break;
    }
    output.push(line);
  }

  return output.join("\n");
}

function normalizeRoleTitleText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isTechnicalSupportOrSystemsJob(job) {
  const text = normalizeKnowledgeText(`${job.title || ""}\n${job.description || ""}\n${job.requirements || ""}`);
  const supportSignals = [
    "technical support",
    "tech support",
    "troubleshooting",
    "help desk",
    "device support",
    "personal device",
    "network access",
    "network connectivity",
    "software issue",
    "hardware diagnostics",
    "systems resolutions",
    "identity management",
    "technology issues",
    "digital production support"
  ];
  return supportSignals.some((signal) => {
    return containsNormalizedPhrase(text, normalizeKnowledgeText(signal));
  });
}

function isNonProgrammingJob(job) {
  const text = normalizeKnowledgeText(`${job.title || ""}\n${job.description || ""}\n${job.requirements || ""}`);
  const title = normalizeKnowledgeText(job.title || "");
  const nonProgrammingSignals = [
    "administrative",
    "communications",
    "content",
    "customer service",
    "editing",
    "event",
    "front desk",
    "marketing",
    "office",
    "social media",
    "student support",
    "writing"
  ];
  const programmingSignals = [
    "algorithm",
    "code review",
    "developer",
    "information systems",
    "programming",
    "software engineer",
    "web scraping"
  ];
  const hasNonProgrammingSignal = nonProgrammingSignals.some((signal) => {
    return containsNormalizedPhrase(text, normalizeKnowledgeText(signal));
  });
  const hasProgrammingSignal = programmingSignals.some((signal) => {
    return containsNormalizedPhrase(text, normalizeKnowledgeText(signal));
  });

  return (containsNormalizedPhrase(title, "social media") || hasNonProgrammingSignal) && !hasProgrammingSignal;
}

function extractDocxText(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const result = spawnSync("textutil", ["-convert", "txt", "-stdout", filePath], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_BODY_BYTES
  });

  if (result.error || result.status !== 0) {
    return "";
  }

  return result.stdout || "";
}

function normalizeStructureText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .toUpperCase();
}

function buildCodexPrompt({ job, jobDir, jobContextPath, knowledgeSnapshotPath }) {
  const resumeMarkdownPath = path.join(WORKSPACE_ROOT, "Master Resume.md");
  const resumePdfPath = path.join(WORKSPACE_ROOT, "Master Resume.pdf");
  const resumeOutputPath = path.join(jobDir, RESUME_FILE_NAME);
  const coverLetterPath = path.join(jobDir, COVER_LETTER_FILE_NAME);

  return `You are preparing structured resume and cover-letter content for one student job application: ${job.jobId}.

Inputs:
- Job context JSON: ${jobContextPath}
- Approved knowledge snapshot JSON: ${knowledgeSnapshotPath}
- Master resume Markdown, canonical content source: ${resumeMarkdownPath}
- Master resume PDF, optional context only if you need to understand existing layout: ${resumePdfPath}
- Local application defaults: ${path.join(WORKSPACE_ROOT, "AGENTS.md")}

Goal:
- Read the job description and requirements for ${job.jobId}.
- Prepare high-quality structured content for a tailored resume and cover letter.
- The local bridge will generate DOCX files deterministically. You must not create, edit, render, inspect, or validate any DOCX files.
- Preserve the master resume's truthful facts, dates, employers, schools, role titles, and credentials. You may tighten wording, reorder emphasis, and remove irrelevant detail, but do not invent or disguise the user's background.
- Use these resume sections after the contact header: TECHNICAL SKILLS, EDUCATION, PROFESSIONAL EXPERIENCE, VOLUNTEERING EXPERIENCE. If the master resume has no volunteer experience, use an empty volunteeringExperience array and keep the section order valid.
- Keep the contact header, TECHNICAL SKILLS, and EDUCATION first. After EDUCATION, place the stronger job-matched experience section first: use VOLUNTEERING EXPERIENCE before PROFESSIONAL EXPERIENCE when the volunteer role is the most direct match for the posting. Otherwise keep PROFESSIONAL EXPERIENCE before VOLUNTEERING EXPERIENCE.
- Translate the user's real experience into job-relevant language. Founder, technical, teaching, support, research, volunteer, leadership, or project experience can support broader role language when that angle is truthful and supported by the master resume or approved knowledge.
- Use the approved knowledge snapshot as a job-relevance-filtered, user-approved source of skills and experience stories. Only facts with status "approved" are approved. Pending skill/story items are collection prompts, not claims, so do not state them as the user's experience unless they are also supported by the master resume or another approved source.
- Treat Desired Qualifications as the highest-priority tailoring source, then Essential Duties / job description. The resume bullets should visibly prove the desired qualifications with the user's real experience.
- Think before writing each experience bullet: ask what the user actually did in that position that best proves a desired qualification or essential duty. Mention the matched experience directly in the bullet instead of leaving generic role descriptions.
- Add only job-matched skills inside the TECHNICAL SKILLS section and inside the existing work experience bullets. The heading TECHNICAL SKILLS is inherited from the master resume; it does not mean every technical/programming skill from the master resume should remain.
- Do not keep generic software-engineering bullets when a more relevant truthful angle exists. Translate founder/engineering/community work into audience-facing impact, product storytelling, user engagement, performance metrics, internal coordination, documentation, and support where appropriate.
- Keep roles within each experience section in reverse chronological order. Do not over-index on technical stack/tool names unless the posting asks for those tools or they support an analytics, content, reporting, communication, or collaboration qualification.
- For non-programming roles such as social media, marketing, administration, customer service, event support, tutoring, or communications, omit programming languages, frameworks, databases, blockchain stack names, GitHub, and developer tooling from TECHNICAL SKILLS unless the posting explicitly asks for those exact tools. Prefer role tools and transferable job terms such as social platforms, design tools, office suites, analytics/reporting, writing/editing, project coordination, and communication.
- For those non-programming roles, do not put GitHub in the contact header unless the posting asks for code samples, technical portfolios, repositories, software projects, or developer collaboration. LinkedIn, email, phone, and location are enough.
- Preserve the user's real role titles from the master resume. Do not hide technical, founder, support, or volunteer titles just because the target role is non-technical. Tailor the bullets, not the facts.
- For non-programming roles, you may generalize narrow technical subject details inside bullets when the exact tools are irrelevant, but keep the role honest.
- Do not include exact programming languages or developer tool names anywhere in a non-programming resume unless the posting explicitly requests those exact terms. Keep the truthful signal, but translate it into the job-relevant level of detail.
- Do not include a skill merely because it appears in the master resume or approved knowledge base. Include it only when it directly supports the current job's desired qualifications, essential duties, or named tools.

Rules:
- Use ${job.jobId} as the local storage key. Do not write this application into another job folder.
- Do not create files. Do not call python-docx, LibreOffice, Quick Look, Poppler, textutil, render scripts, package installers, or GUI tools.
- Do not output Markdown, commentary, final notes, code fences, or file links.
- The resume must not introduce new sections such as TARGETED SUMMARY, SUMMARY, PROFILE, QUALIFICATIONS MATCH, DESIRED QUALIFICATIONS MATCH, RELEVANT EXPERIENCE, PROJECTS, CERTIFICATIONS, or ADDITIONAL SKILLS.
- Do not rename PROFESSIONAL EXPERIENCE.
- Do not fabricate credentials, dates, employers, degrees, eligibility, citizenship, demographic data, references, certifications, or Federal Work Study eligibility.
- Do not submit applications, click sites, upload files, or claim the application was submitted.
- The bridge owns status/progress files and will create these final DOCX files: ${resumeOutputPath} and ${coverLetterPath}.

Progress:
- Print short progress lines to stdout, each beginning with ${TAILOR_PROGRESS_MARKER}
- Good examples:
  ${TAILOR_PROGRESS_MARKER} Reading job requirements.
  ${TAILOR_PROGRESS_MARKER} Matching resume experience to the posting.
  ${TAILOR_PROGRESS_MARKER} Drafting resume content.
  ${TAILOR_PROGRESS_MARKER} Drafting cover letter content.

Output:
- After any progress lines, output exactly one JSON object between these markers:
${TAILOR_JSON_BEGIN}
{...}
${TAILOR_JSON_END}
- The JSON object must follow this schema:
{
  "schemaVersion": 1,
  "jobId": "${job.jobId}",
  "resume": {
    "name": "Applicant Name",
    "contactLine": "City, ST | phone | email | LinkedIn",
    "technicalSkills": [
      { "label": "Customer Service & Communication", "items": ["active listening", "issue triage"] }
    ],
    "education": [
      "Degree or Program | School, City, ST | Start Date - End Date"
    ],
    "experienceSectionOrder": ["PROFESSIONAL EXPERIENCE", "VOLUNTEERING EXPERIENCE"],
    "professionalExperience": [
      { "heading": "Organization, Location: Role Title", "dateRange": "Start Date - End Date", "bullets": ["Tailored bullet proving a job requirement with truthful experience."] }
    ],
    "volunteeringExperience": [
      { "heading": "Organization, Location: Volunteer Role", "dateRange": "Start Date - End Date", "bullets": ["Tailored volunteer bullet proving a job requirement with truthful experience."] }
    ]
  },
  "coverLetter": {
    "greeting": "Dear Hiring Committee,",
    "paragraphs": ["I am applying for the role..."],
    "closing": "Sincerely,",
    "signature": "Applicant Name"
  }
}
- Keep resume bullets concise and specific. Prefer 2-4 bullets per role.
- Use ASCII punctuation only.
`;
}

function buildTailorRepairPrompt({ job, originalPrompt, previousContent, rawOutput, errors }) {
  const contentBlock = previousContent
    ? JSON.stringify(previousContent, null, 2)
    : visibleTextSnippet(rawOutput || "", 12000);
  return `${originalPrompt}

Repair task:
The previous structured content failed bridge validation. Output corrected structured JSON only, using the same ${TAILOR_JSON_BEGIN} and ${TAILOR_JSON_END} markers.

Validation errors:
${(errors || []).map((error) => `- ${error}`).join("\n") || "- Unknown validation error"}

Previous content or raw output:
${contentBlock}

Do not create files. Do not use DOCX/rendering tools. Keep all original no-fabrication and section rules.
`;
}

function extractTailorContentJson(output) {
  const text = String(output || "");
  const beginIndex = text.lastIndexOf(TAILOR_JSON_BEGIN);
  const endIndex = text.lastIndexOf(TAILOR_JSON_END);
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
    throw new Error(`Codex output did not contain ${TAILOR_JSON_BEGIN}/${TAILOR_JSON_END} markers.`);
  }

  const rawJson = text.slice(beginIndex + TAILOR_JSON_BEGIN.length, endIndex).trim();
  if (!rawJson) {
    throw new Error("Codex returned empty tailored content JSON.");
  }

  try {
    return JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Codex returned malformed tailored content JSON: ${getErrorMessage(error)}`);
  }
}

function validateTailorContent(content, job) {
  const errors = [];
  if (!content || typeof content !== "object") {
    return ["Tailored content JSON must be an object."];
  }
  if (Number(content.schemaVersion || 0) !== 1) {
    errors.push("Tailored content JSON schemaVersion must be 1.");
  }
  if (normalizeJobId(content.jobId) !== job.jobId) {
    errors.push(`Tailored content JSON jobId must be ${job.jobId}.`);
  }

  const resume = content.resume && typeof content.resume === "object" ? content.resume : null;
  const coverLetter = content.coverLetter && typeof content.coverLetter === "object" ? content.coverLetter : null;
  if (!resume) {
    errors.push("Tailored content JSON is missing resume.");
  }
  if (!coverLetter) {
    errors.push("Tailored content JSON is missing coverLetter.");
  }

  if (resume) {
    if (!cleanKnowledgeText(resume.name || "", 120)) {
      errors.push("Resume name is missing.");
    }
    if (!cleanKnowledgeText(resume.contactLine || "", 300)) {
      errors.push("Resume contactLine is missing.");
    }
    if (!Array.isArray(resume.technicalSkills) || resume.technicalSkills.length === 0) {
      errors.push("Resume technicalSkills must include at least one labeled skill group.");
    }
    const education = normalizeStringArray(resume.education, 8, 300);
    if (education.length === 0) {
      errors.push("Resume education is missing.");
    }
    const sectionOrder = normalizeExperienceSectionOrder(resume.experienceSectionOrder);
    if (sectionOrder.length !== 2) {
      errors.push("Resume experienceSectionOrder must contain PROFESSIONAL EXPERIENCE and VOLUNTEERING EXPERIENCE.");
    }
    const professional = normalizeExperienceItems(resume.professionalExperience);
    const volunteering = normalizeExperienceItems(resume.volunteeringExperience);
    if (professional.length === 0 && volunteering.length === 0) {
      errors.push("Resume must include at least one professional or volunteering experience item.");
    }
    for (const item of professional.concat(volunteering)) {
      if (!item.heading || !item.dateRange || item.bullets.length === 0) {
        errors.push("Each resume experience item must include heading, dateRange, and at least one bullet.");
        break;
      }
    }
    const forbiddenText = normalizeStructureText(JSON.stringify(resume));
    const forbidden = ["TARGETED SUMMARY", "QUALIFICATIONS MATCH", "DESIRED QUALIFICATIONS MATCH", "RELEVANT EXPERIENCE"]
      .filter((heading) => forbiddenText.includes(heading));
    if (forbidden.length > 0) {
      errors.push(`Resume content contains disallowed ${forbidden.join(", ")}.`);
    }
  }

  if (coverLetter) {
    if (!cleanKnowledgeText(coverLetter.greeting || "", 160)) {
      errors.push("Cover letter greeting is missing.");
    }
    const paragraphs = normalizeStringArray(coverLetter.paragraphs, 8, 1800);
    if (paragraphs.length < 3) {
      errors.push("Cover letter must include at least three paragraphs.");
    }
    if (!cleanKnowledgeText(coverLetter.signature || "", 160)) {
      errors.push("Cover letter signature is missing.");
    }
  }

  return uniqueByNormalized(errors).slice(0, 12);
}

function generateTailoredDocxFiles(content, record) {
  if (!fs.existsSync(DOCX_BUILDER_PATH)) {
    throw new Error(`DOCX builder script is missing: ${DOCX_BUILDER_PATH}`);
  }
  const resumeOutputPath = path.join(record.jobDir, RESUME_FILE_NAME);
  const coverLetterPath = path.join(record.jobDir, COVER_LETTER_FILE_NAME);
  const result = spawnSync("python3", [
    DOCX_BUILDER_PATH,
    record.contentPath,
    resumeOutputPath,
    coverLetterPath
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_BODY_BYTES
  });
  if (result.error || result.status !== 0) {
    throw new Error(`DOCX builder failed: ${getErrorMessage(result.error || result.stderr || result.stdout)}`);
  }
}

function normalizeExperienceSectionOrder(value) {
  const order = normalizeStringArray(value, 2, 80)
    .map((item) => item.toUpperCase())
    .filter((item) => item === "PROFESSIONAL EXPERIENCE" || item === "VOLUNTEERING EXPERIENCE");
  return Array.from(new Set(order));
}

function normalizeExperienceItems(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const source = item && typeof item === "object" ? item : {};
      return {
        heading: cleanKnowledgeText(source.heading || "", 240),
        dateRange: cleanKnowledgeText(source.dateRange || "", 80),
        bullets: normalizeStringArray(source.bullets, 6, 260)
      };
    })
    .filter((item) => item.heading || item.dateRange || item.bullets.length > 0)
    .slice(0, 8);
}

function normalizeStringArray(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanKnowledgeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function getKnowledgeBaseForClient() {
  const knowledge = readKnowledgeBase();
  return {
    ...knowledge,
    path: KNOWLEDGE_BASE_PATH,
    summary: getKnowledgeSummary(knowledge)
  };
}

function upsertKnowledgeItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") {
    throw new Error("Knowledge item must be an object.");
  }

  const knowledge = readKnowledgeBase();
  const type = normalizeKnowledgeType(rawItem.type || (rawItem.keyword ? "skill" : "experience"));
  if (type === "skill") {
    upsertSkillItem(knowledge, rawItem);
  } else {
    upsertExperienceItem(knowledge, rawItem);
  }
  writeKnowledgeBase(knowledge);
  return getKnowledgeBaseForClient();
}

function applyKnowledgeAction(body) {
  const action = String(body && body.action ? body.action : "").toLowerCase();
  const type = normalizeKnowledgeType(body && body.type);
  const id = String(body && body.id ? body.id : "");
  if (!["approve", "reject", "pending", "delete"].includes(action)) {
    throw new Error("Knowledge action must be approve, reject, pending, or delete.");
  }
  if (!id) {
    throw new Error("Knowledge action requires an item ID.");
  }

  const knowledge = readKnowledgeBase();
  const collection = type === "skill" ? knowledge.skills : knowledge.experiences;
  const index = collection.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error("Knowledge item was not found.");
  }

  if (action === "delete") {
    collection.splice(index, 1);
  } else {
    const current = collection[index];
    const patch = body && body.patch && typeof body.patch === "object" ? body.patch : {};
    const nextStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      type,
      status: nextStatus,
      updatedAt: nowIso()
    };
    const sanitized = type === "skill"
      ? sanitizeSkillItem(updated, current)
      : sanitizeExperienceItem(updated, current);
    if (!sanitized) {
      throw new Error("Knowledge item is missing required text.");
    }
    collection[index] = sanitized;
  }

  writeKnowledgeBase(knowledge);
  return getKnowledgeBaseForClient();
}

function startStoryDraft(body) {
  const rawItem = body && body.item && typeof body.item === "object" ? body.item : {};
  const rawIdea = cleanStoryDraft(body && body.rawIdea ? body.rawIdea : "", STORY_TEXT_LIMIT);
  const userPrompt = cleanStoryDraft(body && body.userPrompt ? body.userPrompt : "", STORY_USER_PROMPT_LIMIT);
  const item = {
    ...rawItem,
    title: cleanKnowledgeText(rawItem.title || "Experience story", 160),
    story: cleanStoryDraft(rawItem.story || "", STORY_TEXT_LIMIT),
    prompt: cleanKnowledgeText(rawItem.prompt || "", 900),
    skills: normalizeSkillsList(rawItem.skills),
    sourceJobIds: normalizeSourceJobIds(rawItem.sourceJobIds)
  };
  if (!item.title) {
    throw new Error("Story title is required for AI help.");
  }

  const context = buildStoryDraftContext(item);
  const prompt = buildStoryDraftPrompt({ item, rawIdea, userPrompt, context });
  const draftId = createDraftId(item);
  fs.mkdirSync(STORY_DRAFT_DIR, { recursive: true });
  const promptPath = path.join(STORY_DRAFT_DIR, `${draftId}.md`);
  fs.writeFileSync(promptPath, prompt, "utf8");

  const draftJob = {
    draftId,
    status: "queued",
    progressMessage: "Queued AI story helper.",
    rawIdeaUsed: Boolean(rawIdea),
    userPromptUsed: Boolean(userPrompt),
    story: "",
    questions: "",
    error: "",
    prompt,
    promptPath,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  storyDraftJobs.set(draftId, draftJob);
  runStoryDraftCodex(draftJob);
  return compactStoryDraftJob(draftJob);
}

function startStoryQuestions(body) {
  const rawItem = body && body.item && typeof body.item === "object" ? body.item : {};
  const userPrompt = cleanStoryDraft(body && body.userPrompt ? body.userPrompt : "", STORY_USER_PROMPT_LIMIT);
  const existingQuestions = cleanStoryDraft(body && body.existingQuestions ? body.existingQuestions : "", STORY_QUESTIONS_LIMIT);
  const item = {
    ...rawItem,
    title: cleanKnowledgeText(rawItem.title || "Experience story", 160),
    story: cleanStoryDraft(rawItem.story || "", STORY_TEXT_LIMIT),
    prompt: cleanKnowledgeText(rawItem.prompt || "", 900),
    skills: normalizeSkillsList(rawItem.skills),
    sourceJobIds: normalizeSourceJobIds(rawItem.sourceJobIds)
  };
  if (!item.title) {
    throw new Error("Story title is required for AI follow-up questions.");
  }

  const context = buildStoryDraftContext(item);
  const prompt = buildStoryQuestionsPrompt({ item, userPrompt, existingQuestions, context });
  const draftId = createQuestionsDraftId(item);
  fs.mkdirSync(STORY_DRAFT_DIR, { recursive: true });
  const promptPath = path.join(STORY_DRAFT_DIR, `${draftId}.md`);
  fs.writeFileSync(promptPath, prompt, "utf8");

  const draftJob = {
    draftId,
    status: "queued",
    progressMessage: "Queued AI follow-up question helper.",
    rawIdeaUsed: false,
    userPromptUsed: Boolean(userPrompt),
    story: "",
    questions: "",
    error: "",
    prompt,
    promptPath,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  storyDraftJobs.set(draftId, draftJob);
  runStoryQuestionsCodex(draftJob);
  return compactStoryDraftJob(draftJob);
}

function getStoryDraftStatus(draftId) {
  const draftJob = storyDraftJobs.get(draftId);
  if (!draftJob) {
    throw new Error("Story draft job was not found.");
  }
  return compactStoryDraftJob(draftJob);
}

function createDraftId(item) {
  return `story-draft-${Date.now().toString(36)}-${createKnowledgeId("item", item.title).slice(0, 42)}`;
}

function createQuestionsDraftId(item) {
  return `story-questions-${Date.now().toString(36)}-${createKnowledgeId("item", item.title).slice(0, 42)}`;
}

function compactStoryDraftJob(draftJob) {
  return {
    draftId: draftJob.draftId,
    status: draftJob.status,
    progressMessage: draftJob.progressMessage,
    story: draftJob.story,
    questions: draftJob.questions,
    error: draftJob.error,
    rawIdeaUsed: Boolean(draftJob.rawIdeaUsed),
    userPromptUsed: Boolean(draftJob.userPromptUsed),
    createdAt: draftJob.createdAt,
    updatedAt: draftJob.updatedAt
  };
}

function updateStoryDraftJob(draftId, patch) {
  const current = storyDraftJobs.get(draftId);
  if (!current) {
    return null;
  }
  const updated = {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
  storyDraftJobs.set(draftId, updated);
  return updated;
}

function runStoryDraftCodex(draftJob) {
  updateStoryDraftJob(draftJob.draftId, {
    status: "running",
    progressMessage: "Launching Codex for story draft."
  });

  const command = fs.existsSync(CODEX_BIN) ? CODEX_BIN : "codex";
  let child;
  try {
    child = spawn(command, [
      "exec",
      "--skip-git-repo-check",
      "--full-auto",
      "-C",
      WORKSPACE_ROOT,
      "-c",
      "mcp_servers={}",
      draftJob.prompt
    ], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    updateStoryDraftJob(draftJob.draftId, {
      status: "failed",
      progressMessage: "AI story helper failed to start.",
      error: getErrorMessage(error)
    });
    return;
  }

  let stdout = "";
  let stderr = "";
  let stdoutRemainder = "";
  let stderrRemainder = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = appendLimited(stdout, text);
    stdoutRemainder = captureStoryDraftProgress(draftJob.draftId, stdoutRemainder + text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = appendLimited(stderr, text);
    stderrRemainder = captureStoryDraftProgress(draftJob.draftId, stderrRemainder + text);
  });

  child.on("error", (error) => {
    updateStoryDraftJob(draftJob.draftId, {
      status: "failed",
      progressMessage: "AI story helper failed to start.",
      error: getErrorMessage(error)
    });
  });

  child.on("close", (code) => {
    const latest = storyDraftJobs.get(draftJob.draftId);
    if (latest && latest.status === "failed") {
      return;
    }

    if (code !== 0) {
      updateStoryDraftJob(draftJob.draftId, {
        status: "failed",
        progressMessage: "AI story helper failed.",
        error: `AI story helper exited with code ${code}. ${visibleTextSnippet(stderr || stdout, 600)}`
      });
      return;
    }

    try {
      const draft = extractStoryDraft(`${stdout}\n${stderr}`);
      updateStoryDraftJob(draftJob.draftId, {
        status: "ready",
        progressMessage: "AI draft ready.",
        story: draft.story,
        questions: draft.questions,
        error: ""
      });
    } catch (error) {
      updateStoryDraftJob(draftJob.draftId, {
        status: "failed",
        progressMessage: "AI story helper returned an unreadable result.",
        error: getErrorMessage(error)
      });
    }
  });
}

function runStoryQuestionsCodex(draftJob) {
  updateStoryDraftJob(draftJob.draftId, {
    status: "running",
    progressMessage: "Launching Codex for follow-up questions."
  });

  const command = fs.existsSync(CODEX_BIN) ? CODEX_BIN : "codex";
  let child;
  try {
    child = spawn(command, [
      "exec",
      "--skip-git-repo-check",
      "--full-auto",
      "-C",
      WORKSPACE_ROOT,
      "-c",
      "mcp_servers={}",
      draftJob.prompt
    ], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    updateStoryDraftJob(draftJob.draftId, {
      status: "failed",
      progressMessage: "AI follow-up question helper failed to start.",
      error: getErrorMessage(error)
    });
    return;
  }

  let stdout = "";
  let stderr = "";
  let stdoutRemainder = "";
  let stderrRemainder = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = appendLimited(stdout, text);
    stdoutRemainder = captureStoryDraftProgress(draftJob.draftId, stdoutRemainder + text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr = appendLimited(stderr, text);
    stderrRemainder = captureStoryDraftProgress(draftJob.draftId, stderrRemainder + text);
  });

  child.on("error", (error) => {
    updateStoryDraftJob(draftJob.draftId, {
      status: "failed",
      progressMessage: "AI follow-up question helper failed to start.",
      error: getErrorMessage(error)
    });
  });

  child.on("close", (code) => {
    const latest = storyDraftJobs.get(draftJob.draftId);
    if (latest && latest.status === "failed") {
      return;
    }

    if (code !== 0) {
      updateStoryDraftJob(draftJob.draftId, {
        status: "failed",
        progressMessage: "AI follow-up question helper failed.",
        error: `AI follow-up question helper exited with code ${code}. ${visibleTextSnippet(stderr || stdout, 600)}`
      });
      return;
    }

    try {
      const questions = extractStoryQuestions(`${stdout}\n${stderr}`);
      updateStoryDraftJob(draftJob.draftId, {
        status: "ready",
        progressMessage: "AI follow-up questions ready.",
        story: "",
        questions,
        error: ""
      });
    } catch (error) {
      updateStoryDraftJob(draftJob.draftId, {
        status: "failed",
        progressMessage: "AI follow-up question helper returned an unreadable result.",
        error: getErrorMessage(error)
      });
    }
  });
}

function captureStoryDraftProgress(draftId, bufferedText) {
  const lines = bufferedText.split(/\r?\n/);
  const remainder = lines.pop() || "";
  for (const line of lines) {
    const raw = stripAnsi(line).trim();
    if (!/^STORY_PROGRESS:/i.test(raw)) {
      continue;
    }
    const message = normalizeProgressMessage(raw.replace(/^STORY_PROGRESS:\s*/i, ""));
    if (message) {
      updateStoryDraftJob(draftId, { progressMessage: message });
    }
  }
  return remainder;
}

function appendLimited(current, next) {
  const combined = `${current || ""}${next || ""}`;
  return combined.length > STORY_DRAFT_OUTPUT_LIMIT
    ? combined.slice(combined.length - STORY_DRAFT_OUTPUT_LIMIT)
    : combined;
}

function buildStoryDraftContext(item) {
  const knowledge = readKnowledgeBase();
  const sourceJobId = item.sourceJobIds[0] || "";
  const jobContext = sourceJobId ? readJobContext(sourceJobId) : null;
  const approvedSkills = knowledge.skills
    .filter((skill) => skill.status === "approved")
    .map((skill) => skill.keyword)
    .slice(0, 80);
  const approvedExperiences = knowledge.experiences
    .filter((experience) => experience.status === "approved")
    .map((experience) => ({
      title: experience.title,
      skills: experience.skills,
      story: experience.story
    }))
    .slice(0, 20);

  return {
    sourceJobId,
    sourceJobTitle: jobContext ? jobContext.title : item.sourceTitle || "",
    jobRequirements: jobContext ? visibleTextSnippet(`${jobContext.description}\n${jobContext.requirements}`, 7000) : "",
    approvedSkills,
    approvedExperiences,
    masterResumePath: path.join(WORKSPACE_ROOT, "Master Resume.md")
  };
}

function readJobContext(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    return null;
  }

  const contextPath = path.join(getJobDir(normalized), "job_context.json");
  if (!fs.existsSync(contextPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(contextPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function buildStoryDraftPrompt({ item, rawIdea, userPrompt, context }) {
  const mode = rawIdea
    ? "Turn the user's rough notes into proof-style use-cases that show how the skill was used."
    : "The user did not provide notes. Generate proof-style use-cases grounded in the user's known experience.";
  const userPromptBlock = userPrompt
    ? `Additional user prompt:
${userPrompt}

Treat the additional user prompt as the user's strongest preference for this AI draft. Follow it for focus, tone, structure, and clarification questions unless it conflicts with the no-fabrication rules, approved-source limits, progress markers, or STORY_DRAFT output markers.`
    : "Additional user prompt:\n(empty)";

  return `You are helping the user build a user-approved experience-story database for job applications.

Task:
${mode}

Story item:
${JSON.stringify(item, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

${userPromptBlock}

Rules:
- Do not invent facts, employers, metrics, dates, tools, or outcomes.
- Treat explicit user details in the rough notes or additional user prompt as user-provided source material.
- If rough notes are provided, keep only claims supported by those notes, the additional user prompt, approved knowledge, the master resume, or the job context.
- If rough notes are empty, inspect the master resume path and approved knowledge. Output 3-5 concrete use-cases under the current story title.
- If rough notes include one or more possible experiences, preserve them in one editable draft for the current story title and organize them as use-cases.
- A use-case is a short storytelling proof of how the user applied the skill in a real role, project, tutoring situation, audit, leadership moment, or collaboration moment.
- For each use-case, write natural sentences, not resume bulletpoints and not interview questions.
- Keep clarification questions out of the story draft. If clarification questions would help, put them only in the STORY_QUESTIONS section.
- Do not include question marks, "Needs confirmation", "Confirm...", or other follow-up requests in STORY_DRAFT.
- If details need confirmation, ask for them only in STORY_QUESTIONS.
- Use this shape for each use-case:
  Use case 1: [specific context title]
  [3-5 story-like sentences that explain the situation, how the user used the skill, what action they took, and what known or likely outcome it supports.]
  Evidence used: [one sentence naming the role, project, skill, or approved item relied on.]
- Use-cases may infer a reasonable angle from known roles, but must label uncertainty instead of presenting unverified details as fact.
- Keep the language useful for resumes, cover letters, and fit explanations, but not over-polished.
- Use ASCII punctuation.
- Print short progress lines before the final answer, each beginning with STORY_PROGRESS:
- Good examples:
  STORY_PROGRESS: Reading approved knowledge and job context.
  STORY_PROGRESS: Matching likely experience sources.
  STORY_PROGRESS: Drafting proof-style use-cases.
- After progress lines, output exactly these sections:
STORY_DRAFT_START
...content...
STORY_DRAFT_END
STORY_QUESTIONS_START
...optional clarification questions, or empty...
STORY_QUESTIONS_END

Rough notes from user:
${rawIdea || "(empty)"}
`;
}

function buildStoryQuestionsPrompt({ item, userPrompt, existingQuestions, context }) {
  const userPromptBlock = userPrompt
    ? `Additional user prompt:
${userPrompt}`
    : "Additional user prompt:\n(empty)";

  return `You are helping the user build a user-approved experience-story database for job applications.

Task:
Generate additional follow-up questions that would help turn the current story into stronger, more truthful application material.

Story item:
${JSON.stringify(item, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

Existing follow-up questions to avoid repeating:
${existingQuestions || "(none)"}

${userPromptBlock}

Rules:
- Ask only questions the user can answer from personal experience.
- Do not invent facts, employers, metrics, dates, tools, or outcomes.
- Use the source job post when available. Questions may be based on desired qualifications, minimum qualifications, essential duties, tools, work environment, soft skills, and any other relevant job-post signal.
- Do not focus only on desired qualifications; balance job relevance with gaps in the current story.
- Prefer questions that would make the story more concrete: exact project, action, communication channel, tool, stakeholder, metric, outcome, timeline, or example.
- Include confirmation-style questions when the story has uncertain details. These should be normal follow-up questions, not "Needs confirmation" lines in a draft.
- Avoid duplicates or near-duplicates of the existing follow-up questions.
- Ask 4-8 concise questions, one per line.
- Use ASCII punctuation.
- Print short progress lines before the final answer, each beginning with STORY_PROGRESS:
- Good examples:
  STORY_PROGRESS: Reading current story and source job context.
  STORY_PROGRESS: Finding job-relevant detail gaps.
  STORY_PROGRESS: Writing follow-up questions.
- After progress lines, output exactly this section:
STORY_QUESTIONS_START
...questions...
STORY_QUESTIONS_END
`;
}

function extractStoryDraft(output) {
  const text = String(output || "");
  const storyMatch = text.match(/STORY_DRAFT_START\s*([\s\S]*?)\s*STORY_DRAFT_END/i);
  const questionsMatch = text.match(/STORY_QUESTIONS_START\s*([\s\S]*?)\s*STORY_QUESTIONS_END/i);
  const separated = separateStoryDraftQuestions(
    storyMatch ? storyMatch[1] : text,
    questionsMatch ? questionsMatch[1] : ""
  );
  if (!separated.story) {
    throw new Error("AI story helper returned an empty draft.");
  }
  return separated;
}

function extractStoryQuestions(output) {
  const text = String(output || "");
  const questionsMatch = text.match(/STORY_QUESTIONS_START\s*([\s\S]*?)\s*STORY_QUESTIONS_END/i);
  const questions = cleanStoryDraft(questionsMatch ? questionsMatch[1] : text, STORY_QUESTIONS_LIMIT);
  const cleaned = questions
    .split(/\r?\n/)
    .map((line) => normalizeStoryFollowUpLine(line))
    .filter(Boolean)
    .join("\n");
  if (!cleaned) {
    throw new Error("AI follow-up question helper returned no questions.");
  }
  return cleanStoryDraft(cleaned, STORY_QUESTIONS_LIMIT);
}

function separateStoryDraftQuestions(storySource, questionsSource) {
  let story = cleanStoryDraft(storySource, STORY_TEXT_LIMIT);
  let questions = cleanStoryDraft(questionsSource, STORY_QUESTIONS_LIMIT);
  const sectionMatch = story.match(/(?:^|\n)(?:#+\s*)?(?:clarification questions|questions for (?:the )?user|questions for beybut|follow-up questions|open questions|questions)\s*:?\s*\n/i);
  if (sectionMatch) {
    const embeddedQuestions = story.slice(sectionMatch.index + sectionMatch[0].length);
    story = cleanStoryDraft(story.slice(0, sectionMatch.index), STORY_TEXT_LIMIT);
    questions = cleanStoryDraft([questions, embeddedQuestions].filter(Boolean).join("\n"), STORY_QUESTIONS_LIMIT);
  }
  const lineSplit = moveQuestionLinesOutOfStory(story);
  story = lineSplit.story;
  questions = cleanStoryDraft([questions, lineSplit.questions].filter(Boolean).join("\n"), STORY_QUESTIONS_LIMIT);
  questions = questions.replace(/^\(?empty\)?\.?$/i, "").trim();
  return { story, questions };
}

function moveQuestionLinesOutOfStory(story) {
  const lines = String(story || "").split("\n");
  const storyLines = [];
  const questionLines = [];
  for (const line of lines) {
    if (isStoryFollowUpLine(line)) {
      const question = normalizeStoryFollowUpLine(line);
      if (question) {
        questionLines.push(question);
      }
    } else {
      storyLines.push(line);
    }
  }
  return {
    story: cleanStoryDraft(storyLines.join("\n"), STORY_TEXT_LIMIT),
    questions: cleanStoryDraft(questionLines.join("\n"), STORY_QUESTIONS_LIMIT)
  };
}

function isStoryFollowUpLine(line) {
  const text = String(line || "").trim();
  return text.includes("?")
    || /^\s*(?:[-*]\s*)?(?:needs confirmation|confirmation needed|missing detail|missing details|follow-up|open question)\s*:/i.test(text)
    || /^\s*(?:[-*]\s*)?confirm\b/i.test(text);
}

function normalizeStoryFollowUpLine(line) {
  const text = String(line || "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^(?:needs confirmation|confirmation needed|missing detail|missing details|follow-up|open question)\s*:\s*/i, "")
    .trim();

  if (!text || /^(?:none|n\/a|not needed|no additional confirmation needed)\.?$/i.test(text)) {
    return "";
  }
  return text;
}

function collectKnowledgeSuggestions(job) {
  const knowledge = readKnowledgeBase();
  const suggestions = analyzeJobKnowledgeGaps(job, knowledge);
  let pendingAdded = 0;

  for (const suggestion of suggestions.skills) {
    pendingAdded += addPendingSkillSuggestion(knowledge, suggestion) ? 1 : 0;
  }

  for (const suggestion of suggestions.experiences) {
    pendingAdded += addPendingExperienceSuggestion(knowledge, suggestion) ? 1 : 0;
  }

  writeKnowledgeBase(knowledge);
  return {
    pendingAdded,
    status: getKnowledgeStatusForJob(knowledge, job.jobId, pendingAdded)
  };
}

function buildKnowledgeSnapshot(jobId) {
  const knowledge = readKnowledgeBase();
  const job = readJobContext(jobId) || { jobId, title: "", description: "", requirements: "" };
  const relevanceContext = buildJobRelevanceContext(job);
  const approvedSkills = knowledge.skills.filter((item) => item.status === "approved");
  const relevantApprovedSkills = uniqueKnowledgeItemsByNormalizedKey(
    approvedSkills.filter((item) => isApprovedSkillRelevantForJob(item, relevanceContext)),
    (item) => item.keyword
  );
  const relevantSkillKeys = new Set(
    relevantApprovedSkills.map((item) => normalizeKnowledgeText(item.keyword)).filter(Boolean)
  );
  const approvedExperiences = knowledge.experiences.filter((item) => item.status === "approved");
  const relevantApprovedExperiences = approvedExperiences.filter((item) => {
    return isApprovedExperienceRelevantForJob(item, relevanceContext, relevantSkillKeys);
  });
  const pendingForJob = (items) => items
    .filter((item) => item.status === "pending" && item.sourceJobIds.includes(jobId))
    .map((item) => compactKnowledgeItem(item));

  return {
    schemaVersion: 1,
    sourcePath: KNOWLEDGE_BASE_PATH,
    jobId,
    createdAt: nowIso(),
    approved: {
      skills: relevantApprovedSkills.map((item) => compactKnowledgeItem(item)),
      experiences: relevantApprovedExperiences.map((item) => compactKnowledgeItem(item))
    },
    pendingForThisJob: {
      skills: pendingForJob(knowledge.skills),
      experiences: pendingForJob(knowledge.experiences)
    },
    relevance: {
      rule: "Approved knowledge is filtered for this job before generation. Omitted approved items are still truthful, but should not be used unless the job directly calls for them.",
      approvedSkillCount: approvedSkills.length,
      includedApprovedSkillCount: relevantApprovedSkills.length,
      omittedApprovedSkillCount: Math.max(0, approvedSkills.length - relevantApprovedSkills.length),
      approvedExperienceCount: approvedExperiences.length,
      includedApprovedExperienceCount: relevantApprovedExperiences.length,
      omittedApprovedExperienceCount: Math.max(0, approvedExperiences.length - relevantApprovedExperiences.length)
    },
    rule: "Use approved items as user-approved facts only when they are relevant to this job. Pending items are only gaps for later review."
  };
}

function uniqueKnowledgeItemsByNormalizedKey(items, getKey) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const key = normalizeKnowledgeText(getKey(item));
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function readKnowledgeBase() {
  fs.mkdirSync(APPLICATION_OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(KNOWLEDGE_BASE_PATH)) {
    const created = createDefaultKnowledgeBase();
    writeKnowledgeBase(created);
    return created;
  }

  const parsed = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf8"));
  return normalizeKnowledgeBase(parsed);
}

function writeKnowledgeBase(knowledge) {
  const normalized = normalizeKnowledgeBase(knowledge);
  normalized.updatedAt = nowIso();
  writeJson(KNOWLEDGE_BASE_PATH, normalized);
}

function createDefaultKnowledgeBase() {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    skills: [],
    experiences: []
  };
}

function normalizeKnowledgeBase(raw) {
  const knowledge = {
    ...createDefaultKnowledgeBase(),
    ...(raw && typeof raw === "object" ? raw : {})
  };
  knowledge.skills = (Array.isArray(knowledge.skills) ? knowledge.skills : [])
    .map((item) => sanitizeSkillItem(item))
    .filter(Boolean)
    .sort(compareKnowledgeItems);
  knowledge.experiences = (Array.isArray(knowledge.experiences) ? knowledge.experiences : [])
    .map((item) => sanitizeExperienceItem(item))
    .filter(Boolean)
    .sort(compareKnowledgeItems);
  return knowledge;
}

function upsertSkillItem(knowledge, rawItem) {
  const keyword = cleanKnowledgeText(rawItem.keyword || rawItem.title || rawItem.value, 120);
  if (!keyword) {
    throw new Error("Skill keyword is required.");
  }

  const key = normalizeKnowledgeText(keyword);
  const index = knowledge.skills.findIndex((item) => item.id === rawItem.id || normalizeKnowledgeText(item.keyword) === key);
  const existing = index >= 0 ? knowledge.skills[index] : {};
  const next = sanitizeSkillItem({
    ...existing,
    ...rawItem,
    keyword,
    sourceJobIds: mergeUnique(existing.sourceJobIds, rawItem.sourceJobIds)
  }, existing);

  if (index >= 0) {
    knowledge.skills[index] = next;
  } else {
    knowledge.skills.push(next);
  }
}

function upsertExperienceItem(knowledge, rawItem) {
  const title = cleanKnowledgeText(rawItem.title || rawItem.topicTitle, 160);
  if (!title) {
    throw new Error("Experience title is required.");
  }

  const key = normalizeKnowledgeText(rawItem.topic || title);
  const index = knowledge.experiences.findIndex((item) => {
    return item.id === rawItem.id || normalizeKnowledgeText(item.topic || item.title) === key;
  });
  const existing = index >= 0 ? knowledge.experiences[index] : {};
  const next = sanitizeExperienceItem({
    ...existing,
    ...rawItem,
    title,
    sourceJobIds: mergeUnique(existing.sourceJobIds, rawItem.sourceJobIds)
  }, existing);

  if (index >= 0) {
    knowledge.experiences[index] = next;
  } else {
    knowledge.experiences.push(next);
  }
}

function addPendingSkillSuggestion(knowledge, suggestion) {
  const keyword = cleanKnowledgeText(suggestion.keyword, 120);
  const key = normalizeKnowledgeText(keyword);
  if (!keyword || !key) {
    return false;
  }

  const existing = knowledge.skills.find((item) => normalizeKnowledgeText(item.keyword) === key);
  if (existing) {
    if (existing.status === "pending") {
      existing.sourceJobIds = mergeUnique(existing.sourceJobIds, suggestion.sourceJobIds);
      existing.updatedAt = nowIso();
    }
    return false;
  }

  knowledge.skills.push(sanitizeSkillItem({
    type: "skill",
    keyword,
    status: "pending",
    notes: suggestion.notes || "",
    sourceJobIds: suggestion.sourceJobIds
  }));
  return true;
}

function addPendingExperienceSuggestion(knowledge, suggestion) {
  const topic = cleanKnowledgeText(suggestion.topic, 100);
  const sourceJobIds = normalizeSourceJobIds(suggestion.sourceJobIds);
  const normalizedTopic = normalizeKnowledgeText(topic);
  const existingForJob = knowledge.experiences.find((item) => {
    return normalizeKnowledgeText(item.topic) === normalizedTopic &&
      sourceJobIds.some((jobId) => item.sourceJobIds.includes(jobId));
  });
  if (existingForJob) {
    if (existingForJob.status === "pending") {
      existingForJob.sourceJobIds = mergeUnique(existingForJob.sourceJobIds, sourceJobIds);
      existingForJob.skills = mergeUnique(existingForJob.skills, suggestion.skills);
      existingForJob.updatedAt = nowIso();
    }
    return false;
  }

  const hasSameTopic = knowledge.experiences.some((item) => normalizeKnowledgeText(item.topic) === normalizedTopic);
  const primaryJobId = sourceJobIds[0] || "";
  knowledge.experiences.push(sanitizeExperienceItem({
    id: hasSameTopic && primaryJobId ? createKnowledgeId("experience", `${topic} ${primaryJobId}`) : "",
    type: "experience",
    title: suggestion.title,
    topic,
    story: "",
    prompt: suggestion.prompt,
    skills: suggestion.skills,
    sourceTitle: suggestion.sourceTitle,
    sourceJobIds,
    status: "pending"
  }));
  return true;
}

function sanitizeSkillItem(raw, existing = {}) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const keyword = cleanKnowledgeText(raw.keyword || raw.title || existing.keyword, 120);
  if (!keyword) {
    return null;
  }

  const status = normalizeKnowledgeStatus(raw.status || existing.status || "pending");
  return stampKnowledgeStatus({
    id: cleanKnowledgeText(raw.id || existing.id || createKnowledgeId("skill", keyword), 120),
    type: "skill",
    keyword,
    status,
    notes: cleanKnowledgeText(raw.notes || existing.notes || "", 600),
    sourceJobIds: normalizeSourceJobIds(mergeUnique(existing.sourceJobIds, raw.sourceJobIds)),
    createdAt: existing.createdAt || raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
    approvedAt: existing.approvedAt || raw.approvedAt || "",
    rejectedAt: existing.rejectedAt || raw.rejectedAt || ""
  });
}

function sanitizeExperienceItem(raw, existing = {}) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const title = cleanKnowledgeText(raw.title || existing.title, 160);
  if (!title) {
    return null;
  }

  const storySource = Object.prototype.hasOwnProperty.call(raw, "story") ? raw.story : existing.story;
  const status = normalizeKnowledgeStatus(raw.status || existing.status || "pending");
  return stampKnowledgeStatus({
    id: cleanKnowledgeText(raw.id || existing.id || createKnowledgeId("experience", raw.topic || title), 140),
    type: "experience",
    title,
    topic: cleanKnowledgeText(raw.topic || existing.topic || "", 100),
    status,
    story: cleanStoryDraft(storySource || "", STORY_TEXT_LIMIT),
    prompt: cleanKnowledgeText(raw.prompt || existing.prompt || "", 900),
    skills: normalizeSkillsList(Object.prototype.hasOwnProperty.call(raw, "skills") ? raw.skills : existing.skills),
    sourceTitle: cleanKnowledgeText(raw.sourceTitle || existing.sourceTitle || "", 180),
    sourceJobIds: normalizeSourceJobIds(mergeUnique(existing.sourceJobIds, raw.sourceJobIds)),
    createdAt: existing.createdAt || raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
    approvedAt: existing.approvedAt || raw.approvedAt || "",
    rejectedAt: existing.rejectedAt || raw.rejectedAt || ""
  });
}

function stampKnowledgeStatus(item) {
  const output = { ...item };
  if (output.status === "approved" && !output.approvedAt) {
    output.approvedAt = nowIso();
  }
  if (output.status === "rejected" && !output.rejectedAt) {
    output.rejectedAt = nowIso();
  }
  if (output.status !== "approved") {
    output.approvedAt = "";
  }
  if (output.status !== "rejected") {
    output.rejectedAt = "";
  }
  return output;
}

function analyzeJobKnowledgeGaps(job, knowledge) {
  const jobText = `${job.title || ""}\n${job.description || ""}\n${job.requirements || ""}`;
  const normalizedJobText = normalizeKnowledgeText(jobText);
  const approvedSkillKeys = new Set(knowledge.skills
    .filter((item) => item.status === "approved")
    .map((item) => normalizeKnowledgeText(item.keyword)));

  const explicitSkills = SKILL_CANDIDATES
    .filter((keyword) => jobMentionsSkill(normalizedJobText, keyword))
    .concat(extractPostedSkillPhrases(jobText))
    .map((keyword) => cleanKnowledgeText(keyword, 120))
    .filter(Boolean);

  const uniqueSkills = uniqueByNormalized(explicitSkills)
    .filter((keyword) => !approvedSkillKeys.has(normalizeKnowledgeText(keyword)))
    .slice(0, 12);

  const skills = uniqueSkills.map((keyword) => ({
    keyword,
    sourceJobIds: [job.jobId],
    notes: `Suggested from ${job.jobId}${job.title ? `: ${job.title}` : ""}.`
  }));

  const approvedExperienceTopicsForJob = new Set(knowledge.experiences
    .filter((item) => item.status === "approved")
    .filter((item) => item.sourceJobIds.includes(job.jobId))
    .flatMap((item) => [item.topic, ...normalizeSkillsList(item.skills)])
    .map(normalizeKnowledgeText)
    .filter(Boolean));

  const experiences = EXPERIENCE_TOPICS
    .map((topic) => {
      const matchedAliases = topic.aliases.filter((alias) => {
        return containsNormalizedPhrase(normalizedJobText, normalizeKnowledgeText(alias));
      });
      if (matchedAliases.length === 0) {
        return null;
      }
      if (approvedExperienceTopicsForJob.has(normalizeKnowledgeText(topic.topic))) {
        return null;
      }

      const matchedSkills = uniqueByNormalized(
        uniqueSkills.concat(matchedAliases).filter((skill) => {
          const normalizedSkill = normalizeKnowledgeText(skill);
          return matchedAliases.some((alias) => {
            const normalizedAlias = normalizeKnowledgeText(alias);
            return normalizedSkill.includes(normalizedAlias) || normalizedAlias.includes(normalizedSkill);
          });
        })
      ).slice(0, 8);

      return {
        topic: topic.topic,
        title: topic.title,
        prompt: topic.prompt,
        skills: matchedSkills.length > 0 ? matchedSkills : matchedAliases,
        sourceTitle: job.title,
        sourceJobIds: [job.jobId]
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  return { skills, experiences };
}

function buildJobRelevanceContext(job) {
  const jobText = `${job.title || ""}\n${job.description || ""}\n${job.requirements || ""}`;
  return {
    jobId: normalizeJobId(job.jobId),
    title: String(job.title || ""),
    jobText,
    normalizedJobText: normalizeKnowledgeText(jobText)
  };
}

function isApprovedSkillRelevantForJob(item, relevanceContext) {
  const keyword = cleanKnowledgeText(item.keyword, 120);
  if (!keyword) {
    return false;
  }
  return jobMentionsSkill(relevanceContext.normalizedJobText, keyword);
}

function isApprovedExperienceRelevantForJob(item, relevanceContext, relevantSkillKeys) {
  const topicDefinition = getExperienceTopicDefinition(item.topic);
  if (topicDefinition && topicDefinition.aliases.some((alias) => {
    return containsNormalizedPhrase(relevanceContext.normalizedJobText, normalizeKnowledgeText(alias));
  })) {
    return true;
  }

  const itemSkills = normalizeSkillsList(item.skills);
  if (itemSkills.some((skill) => {
    const normalizedSkill = normalizeKnowledgeText(skill);
    return relevantSkillKeys.has(normalizedSkill) || jobMentionsSkill(relevanceContext.normalizedJobText, skill);
  })) {
    return true;
  }

  return false;
}

function getExperienceTopicDefinition(topic) {
  const normalizedTopic = normalizeKnowledgeText(topic);
  return EXPERIENCE_TOPICS.find((item) => normalizeKnowledgeText(item.topic) === normalizedTopic) || null;
}

function extractPostedSkillPhrases(text) {
  const phrases = [];
  const patterns = [
    /\b(?:experience|knowledge|proficiency|proficient|skills?|familiarity)\s+(?:with|in|using|of)\s+([^.;:\n]+)/gi,
    /\bability to\s+([^.;:\n]+)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fragment = String(match[1] || "")
        .replace(/\band\/or\b/gi, ",")
        .replace(/\b(?:including|such as|e\.g\.)\b/gi, ",")
        .replace(/\((?:preferred|required)\)/gi, "");
      for (const part of fragment.split(/,|\/|\band\b|\bor\b/i)) {
        const phrase = cleanKnowledgeText(part, 80)
          .replace(/^(use|using|work with|perform|including|such as)\s+/i, "")
          .replace(/\bothers?\b/gi, "")
          .replace(/\b(?:preferred|required)\b/gi, "")
          .replace(/\s+\(.*?\)$/g, "")
          .trim();
        if (isUsefulExtractedSkill(phrase)) {
          phrases.push(titleCaseSkill(phrase));
        }
      }
    }
  }

  return uniqueByNormalized(phrases).slice(0, 8);
}

function isUsefulExtractedSkill(phrase) {
  const normalized = normalizeKnowledgeText(phrase);
  if (normalized.length < 3 || normalized.length > 50) {
    return false;
  }
  if (/^\d+$/.test(normalized)) {
    return false;
  }
  if (EXTRACTED_SKILL_STOPLIST.has(normalized)) {
    return false;
  }
  return !hasAny(normalized, [
    "work independently",
    "work as part",
    "perform other duties",
    "lift",
    "stand",
    "sit",
    "walk",
    "communicate effectively both",
    "maintain regular",
    "pass",
    "possess"
  ]);
}

function jobMentionsSkill(normalizedJobText, skill) {
  const normalizedSkill = normalizeKnowledgeText(skill);
  if (containsNormalizedPhrase(normalizedJobText, normalizedSkill)) {
    return true;
  }

  const aliases = JOB_SKILL_ALIASES[normalizedSkill] || [];

  return aliases.some((alias) => {
    return containsNormalizedPhrase(normalizedJobText, normalizeKnowledgeText(alias));
  });
}

function containsNormalizedPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) {
    return false;
  }
  const pattern = new RegExp(`(?:^| )${escapeRegExp(normalizedPhrase)}(?: |$)`);
  return pattern.test(normalizedText);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getKnowledgeStatusForJob(knowledge, jobId, pendingAdded = 0) {
  const summary = getKnowledgeSummary(knowledge);
  const pendingForJobCount = knowledge.skills.concat(knowledge.experiences)
    .filter((item) => item.status === "pending" && item.sourceJobIds.includes(jobId))
    .length;

  return {
    basePath: KNOWLEDGE_BASE_PATH,
    approvedSkillCount: summary.approvedSkills,
    approvedExperienceCount: summary.approvedExperiences,
    pendingSkillCount: summary.pendingSkills,
    pendingExperienceCount: summary.pendingExperiences,
    pendingForJobCount,
    pendingAdded
  };
}

function getKnowledgeSummary(knowledge) {
  return {
    approvedSkills: knowledge.skills.filter((item) => item.status === "approved").length,
    pendingSkills: knowledge.skills.filter((item) => item.status === "pending").length,
    rejectedSkills: knowledge.skills.filter((item) => item.status === "rejected").length,
    approvedExperiences: knowledge.experiences.filter((item) => item.status === "approved").length,
    pendingExperiences: knowledge.experiences.filter((item) => item.status === "pending").length,
    rejectedExperiences: knowledge.experiences.filter((item) => item.status === "rejected").length
  };
}

function compactKnowledgeItem(item) {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => {
    return !(value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0));
  }));
}

function normalizeKnowledgeType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "skill" || normalized === "skills") {
    return "skill";
  }
  if (normalized === "experience" || normalized === "experiences" || normalized === "story") {
    return "experience";
  }
  throw new Error("Knowledge type must be skill or experience.");
}

function normalizeKnowledgeStatus(value) {
  const normalized = String(value || "").toLowerCase();
  return KNOWLEDGE_STATUSES.has(normalized) ? normalized : "pending";
}

function normalizeSourceJobIds(value) {
  return mergeUnique([], Array.isArray(value) ? value : [value])
    .map(normalizeJobId)
    .filter(Boolean)
    .slice(0, 40);
}

function normalizeSkillsList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/,|\n/);
  return uniqueByNormalized(raw.map((item) => cleanKnowledgeText(item, 80)).filter(Boolean)).slice(0, 30);
}

function mergeUnique(first, second) {
  return uniqueByNormalized([...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]);
}

function uniqueByNormalized(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const text = cleanKnowledgeText(value, 160);
    const key = normalizeKnowledgeText(text);
    if (!text || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(text);
  }
  return output;
}

function cleanKnowledgeText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanStoryDraft(value, maxLength) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[<>]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function visibleTextSnippet(value, maxLength) {
  return String(value || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeKnowledgeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9#+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

function createKnowledgeId(prefix, value) {
  const slug = normalizeKnowledgeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${prefix}-${slug || Date.now().toString(36)}`;
}

function titleCaseSkill(value) {
  const original = cleanKnowledgeText(value, 80);
  if (/[A-Z]{2,}|[.#]/.test(original)) {
    return original;
  }
  return original.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function compareKnowledgeItems(a, b) {
  const statusOrder = { pending: 0, approved: 1, rejected: 2 };
  const statusDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  return String(a.keyword || a.title || "").localeCompare(String(b.keyword || b.title || ""));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeJob(job) {
  if (!job || typeof job !== "object") {
    throw new Error("Job context must be an object.");
  }

  const haystack = [
    job.jobId,
    job.title,
    job.url,
    job.href,
    job.description,
    job.requirements,
    job.qualifications,
    job.summary
  ].join(" ");
  const jobId = normalizeJobId(haystack);

  return {
    schemaVersion: 2,
    jobId,
    title: String(job.title || ""),
    url: String(job.url || job.href || ""),
    pageTitle: String(job.pageTitle || ""),
    timestamp: job.timestamp || new Date().toISOString(),
    description: String(job.description || job.summary || "").slice(0, 20000),
    requirements: String(job.requirements || job.qualifications || "").slice(0, 8000),
    applyButtons: Array.isArray(job.applyButtons) ? job.applyButtons.slice(0, 20) : []
  };
}

function normalizeJobId(value) {
  const match = String(value || "").match(/\bJR[-\s]?\d{3,}\b/i);
  return match ? match[0].replace(/[-\s]/g, "").toUpperCase() : "";
}

function normalizeJobDisposition(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || normalized === "clear" || normalized === "none" || normalized === "unmarked") {
    return "";
  }
  if (["applied", "application_submitted", "submitted"].includes(normalized)) {
    return "applied";
  }
  if ([
    "dont_qualify",
    "do_not_qualify",
    "not_qualify",
    "not_qualified",
    "does_not_qualify",
    "unqualified",
    "skip"
  ].includes(normalized)) {
    return "dont_qualify";
  }
  return normalized;
}

function getJobDispositionLabel(disposition) {
  const normalized = normalizeJobDisposition(disposition);
  if (normalized === "applied") {
    return "Applied";
  }
  if (normalized === "dont_qualify") {
    return "Don't Qualify";
  }
  return "";
}

function parseJobIds(value) {
  const matches = String(value || "").match(/\bJR[-\s]?\d{3,}\b/gi) || [];
  return Array.from(new Set(matches.map(normalizeJobId).filter(Boolean)));
}

function getJobDir(jobId) {
  const normalized = normalizeJobId(jobId);
  if (!normalized) {
    throw new Error("Missing JR job ID.");
  }
  return path.join(APPLICATION_OUTPUT_DIR, normalized);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-private-network", "true");
}

function log(message) {
  process.stderr.write(`[application-tailor-bridge] ${message}\n`);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
