const BRIDGE_BASE_URL = "http://127.0.0.1:17366";
const CURRENT_JOB_STORAGE_KEY = "applicationTailor.currentJobId";
const APPLY_INTENT_STORAGE_KEY = "applicationTailor.lastApplyIntent";
const APPLY_INTENT_TTL_MS = 12 * 60 * 60 * 1000;
const APPLY_INTENT_PENDING_TTL_MS = 2 * 60 * 1000;
const VOLUNTARY_DISCLOSURE_MIGRATION_KEY = "applicationTailor.voluntaryDisclosureDefaultsMigrated";

const tailorButton = document.getElementById("tailorApplicationButton");
const autofillResumeButton = document.getElementById("autofillResumeButton");
const processJobPostButton = document.getElementById("processJobPostButton");
const jobPostMarkActions = document.getElementById("jobPostMarkActions");
const markAppliedButton = document.getElementById("markAppliedButton");
const markDontQualifyButton = document.getElementById("markDontQualifyButton");
const reviewSkillsLink = document.getElementById("reviewSkillsLink");
const jobStatusBox = document.getElementById("jobStatus");
const statusBox = document.getElementById("status");

let pollTimer = null;
let canProcessCurrentJobPost = false;
let canMarkCurrentJobPost = false;
let currentJobPostProcessed = false;
let canAutofillCurrentApplication = false;
let currentJobDisposition = "";

tailorButton.addEventListener("click", tailorApplication);
autofillResumeButton.addEventListener("click", autofillResume);
processJobPostButton.addEventListener("click", processJobPost);
markAppliedButton.addEventListener("click", () => markJobDisposition("applied"));
markDontQualifyButton.addEventListener("click", () => markJobDisposition("dont_qualify"));
reviewSkillsLink.addEventListener("click", openReviewSkills);
document.addEventListener("DOMContentLoaded", refreshCurrentPageStatus);

function openReviewSkills(event) {
  event.preventDefault();
  const optionsUrl = chrome.runtime.getURL("options.html");
  chrome.tabs.create({ url: optionsUrl }, () => {
    if (chrome.runtime.lastError) {
      window.open(optionsUrl, "_blank", "noopener");
    }
  });
}

async function tailorApplication() {
  setButtons({ tailoring: true, canCheck: false });
  statusBox.textContent = "Reading this job page...";

  try {
    const tab = await getActiveTab();
    const jobContext = await captureJobContext(tab.id);
    requireJobId(jobContext.jobId);
    await rememberCurrentJob(jobContext.jobId);

    const result = await bridgeFetch("/application/tailor", {
      method: "POST",
      body: JSON.stringify({
        job: jobContext
      })
    });

    renderApplicationStatus(result.application);
    await refreshPageReadinessBadges(tab.id);
    statusBox.textContent = `Codex is preparing ${jobContext.jobId}.`;
    pollStatus(jobContext.jobId);
  } catch (error) {
    clearTimeout(pollTimer);
    setButtons({ tailoring: false, canCheck: Boolean(await getRememberedJobId()) });
    statusBox.textContent = friendlyError(error);
  }
}

async function processJobPost() {
  setButtons({ processing: true });
  statusBox.textContent = "Reading this job post...";

  try {
    const tab = await getActiveTab();
    const jobContext = await captureJobContext(tab.id);
    requireJobId(jobContext.jobId);
    if (!pageLooksLikeJobPost(jobContext)) {
      throw new Error("Open a supported job post page to mark this job.");
    }
    await rememberCurrentJob(jobContext.jobId);
    const jobPostStatus = await fetchJobPostStatus(jobContext.jobId);
    if (jobPostStatus.processed) {
      renderProcessedJobStatus({ job: jobPostStatus });
      statusBox.textContent = `${jobContext.jobId} has already been processed.`;
      setButtons({ canProcess: true, jobPostProcessed: true, jobDisposition: getJobDisposition(null, jobPostStatus) });
      return;
    }

    const result = await bridgeFetch("/job/process", {
      method: "POST",
      body: JSON.stringify({
        job: jobContext
      })
    });

    renderProcessedJobStatus(result);
    await refreshPageReadinessBadges(tab.id);
    statusBox.textContent = formatProcessedJobMessage(result, jobContext.jobId);
    setButtons({ canProcess: true, jobPostProcessed: true, jobDisposition: getJobDisposition(null, result.job) });
  } catch (error) {
    statusBox.textContent = friendlyError(error);
  } finally {
    setButtons({ processing: false });
  }
}

async function markJobDisposition(disposition) {
  const label = formatJobDispositionLabel(disposition);
  setButtons({ marking: true });
  statusBox.textContent = `Marking this job as ${label.toLowerCase()}...`;

  try {
    const tab = await getActiveTab();
    const jobContext = await captureJobContext(tab.id);
    requireJobId(jobContext.jobId);
    if (!pageLooksLikeJobPost(jobContext)) {
      throw new Error("Open a supported job post page to mark this job.");
    }
    await rememberCurrentJob(jobContext.jobId);

    const result = await bridgeFetch("/job/disposition", {
      method: "POST",
      body: JSON.stringify({
        job: jobContext,
        disposition
      })
    });

    renderApplicationStatus(result.application);
    await refreshPageReadinessBadges(tab.id);
    statusBox.textContent = `${jobContext.jobId} marked ${label}.`;
    setButtons({
      canProcess: true,
      canMarkJobPost: true,
      canAutofill: canAutofillCurrentApplication,
      jobPostProcessed: Boolean(result.job && result.job.processed),
      jobDisposition: disposition
    });
  } catch (error) {
    statusBox.textContent = friendlyError(error);
  } finally {
    setButtons({ marking: false });
  }
}

async function autofillResume() {
  setButtons({ autofilling: true });
  statusBox.textContent = "Finding autofill data for this application...";

  try {
    const tab = await getActiveTab();
    const resolved = await resolveJobForAutofill(tab.id).catch(() => resolveRememberedApplyPageJob(tab));
    await rememberCurrentJob(resolved.jobId);

    const uploadPackage = resolved.supportsDocuments && hasUploadArtifacts(resolved.application)
      ? await fetchUploadPackage(resolved.jobId)
      : { files: [], skills: "", resumeProfile: {} };
    const profile = await loadSavedProfile();
    const response = await sendPageMessage(tab.id, {
      type: "APPLICATION_AUTOFILL_UPLOAD_ARTIFACTS",
      jobId: resolved.jobId,
      expectedTitle: resolved.title,
      autoClickNext: true,
      files: uploadPackage.files,
      skills: uploadPackage.skills,
      resumeProfile: uploadPackage.resumeProfile,
      profile
    });

    if (!response || response.ok === false) {
      throw new Error(response && response.error ? response.error : "The application page did not accept the autofill update.");
    }

    const uploadResult = response.result || {};
    if (resolved.application) {
      renderApplicationStatus(resolved.application);
    }
    setButtons({ autofilling: false, canAutofill: true, canCheck: true, canProcess: false, jobDisposition: getJobDisposition(resolved.application) });
    statusBox.textContent = formatAutofillResult(uploadResult, resolved.jobId);
  } catch (error) {
    setButtons({ autofilling: false, canAutofill: canAutofillCurrentApplication });
    statusBox.textContent = friendlyError(error);
  }
}

async function refreshCurrentPageStatus() {
  clearTimeout(pollTimer);

  try {
    const tab = await getActiveTab();
    const jobContext = await captureJobContext(tab.id);
    requireJobId(jobContext.jobId);
    await rememberCurrentJob(jobContext.jobId);
    const result = await fetchStatus(jobContext.jobId);
    const jobPostStatus = await fetchJobPostStatus(jobContext.jobId, result.application);
    const canMarkJobPost = pageLooksLikeJobPost(jobContext);
    const canAutofill = pageSupportsApplicationAutofill(jobContext) &&
      (hasUploadArtifacts(result.application) || pageSupportsApplicationQuestionAutofill(jobContext));
    renderApplicationStatus(result.application);
    await refreshPageReadinessBadges(tab.id);

    if (isInProgress(result.application)) {
      setButtons({
        tailoring: true,
        canProcess: true,
        canMarkJobPost,
        canAutofill,
        jobPostProcessed: Boolean(jobPostStatus.processed),
        jobDisposition: getJobDisposition(result.application, jobPostStatus)
      });
      pollStatus(jobContext.jobId);
    } else {
      setButtons({
        tailoring: false,
        canCheck: true,
        canProcess: true,
        canMarkJobPost,
        canAutofill,
        jobPostProcessed: Boolean(jobPostStatus.processed),
        jobDisposition: getJobDisposition(result.application, jobPostStatus)
      });
      statusBox.textContent = formatCurrentJobMessage(result.application, jobContext.jobId);
    }
  } catch (_error) {
    try {
      const tab = await getActiveTab();
      const resolved = await resolveJobForAutofill(tab.id);
      await rememberCurrentJob(resolved.jobId);
      renderApplicationStatus(resolved.application);
      const canAutofill = hasUploadArtifacts(resolved.application) || resolved.supportsApplicationQuestions;
      setButtons({
        tailoring: false,
        canCheck: true,
        canProcess: false,
        canMarkJobPost: false,
        canAutofill,
        jobPostProcessed: false,
        jobDisposition: getJobDisposition(resolved.application)
      });
      statusBox.textContent = canAutofill
        ? `Ready to autofill this application step for ${resolved.jobId}.`
        : `Tailored files for ${resolved.jobId} are not ready yet.`;
      return;
    } catch (__error) {
      // Application pages hide JR IDs, so the popup makes a best-effort title match before falling back.
    }

    try {
      const tab = await getActiveTab();
      const resolved = await resolveRememberedApplyPageJob(tab);
      await rememberCurrentJob(resolved.jobId);
      renderApplicationStatus(resolved.application);
      await refreshPageReadinessBadges();
      const canAutofill = hasUploadArtifacts(resolved.application) || resolved.supportsApplicationQuestions;
      setButtons({
        tailoring: false,
        canCheck: true,
        canProcess: false,
        canMarkJobPost: false,
        canAutofill,
        jobPostProcessed: false,
        jobDisposition: getJobDisposition(resolved.application)
      });
      statusBox.textContent = canAutofill
        ? `Ready to autofill this application step for ${resolved.jobId}.`
        : "";
      return;
    } catch (__error) {
      // The visible status below is clearer than surfacing a startup race here.
    }

    renderApplicationStatus(null);
    setButtons({ tailoring: false, canCheck: false, canProcess: false, canMarkJobPost: false, canAutofill: false, jobPostProcessed: false, jobDisposition: "" });
    statusBox.textContent = "Open a supported job page with a JR job ID.";
  }
}

async function pollStatus(jobId) {
  clearTimeout(pollTimer);

  try {
    const result = await fetchStatus(jobId);
    const jobPostStatus = await fetchJobPostStatus(jobId, result.application);
    const buttonState = {
      canProcess: true,
      canAutofill: false,
      jobPostProcessed: Boolean(jobPostStatus.processed),
      jobDisposition: getJobDisposition(result.application, jobPostStatus)
    };
    renderApplicationStatus(result.application);
    await refreshPageReadinessBadges();

    if (isInProgress(result.application)) {
      setButtons({ tailoring: true, canCheck: false, ...buttonState });
      pollTimer = setTimeout(() => pollStatus(jobId), 3000);
      return;
    }

    setButtons({ tailoring: false, canCheck: true, ...buttonState });
    statusBox.textContent = hasJobDisposition(result.application)
      ? `${jobId} is marked ${formatJobDispositionLabel(result.application.jobDisposition)}.`
      : isReady(result.application)
      ? `Documents for ${jobId} are ready.`
      : isNeedsReviewOfSkills(result.application)
        ? `Skills for ${jobId} need review. Open Review Skills & Stories for this job.`
      : isProcessed(result.application)
        ? `Job post for ${jobId} is processed. Review Skills & Stories for pending items.`
      : result.application && result.application.error
        ? result.application.error
        : `Documents for ${jobId} are not ready.`;
  } catch (error) {
    setButtons({ tailoring: false, canCheck: Boolean(await getRememberedJobId()), canAutofill: false });
    statusBox.textContent = friendlyError(error);
  }
}

async function fetchStatus(jobId) {
  return bridgeFetch(`/application/status?jobId=${encodeURIComponent(jobId)}`);
}

async function fetchAllApplicationStatuses() {
  const data = await bridgeFetch("/application/statuses");
  return Array.isArray(data.applications) ? data.applications : [];
}

async function fetchUploadPackage(jobId) {
  const data = await bridgeFetch(`/application/upload-package?jobId=${encodeURIComponent(jobId)}`, {
    headers: {
      "x-application-tailor-upload": "resume"
    }
  });
  return data.uploadPackage;
}

async function loadSavedProfile() {
  const defaults = globalThis.ApplicationAutofillDefaults;
  if (!defaults) {
    return null;
  }

  const stored = await chrome.storage.sync.get({ profile: defaults.defaultProfile });
  const profile = defaults.deepMerge(defaults.defaultProfile, stored.profile || {});
  await chrome.storage.local.set({ [VOLUNTARY_DISCLOSURE_MIGRATION_KEY]: true });
  return profile;
}

async function fetchJobPostStatus(jobId, application = null) {
  try {
    const data = await bridgeFetch(`/job/status?jobId=${encodeURIComponent(jobId)}`);
    return data.job || {};
  } catch (error) {
    if (isMissingBridgeRoute(error)) {
      return inferJobPostStatusFromApplication(jobId, application);
    }
    throw error;
  }
}

function inferJobPostStatusFromApplication(jobId, application) {
  const status = String(application && application.status ? application.status : "");
  return {
    jobId,
    processed: Boolean(status && status !== "not_started"),
    disposition: getJobDisposition(application),
    inferred: true
  };
}

async function refreshPageReadinessBadges(tabId) {
  try {
    const targetTabId = tabId || (await getActiveTab()).id;
    await sendPageMessage(targetTabId, {
      type: "APPLICATION_AUTOFILL_REFRESH_READINESS_BADGES"
    });
  } catch (error) {
    // Badge refresh is opportunistic; popup status remains the source of truth if the page cannot be annotated.
  }
}

function renderApplicationStatus(application) {
  if (!application) {
    jobStatusBox.style.display = "none";
    jobStatusBox.textContent = "";
    return;
  }

  const artifacts = Array.isArray(application.artifacts) ? application.artifacts : [];
  const progressEvents = Array.isArray(application.progressEvents) ? application.progressEvents : [];
  const artifactPreview = artifacts
    .slice(0, 5)
    .map((artifact) => artifact.path || artifact)
    .join("\n");
  const validationErrors = Array.isArray(application.validationErrors) ? application.validationErrors : [];
  const validationWarnings = Array.isArray(application.validationWarnings) ? application.validationWarnings : [];
  const progressPreview = progressEvents
    .slice(-5)
    .map((event) => formatProgressEvent(event))
    .filter(Boolean)
    .join("\n");

  jobStatusBox.style.display = "block";
  jobStatusBox.textContent =
    `Job: ${application.jobId || "Unknown"}\n` +
    `Status: ${application.status || "unknown"}\n` +
    (hasJobDisposition(application) ? `Marked: ${formatJobDispositionLabel(application.jobDisposition)}\n` : "") +
    (application.progressMessage ? `Now: ${application.progressMessage}\n` : "") +
    (application.title ? `Title: ${application.title}\n` : "") +
    (application.queuePosition ? `Queue: ${application.queuePosition}${application.activeJobId ? ` behind ${application.activeJobId}` : ""}\n` : "") +
    (application.jobDir ? `Folder: ${application.jobDir}\n` : "") +
    (typeof application.documentCount === "number" ? `Documents: ${application.documentCount}/2\n` : "") +
    (application.knowledge ? `Knowledge: ${formatKnowledgeStatus(application.knowledge)}\n` : "") +
    (validationWarnings.length ? `Warnings: ${validationWarnings.join("; ")}\n` : "") +
    (validationErrors.length ? `Validation errors: ${validationErrors.join("; ")}\n` : "") +
    (progressPreview ? `\nProgress:\n${progressPreview}` : "") +
    (artifactPreview ? `\nFiles:\n${artifactPreview}` : "") +
    (application.error ? `\n\nError:\n${application.error}` : "");
}

function renderProcessedJobStatus(result) {
  const job = result && result.job ? result.job : null;
  if (!job) {
    jobStatusBox.style.display = "none";
    jobStatusBox.textContent = "";
    return;
  }

  const descriptionLength = Number(job.descriptionLength || 0);
  const requirementsLength = Number(job.requirementsLength || 0);

  jobStatusBox.style.display = "block";
  jobStatusBox.textContent =
    `Processed Job: ${job.jobId || "Unknown"}\n` +
    (job.title ? `Title: ${job.title}\n` : "") +
    (job.disposition ? `Marked: ${formatJobDispositionLabel(job.disposition)}\n` : "") +
    `Description: ${descriptionLength.toLocaleString()} characters captured\n` +
    `Qualifications: ${requirementsLength.toLocaleString()} characters captured\n` +
    (result.knowledge ? `Knowledge: ${formatKnowledgeStatus(result.knowledge)}\n` : "") +
    (job.jobContextPath ? `\nFiles:\n${job.jobContextPath}` : "") +
    (job.knowledgeSnapshotPath ? `\n${job.knowledgeSnapshotPath}` : "");
}

function formatKnowledgeStatus(knowledge) {
  const pending = Number(knowledge.pendingForJobCount || 0);
  const added = Number(knowledge.pendingAdded || 0);
  const approved = `${Number(knowledge.approvedSkillCount || 0)} skills, ${Number(knowledge.approvedExperienceCount || 0)} stories approved`;
  if (pending > 0) {
    return `${approved}; ${pending} pending for this job${added > 0 ? `, ${added} new` : ""}`;
  }
  return approved;
}

function formatProcessedJobMessage(result, fallbackJobId) {
  const jobId = result && result.job && result.job.jobId ? result.job.jobId : fallbackJobId;
  const disposition = getJobDisposition(null, result && result.job);
  if (disposition) {
    return `Processed ${jobId}; still marked ${formatJobDispositionLabel(disposition)}.`;
  }
  if (result && result.alreadyProcessed) {
    return `${jobId} has already been processed.`;
  }

  const pendingAdded = Number(result && result.pendingAdded ? result.pendingAdded : 0);
  if (pendingAdded > 0) {
    return `Processed ${jobId}; added ${pendingAdded} pending knowledge item${pendingAdded === 1 ? "" : "s"}.`;
  }
  return `Processed ${jobId}; no new knowledge gaps found.`;
}

function formatCurrentJobMessage(application, fallbackJobId) {
  const jobId = application && application.jobId ? application.jobId : fallbackJobId;
  if (hasJobDisposition(application)) {
    return `${jobId} is marked ${formatJobDispositionLabel(application.jobDisposition)}.`;
  }
  if (isReady(application)) {
    return `Documents for ${jobId} are ready.`;
  }
  if (isNeedsReviewOfSkills(application)) {
    return `Skills for ${jobId} need review. Open Review Skills & Stories for this job.`;
  }
  if (isProcessed(application)) {
    return `Job post for ${jobId} is processed. Review Skills & Stories for pending items.`;
  }
  return `Process ${jobId} to collect skills and story gaps, or tailor the full application.`;
}

function getJobDisposition(application, job = null) {
  return normalizeJobDisposition(
    (application && application.jobDisposition) ||
    (job && job.disposition) ||
    ""
  );
}

function hasJobDisposition(application) {
  return Boolean(getJobDisposition(application));
}

function normalizeJobDisposition(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized === "applied") {
    return "applied";
  }
  if (["dont_qualify", "do_not_qualify", "not_qualified", "does_not_qualify"].includes(normalized)) {
    return "dont_qualify";
  }
  return "";
}

function formatJobDispositionLabel(disposition) {
  const normalized = normalizeJobDisposition(disposition);
  if (normalized === "applied") {
    return "Applied";
  }
  if (normalized === "dont_qualify") {
    return "Don't Qualify";
  }
  return "Marked";
}

function formatAutofillResult(result, jobId) {
  const uploaded = Array.isArray(result && result.uploadedFiles) ? result.uploadedFiles : [];
  const skipped = Array.isArray(result && result.skippedFiles) && result.artifactUploadSkipped !== "no_file_input_on_this_step"
    ? result.skippedFiles
    : [];
  const parts = [];

  if (uploaded.length > 0) {
    parts.push(`uploaded ${uploaded.map((file) => file.fileName || file.kind).filter(Boolean).join(", ")}`);
  }
  if (result && result.skillsApplied) {
    parts.push("filled Skills");
  }
  if (result && result.applicationQuestionsApplied) {
    const fields = Array.isArray(result.applicationQuestionFields) ? result.applicationQuestionFields : [];
    parts.push(fields.length > 0 ? `filled ${fields.length} application field${fields.length === 1 ? "" : "s"}` : "filled application fields");
  }
  if (result && Array.isArray(result.applicationQuestionNeedsValues) && result.applicationQuestionNeedsValues.length > 0) {
    parts.push(`needs saved values for ${result.applicationQuestionNeedsValues.slice(0, 3).join(", ")}${result.applicationQuestionNeedsValues.length > 3 ? ", ..." : ""}`);
  }
  if (result && result.experienceApplied) {
    parts.push("fixed parsed work experience");
  }
  if (result && result.educationApplied) {
    parts.push("fixed expected graduation year");
  } else if (result && result.educationSkipped) {
    const detail = result.educationDebug ? `: ${result.educationDebug}` : "";
    parts.push(`expected grad year not fixed (${result.educationSkipped}${detail})`);
  }
  if (skipped.length > 0) {
    parts.push(`skipped ${skipped.map((file) => file.fileName || file.kind).filter(Boolean).join(", ")}`);
  }
  if (result && result.autoAdvanceStoppedAt === "Review") {
    const clicks = Number(result.nextClicks || 0);
    parts.push(clicks > 0 ? `advanced to Review (${clicks} Next click${clicks === 1 ? "" : "s"})` : "already on Review");
  } else if (result && result.autoAdvanceStoppedAt && result.nextClickSkipped) {
    const clicks = Number(result.nextClicks || 0);
    const prefix = clicks > 0 ? `clicked Next ${clicks} time${clicks === 1 ? "" : "s"}; ` : "";
    parts.push(`${prefix}stopped at ${result.autoAdvanceStoppedAt} (${result.nextClickSkipped})`);
  } else if (result && result.nextClicked) {
    const clicks = Number(result.nextClicks || 1);
    parts.push(clicks > 1 ? `clicked Next ${clicks} times` : "clicked Next");
  } else if (result && result.nextClickSkipped) {
    parts.push(`did not click Next (${result.nextClickSkipped})`);
  }

  return parts.length > 0
    ? `Autofill for ${jobId}: ${parts.join("; ")}. Check the application page before continuing.`
    : `Nothing new to autofill for ${jobId}. Check the application page before continuing.`;
}

function formatProgressEvent(event) {
  if (!event || !event.message) {
    return "";
  }

  const time = formatProgressTime(event.at);
  return `${time ? `${time} ` : ""}${event.message}`;
}

function formatProgressTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setButtons({
  tailoring = false,
  processing = false,
  autofilling = false,
  marking = false,
  canProcess,
  canMarkJobPost,
  canAutofill,
  jobPostProcessed,
  jobDisposition
} = {}) {
  if (typeof canProcess === "boolean") {
    canProcessCurrentJobPost = canProcess;
  }
  if (typeof canMarkJobPost === "boolean") {
    canMarkCurrentJobPost = canMarkJobPost;
  }
  if (typeof canAutofill === "boolean") {
    canAutofillCurrentApplication = canAutofill;
  }
  if (typeof jobPostProcessed === "boolean") {
    currentJobPostProcessed = jobPostProcessed;
  }
  if (typeof jobDisposition === "string") {
    currentJobDisposition = normalizeJobDisposition(jobDisposition);
  }

  const busy = Boolean(tailoring || processing || autofilling || marking);
  tailorButton.disabled = busy;
  autofillResumeButton.disabled = busy || !canAutofillCurrentApplication;
  processJobPostButton.disabled = busy || !canProcessCurrentJobPost || currentJobPostProcessed;
  jobPostMarkActions.hidden = !canMarkCurrentJobPost;
  markAppliedButton.disabled = busy || !canMarkCurrentJobPost || currentJobDisposition === "applied";
  markDontQualifyButton.disabled = busy || !canMarkCurrentJobPost || currentJobDisposition === "dont_qualify";
  tailorButton.textContent = tailoring ? "Tailoring..." : "Tailor Application";
  autofillResumeButton.textContent = autofilling ? "Autofilling..." : "Autofill";
  processJobPostButton.textContent = processing
    ? "Processing..."
    : currentJobPostProcessed
      ? "Job Post Processed"
      : "Process Job Post";
  markAppliedButton.textContent = marking ? "Marking..." : currentJobDisposition === "applied" ? "Marked Applied" : "Mark Applied";
  markDontQualifyButton.textContent = marking ? "Marking..." : currentJobDisposition === "dont_qualify" ? "Marked" : "Don't Qualify";
  autofillResumeButton.title = !canAutofillCurrentApplication
    ? "Open the matching application upload, My Experience, Skills, or Application Questions step."
    : "";
  processJobPostButton.title = !canProcessCurrentJobPost
    ? "Open a supported job page with a JR job ID."
    : currentJobPostProcessed
      ? "This job post is already saved in the local knowledge system."
      : "";
  markAppliedButton.title = !canMarkCurrentJobPost
    ? "Open a supported job page with a JR job ID."
    : currentJobDisposition === "applied"
      ? "This job is already marked applied."
      : "";
  markDontQualifyButton.title = !canMarkCurrentJobPost
    ? "Open a supported job page with a JR job ID."
    : currentJobDisposition === "dont_qualify"
      ? "This job is already marked as don't qualify."
      : "";
}

function isReady(application) {
  return application && application.status === "ready";
}

function isProcessed(application) {
  return application && application.status === "processed";
}

function isNeedsReviewOfSkills(application) {
  return application && application.status === "needs_review_of_skills";
}

function isInProgress(application) {
  return application && (application.status === "queued" || application.status === "running");
}

function hasUploadArtifacts(application) {
  if (!application) {
    return false;
  }

  const artifacts = Array.isArray(application.artifacts) ? application.artifacts : [];
  const hasResume = artifacts.some((artifact) => artifact && artifact.kind === "resume-docx");
  const hasCoverLetter = artifacts.some((artifact) => artifact && artifact.kind === "cover-letter-docx");
  return (hasResume && hasCoverLetter) ||
    Boolean(application.status === "ready" && Number(application.documentCount || 0) >= 2);
}

async function captureJobContext(tabId) {
  const job = await captureVisibleJobContext(tabId);
  if (job && normalizeJobId(job.jobId)) {
    return {
      ...job,
      jobId: normalizeJobId(job.jobId)
    };
  }

  throw new Error("I could not read this job page.");
}

async function resolveJobForAutofill(tabId) {
  const pageJob = await captureVisibleJobContext(tabId);
  const supportsDocuments = pageSupportsDocumentAutofill(pageJob);
  const supportsApplicationQuestions = pageSupportsApplicationQuestionAutofill(pageJob);
  if (!pageSupportsApplicationAutofill(pageJob)) {
    throw new Error("Open a supported upload, My Experience, Skills, or Application Questions step, then try Autofill.");
  }

  const pageJobId = normalizeJobId(pageJob && pageJob.jobId);
  if (pageJobId) {
    const status = await fetchStatus(pageJobId);
    return {
      jobId: pageJobId,
      title: status.application && status.application.title || pageJob.title || "",
      application: status.application,
      supportsDocuments,
      supportsApplicationQuestions,
      source: "page"
    };
  }

  const titleCandidates = getAutofillTitleCandidates(pageJob);
  const currentUrl = pageJob && pageJob.url ? pageJob.url : "";
  const applications = await fetchAllApplicationStatuses();
  const referrerMatch = await resolveApplicationReferrerJob(pageJob, titleCandidates, applications);
  if (referrerMatch) {
    return {
      ...referrerMatch,
      supportsDocuments,
      supportsApplicationQuestions,
      source: "referrer"
    };
  }

  const historyMatch = await resolveApplicationNavigationHistoryJob(tabId, pageJob, titleCandidates, applications);
  if (historyMatch) {
    return {
      ...historyMatch,
      supportsDocuments,
      supportsApplicationQuestions,
      source: "navigation_history"
    };
  }

  const titleMatches = scoreKnownApplicationsByTitle(titleCandidates, applications);
  const applyIntentMatch = await resolveRecentApplyIntent(titleCandidates, currentUrl, applications, pageJob && pageJob.applyIntent);
  if (applyIntentMatch) {
    return {
      ...applyIntentMatch,
      supportsDocuments,
      supportsApplicationQuestions,
      source: "apply_intent"
    };
  }

  const rememberedMatch = await resolveRememberedJob(titleCandidates, titleMatches);
  if (rememberedMatch) {
    return {
      ...rememberedMatch,
      supportsDocuments,
      supportsApplicationQuestions,
      source: "remembered"
    };
  }

  const titleMatch = findKnownApplicationByTitle(titleCandidates, applications, titleMatches);
  if (titleMatch) {
    return {
      jobId: titleMatch.jobId,
      title: titleMatch.title || titleCandidates[0] || "",
      application: titleMatch,
      supportsDocuments,
      supportsApplicationQuestions,
      source: "title"
    };
  }

  throw new Error("I could not match this application page to a tailored JR job. Open the original job post once, or tailor/process it first.");
}

async function resolveRecentApplyIntent(titleCandidates, currentUrl, applications, pageIntent = null) {
  const intent = await getRecentApplyIntent(currentUrl, pageIntent);
  const urlMatch = findKnownApplicationByUrl(intent && intent.jobUrl, applications);
  const jobId = normalizeJobId(urlMatch && urlMatch.jobId) || normalizeJobId(intent && intent.jobId);
  if (!jobId) {
    return null;
  }

  return resolveKnownApplicationJob(jobId, titleCandidates, urlMatch && urlMatch.title || intent.title || "");
}

async function resolveApplicationReferrerJob(pageJob, titleCandidates, applications) {
  if (!pageUrlLooksLikeWorkdayApplyStep(pageJob && pageJob.url)) {
    return null;
  }

  const referrerMatch = findKnownApplicationByUrl(pageJob && pageJob.referrer, applications);
  const jobId = normalizeJobId(referrerMatch && referrerMatch.jobId);
  if (!jobId) {
    return null;
  }

  return resolveKnownApplicationJob(jobId, titleCandidates, referrerMatch.title || "");
}

async function resolveApplicationNavigationHistoryJob(tabId, pageJob, titleCandidates, applications) {
  if (!pageUrlLooksLikeWorkdayApplyStep(pageJob && pageJob.url)) {
    return null;
  }

  const history = await getNavigationHistory(tabId);
  const entries = Array.isArray(history && history.entries) ? history.entries : [];
  if (entries.length === 0) {
    return null;
  }

  const currentUrl = normalizeComparableUrl(pageJob && pageJob.url);
  const currentIndex = Number.isInteger(history.currentIndex)
    ? history.currentIndex
    : entries.findIndex((entry) => normalizeComparableUrl(entry && entry.url) === currentUrl);
  const priorEntries = entries
    .slice(0, currentIndex >= 0 ? currentIndex : entries.length)
    .reverse();

  for (const entry of priorEntries) {
    const match = findKnownApplicationByUrl(entry && entry.url, applications);
    const jobId = normalizeJobId(match && match.jobId);
    if (!jobId) {
      continue;
    }

    const resolved = await resolveKnownApplicationJob(jobId, titleCandidates, match.title || "");
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolveRememberedJob(titleCandidates, titleMatches) {
  const rememberedJobId = normalizeJobId(await getRememberedJobId());
  if (!rememberedJobId) {
    return null;
  }

  if (Array.isArray(titleMatches) && titleMatches.length > 0) {
    const topScore = titleMatches[0].score;
    const topMatches = titleMatches.filter((item) => item.score === topScore);
    if (topMatches.length !== 1 || normalizeJobId(topMatches[0].application && topMatches[0].application.jobId) !== rememberedJobId) {
      return null;
    }
  }

  return resolveKnownApplicationJob(rememberedJobId, titleCandidates, "");
}

async function resolveKnownApplicationJob(jobId, titleCandidates, fallbackTitle) {
  try {
    const status = await fetchStatus(jobId);
    const application = status && status.application ? status.application : null;
    const knownTitle = application && application.title ? application.title : fallbackTitle;
    if (!application || !autofillTitlesAreCompatible(knownTitle, titleCandidates)) {
      return null;
    }

    return {
      jobId,
      title: knownTitle || titleCandidates[0] || "",
      application
    };
  } catch (_error) {
    return null;
  }
}

async function resolveRememberedApplyPageJob(tab) {
  if (!pageUrlLooksLikeWorkdayApplyStep(tab && tab.url)) {
    throw new Error("Open a supported application step, then try Autofill.");
  }

  const pageJob = tab && tab.id ? await captureVisibleJobContext(tab.id).catch(() => null) : null;
  const titleCandidates = getAutofillTitleCandidates(pageJob);
  const applications = await fetchAllApplicationStatuses();
  const referrerMatch = await resolveApplicationReferrerJob(pageJob, titleCandidates, applications);
  if (referrerMatch) {
    return {
      ...referrerMatch,
      supportsDocuments: true,
      supportsApplicationQuestions: true,
      source: "referrer_fallback"
    };
  }

  const historyMatch = await resolveApplicationNavigationHistoryJob(tab && tab.id, pageJob, titleCandidates, applications);
  if (historyMatch) {
    return {
      ...historyMatch,
      supportsDocuments: true,
      supportsApplicationQuestions: true,
      source: "navigation_history_fallback"
    };
  }

  const applyIntentMatch = await resolveRecentApplyIntent(titleCandidates, tab && tab.url || "", applications, pageJob && pageJob.applyIntent);
  if (applyIntentMatch) {
    return {
      ...applyIntentMatch,
      supportsDocuments: true,
      supportsApplicationQuestions: true,
      source: "apply_intent_fallback"
    };
  }

  if (titleCandidates.length === 0) {
    throw new Error("I could not read the application title, so I will not guess which JR this page belongs to.");
  }

  const titleMatches = scoreKnownApplicationsByTitle(titleCandidates, applications);
  const rememberedMatch = await resolveRememberedJob(titleCandidates, titleMatches);
  if (!rememberedMatch) {
    if (titleMatches.length > 1 && titleMatches[0].score === titleMatches[1].score) {
      const jobIds = titleMatches.slice(0, 4).map((item) => item.application && item.application.jobId).filter(Boolean).join(", ");
      throw new Error(`This application title matches multiple local jobs: ${jobIds}. Open the original job post and click Apply again.`);
    }

    throw new Error("I could not match this application page to a tailored JR job. Open the original job post once, or tailor/process it first.");
  }

  if (!hasUploadArtifacts(rememberedMatch.application)) {
    throw new Error(`Tailored files for ${rememberedMatch.jobId} are not ready yet.`);
  }

  return {
    ...rememberedMatch,
    supportsDocuments: true,
    supportsApplicationQuestions: true,
    source: "remembered_apply_page_checked"
  };
}

function pageSupportsApplicationAutofill(job) {
  return looksLikeWorkdayApplyStep(job) || pageSupportsDocumentAutofill(job) || pageSupportsApplicationQuestionAutofill(job);
}

function pageLooksLikeJobPost(job) {
  const text = normalizeText([
    job && job.title,
    job && job.pageTitle,
    job && job.description,
    job && job.url
  ].join("\n"));

  if (!normalizeJobId(job && job.jobId)) {
    return false;
  }

  const postingMarkers = [
    "view job posting details",
    "job profile",
    "job family",
    "minimum qualifications",
    "job description",
    "posting end date",
    "job requisition id",
    "apply before"
  ];
  const postingMarkerCount = postingMarkers.filter((marker) => text.includes(marker)).length;
  const hasStrongPostingSignal = postingMarkerCount >= 2 || hasAny(text, [
    "view job posting details",
    "job requisition id"
  ]);

  if (!hasStrongPostingSignal) {
    return false;
  }

  const applicationStepMarkers = [
    "job application for",
    "quick apply",
    "upload resume or cv",
    "drop file here",
    "select files",
    "my experience",
    "application questions",
    "voluntary disclosures",
    "self identify",
    "review your application",
    "legal equivalent of a signature"
  ];
  const applicationStepCount = applicationStepMarkers.filter((marker) => text.includes(marker)).length;
  if (applicationStepCount >= 2 && postingMarkerCount < 2) {
    return false;
  }

  return true;
}

function pageSupportsDocumentAutofill(job) {
  const text = normalizeText([
    job && job.title,
    job && job.pageTitle,
    job && job.description,
    job && job.url
  ].join("\n"));

  if (looksLikeWorkdayApplyStep(job)) {
    return true;
  }

  return pageSupportsDocumentAutofillText(text);
}

function pageSupportsDocumentAutofillText(text) {
  return (
    hasAny(text, ["job application for", "upload resume", "upload either doc", "resume cv and cover letter", "my experience"]) &&
    hasAny(text, ["resume", "cv", "cover letter", "quick apply", "drop file here", "select files", "skills"])
  );
}

function pageSupportsApplicationQuestionAutofill(job) {
  const text = normalizeText([
    job && job.title,
    job && job.pageTitle,
    job && job.description,
    job && job.url
  ].join("\n"));

  return pageSupportsApplicationQuestionAutofillText(text);
}

function looksLikeWorkdayApplyStep(job) {
  const url = String(job && job.url ? job.url : "");
  if (pageUrlLooksLikeWorkdayApplyStep(url)) {
    return true;
  }

  const text = normalizeText([
    job && job.title,
    job && job.pageTitle,
    job && job.description
  ].join("\n"));

  return hasAny(text, [
    "job application for",
    "quick apply",
    "upload resume or cv",
    "my experience",
    "application questions",
    "voluntary disclosures",
    "self identify",
    "review your application"
  ]);
}

function pageUrlLooksLikeWorkdayApplyStep(url) {
  return /\/apply\//i.test(String(url || ""));
}

function pageSupportsApplicationQuestionAutofillText(text) {
  return hasAny(text, [
    "application questions",
    "voluntary disclosures",
    "voluntary personal information",
    "eligible to work",
    "asu sponsorship",
    "enrolled in class",
    "classes at asu",
    "federal work study",
    "18 years or older",
    "hispanic or latino descent",
    "select your gender",
    "veteran status",
    "legal equivalent of a signature"
  ]);
}

function getAutofillTitleCandidates(job) {
  const values = [
    job && job.title,
    job && job.pageTitle,
    extractApplicationJobTitle(job && job.title),
    extractApplicationJobTitle(job && job.pageTitle),
    ...extractApplicationJobTitles(job && job.description)
  ];
  const seen = new Set();
  const candidates = [];

  for (const value of values) {
    const title = cleanApplicationJobTitle(value);
    const key = normalizeApplicationTitle(title);
    if (!title || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(title);
  }

  return candidates;
}

function findKnownApplicationByTitle(titleCandidates, applications, scoredApplications = null) {
  const scored = Array.isArray(scoredApplications)
    ? scoredApplications
    : scoreKnownApplicationsByTitle(titleCandidates, applications);

  if (scored.length === 0) {
    return null;
  }

  if (scored.length > 1 && scored[0].score === scored[1].score) {
    throw new Error(`This application title matches multiple local jobs: ${scored.slice(0, 3).map((item) => item.application.jobId).join(", ")}.`);
  }

  return scored[0].application;
}

function scoreKnownApplicationsByTitle(titleCandidates, applications) {
  return (Array.isArray(applications) ? applications : [])
    .map((application) => ({
      application,
      score: scoreApplicationTitleMatch(titleCandidates, application)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
}

function findKnownApplicationByUrl(url, applications) {
  const comparableUrl = normalizeComparableUrl(url);
  if (!comparableUrl) {
    return null;
  }

  return (Array.isArray(applications) ? applications : []).find((application) => {
    return normalizeComparableUrl(application && application.url) === comparableUrl;
  }) || null;
}

function normalizeComparableUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    parsed.hash = "";
    parsed.search = "";
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function scoreApplicationTitleMatch(titleCandidates, application) {
  const appTitle = normalizeApplicationTitle(application && application.title);
  if (!appTitle) {
    return 0;
  }

  let score = 0;
  for (const candidate of titleCandidates) {
    const candidateTitle = normalizeApplicationTitle(candidate);
    if (!candidateTitle) {
      continue;
    }

    if (candidateTitle === appTitle) {
      score = Math.max(score, 100);
    } else if (candidateTitle.includes(appTitle) || appTitle.includes(candidateTitle)) {
      score = Math.max(score, 75);
    }
  }

  if (score > 0 && hasUploadArtifacts(application)) {
    score += 5;
  }

  return score;
}

function titleMatchesAny(title, candidates) {
  const normalizedTitle = normalizeApplicationTitle(title);
  return Boolean(normalizedTitle && candidates.some((candidate) => {
    const normalizedCandidate = normalizeApplicationTitle(candidate);
    return normalizedCandidate && (
      normalizedCandidate === normalizedTitle ||
      normalizedCandidate.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedCandidate)
    );
  }));
}

function autofillTitlesAreCompatible(title, candidates) {
  const normalizedTitle = normalizeApplicationTitle(title);
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeApplicationTitle)
    .filter(Boolean);
  if (normalizedCandidates.length === 0) {
    return true;
  }
  if (!normalizedTitle) {
    return false;
  }

  return titleMatchesAny(title, candidates);
}

function extractApplicationJobTitles(value) {
  const output = [];
  const lines = String(value || "")
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 40);

  for (const line of lines) {
    const title = extractApplicationJobTitle(line);
    if (title) {
      output.push(title);
    }
  }

  return output;
}

function extractApplicationJobTitle(value) {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  const applicationMatch = line.match(/^Job Application for\s+(.+)$/i);
  if (applicationMatch && applicationMatch[1]) {
    return cleanApplicationJobTitle(applicationMatch[1]);
  }

  const uploadTitleMatch = line.match(/^(.+?)\s*:\s*(?:Upload Resume or CV|Quick Apply|My Experience|Application Questions|Voluntary Disclosures|Self Identify|Review)(?:\s*-\s*Workday)?$/i);
  if (uploadTitleMatch && uploadTitleMatch[1]) {
    return cleanApplicationJobTitle(uploadTitleMatch[1]);
  }

  return "";
}

function cleanApplicationJobTitle(value) {
  return visibleSnippet(String(value || "")
    .replace(/\s*-\s*Workday.*$/i, "")
    .replace(/\s*:\s*(?:Upload Resume or CV|Quick Apply|My Experience|Application Questions|Voluntary Disclosures|Self Identify|Review).*$/i, "")
    .replace(/^Job Application for\s+/i, "")
    .trim(), 180);
}

function normalizeApplicationTitle(value) {
  return normalizeText(cleanApplicationJobTitle(value));
}

async function captureVisibleJobContext(tabId) {
  let response = null;
  try {
    response = await sendPageMessage(tabId, {
      type: "APPLICATION_AUTOFILL_CAPTURE_JOB_CONTEXT"
    });
  } catch (_error) {
    response = null;
  }

  const contentJob = response && response.ok && response.job ? response.job : null;
  if (contentJob && normalizeJobId(contentJob.jobId)) {
    return {
      ...contentJob,
      jobId: normalizeJobId(contentJob.jobId)
    };
  }

  const frameJob = await captureJobContextFromFrames(tabId);
  if (frameJob && frameJob.jobId) {
    return {
      ...(contentJob || {}),
      ...frameJob,
    };
  }

  return contentJob;
}

async function captureJobContextFromFrames(tabId) {
  let frames = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectFrameJobContext
    });
    frames = results.map((item) => item.result).filter(Boolean);
  } catch (_error) {
    frames = [];
  }

  if (frames.length === 0) {
    return null;
  }

  const visibleCombined = frames.map((frame) => `${frame.url}\n${frame.title}\n${frame.text}`).join("\n\n");
  const sourceCombined = frames.map((frame) => frame.source || "").join("\n\n");
  const jobId = extractLabeledJobId(visibleCombined) || normalizeJobId(visibleCombined) || extractUniqueJobId(sourceCombined);
  if (!jobId) {
    return null;
  }

  const bestFrame = frames.find((frame) => extractLabeledJobId(frame.text) === jobId) ||
    frames.find((frame) => normalizeJobId(`${frame.url}\n${frame.title}\n${frame.text}`) === jobId) ||
    frames.find((frame) => extractUniqueJobId(frame.source) === jobId) ||
    frames[0];
  const description = visibleSnippet(bestFrame.text || visibleCombined, 15000);

  return {
    schemaVersion: 2,
    jobId,
    title: extractTitleFromFrame(bestFrame, jobId),
    url: bestFrame.url || "",
    referrer: bestFrame.referrer || "",
    pageTitle: bestFrame.title || "",
    timestamp: new Date().toISOString(),
    description,
    requirements: extractRequirements(description),
    applyButtons: []
  };
}

function collectFrameJobContext() {
  return {
    url: window.location.href,
    referrer: document.referrer || "",
    title: document.title || "",
    text: document.body ? String(document.body.innerText || document.body.textContent || "").slice(0, 30000) : "",
    source: document.documentElement ? String(document.documentElement.innerHTML || "").slice(0, 120000) : ""
  };
}

function extractTitleFromFrame(frame, jobId) {
  const title = String(frame && frame.title ? frame.title : "")
    .replace(/\s*-\s*Workday.*$/i, "")
    .replace(/^View Job Posting Details\s*$/i, "")
    .trim();
  if (title) {
    return visibleSnippet(title, 180);
  }

  const lines = String(frame && frame.text ? frame.text : "")
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const ignored = new Set([
    "view job posting details",
    "skip to main content",
    "accessibility overview",
    "apply",
    "job requisition id",
    jobId.toUpperCase()
  ]);

  const match = lines.find((line) => {
    const normalized = line.toLowerCase();
    return (
      line.length >= 3 &&
      line.length <= 160 &&
      !ignored.has(normalized) &&
      !/^jr\d+$/i.test(line) &&
      !/^(home|personal resources|saved|search)$/i.test(line) &&
      !/(posting date|posting end date|location|time type|job type|job family)/i.test(line)
    );
  });

  return match ? visibleSnippet(match, 180) : "";
}

function extractRequirements(text) {
  const lines = String(text || "")
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const output = [];
  let collecting = false;

  for (const line of lines) {
    const normalized = normalizeText(line);
    if (hasAny(normalized, ["requirement", "qualification", "minimum", "preferred", "skill", "knowledge"])) {
      collecting = true;
    }

    if (collecting) {
      output.push(line);
    }

    if (output.length >= 45) {
      break;
    }
  }

  return visibleSnippet(output.join("\n"), 6000);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

async function sendPageMessage(tabId, message) {
  const directResponse = await executeCurrentContentApi(tabId, message);
  if (directResponse) {
    return directResponse;
  }

  return chrome.tabs.sendMessage(tabId, message);
}

async function injectCurrentContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["defaults.js", "content.js"]
    });
  } catch (_error) {
    // The follow-up message keeps the user-facing error tied to the actual action.
  }
}

async function executeCurrentContentApi(tabId, message) {
  await injectCurrentContentScript(tabId);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (payload) => {
        const api = globalThis.ApplicationAutofillApi;
        if (!api || typeof api.handleMessage !== "function") {
          return null;
        }

        return api.handleMessage(payload);
      },
      args: [message]
    });

    return Array.isArray(results) && results[0] ? results[0].result : null;
  } catch (_error) {
    return null;
  }
}

async function bridgeFetch(path, init = {}) {
  const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Bridge returned HTTP ${response.status}.`);
  }

  return data;
}

async function getNavigationHistory(tabId) {
  if (!tabId) {
    return null;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "APPLICATION_AUTOFILL_GET_NAVIGATION_HISTORY",
      tabId
    });
    if (response && response.ok) {
      return response.history || null;
    }
  } catch (_error) {
    // Navigation history is a precision aid for duplicate-title application pages; other matchers can still run.
  }

  return null;
}

async function rememberCurrentJob(jobId) {
  await chrome.storage.local.set({ [CURRENT_JOB_STORAGE_KEY]: jobId });
}

async function getRememberedJobId() {
  const stored = await chrome.storage.local.get({ [CURRENT_JOB_STORAGE_KEY]: "" });
  return stored[CURRENT_JOB_STORAGE_KEY] || "";
}

async function getRecentApplyIntent(currentUrl = "", pageIntent = null) {
  const pageScopedIntent = normalizeRecentApplyIntent(pageIntent, currentUrl);
  if (pageScopedIntent) {
    return pageScopedIntent;
  }

  const stored = await chrome.storage.local.get({ [APPLY_INTENT_STORAGE_KEY]: null });
  return normalizeRecentApplyIntent(stored[APPLY_INTENT_STORAGE_KEY], currentUrl);
}

function normalizeRecentApplyIntent(intent, currentUrl = "") {
  if (!intent || typeof intent !== "object") {
    return null;
  }

  const clickedAt = Number(intent.clickedAt || 0);
  if (!clickedAt || Date.now() - clickedAt > APPLY_INTENT_TTL_MS) {
    return null;
  }

  const currentApplyToken = extractWorkdayApplyToken(currentUrl);
  const intentApplyToken = String(intent.applyToken || "");
  if (currentApplyToken && intentApplyToken) {
    return currentApplyToken === intentApplyToken ? intent : null;
  }

  if (currentApplyToken && !intentApplyToken && Date.now() - clickedAt > APPLY_INTENT_PENDING_TTL_MS) {
    return null;
  }

  return intent;
}

function requireJobId(jobId) {
  if (!normalizeJobId(jobId)) {
    throw new Error("I could not find a JR job ID on this page.");
  }
}

function normalizeJobId(value) {
  const match = String(value || "").match(/\bJR[-\s]?\d{3,}\b/i);
  return match ? match[0].replace(/[-\s]/g, "").toUpperCase() : "";
}

function extractLabeledJobId(text) {
  const lines = String(text || "")
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^job requisition id$/i.test(lines[index])) {
      continue;
    }

    for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
      const jobId = normalizeJobId(lines[index + offset]);
      if (jobId) {
        return jobId;
      }
    }
  }

  const inlineMatch = String(text || "").match(/Job Requisition ID\s*[:\n\r ]+\s*(JR[-\s]?\d{3,})/i);
  return inlineMatch && inlineMatch[1] ? normalizeJobId(inlineMatch[1]) : "";
}

function extractUniqueJobId(value) {
  const matches = String(value || "").match(/\bJR[-\s]?\d{3,}\b/gi) || [];
  const jobIds = Array.from(new Set(matches.map(normalizeJobId).filter(Boolean)));
  return jobIds.length === 1 ? jobIds[0] : "";
}

function extractWorkdayApplyToken(url) {
  try {
    const parsed = new URL(url || "");
    const match = parsed.pathname.match(/\/apply\/([^/?#]+)/i);
    return match && match[1] ? match[1] : "";
  } catch (_error) {
    return "";
  }
}

function visibleSnippet(value, maxLength) {
  return String(value || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxLength);
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (isMissingBridgeRoute(error)) {
    return "Restart the v2 local bridge, then try again.";
  }
  if (message.includes("Failed to fetch") || message.includes("Bridge returned HTTP")) {
    return "Start the v2 local bridge, then try again.";
  }
  return message || "Something went wrong.";
}

function isMissingBridgeRoute(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Not found." || message.includes("Not found");
}
