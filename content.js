(function () {
  const CONTENT_SCRIPT_VERSION = "2.1.58-referrer-match";
  if (
    globalThis.__APPLICATION_AUTOFILL_CONTENT_LOADED__ &&
    globalThis.__APPLICATION_AUTOFILL_CONTENT_VERSION__ === CONTENT_SCRIPT_VERSION
  ) {
    return;
  }

  globalThis.__APPLICATION_AUTOFILL_CONTENT_LOADED__ = true;
  globalThis.__APPLICATION_AUTOFILL_CONTENT_VERSION__ = CONTENT_SCRIPT_VERSION;

  const defaults = globalThis.ApplicationAutofillDefaults;
  const defaultProfile = defaults.defaultProfile;

  const FILL_STYLE_ID = "application-autofill-highlight-style";
  const FIELD_ID_ATTR = "data-application-autofill-field-id";
  const RADIO_GROUP_ID_ATTR = "data-application-autofill-radio-group-id";
  const TEXT_FIELD_SELECTOR =
    'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input[type="month"], input[type="search"], textarea, [contenteditable="true"]';
  const CONTROL_SELECTOR =
    `${TEXT_FIELD_SELECTOR}, select, input[type="radio"], input[type="checkbox"]`;
  const SNAPSHOT_SELECTOR = `${CONTROL_SELECTOR}, input[type="file"]`;
  const BRIDGE_BASE_URL = "http://127.0.0.1:17366";
  const CURRENT_JOB_STORAGE_KEY = "applicationTailor.currentJobId";
  const APPLY_INTENT_STORAGE_KEY = "applicationTailor.lastApplyIntent";
  const APPLY_INTENT_TTL_MS = 12 * 60 * 60 * 1000;
  const READINESS_BADGE_STYLE_ID = "application-tailor-readiness-badge-style";
  const READINESS_BADGE_STYLE_VERSION = "2.1.2";
  const READINESS_BADGE_ATTR = "data-application-tailor-readiness-badge";
  const READINESS_JOB_ID_ATTR = "data-application-tailor-job-id";
  const READINESS_RENDER_ATTR = "data-application-tailor-readiness-render";

  let readinessBadgeRefreshTimer = null;
  let readinessBadgeObserver = null;
  let applyIntentNavigationTimer = null;
  const autoAppliedMarkedJobIds = new Set();
  const autoAppliedMarkInFlightJobIds = new Set();

  globalThis.ApplicationAutofillApi = {
    version: CONTENT_SCRIPT_VERSION,
    handleMessage: handleApplicationAutofillMessage
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    handleApplicationAutofillMessage(message).then(sendResponse);
    return true;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startReadinessBadgeWatcher, { once: true });
  } else {
    startReadinessBadgeWatcher();
  }
  startApplyIntentWatcher();

  async function handleApplicationAutofillMessage(message) {
    try {
      if (message.type === "APPLICATION_AUTOFILL_CAPTURE_JOB_LISTINGS") {
        return { ok: true, batch: await captureJobListings(), version: CONTENT_SCRIPT_VERSION };
      }

      if (message.type === "APPLICATION_AUTOFILL_CAPTURE_JOB_PAGE") {
        return { ok: true, job: captureCurrentJobPage(), version: CONTENT_SCRIPT_VERSION };
      }

      if (message.type === "APPLICATION_AUTOFILL_CAPTURE_JOB_CONTEXT") {
        return { ok: true, job: captureJobContext(), version: CONTENT_SCRIPT_VERSION };
      }

      if (message.type === "APPLICATION_AUTOFILL_UPLOAD_RESUME") {
        return {
          ok: true,
          result: await autofillApplicationArtifacts({ ...message, files: [message.file || message] }),
          version: CONTENT_SCRIPT_VERSION
        };
      }

      if (message.type === "APPLICATION_AUTOFILL_UPLOAD_ARTIFACTS") {
        return {
          ok: true,
          result: await autofillApplicationArtifacts(message),
          version: CONTENT_SCRIPT_VERSION
        };
      }

      if (message.type === "APPLICATION_AUTOFILL_REFRESH_READINESS_BADGES") {
        if (Array.isArray(message.applications)) {
          renderReadinessBadges(message.applications);
          return { ok: true, version: CONTENT_SCRIPT_VERSION };
        }

        return { ok: true, result: await refreshReadinessBadges(), version: CONTENT_SCRIPT_VERSION };
      }

      return {
        ok: false,
        error: `Unsupported application autofill message: ${message.type}`,
        version: CONTENT_SCRIPT_VERSION
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        version: CONTENT_SCRIPT_VERSION
      };
    }
  }

  function fillApplication(profile, options) {
    ensureHighlightStyle();
    clearHighlights();

    const elements = Array.from(document.querySelectorAll(CONTROL_SELECTOR));
    const radioGroups = new Set();
    const stats = {
      filled: 0,
      skipped: 0,
      unsupported: 0,
      failed: 0,
      skippedLabels: [],
      filledLabels: []
    };

    for (const element of elements) {
      if (!isFillable(element)) {
        continue;
      }

      try {
        if (element.matches('input[type="radio"]')) {
          const name = element.name || getStableKey(element);
          if (radioGroups.has(name)) {
            continue;
          }
          radioGroups.add(name);
          const group = getRadioGroup(element);
          const handled = fillRadioGroup(group, profile);
          record(stats, handled);
          continue;
        }

        const handled = fillSingleElement(element, profile);
        record(stats, handled);
      } catch (_error) {
        stats.failed += 1;
      }
    }

    if (options.highlightSkipped) {
      highlightSkippedFields();
    }

    return stats;
  }

  function captureFormSnapshot() {
    const fields = [];
    const seenRadioGroups = new Set();
    const elements = Array.from(document.querySelectorAll(SNAPSHOT_SELECTOR));

    for (const element of elements) {
      if (!isVisibleControl(element)) {
        continue;
      }

      if (element.matches('input[type="radio"]')) {
        const group = getRadioGroup(element);
        const fieldId = assignRadioGroupId(group);
        if (seenRadioGroups.has(fieldId)) {
          continue;
        }
        seenRadioGroups.add(fieldId);
        fields.push(buildRadioGroupRecord(fieldId, group));
        continue;
      }

      fields.push(buildElementRecord(element));
    }

    return {
      schemaVersion: 1,
      sessionId: createSessionId(),
      url: window.location.href,
      title: document.title || "",
      timestamp: new Date().toISOString(),
      fieldCount: fields.length,
      fields
    };
  }

  async function captureJobListings() {
    const workdayBatch = await captureWorkdayStudentJobs();
    if (workdayBatch.jobs.length > 0) {
      return workdayBatch;
    }

    const jobs = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    for (const anchor of anchors) {
      const href = toAbsoluteUrl(anchor.getAttribute("href"));
      if (!href || !looksLikeJobLink(href, anchor)) {
        continue;
      }

      const container = nearestJobContainer(anchor);
      const title = extractJobTitle(anchor, container);
      const description = visibleSnippet(visibleText(container || anchor), 3000);
      const jobId = extractJobId(`${title} ${href} ${description}`);
      const key = `${href}::${normalize(title)}`;

      if (!title || isBadJobTitle(title) || !jobId || seen.has(key)) {
        continue;
      }

      seen.add(key);
      jobs.push({
        jobId,
        title,
        href,
        location: extractLabeledValue(description, ["location", "campus"]),
        department: extractLabeledValue(description, ["department", "unit"]),
        summary: description,
        sourceIndex: jobs.length
      });

      if (jobs.length >= 50) {
        break;
      }
    }

    return {
      schemaVersion: 1,
      batchId: createSessionId(),
      sourceUrl: window.location.href,
      title: document.title || "",
      timestamp: new Date().toISOString(),
      jobCount: jobs.length,
      jobs
    };
  }

  async function captureWorkdayStudentJobs() {
    const scroller = findWorkdayResultsScroller();
    const originalScrollTop = scroller ? scroller.scrollTop : 0;
    const jobsById = new Map();
    let unchangedRounds = 0;
    let lastCount = 0;

    for (let round = 0; round < 80; round += 1) {
      collectWorkdayJobsFromText(jobsById);

      if (!scroller) {
        break;
      }

      if (jobsById.size === lastCount) {
        unchangedRounds += 1;
      } else {
        unchangedRounds = 0;
        lastCount = jobsById.size;
      }

      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(280, scroller.clientHeight * 0.85), scroller.scrollHeight);
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(260);

      if ((scroller.scrollTop === before || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) && unchangedRounds >= 3) {
        break;
      }
    }

    if (scroller) {
      scroller.scrollTop = originalScrollTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    const jobs = Array.from(jobsById.values());
    return {
      schemaVersion: 1,
      batchId: createSessionId(),
      sourceUrl: window.location.href,
      title: document.title || "",
      timestamp: new Date().toISOString(),
      jobCount: jobs.length,
      jobs
    };
  }

  function startReadinessBadgeWatcher() {
    if (!document.body || readinessBadgeObserver || !shouldEnableReadinessBadges()) {
      return;
    }

    queueReadinessBadgeRefresh(700);
    readinessBadgeObserver = new MutationObserver((mutations) => {
      if (mutations.every(isReadinessBadgeMutation)) {
        return;
      }

      queueReadinessBadgeRefresh(1200);
    });
    readinessBadgeObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function shouldEnableReadinessBadges() {
    const bodyText = document.body ? rawVisibleText(document.body, 20000) : "";
    return /\bJR[-\s]?\d{4,}\b/i.test(`${window.location.href} ${document.title || ""} ${bodyText}`) ||
      /workday|myworkdayjobs|asu/i.test(`${window.location.href} ${document.title || ""}`);
  }

  function queueReadinessBadgeRefresh(delayMs) {
    clearTimeout(readinessBadgeRefreshTimer);
    readinessBadgeRefreshTimer = setTimeout(() => {
      refreshReadinessBadges().catch(() => {
        // The local bridge is optional for browsing; badges appear once it is running.
      });
    }, delayMs);
  }

  async function refreshReadinessBadges() {
    const jobIds = collectVisibleJobIds();
    if (jobIds.length === 0) {
      renderReadinessBadges([]);
      return { jobCount: 0, badgeCount: 0 };
    }

    let applications = await fetchKnownApplicationStatuses(jobIds);
    const autoMarkedApplied = await autoMarkAppliedJobs(jobIds, applications);
    if (autoMarkedApplied.length > 0) {
      applications = await fetchKnownApplicationStatuses(jobIds);
    }

    const badgeCount = renderReadinessBadges(applications);
    return { jobCount: jobIds.length, badgeCount, autoMarkedApplied: autoMarkedApplied.length };
  }

  function collectVisibleJobIds() {
    const text = [
      window.location.href,
      document.title || "",
      document.body ? rawVisibleText(document.body, 120000) : ""
    ].join("\n");
    const matches = text.match(/\bJR[-\s]?\d{4,}\b/gi) || [];
    return Array.from(new Set(matches.map(normalizeJobId).filter(Boolean)));
  }

  async function fetchKnownApplicationStatuses(jobIds) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "APPLICATION_AUTOFILL_FETCH_READINESS_STATUSES",
        jobIds
      });

      if (response && response.ok && Array.isArray(response.applications)) {
        return response.applications;
      }
    } catch (_error) {
      // Fall back to direct fetch for older loaded extension versions or service-worker startup races.
    }

    const query = encodeURIComponent(jobIds.join(","));
    const response = await fetch(`${BRIDGE_BASE_URL}/application/statuses?jobIds=${query}`);
    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Bridge returned HTTP ${response.status}.`);
    }

    return Array.isArray(data.applications) ? data.applications : [];
  }

  async function autoMarkAppliedJobs(jobIds, applications) {
    const statusesByJobId = new Map(
      (Array.isArray(applications) ? applications : [])
        .map((application) => [normalizeJobId(application && application.jobId), application])
        .filter(([jobId]) => Boolean(jobId))
    );
    const visibleAppliedJobs = collectVisibleAppliedJobs(jobIds)
      .filter((job) => {
        const jobId = normalizeJobId(job && job.jobId);
        if (!jobId || autoAppliedMarkedJobIds.has(jobId) || autoAppliedMarkInFlightJobIds.has(jobId)) {
          return false;
        }

        return getReadinessStatus(statusesByJobId.get(jobId)) !== "applied";
      });

    const markedJobIds = [];
    for (const job of visibleAppliedJobs) {
      const jobId = normalizeJobId(job && job.jobId);
      if (!jobId) {
        continue;
      }

      autoAppliedMarkInFlightJobIds.add(jobId);
      try {
        await markJobDispositionFromPage(job, "applied");
        autoAppliedMarkedJobIds.add(jobId);
        markedJobIds.push(jobId);
      } finally {
        autoAppliedMarkInFlightJobIds.delete(jobId);
      }
    }

    return markedJobIds;
  }

  function collectVisibleAppliedJobs(jobIds) {
    const ids = Array.from(new Set((Array.isArray(jobIds) ? jobIds : []).map(normalizeJobId).filter(Boolean)));
    if (ids.length === 0 || !document.body) {
      return [];
    }

    const bodyText = rawVisibleText(document.body, 120000);
    const currentJob = captureCurrentJobPage();
    const currentJobId = normalizeJobId(`${currentJob.jobId} ${currentJob.title} ${currentJob.url} ${currentJob.description}`);
    return ids
      .map((jobId) => {
        const isCurrentJob = jobId === currentJobId;
        const title = cleanCapturedJobTitle(isCurrentJob ? currentJob.title : inferVisibleJobTitle(jobId, bodyText));
        const signal = findAppliedSignalForJob({ jobId, title, bodyText, isCurrentJob });
        if (!signal) {
          return null;
        }

        return {
          schemaVersion: 2,
          jobId,
          title: title || jobId,
          url: isCurrentJob ? currentJob.url : window.location.href,
          pageTitle: document.title || "",
          timestamp: new Date().toISOString(),
          description: isCurrentJob ? currentJob.description : visibleSnippet(getJobScopedText(jobId, title, bodyText), 12000),
          autoMarkedFrom: "workday_applied_signal",
          autoMarkedSignal: signal
        };
      })
      .filter(Boolean);
  }

  function findAppliedSignalForJob({ jobId, title, bodyText, isCurrentJob }) {
    const titleNorm = normalize(title);
    if (isCurrentJob && currentPageLooksLikeJob(jobId, titleNorm)) {
      const headingSignal = findAppliedHeadingSignal(titleNorm);
      if (headingSignal) {
        return headingSignal;
      }

      const actionSignal = findAppliedActionSignal();
      if (actionSignal) {
        return actionSignal;
      }
    }

    return findAppliedTextSignal(getJobScopedText(jobId, title, bodyText));
  }

  function findAppliedHeadingSignal(titleNorm) {
    if (!titleNorm) {
      return "";
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']"))
      .filter((element) => element instanceof HTMLElement && isVisibleElement(element));
    for (const heading of headings) {
      const text = normalize(visibleText(heading));
      if (text === `${titleNorm} applied` || text.startsWith(`${titleNorm} applied `)) {
        return visibleSnippet(visibleText(heading), 180);
      }
    }

    return "";
  }

  function findAppliedActionSignal() {
    const actionLabels = [
      "view application",
      "review application",
      "withdraw application",
      "application submitted"
    ];
    const actions = Array.from(document.querySelectorAll("button, a[href], [role='button']"));
    for (const action of actions) {
      if (!(action instanceof HTMLElement) || !isVisibleElement(action)) {
        continue;
      }

      const label = normalize(visibleText(action) || action.getAttribute("aria-label") || action.getAttribute("title") || "");
      if (actionLabels.includes(label)) {
        return visibleSnippet(visibleText(action) || action.getAttribute("aria-label") || "", 120);
      }
    }

    return "";
  }

  function findAppliedTextSignal(text) {
    const lines = String(text || "")
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const line of lines) {
      if (/^applied\s+(?:\d{1,2}\/\d{1,2}\/\d{2,4}|today|yesterday)\b/i.test(line)) {
        return visibleSnippet(line, 180);
      }

      if (/^(?:already applied|application submitted|application complete|application received)$/i.test(line)) {
        return visibleSnippet(line, 180);
      }
    }

    const normalized = normalize(lines.join(" "));
    const phrases = [
      "already applied",
      "you have applied",
      "you applied",
      "application submitted",
      "application complete",
      "application received",
      "your application has been submitted"
    ];
    const phrase = phrases.find((item) => hasAny(normalized, [item]));
    return phrase || "";
  }

  function getJobScopedText(jobId, title, bodyText) {
    const text = String(bodyText || "");
    const snippets = [];
    const jobIdIndex = text.toUpperCase().indexOf(jobId);
    if (jobIdIndex >= 0) {
      snippets.push(text.slice(Math.max(0, jobIdIndex - 1600), Math.min(text.length, jobIdIndex + 2200)));
    }

    const titleNorm = normalize(title);
    if (titleNorm) {
      const lines = text.split(/\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (normalize(lines[index]).includes(titleNorm)) {
          snippets.push(lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 8)).join("\n"));
          break;
        }
      }
    }

    return snippets.length > 0 ? snippets.join("\n") : text.slice(0, 5000);
  }

  async function markJobDispositionFromPage(job, disposition) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "APPLICATION_AUTOFILL_MARK_JOB_DISPOSITIONS",
        disposition,
        jobs: [job]
      });

      if (response && response.ok) {
        return response;
      }
    } catch (_error) {
      // Fall back to direct fetch for older loaded service workers.
    }

    const response = await fetch(`${BRIDGE_BASE_URL}/job/disposition`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ job, disposition })
    });
    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Bridge returned HTTP ${response.status}.`);
    }

    return data;
  }

  function renderReadinessBadges(applications) {
    const previousObserver = readinessBadgeObserver;
    if (previousObserver) {
      previousObserver.disconnect();
    }

    try {
      ensureReadinessBadgeStyle();
      const renderId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      let badgeCount = 0;
      for (const application of Array.isArray(applications) ? applications : []) {
        const status = getReadinessStatus(application);
        if (!status || status === "not_started") {
          continue;
        }

        const targets = findReadinessTargets(application);
        for (const target of targets) {
          attachReadinessBadge(target, application, status, renderId);
          badgeCount += 1;
        }
      }

      removeStaleReadinessBadges(renderId);
      return badgeCount;
    } finally {
      if (previousObserver && document.body) {
        previousObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }
    }
  }

  function clearReadinessBadges() {
    document.querySelectorAll(`[${READINESS_BADGE_ATTR}]`).forEach((badge) => {
      badge.remove();
    });
  }

  function removeStaleReadinessBadges(renderId) {
    document.querySelectorAll(`[${READINESS_BADGE_ATTR}]`).forEach((badge) => {
      if (badge.getAttribute(READINESS_RENDER_ATTR) !== renderId) {
        badge.remove();
      }
    });
  }

  function findReadinessTargets(application) {
    const jobId = normalizeJobId(application && application.jobId);
    const titleNorms = getReadinessTitleNorms(application, jobId);
    if (!jobId || titleNorms.length === 0) {
      return [];
    }

    if (titleNorms.some((titleNorm) => currentPageLooksLikeJob(jobId, titleNorm))) {
      const currentPageTarget = findCurrentJobPageBadgeTarget(titleNorms);
      return currentPageTarget ? [currentPageTarget] : [];
    }

    const targets = [];
    const seen = new Set();
    const selectors = [
      "a[href]",
      "[role='link']",
      "h1",
      "h2",
      "h3",
      "[role='heading']",
      "[data-automation-id*='jobTitle']",
      "[data-automation-id*='JobTitle']",
      "[data-automation-id*='title']",
      "[data-automation-id*='Title']"
    ].join(",");

    for (const titleNorm of titleNorms) {
      for (const candidate of Array.from(document.querySelectorAll(selectors))) {
        addReadinessTarget(candidate, { jobId, titleNorm, targets, seen });
      }
    }

    for (const titleNorm of titleNorms) {
      if (targets.length > 0) {
        break;
      }

      for (const candidate of findTextNodeTitleTargets(titleNorm)) {
        addReadinessTarget(candidate, { jobId, titleNorm, targets, seen });
      }
    }

    if (targets.length === 0 && titleNorms.some((titleNorm) => currentPageLooksLikeJob(jobId, titleNorm))) {
      addFallbackReadinessTarget(findCurrentJobPageBadgeTarget(titleNorms), { targets, seen });
    }

    return targets.slice(0, 12);
  }

  function getReadinessTitleNorms(application, jobId) {
    const norms = new Set();
    const savedTitle = cleanCapturedJobTitle(String(application && application.title ? application.title : "").trim());
    if (savedTitle && !isBadJobTitle(savedTitle)) {
      norms.add(normalize(savedTitle));
    }

    const bodyText = document.body ? rawVisibleText(document.body, 80000) : "";
    const lines = bodyText
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length - 1; index += 1) {
      const title = cleanCapturedJobTitle(lines[index]);
      const meta = lines[index + 1];
      if (textMentionsJobId(meta, jobId) && !isBadJobTitle(title)) {
        norms.add(normalize(title));
      }
    }

    if (textMentionsJobId(`${window.location.href} ${document.title || ""} ${bodyText}`, jobId)) {
      const currentTitle = extractCurrentJobTitle(bodyText, document.title || "");
      if (currentTitle && !isBadJobTitle(currentTitle)) {
        norms.add(normalize(cleanCapturedJobTitle(currentTitle)));
      }
    }

    return Array.from(norms).filter(Boolean);
  }

  function addReadinessTarget(candidate, context) {
    if (!(candidate instanceof HTMLElement) || !isVisibleElement(candidate)) {
      return;
    }

    const candidateText = visibleText(candidate);
    if (!readinessTitleMatches(candidateText, context.titleNorm)) {
      return;
    }

    const hasNearbyJobId = elementOrNearbyTextMentionsJobId(candidate, context.jobId);
    const isLikelyCurrentPageTitle = isTitleHeading(candidate) && currentPageLooksLikeJob(context.jobId, context.titleNorm);
    if (!hasNearbyJobId && !isLikelyCurrentPageTitle) {
      return;
    }

    const target = candidate.closest("a[href], h1, h2, h3, [role='heading']") || candidate;
    addFallbackReadinessTarget(target, context);
  }

  function addFallbackReadinessTarget(target, context) {
    if (!(target instanceof HTMLElement) || !isVisibleElement(target)) {
      return;
    }

    if (context.seen.has(target)) {
      return;
    }

    context.seen.add(target);
    context.targets.push(target);
  }

  function findCurrentJobPageBadgeTarget(titleNorms) {
    const selectors = [
      "h1",
      "h2",
      "h3",
      "[role='heading']",
      "[data-automation-id*='jobTitle']",
      "[data-automation-id*='JobTitle']",
      "[data-automation-id*='title']",
      "[data-automation-id*='Title']"
    ].join(",");
    const headings = Array.from(document.querySelectorAll(selectors))
      .filter((element) => element instanceof HTMLElement && isVisibleElement(element));

    for (const titleNorm of titleNorms) {
      const exact = headings.find((element) => readinessTitleMatches(visibleText(element), titleNorm));
      if (exact) {
        return exact.closest("h1, h2, h3, [role='heading']") || exact;
      }
    }

    const usefulHeading = headings.find((element) => {
      const text = normalize(visibleText(element));
      return text && !hasAny(text, [
        "view job posting details",
        "job details",
        "similar jobs",
        "accessibility overview"
      ]);
    });
    return usefulHeading || headings[0] || document.body;
  }

  function findTextNodeTitleTargets(titleNorm) {
    const targets = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 180 || normalize(text) !== titleNorm) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent || parent.closest(`[${READINESS_BADGE_ATTR}], script, style, noscript`)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node && targets.length < 24) {
      if (node.parentElement) {
        targets.push(node.parentElement);
      }
      node = walker.nextNode();
    }

    return targets;
  }

  function readinessTitleMatches(value, titleNorm) {
    const text = normalize(value);
    return text === titleNorm || text.startsWith(`${titleNorm} `) || text.includes(` ${titleNorm} `);
  }

  function elementOrNearbyTextMentionsJobId(element, jobId) {
    if (textMentionsJobId([
      element.getAttribute("href") || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      visibleText(element)
    ].join(" "), jobId)) {
      return true;
    }

    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const text = rawVisibleText(current, 7000);
      if (text.length < 7000 && textMentionsJobId(text, jobId)) {
        return true;
      }

      if (nearbyNodeTextMentionsJobId(current, jobId)) {
        return true;
      }

      current = current.parentElement;
    }

    return false;
  }

  function nearbyNodeTextMentionsJobId(node, jobId) {
    const candidates = [
      node.previousSibling,
      node.nextSibling,
      node.previousElementSibling,
      node.nextElementSibling,
      node.parentElement ? node.parentElement.previousSibling : null,
      node.parentElement ? node.parentElement.nextSibling : null,
      node.parentElement ? node.parentElement.previousElementSibling : null,
      node.parentElement ? node.parentElement.nextElementSibling : null
    ];

    return candidates.some((candidate) => textMentionsJobId(nodeVisibleText(candidate, 5000), jobId));
  }

  function nodeVisibleText(node, maxLength) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.nodeValue || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
    }

    if (node instanceof Element) {
      return rawVisibleText(node, maxLength);
    }

    return "";
  }

  function currentPageLooksLikeJob(jobId, titleNorm) {
    if (!jobId || !titleNorm) {
      return false;
    }

    const bodyText = document.body ? rawVisibleText(document.body, 30000) : "";
    const normalizedBody = normalize(bodyText);
    return textMentionsJobId(`${window.location.href} ${document.title || ""} ${bodyText}`, jobId) &&
      normalizedBody.includes(titleNorm) &&
      pageHasJobPostDetailMarkers(normalizedBody);
  }

  function pageHasJobPostDetailMarkers(normalizedBody) {
    const markers = [
      "view job posting details",
      "job requisition id",
      "job profile",
      "minimum qualifications",
      "job description",
      "posting end date"
    ];
    return markers.filter((marker) => hasAny(normalizedBody, [marker])).length >= 3;
  }

  function textMentionsJobId(value, jobId) {
    const matches = String(value || "").match(/\bJR[-\s]?\d{3,}\b/gi) || [];
    return matches.some((match) => normalizeJobId(match) === jobId);
  }

  function attachReadinessBadge(target, application, status, renderId) {
    const jobId = normalizeJobId(application.jobId);
    const existing = findExistingReadinessBadge(target, jobId) || findRelocatableCurrentJobBadge(target, application, jobId);
    const badge = existing || document.createElement("span");
    badge.setAttribute(READINESS_BADGE_ATTR, status);
    badge.setAttribute(READINESS_JOB_ID_ATTR, jobId);
    badge.setAttribute(READINESS_RENDER_ATTR, renderId);
    badge.textContent = getReadinessLabel(status, application);
    applyReadinessBadgeColors(badge, status);
    badge.title = [
      application.jobId || "",
      application.progressMessage || "",
      typeof application.documentCount === "number" ? `${application.documentCount}/2 documents` : "",
      isArtifactOpenStatus(status) ? "Click to open resume and cover letter." : "",
      status === "applied" ? "Marked as applied." : "",
      status === "dont_qualify" ? "Marked as don't qualify." : "",
      isKnowledgeReviewStatus(status) ? "Click to review pending skills and stories for this job." : ""
    ].filter(Boolean).join(" - ");
    configureReadinessBadgeInteraction(badge, application, status);

    if (existing) {
      placeReadinessBadge(target, badge);
      return;
    }

    placeReadinessBadge(target, badge);
  }

  function placeReadinessBadge(target, badge) {
    if (isTitleHeading(target)) {
      if (badge.parentElement !== target) {
        target.appendChild(badge);
      }
      return;
    }

    if (badge.previousElementSibling !== target) {
      target.insertAdjacentElement("afterend", badge);
    }
  }

  function configureReadinessBadgeInteraction(badge, application, status) {
    if (isArtifactOpenStatus(status) || isKnowledgeReviewStatus(status)) {
      badge.setAttribute("role", "button");
      badge.tabIndex = 0;
      badge.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isArtifactOpenStatus(status)) {
          openApplicationArtifactsFromBadge(badge, application);
        } else {
          openKnowledgeReviewFromBadge(badge, application);
        }
      };
      badge.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (isArtifactOpenStatus(status)) {
          openApplicationArtifactsFromBadge(badge, application);
        } else {
          openKnowledgeReviewFromBadge(badge, application);
        }
      };
      return;
    }

    badge.removeAttribute("role");
    badge.removeAttribute("tabindex");
    badge.onclick = null;
    badge.onkeydown = null;
  }

  function findExistingReadinessBadge(target, jobId) {
    if (!target || !jobId) {
      return null;
    }

    if (isTitleHeading(target)) {
      const directBadge = Array.from(target.children || []).find((child) => badgeMatchesJob(child, jobId));
      if (directBadge) {
        return directBadge;
      }
    }

    const next = target.nextElementSibling;
    return badgeMatchesJob(next, jobId) ? next : null;
  }

  function findRelocatableCurrentJobBadge(target, application, jobId) {
    if (!target || !application || !jobId) {
      return null;
    }

    const titleNorms = getReadinessTitleNorms(application, jobId);
    if (!titleNorms.some((titleNorm) => currentPageLooksLikeJob(jobId, titleNorm))) {
      return null;
    }

    const badges = Array.from(document.querySelectorAll(`[${READINESS_BADGE_ATTR}]`))
      .filter((badge) => badgeMatchesJob(badge, jobId));
    return badges.length === 1 ? badges[0] : null;
  }

  function badgeMatchesJob(element, jobId) {
    return Boolean(
      element &&
      element instanceof HTMLElement &&
      element.hasAttribute(READINESS_BADGE_ATTR) &&
      normalizeJobId(element.getAttribute(READINESS_JOB_ID_ATTR)) === jobId
    );
  }

  function applyReadinessBadgeColors(badge, status) {
    const colors = getReadinessBadgeColors(status);
    badge.style.setProperty("border-color", colors.border, "important");
    badge.style.setProperty("background", colors.background, "important");
    badge.style.setProperty("color", colors.color, "important");
    if (colors.cursor) {
      badge.style.setProperty("cursor", colors.cursor, "important");
    } else {
      badge.style.removeProperty("cursor");
    }
  }

  function getReadinessBadgeColors(status) {
    if (status === "ready") {
      return {
        border: "#8fc7a1",
        background: "#e8f6eb",
        color: "#155c2f",
        cursor: "pointer"
      };
    }
    if (status === "running" || status === "queued") {
      return {
        border: "#e4bf6f",
        background: "#fff4d6",
        color: "#6f4a00"
      };
    }
    if (status === "processed") {
      return {
        border: "#82b7d3",
        background: "#e8f5fb",
        color: "#144f69"
      };
    }
    if (status === "applied") {
      return {
        border: "#77b987",
        background: "#e4f5e9",
        color: "#185a2f",
        cursor: "pointer"
      };
    }
    if (status === "dont_qualify") {
      return {
        border: "#d7958d",
        background: "#fff0ed",
        color: "#7a2c25"
      };
    }
    if (isKnowledgeReviewStatus(status)) {
      return {
        border: "#d3b15f",
        background: "#fff7df",
        color: "#674b00",
        cursor: "pointer"
      };
    }
    if (status === "failed") {
      return {
        border: "#df9b9b",
        background: "#ffe9e7",
        color: "#842424"
      };
    }
    return {
      border: "#cbd4ce",
      background: "#f4f6f5",
      color: "#33424b"
    };
  }

  async function openKnowledgeReviewFromBadge(badge, application) {
    const jobId = normalizeJobId(application && application.jobId);
    if (badge.getAttribute("aria-busy") === "true") {
      return;
    }

    const previousText = badge.textContent;
    const previousTitle = badge.title;
    badge.setAttribute("aria-busy", "true");
    badge.textContent = "Opening...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "APPLICATION_AUTOFILL_OPEN_KNOWLEDGE_REVIEW",
        jobId
      });

      if (!response || response.ok === false) {
        throw new Error(response && response.error ? response.error : "Could not open review page.");
      }

      badge.textContent = "Opened";
      badge.title = jobId
        ? `Opened skills and stories review for ${jobId}.`
        : "Opened skills and stories review.";
      setTimeout(() => {
        badge.textContent = previousText;
        badge.title = previousTitle;
        badge.removeAttribute("aria-busy");
      }, 1400);
    } catch (error) {
      badge.textContent = "Open failed";
      badge.title = error instanceof Error ? error.message : String(error);
      setTimeout(() => {
        badge.textContent = previousText;
        badge.title = previousTitle;
        badge.removeAttribute("aria-busy");
      }, 2400);
    }
  }

  async function openApplicationArtifactsFromBadge(badge, application) {
    const jobId = normalizeJobId(application && application.jobId);
    if (!jobId || badge.getAttribute("aria-busy") === "true") {
      return;
    }

    const previousText = badge.textContent;
    const previousTitle = badge.title;
    badge.setAttribute("aria-busy", "true");
    badge.textContent = "Opening...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "APPLICATION_AUTOFILL_OPEN_APPLICATION_ARTIFACTS",
        jobId
      });

      if (!response || response.ok === false) {
        throw new Error(response && response.error ? response.error : "Could not open documents.");
      }

      badge.textContent = "Opened";
      badge.title = "Opened resume and cover letter.";
      setTimeout(() => {
        badge.textContent = previousText;
        badge.title = previousTitle;
        badge.removeAttribute("aria-busy");
      }, 1400);
    } catch (error) {
      badge.textContent = "Open failed";
      badge.title = error instanceof Error ? error.message : String(error);
      setTimeout(() => {
        badge.textContent = previousText;
        badge.title = previousTitle;
        badge.removeAttribute("aria-busy");
      }, 2400);
    }
  }

  function getReadinessLabel(status, application) {
    if (status === "applied") {
      return "Applied";
    }

    if (status === "dont_qualify") {
      return "Don't Qualify";
    }

    if (status === "ready") {
      return "Ready";
    }

    if (status === "running") {
      return "Preparing";
    }

    if (status === "queued") {
      return "Queued";
    }

    if (status === "needs_review_of_skills") {
      return "Needs Review";
    }

    if (status === "processed") {
      return "Processed";
    }

    if (status === "failed") {
      return "Failed";
    }

    return application && application.status ? String(application.status) : "Status";
  }

  function getReadinessStatus(application) {
    return normalizeReadinessStatus(application && (application.jobDisposition || application.status));
  }

  function normalizeReadinessStatus(status) {
    return String(status || "").toLowerCase().replace(/[^a-z_]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function isKnowledgeReviewStatus(status) {
    return status === "needs_review_of_skills";
  }

  function isArtifactOpenStatus(status) {
    return status === "ready" || status === "applied";
  }

  function isTitleHeading(element) {
    return element.matches("h1, h2, h3, [role='heading']");
  }

  function isReadinessBadgeMutation(mutation) {
    const nodes = [
      mutation.target,
      ...Array.from(mutation.addedNodes || []),
      ...Array.from(mutation.removedNodes || [])
    ];

    return nodes.every((node) => {
      if (node instanceof Text) {
        const parent = node.parentElement;
        return Boolean(parent && parent.closest(`[${READINESS_BADGE_ATTR}]`));
      }

      if (!(node instanceof Element)) {
        return false;
      }
      return Boolean(node.closest(`[${READINESS_BADGE_ATTR}]`) || node.hasAttribute(READINESS_BADGE_ATTR));
    });
  }

  function ensureReadinessBadgeStyle() {
    const existing = document.getElementById(READINESS_BADGE_STYLE_ID);
    if (existing && existing.dataset.version === READINESS_BADGE_STYLE_VERSION) {
      return;
    }

    const style = existing || document.createElement("style");
    style.id = READINESS_BADGE_STYLE_ID;
    style.dataset.version = READINESS_BADGE_STYLE_VERSION;
    style.textContent = `
      [${READINESS_BADGE_ATTR}] {
        display: inline-flex !important;
        align-items: center !important;
        max-width: 11rem !important;
        min-height: 1.35rem !important;
        margin-left: 0.45rem !important;
        padding: 0.12rem 0.45rem !important;
        border: 1px solid transparent !important;
        border-radius: 999px !important;
        font: 700 0.72rem/1.2 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0 !important;
        text-decoration: none !important;
        text-transform: none !important;
        vertical-align: middle !important;
        white-space: nowrap !important;
      }

      [${READINESS_BADGE_ATTR}="ready"],
      [${READINESS_BADGE_ATTR}="applied"] {
        border-color: #8fc7a1 !important;
        background: #e8f6eb !important;
        color: #155c2f !important;
        cursor: pointer !important;
      }

      [${READINESS_BADGE_ATTR}="ready"]:hover,
      [${READINESS_BADGE_ATTR}="ready"]:focus-visible,
      [${READINESS_BADGE_ATTR}="applied"]:hover,
      [${READINESS_BADGE_ATTR}="applied"]:focus-visible {
        border-color: #5da976 !important;
        background: #d7f0de !important;
        outline: 2px solid rgba(21, 92, 47, 0.25) !important;
        outline-offset: 2px !important;
      }

      [${READINESS_BADGE_ATTR}="running"],
      [${READINESS_BADGE_ATTR}="queued"] {
        border-color: #e4bf6f !important;
        background: #fff4d6 !important;
        color: #6f4a00 !important;
      }

      [${READINESS_BADGE_ATTR}="processed"] {
        border-color: #82b7d3 !important;
        background: #e8f5fb !important;
        color: #144f69 !important;
      }

      [${READINESS_BADGE_ATTR}="dont_qualify"] {
        border-color: #d7958d !important;
        background: #fff0ed !important;
        color: #7a2c25 !important;
      }

      [${READINESS_BADGE_ATTR}="needs_review_of_skills"] {
        border-color: #d3b15f !important;
        background: #fff7df !important;
        color: #674b00 !important;
        cursor: pointer !important;
      }

      [${READINESS_BADGE_ATTR}="needs_review_of_skills"]:hover,
      [${READINESS_BADGE_ATTR}="needs_review_of_skills"]:focus-visible {
        border-color: #b8922d !important;
        background: #ffefbd !important;
        outline: 2px solid rgba(103, 75, 0, 0.24) !important;
        outline-offset: 2px !important;
      }

      [${READINESS_BADGE_ATTR}="failed"] {
        border-color: #df9b9b !important;
        background: #ffe9e7 !important;
        color: #842424 !important;
      }
    `;
    if (!existing) {
      document.documentElement.appendChild(style);
    }
  }

  function collectWorkdayJobsFromText(jobsById) {
    const text = rawVisibleText(document.body, 60000);
    const lines = text
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length - 1; index += 1) {
      const title = cleanCapturedJobTitle(lines[index]);
      const meta = lines[index + 1];
      const idMatch = meta.match(/\bJR\d{4,}\b/i);

      if (!idMatch || isBadJobTitle(title)) {
        continue;
      }

      const jobId = idMatch[0].toUpperCase();
      if (jobsById.has(jobId)) {
        continue;
      }

      jobsById.set(jobId, {
        jobId,
        title,
        href: findHrefForTitle(title),
        location: extractWorkdayMeta(meta, "Campus") || extractWorkdayMeta(meta, "Off-Campus"),
        department: "",
        postingDate: extractWorkdayMeta(meta, "Posting Date"),
        summary: `${title}\n${meta}`,
        sourceIndex: jobsById.size
      });
    }
  }

  function findWorkdayResultsScroller() {
    const candidates = Array.from(document.querySelectorAll("main, [role='main'], [data-automation-id], section, div"))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const text = rawVisibleText(element, 12000);
        return element.scrollHeight > element.clientHeight + 80 && /\bJR\d{4,}\b/i.test(text);
      })
      .sort((a, b) => rawVisibleText(a, 12000).length - rawVisibleText(b, 12000).length);

    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function findHrefForTitle(title) {
    const titleNorm = normalize(title);
    const anchor = Array.from(document.querySelectorAll("a[href]")).find((item) => normalize(visibleText(item)) === titleNorm);
    return anchor ? toAbsoluteUrl(anchor.getAttribute("href")) : "";
  }

  function extractWorkdayMeta(meta, label) {
    const parts = String(meta || "").split("|").map((part) => part.trim());
    const normalizedLabel = normalize(label);

    for (const part of parts) {
      if (normalize(part).startsWith(normalizedLabel)) {
        return part.replace(new RegExp(`^${label}\\s*:\\s*`, "i"), "").trim();
      }
    }

    return "";
  }

  function isBadJobTitle(title) {
    const normalized = normalize(title);
    return (
      !normalized ||
      normalized.length < 3 ||
      normalized.length > 160 ||
      /^https?:\/\//i.test(title) ||
      hasAny(normalized, [
        "workday",
        "search results",
        "saved searches",
        "current search",
        "privacy",
        "clery",
        "human resources",
        "job requisition id",
        "job details",
        "view all apps",
        "new chrome available",
        "accessibility overview"
      ])
    );
  }

  function captureCurrentJobPage() {
    const bodyText = visibleSnippet(visibleText(document.body), 12000);
    const heading = document.querySelector("h1, h2, [data-automation-id*='jobTitle'], [data-automation-id*='JobTitle']");
    const title = extractCurrentJobTitle(bodyText, heading ? visibleText(heading) : document.title || "");
    const jobId = extractLabeledJobId(bodyText) || extractJobId(`${title} ${window.location.href} ${bodyText}`) || createSessionId();

    return {
      schemaVersion: 1,
      jobId,
      title,
      url: window.location.href,
      referrer: document.referrer || "",
      pageTitle: document.title || "",
      timestamp: new Date().toISOString(),
      description: bodyText,
      applyButtons: findApplyButtons()
    };
  }

  function extractCurrentJobTitle(bodyText, fallbackTitle) {
    const applicationTitle = extractApplicationJobTitle(`${fallbackTitle || ""}\n${document.title || ""}\n${bodyText || ""}`);
    if (applicationTitle) {
      return cleanCapturedJobTitle(applicationTitle);
    }

    const lines = String(bodyText || "")
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const candidates = [fallbackTitle, ...lines];

    for (const candidate of candidates) {
      const title = cleanCapturedJobTitle(candidate);
      const normalized = normalize(title);
      if (
        title.length >= 3 &&
        title.length <= 160 &&
        !/^jr\d+$/i.test(title) &&
        !normalized.includes("http") &&
        !hasAny(normalized, [
          "skip to main content",
          "accessibility overview",
          "view job posting details",
          "job application for",
          "job details",
          "job profile",
          "job family",
          "time type",
          "apply",
          "home",
          "personal resources",
          "saved",
          "search"
        ])
      ) {
        return title;
      }
    }

    return cleanCapturedJobTitle(fallbackTitle || document.title || "");
  }

  function inferVisibleJobTitle(jobId, bodyText) {
    const lines = String(bodyText || "")
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      if (!textMentionsJobId(lines[index], jobId)) {
        continue;
      }

      for (let offset = 1; offset <= 4; offset += 1) {
        const title = cleanCapturedJobTitle(lines[index - offset]);
        if (title && !isBadJobTitle(title)) {
          return title;
        }
      }
    }

    return "";
  }

  function cleanCapturedJobTitle(value) {
    return visibleSnippet(String(value || "")
      .replace(/\s+(?:Applied|Don't Qualify|Ready|Processed|Preparing|Queued|Needs Review|Failed|Status)\s*$/i, "")
      .replace(/\s+(?:Applied|Don't Qualify|Ready|Processed|Preparing|Queued|Needs Review|Failed|Status)\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$/i, "")
      .trim(), 180);
  }

  function extractApplicationJobTitle(value) {
    const lines = String(value || "")
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const line of lines) {
      const applicationMatch = line.match(/^Job Application for\s+(.+)$/i);
      if (applicationMatch && applicationMatch[1]) {
        return cleanApplicationJobTitle(applicationMatch[1]);
      }

      const uploadTitleMatch = line.match(/^(.+?)\s*:\s*(?:Upload Resume or CV|Quick Apply|My Experience|Application Questions|Voluntary Disclosures|Self Identify|Review)(?:\s*-\s*Workday)?$/i);
      if (uploadTitleMatch && uploadTitleMatch[1]) {
        return cleanApplicationJobTitle(uploadTitleMatch[1]);
      }
    }

    return "";
  }

  function cleanApplicationJobTitle(value) {
    return visibleSnippet(String(value || "")
      .replace(/\s*-\s*Workday.*$/i, "")
      .replace(/\s*:\s*(?:Upload Resume or CV|Quick Apply|My Experience|Application Questions|Voluntary Disclosures|Self Identify|Review).*$/i, "")
      .trim(), 180);
  }

  function captureJobContext() {
    const page = captureCurrentJobPage();
    const description = visibleSnippet(page.description || visibleText(document.body), 15000);

    return {
      schemaVersion: 2,
      jobId: normalizeJobId(`${page.jobId} ${page.title} ${page.url} ${description}`),
      title: page.title,
      url: page.url,
      referrer: page.referrer,
      pageTitle: page.pageTitle,
      timestamp: new Date().toISOString(),
      description,
      requirements: extractRequirements(description),
      applyButtons: page.applyButtons,
      applyIntent: getApplyIntentForCurrentPage()
    };
  }

  function startApplyIntentWatcher() {
    document.addEventListener("pointerdown", rememberApplyIntentFromInteraction, true);
    document.addEventListener("click", rememberApplyIntentFromInteraction, true);
    document.addEventListener("keydown", rememberApplyIntentFromInteraction, true);
    refreshApplyIntentForCurrentApplyPage();
  }

  function rememberApplyIntentFromInteraction(event) {
    if (event && event.type === "keydown" && !["Enter", " ", "Spacebar"].includes(event.key)) {
      return;
    }

    const target = event && event.target instanceof Element ? event.target : null;
    const control = target ? target.closest("button, a[href], [role='button']") : null;
    if (!control) {
      return;
    }

    const label = normalize([
      visibleText(control),
      control.getAttribute("aria-label") || "",
      control.getAttribute("title") || ""
    ].join(" "));
    if (!/\bapply\b/.test(label)) {
      return;
    }

    const job = captureJobContext();
    const jobId = normalizeJobId(`${job.jobId} ${job.title} ${job.url} ${job.description}`);
    if (!jobId || !pageLooksLikeWorkdayJobPost(job)) {
      return;
    }

    const href = control.href || control.getAttribute("href") || "";
    const applyUrl = href ? toAbsoluteUrl(href) : "";
    const intent = {
      schemaVersion: 1,
      source: `workday_apply_${event && event.type || "interaction"}`,
      jobId,
      title: job.title || "",
      jobUrl: window.location.href,
      pageTitle: document.title || "",
      applyUrl,
      applyToken: extractWorkdayApplyToken(applyUrl),
      clickedAt: Date.now()
    };

    try {
      writeApplyIntentToSession(intent);
      chrome.storage.local.set({
        [CURRENT_JOB_STORAGE_KEY]: jobId,
        [APPLY_INTENT_STORAGE_KEY]: intent
      });
      trackApplyNavigation(intent);
    } catch (_error) {
      // Best effort only; the popup still has other page-resolution paths.
    }
  }

  function refreshApplyIntentForCurrentApplyPage() {
    const applyToken = extractWorkdayApplyToken(window.location.href);
    if (!applyToken) {
      return;
    }

    try {
      const sessionIntent = getApplyIntentForCurrentPage();
      if (sessionIntent) {
        chrome.storage.local.set({
          [CURRENT_JOB_STORAGE_KEY]: sessionIntent.jobId,
          [APPLY_INTENT_STORAGE_KEY]: sessionIntent
        });
        return;
      }

      chrome.storage.local.get({ [APPLY_INTENT_STORAGE_KEY]: null }, (stored) => {
        const intent = stored && stored[APPLY_INTENT_STORAGE_KEY];
        const clickedAt = Number(intent && intent.clickedAt || 0);
        if (!intent || !clickedAt || Date.now() - clickedAt > APPLY_INTENT_TTL_MS) {
          return;
        }

        const previousToken = String(intent.applyToken || "");
        if (previousToken && previousToken !== applyToken) {
          return;
        }

        chrome.storage.local.set({
          [APPLY_INTENT_STORAGE_KEY]: {
            ...intent,
            applyUrl: window.location.href,
            applyToken,
            navigatedAt: intent.navigatedAt || Date.now()
          }
        });
      });
    } catch (_error) {
      // Best effort only; the popup can still require an unambiguous page match.
    }
  }

  function writeApplyIntentToSession(intent) {
    try {
      window.sessionStorage.setItem(APPLY_INTENT_STORAGE_KEY, JSON.stringify(intent));
    } catch (_error) {
      // Session storage is a synchronous handoff only; Chrome storage remains the fallback.
    }
  }

  function getApplyIntentForCurrentPage() {
    const intent = readApplyIntentFromSession();
    const clickedAt = Number(intent && intent.clickedAt || 0);
    if (!intent || !clickedAt || Date.now() - clickedAt > APPLY_INTENT_TTL_MS) {
      return null;
    }

    const applyToken = extractWorkdayApplyToken(window.location.href);
    const intentApplyToken = String(intent.applyToken || "");
    if (applyToken && intentApplyToken && applyToken !== intentApplyToken) {
      return null;
    }

    return {
      ...intent,
      applyUrl: applyToken ? window.location.href : intent.applyUrl || "",
      applyToken: applyToken || intentApplyToken,
      navigatedAt: applyToken ? intent.navigatedAt || Date.now() : intent.navigatedAt
    };
  }

  function readApplyIntentFromSession() {
    try {
      const raw = window.sessionStorage.getItem(APPLY_INTENT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function trackApplyNavigation(intent) {
    clearInterval(applyIntentNavigationTimer);
    const startedAt = Date.now();
    applyIntentNavigationTimer = setInterval(() => {
      const applyToken = extractWorkdayApplyToken(window.location.href);
      if (applyToken) {
        clearInterval(applyIntentNavigationTimer);
        chrome.storage.local.set({
          [APPLY_INTENT_STORAGE_KEY]: {
            ...intent,
            applyUrl: window.location.href,
            applyToken,
            navigatedAt: Date.now()
          }
        });
        return;
      }

      if (Date.now() - startedAt > 30000) {
        clearInterval(applyIntentNavigationTimer);
      }
    }, 250);
  }

  function pageLooksLikeWorkdayJobPost(job) {
    const text = normalize([
      job && job.title,
      job && job.pageTitle,
      job && job.description,
      job && job.url
    ].join("\n"));

    return hasAny(text, [
      "view job posting details",
      "job requisition id",
      "job profile",
      "minimum qualifications",
      "job description"
    ]);
  }

  function extractWorkdayApplyToken(url) {
    try {
      const parsed = new URL(url || "", window.location.href);
      const match = parsed.pathname.match(/\/apply\/([^/?#]+)/i);
      return match && match[1] ? match[1] : "";
    } catch (_error) {
      return "";
    }
  }

  function applyReadyJobAutofill(message) {
    const expectedJobId = normalizeJobId(message.jobId);
    const currentJob = captureCurrentJobPage();
    const currentJobId = normalizeJobId(`${currentJob.jobId} ${currentJob.title} ${currentJob.url} ${currentJob.description}`) || normalizeJobId(message.pageJobId);

    if (!expectedJobId) {
      throw new Error("No tailored JR job ID was provided.");
    }

    if (currentJobId && expectedJobId !== currentJobId) {
      throw new Error(`This page is ${currentJobId || "an unknown job"}, not ${expectedJobId || "the tailored job"}.`);
    }

    if (!currentJobId && !message.allowRememberedJobOnApplicationPage) {
      throw new Error(`This page does not show ${expectedJobId}. Open the matching application page and try again.`);
    }

    const answers = Array.isArray(message.answers) ? message.answers : [];
    if (answers.length > 0) {
      const codexResult = applyStagedAnswers(answers);
      if (codexResult.applied > 0) {
        return codexResult;
      }
    }

    const profile = defaults.deepMerge(defaultProfile, message.profile || {});
    return fillApplication(profile, { highlightSkipped: true });
  }

  async function autofillApplicationArtifacts(message) {
    const expectedJobId = normalizeJobId(message.jobId);
    const expectedTitle = visibleSnippet(message.expectedTitle || message.title || "", 180);
    if (!expectedJobId) {
      throw new Error("No tailored JR job ID was provided.");
    }

    assertResumeUploadMatchesCurrentPage(expectedJobId, expectedTitle);

    ensureHighlightStyle();
    const profile = defaults.deepMerge(defaultProfile, message.profile || {});
    const artifacts = decodeUploadArtifacts(message.files || []);
    const resumeProfile = normalizeResumeProfile(message.resumeProfile || message.resume || {});
    const context = { expectedJobId, profile, artifacts, resumeProfile, skills: message.skills };
    if (message.autoClickNext) {
      return autofillApplicationUntilReview(context);
    }

    return autofillCurrentApplicationStep(context, false);
  }

  async function autofillCurrentApplicationStep(context, autoClickNext) {
    const { expectedJobId, profile, artifacts, resumeProfile, skills } = context;
    const applicationStep = getCurrentWorkdayApplicationStep();
    const applicationQuestionsResult = await autofillKnownApplicationFields(profile);
    const uploadResult = await uploadMissingArtifacts(artifacts, {
      allowMissingFileInput: !isApplicationArtifactUploadStep()
    });
    const experienceResult = repairWorkdayParsedExperience(resumeProfile);
    const educationResult = await repairWorkdayParsedEducation(resumeProfile);
    const skillsResult = applyWorkdaySkills(skills);
    const nextResult = autoClickNext
      ? await clickWorkdayNextAfterAutofill()
      : { clicked: false, skipped: "disabled" };

    return {
      ...uploadResult,
      applicationStep,
      applicationQuestionsApplied: applicationQuestionsResult.applied > 0,
      applicationQuestionFields: applicationQuestionsResult.fields,
      applicationQuestionSkipped: applicationQuestionsResult.skipped,
      applicationQuestionNeedsValues: applicationQuestionsResult.needsValues,
      experienceApplied: experienceResult.applied,
      experienceFields: experienceResult.fields,
      educationApplied: educationResult.applied,
      educationFields: educationResult.fields,
      educationSkipped: educationResult.skipped,
      educationDebug: educationResult.debug,
      skillsApplied: skillsResult.applied,
      skillsSkipped: skillsResult.skipped,
      nextClicked: nextResult.clicked,
      nextClickSkipped: nextResult.skipped || "",
      jobId: expectedJobId,
      inputLabel: uploadResult.input ? summarizeContext(getElementContext(uploadResult.input)) : ""
    };
  }

  async function autofillApplicationUntilReview(context) {
    const maxSteps = 8;
    const aggregate = createAutofillAggregate(context.expectedJobId);

    for (let index = 0; index < maxSteps; index += 1) {
      const currentStep = getCurrentWorkdayApplicationStep();
      if (isWorkdayReviewStep(currentStep)) {
        aggregate.autoAdvanceStoppedAt = "Review";
        aggregate.nextClickSkipped = "";
        return aggregate;
      }

      const stepResult = await autofillCurrentApplicationStep(context, true);
      mergeAutofillResult(aggregate, stepResult);

      if (isWorkdayReviewStep(stepResult.nextStep) || isCurrentWorkdayReviewStep()) {
        aggregate.autoAdvanceStoppedAt = "Review";
        aggregate.nextClickSkipped = "";
        return aggregate;
      }

      if (!stepResult.nextClicked) {
        if (shouldRetryStuckApplicationStep(stepResult)) {
          await delay(1800);
          const retryResult = await autofillCurrentApplicationStep(context, true);
          mergeAutofillResult(aggregate, retryResult);

          if (isWorkdayReviewStep(retryResult.nextStep) || isCurrentWorkdayReviewStep()) {
            aggregate.autoAdvanceStoppedAt = "Review";
            aggregate.nextClickSkipped = "";
            return aggregate;
          }

          if (retryResult.nextClicked) {
            await delay(1500);
            continue;
          }

          aggregate.autoAdvanceStoppedAt = retryResult.applicationStep || stepResult.applicationStep || currentStep || "";
          aggregate.nextClickSkipped = retryResult.nextClickSkipped || stepResult.nextClickSkipped || "Next did not advance after retry";
          return aggregate;
        }

        aggregate.autoAdvanceStoppedAt = stepResult.applicationStep || currentStep || "";
        aggregate.nextClickSkipped = stepResult.nextClickSkipped || "Next did not advance";
        return aggregate;
      }

      await delay(1500);
    }

    aggregate.nextClickSkipped = `stopped after ${maxSteps} auto-advance attempts`;
    aggregate.autoAdvanceStoppedAt = getCurrentWorkdayApplicationStep();
    return aggregate;
  }

  function shouldRetryStuckApplicationStep(result) {
    const skipped = normalize((result && result.nextClickSkipped) || "");
    return skipped.includes("stayed on");
  }

  function createAutofillAggregate(jobId) {
    return {
      uploadedFiles: [],
      skippedFiles: [],
      applicationQuestionsApplied: false,
      applicationQuestionFields: [],
      applicationQuestionSkipped: 0,
      applicationQuestionNeedsValues: [],
      experienceApplied: false,
      experienceFields: [],
      educationApplied: false,
      educationFields: [],
      educationSkipped: "",
      educationDebug: "",
      skillsApplied: false,
      skillsSkipped: 0,
      nextClicked: false,
      nextClickSkipped: "",
      nextClicks: 0,
      autoAdvanceSteps: [],
      autoAdvanceStoppedAt: "",
      jobId,
      inputLabel: ""
    };
  }

  function mergeAutofillResult(aggregate, result) {
    aggregate.uploadedFiles = uniqueBySummaryKey(aggregate.uploadedFiles.concat(result.uploadedFiles || []));
    aggregate.skippedFiles = uniqueBySummaryKey(aggregate.skippedFiles.concat(result.skippedFiles || []));
    aggregate.applicationQuestionsApplied = aggregate.applicationQuestionsApplied || Boolean(result.applicationQuestionsApplied);
    aggregate.applicationQuestionFields = uniqueStrings(aggregate.applicationQuestionFields.concat(result.applicationQuestionFields || []));
    aggregate.applicationQuestionSkipped += Number(result.applicationQuestionSkipped || 0);
    aggregate.applicationQuestionNeedsValues = uniqueStrings(aggregate.applicationQuestionNeedsValues.concat(result.applicationQuestionNeedsValues || []));
    aggregate.experienceApplied = aggregate.experienceApplied || Boolean(result.experienceApplied);
    aggregate.experienceFields = uniqueStrings(aggregate.experienceFields.concat(result.experienceFields || []));
    aggregate.educationApplied = aggregate.educationApplied || Boolean(result.educationApplied);
    aggregate.educationFields = uniqueStrings(aggregate.educationFields.concat(result.educationFields || []));
    aggregate.educationSkipped = result.educationSkipped || aggregate.educationSkipped;
    aggregate.educationDebug = result.educationDebug || aggregate.educationDebug;
    aggregate.skillsApplied = aggregate.skillsApplied || Boolean(result.skillsApplied);
    aggregate.skillsSkipped += Number(result.skillsSkipped || 0);
    aggregate.nextClicked = aggregate.nextClicked || Boolean(result.nextClicked);
    aggregate.nextClickSkipped = result.nextClickSkipped || "";
    aggregate.nextClicks += result.nextClicked ? 1 : 0;
    aggregate.autoAdvanceSteps.push({
      from: result.applicationStep || "",
      to: result.nextStep || "",
      skipped: result.nextClickSkipped || ""
    });
    aggregate.inputLabel = aggregate.inputLabel || result.inputLabel || "";
  }

  function uniqueBySummaryKey(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = JSON.stringify([
        item && item.kind || "",
        item && item.fileName || "",
        item && item.status || ""
      ]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  }

  async function clickWorkdayNextAfterAutofill() {
    await delay(900);
    const previousStep = getCurrentWorkdayApplicationStep();
    if (isWorkdayReviewStep(previousStep)) {
      return { clicked: false, skipped: "already on Review", fromStep: previousStep, nextStep: previousStep };
    }

    const button = findWorkdayNextButton();
    if (!button) {
      return { clicked: false, skipped: "button not found", fromStep: previousStep, nextStep: previousStep };
    }
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return { clicked: false, skipped: "button disabled", fromStep: previousStep, nextStep: previousStep };
    }

    try {
      button.scrollIntoView({ block: "center", inline: "center" });
    } catch (_error) {
      // Scrolling is just polish; the click below is the important action.
    }

    mark(button, "filled");
    const trustedClick = await requestTrustedClick(button);
    if (!trustedClick || trustedClick.ok === false) {
      button.click();
    }

    const nextStep = await waitForWorkdayApplicationStepChange(previousStep, 7000);
    if (isWorkdayReviewStep(nextStep) || (nextStep && nextStep !== previousStep)) {
      return { clicked: true, skipped: "", fromStep: previousStep, nextStep };
    }

    const currentStep = getCurrentWorkdayApplicationStep();
    if (isWorkdayReviewStep(currentStep) || (currentStep && currentStep !== previousStep)) {
      return { clicked: true, skipped: "", fromStep: previousStep, nextStep: currentStep };
    }

    return {
      clicked: false,
      skipped: currentStep ? `stayed on ${currentStep}` : "stayed on current step",
      fromStep: previousStep,
      nextStep: currentStep || previousStep
    };
  }

  function findWorkdayNextButton() {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a[href]"))
      .filter((element) => isVisibleElement(element))
      .filter((element) => {
        const text = normalize([
          visibleText(element),
          element.getAttribute("aria-label") || "",
          element.getAttribute("title") || ""
        ].join(" "));
        return text === "next" || text.endsWith(" next") || text.startsWith("next ");
      });

    return candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10;
    }) || null;
  }

  async function waitForWorkdayApplicationStepChange(previousStep, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await delay(250);
      const currentStep = getCurrentWorkdayApplicationStep();
      if (isWorkdayReviewStep(currentStep)) {
        return currentStep;
      }
      if (currentStep && currentStep !== previousStep) {
        return currentStep;
      }
    }

    return getCurrentWorkdayApplicationStep();
  }

  function isCurrentWorkdayReviewStep() {
    return isWorkdayReviewStep(getCurrentWorkdayApplicationStep());
  }

  function isWorkdayReviewStep(step) {
    return normalize(step) === "review";
  }

  function getCurrentWorkdayApplicationStep() {
    const knownSteps = [
      "Upload Resume or CV",
      "Quick Apply",
      "My Experience",
      "Application Questions",
      "Voluntary Disclosures",
      "Self Identify",
      "Review"
    ];

    const selectedCandidates = Array.from(document.querySelectorAll([
      "[aria-current='step']",
      "[aria-current='true']",
      "[aria-selected='true']",
      "[aria-checked='true']",
      "[data-automation-selected='true']",
      "[data-selected='true']"
    ].join(",")))
      .filter(isVisibleElement)
      .map((element) => canonicalWorkdayStepName(visibleText(element), knownSteps))
      .filter(Boolean);
    if (selectedCandidates.length > 0) {
      return selectedCandidates[0];
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
      .filter(isVisibleElement)
      .map((element) => canonicalWorkdayStepName(visibleText(element), knownSteps))
      .filter(Boolean);
    const headingStep = headings.find((step) => step !== "Quick Apply") || headings[0] || "";
    if (headingStep) {
      return headingStep;
    }

    const title = String(document.title || "");
    const titleMatch = title.match(/:\s*(Upload Resume or CV|Quick Apply|My Experience|Application Questions|Voluntary Disclosures|Self Identify|Review)(?:\s*-\s*Workday)?\s*$/i);
    return titleMatch ? canonicalWorkdayStepName(titleMatch[1], knownSteps) : "";
  }

  function canonicalWorkdayStepName(value, knownSteps) {
    const normalized = normalize(value);
    if (!normalized) {
      return "";
    }

    return knownSteps.find((step) => normalize(step) === normalized || normalized.includes(normalize(step))) || "";
  }

  function assertResumeUploadMatchesCurrentPage(expectedJobId, expectedTitle) {
    const currentJob = captureCurrentJobPage();
    const currentJobId = normalizeJobId(`${currentJob.jobId} ${currentJob.title} ${currentJob.url} ${currentJob.description}`);
    if (currentJobId && currentJobId !== expectedJobId) {
      throw new Error(`This page is ${currentJobId}, not ${expectedJobId}.`);
    }

    if (!currentJobId && expectedTitle && !currentPageTitleMatches(expectedTitle, currentJob)) {
      throw new Error(`This application page does not look like ${expectedTitle}.`);
    }
  }

  function currentPageTitleMatches(expectedTitle, currentJob) {
    const headingTitles = Array.from(document.querySelectorAll("h1, h2, [data-automation-id*='title'], [data-automation-id*='Title']"))
      .map((element) => visibleText(element))
      .filter(Boolean);
    const candidates = [
      currentJob && currentJob.title,
      document.title || "",
      extractApplicationJobTitle(document.title || ""),
      ...headingTitles.map((title) => extractApplicationJobTitle(title) || title)
    ].filter(Boolean);

    return candidates.some((candidate) => titlesMatch(candidate, expectedTitle));
  }

  function titlesMatch(left, right) {
    const leftNorm = normalizeApplicationTitle(left);
    const rightNorm = normalizeApplicationTitle(right);
    return Boolean(leftNorm && rightNorm && (leftNorm === rightNorm || leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)));
  }

  function normalizeApplicationTitle(value) {
    return normalize(cleanApplicationJobTitle(extractApplicationJobTitle(value) || value))
      .replace(/\b(job application for|workday|upload resume or cv|quick apply)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeUploadArtifacts(payloads) {
    return (Array.isArray(payloads) ? payloads : [payloads])
      .filter(Boolean)
      .map((payload) => ({
        kind: String(payload.kind || inferArtifactKind(payload.fileName || "")),
        file: decodeUploadFile(payload)
      }));
  }

  function decodeUploadFile(payload) {
    const base64 = String(payload && payload.base64 ? payload.base64 : "");
    const fileName = String(payload && payload.fileName ? payload.fileName : "tailored_resume.docx");
    const mimeType = String(payload && payload.mimeType ? payload.mimeType : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    if (!base64) {
      throw new Error("The tailored resume file was empty.");
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], fileName, {
      type: mimeType,
      lastModified: Date.now()
    });
  }

  function inferArtifactKind(fileName) {
    return /cover[_\s-]*letter/i.test(String(fileName || "")) ? "cover-letter-docx" : "resume-docx";
  }

  async function uploadMissingArtifacts(artifacts, options = {}) {
    const wanted = selectArtifactsForCurrentPage(artifacts);
    const skippedFiles = artifacts
      .filter((artifact) => !wanted.includes(artifact))
      .map((artifact) => summarizeArtifact(artifact, "already_present_or_not_needed"));

    if (wanted.length === 0) {
      return {
        uploadedFiles: [],
        skippedFiles,
        input: null
      };
    }

    const input = findApplicationFileInput();
    if (!input) {
      if (options.allowMissingFileInput) {
        return {
          uploadedFiles: [],
          skippedFiles,
          input: null,
          artifactUploadSkipped: "no_file_input_on_this_step"
        };
      }

      throw new Error("I could not find a resume/CV or cover letter file input on this page.");
    }

    let selected = wanted;
    if (!input.multiple && wanted.length > 1) {
      selected = wanted.slice(0, 1);
      skippedFiles.push(...wanted.slice(1).map((artifact) => summarizeArtifact(artifact, "input_accepts_one_file")));
    }

    const transfer = new DataTransfer();
    for (const artifact of selected) {
      transfer.items.add(artifact.file);
    }

    try {
      input.files = transfer.files;
    } catch (_error) {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: transfer.files
      });
    }

    dispatchFileInputEvents(input);
    dispatchFileDropEvents(input, transfer);
    await delay(450);
    mark(input, "filled");

    return {
      uploadedFiles: selected.map((artifact) => summarizeArtifact(artifact, "uploaded")),
      skippedFiles,
      input
    };
  }

  function selectArtifactsForCurrentPage(artifacts) {
    const attachmentSection = getAttachmentSectionElement();
    const normalizedPage = normalize([
      rawVisibleText(document.body, 120000),
      attachmentSection ? visibleText(attachmentSection) : ""
    ].join("\n"));
    const existingKinds = getUploadedArtifactKinds(artifacts);
    const isQuickApplyResumeStep =
      hasAny(normalizedPage, ["quick apply", "drop file here", "upload resume"]) &&
      !hasAny(normalizedPage, ["resume cv and cover letter", "please attach both"]);
    const isAttachmentStep = Boolean(attachmentSection) || hasAny(normalizedPage, ["resume cv and cover letter", "please attach both", "cover letter"]);
    const byAttachmentPriority = (left, right) => artifactUploadPriority(left, isAttachmentStep) - artifactUploadPriority(right, isAttachmentStep);

    if (isQuickApplyResumeStep && !isAttachmentStep) {
      return artifacts.filter((artifact) => artifact.kind === "resume-docx" && !existingKinds.has(artifact.kind));
    }

    return artifacts.filter((artifact) => {
      if (!isAttachmentStep && artifact.kind !== "resume-docx") {
        return false;
      }
      return !existingKinds.has(artifact.kind);
    }).sort(byAttachmentPriority);
  }

  function isApplicationArtifactUploadStep() {
    const attachmentSection = getAttachmentSectionElement();
    const normalizedPage = normalize([
      rawVisibleText(document.body, 120000),
      attachmentSection ? visibleText(attachmentSection) : ""
    ].join("\n"));

    return Boolean(attachmentSection) || (
      hasAny(normalizedPage, ["upload", "attach", "drop file", "select files", "please attach both"]) &&
      hasAny(normalizedPage, ["resume", "cv", "cover letter", "doc", "docx", "pdf"])
    );
  }

  function artifactUploadPriority(artifact, isAttachmentStep) {
    if (isAttachmentStep && artifact.kind === "cover-letter-docx") {
      return 0;
    }

    if (artifact.kind === "resume-docx") {
      return 1;
    }

    return 2;
  }

  function getUploadedArtifactKinds(artifacts) {
    const normalizedPage = normalizeFileNameText(getUploadedAttachmentText());
    const kinds = new Set();

    for (const artifact of artifacts) {
      const fileName = normalizeFileNameText(artifact.file.name);
      if (fileName && normalizedPage.includes(fileName)) {
        kinds.add(artifact.kind);
      }
    }

    if (hasUploadedResumeName(normalizedPage)) {
      kinds.add("resume-docx");
    }
    if (hasUploadedCoverLetterName(normalizedPage)) {
      kinds.add("cover-letter-docx");
    }

    return kinds;
  }

  function getUploadedAttachmentText() {
    const section = getAttachmentSectionElement() || document.body;
    const pieces = [];
    const seen = new Set();
    const selectors = [
      "[role='listitem']",
      "li",
      "a",
      "[data-automation-id*='file']",
      "[data-automation-id*='File']",
      "[data-automation-id*='attachment']",
      "[data-automation-id*='Attachment']",
      "div",
      "span"
    ].join(",");

    for (const element of Array.from(section.querySelectorAll(selectors))) {
      if (!isVisibleElement(element)) {
        continue;
      }

      const text = visibleSnippet(visibleText(element), 260);
      if (!looksLikeUploadedAttachmentText(text)) {
        continue;
      }

      const key = normalizeFileNameText(text);
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      pieces.push(text);
    }

    return pieces.join("\n");
  }

  function looksLikeUploadedAttachmentText(text) {
    const value = String(text || "").trim();
    if (!/\.[a-z0-9]{2,5}\b/i.test(value)) {
      return false;
    }

    const normalized = normalize(value);
    return !hasAny(normalized, [
      "upload either doc",
      "file types",
      "drop file",
      "select files",
      "please attach"
    ]);
  }

  function normalizeFileNameText(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function hasUploadedResumeName(text) {
    return /(?:resume|cv|curriculum vitae)[\w\s_.()-]{0,80}\.(?:docx?|pdf|txt|html)\b/i.test(text) ||
      /\.(?:docx?|pdf|txt|html)\b[\w\s_.()-]{0,80}(?:resume|cv|curriculum vitae)/i.test(text);
  }

  function hasUploadedCoverLetterName(text) {
    return /cover[\s_-]*letter[\w\s_.()-]{0,80}\.(?:docx?|pdf|txt|html)\b/i.test(text) ||
      /\.(?:docx?|pdf|txt|html)\b[\w\s_.()-]{0,80}cover[\s_-]*letter/i.test(text);
  }

  function getAttachmentSectionText() {
    const section = getAttachmentSectionElement();
    return section ? visibleText(section) : "";
  }

  function getAttachmentSectionElement() {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, [role='heading']"))
      .filter((heading) => hasAny(normalize(visibleText(heading)), ["resume cv and cover letter", "cover letter"]));

    for (const heading of headings) {
      let current = heading.parentElement;
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const text = visibleText(current);
        const normalized = normalize(text);
        if (
          hasAny(normalized, ["resume cv and cover letter", "please attach both", "cover letter"]) &&
          hasAny(normalized, ["upload", "successfully uploaded", "docx", "pdf"])
        ) {
          return current;
        }
      }
    }

    return null;
  }

  function summarizeArtifact(artifact, status) {
    return {
      kind: artifact.kind,
      fileName: artifact.file.name,
      fileSize: artifact.file.size,
      status
    };
  }

  function findApplicationFileInput() {
    const candidates = querySelectorAllDeep('input[type="file"]')
      .filter((input) => !input.disabled)
      .map((input) => ({
        input,
        score: scoreApplicationFileInput(input)
      }))
      .sort((left, right) => right.score - left.score);

    return candidates.length > 0 ? candidates[0].input : null;
  }

  function normalizeResumeProfile(profile) {
    const source = profile && typeof profile === "object" ? profile : {};
    return {
      experiences: Array.isArray(source.experiences) ? source.experiences.filter(Boolean) : [],
      education: Array.isArray(source.education) ? source.education.filter(Boolean) : []
    };
  }

  function repairWorkdayParsedExperience(resumeProfile) {
    const result = {
      applied: false,
      fields: []
    };

    const experiences = Array.isArray(resumeProfile.experiences) ? resumeProfile.experiences : [];
    if (experiences.length === 0) {
      return result;
    }

    for (const container of findWorkExperienceEntryContainers()) {
      const fields = getWorkExperienceEntryFields(container);
      const resumeExperience = findResumeExperienceForEntry(fields, experiences);
      if (!resumeExperience) {
        continue;
      }

      if (fields.title && shouldRepairJobTitleFromResume(getCurrentValue(fields.title), resumeExperience)) {
        setTextControlValue(fields.title, resumeExperience.jobTitle);
        dispatchInputEvents(fields.title);
        mark(fields.title, "filled");
        result.applied = true;
        result.fields.push(`${resumeExperience.jobTitle || "Experience"} job title`);
      }

      if (fields.company && shouldRepairCompanyFromResume(getCurrentValue(fields.company), resumeExperience)) {
        setTextControlValue(fields.company, resumeExperience.organization);
        dispatchInputEvents(fields.company);
        mark(fields.company, "filled");
        result.applied = true;
        result.fields.push(`${resumeExperience.jobTitle || "Experience"} company`);
      }

      if (fields.description && shouldRepairDescriptionFromResume(getCurrentValue(fields.description), resumeExperience)) {
        setTextControlValue(fields.description, resumeExperience.description);
        dispatchInputEvents(fields.description);
        mark(fields.description, "filled");
        result.applied = true;
        result.fields.push(`${resumeExperience.jobTitle || "Experience"} role description`);
      }
    }

    return result;
  }

  function findWorkExperienceEntryContainers() {
    const containers = [];
    const seen = new Set();
    const controls = Array.from(document.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter((element) => isVisibleControl(element) && !isFileInput(element));

    for (const control of controls) {
      const container = findWorkExperienceEntryContainer(control);
      if (!container || seen.has(container)) {
        continue;
      }
      seen.add(container);
      containers.push(container);
    }

    return containers;
  }

  function findWorkExperienceEntryContainer(anchorField) {
    let current = anchorField.parentElement;
    for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
      const normalized = normalize(visibleText(current));
      if (
        hasAll(normalized, ["job title", "company", "from"]) &&
        hasAny(normalized, ["role description", "remove"]) &&
        !hasAny(normalized, ["education", "resume cv and cover letter"])
      ) {
        return current;
      }
    }

    return null;
  }

  function getWorkExperienceEntryFields(container) {
    const controls = Array.from(container.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter((element) => isVisibleControl(element) && !isFileInput(element));
    const singleLineTextFields = controls.filter(isSingleLineWorkdayTextField);
    return {
      title: singleLineTextFields[0] || null,
      company: singleLineTextFields[1] || null,
      description: controls.find(isLongTextControl) || null,
      dates: getWorkdayEntryDateParts(container)
    };
  }

  function isSingleLineWorkdayTextField(element) {
    if (!element || element.matches("textarea") || element.isContentEditable) {
      return false;
    }

    const type = (element.getAttribute("type") || "text").toLowerCase();
    return !["hidden", "file", "checkbox", "radio", "date", "month", "number"].includes(type);
  }

  function isLongTextControl(element) {
    return Boolean(element && (element.matches("textarea") || element.isContentEditable));
  }

  function getWorkdayEntryDateParts(container) {
    const dateFields = Array.from(container.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter((element) => {
        const type = (element.getAttribute("type") || "").toLowerCase();
        const placeholder = normalize(element.getAttribute("placeholder") || "");
        return isVisibleControl(element) && (type === "number" || placeholder === "mm" || placeholder === "yyyy");
      })
      .map((element) => Number(String(getCurrentValue(element) || "").trim()))
      .filter((value) => Number.isFinite(value));

    return {
      startMonth: dateFields[0] || null,
      startYear: dateFields[1] || null,
      endMonth: dateFields[2] || null,
      endYear: dateFields[3] || null
    };
  }

  function findResumeExperienceForEntry(fields, experiences) {
    let best = null;
    for (const experience of experiences) {
      const score = scoreResumeExperienceMatch(fields, experience);
      if (!best || score > best.score) {
        best = { score, experience };
      }
    }

    return best && best.score >= 5 ? best.experience : null;
  }

  function scoreResumeExperienceMatch(fields, experience) {
    let score = 0;
    const currentTitle = fields.title ? getCurrentValue(fields.title) : "";
    const currentCompany = fields.company ? getCurrentValue(fields.company) : "";

    score += scoreTextMatch(currentTitle, experience.jobTitle) * 2;
    score += scoreTextMatch(currentCompany, experience.organization);

    if (datesMatch(fields.dates, experience)) {
      score += 5;
    }

    return score;
  }

  function scoreTextMatch(left, right) {
    const leftNorm = normalize(left);
    const rightNorm = normalize(right);
    if (!leftNorm || !rightNorm) {
      return 0;
    }

    if (leftNorm === rightNorm) {
      return 3;
    }

    if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) {
      return 2;
    }

    return tokenOverlapRatio(leftNorm, rightNorm) >= 0.5 ? 1 : 0;
  }

  function datesMatch(dates, experience) {
    if (!dates || !experience) {
      return false;
    }

    const startMatches =
      dates.startYear &&
      Number(experience.startYear) === Number(dates.startYear) &&
      (!dates.startMonth || !experience.startMonth || Number(experience.startMonth) === Number(dates.startMonth));
    const endMatches =
      dates.endYear &&
      Number(experience.endYear) === Number(dates.endYear) &&
      (!dates.endMonth || !experience.endMonth || Number(experience.endMonth) === Number(dates.endMonth));

    return Boolean(startMatches && endMatches);
  }

  function shouldRepairJobTitleFromResume(currentTitle, experience) {
    const resumeTitle = String(experience && experience.jobTitle ? experience.jobTitle : "").trim();
    if (!resumeTitle) {
      return false;
    }

    const current = String(currentTitle || "").trim();
    if (!current) {
      return true;
    }

    const currentNorm = normalize(current);
    const resumeNorm = normalize(resumeTitle);
    if (!currentNorm) {
      return false;
    }

    if (currentNorm === resumeNorm) {
      return collapseTitleWhitespace(current) !== collapseTitleWhitespace(resumeTitle);
    }

    if (currentNorm.includes(resumeNorm)) {
      return false;
    }

    return resumeNorm.includes(currentNorm) && current.length < resumeTitle.length * 0.75;
  }

  function collapseTitleWhitespace(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function shouldRepairCompanyFromResume(currentCompany, experience) {
    const organization = String(experience && experience.organization ? experience.organization : "").trim();
    if (!organization) {
      return false;
    }

    const current = String(currentCompany || "").trim();
    if (!current) {
      return true;
    }

    const currentNorm = normalize(current);
    const organizationNorm = normalize(organization);
    if (currentNorm === organizationNorm) {
      return false;
    }

    if (
      organizationNorm &&
      currentNorm.startsWith(`${organizationNorm} `) &&
      current.length > organization.length &&
      /,\s*\S/.test(current.slice(organization.length))
    ) {
      return true;
    }

    if (scoreTextMatch(current, organization) > 0) {
      return false;
    }

    const descriptionNorm = normalize(experience.description || "");
    const titleNorm = normalize(experience.jobTitle || "");
    return Boolean(
      currentNorm &&
      (
        (` ${descriptionNorm} `).includes(` ${currentNorm} `) ||
        (` ${titleNorm} `).includes(` ${currentNorm} `)
      )
    );
  }

  function shouldRepairDescriptionFromResume(currentDescription, experience) {
    const resumeDescription = String(experience && experience.description ? experience.description : "").trim();
    if (!resumeDescription) {
      return false;
    }

    const current = String(currentDescription || "").trim();
    if (!current) {
      return true;
    }

    const currentNorm = normalize(current);
    const resumeNorm = normalize(resumeDescription);
    if (!currentNorm || currentNorm === resumeNorm) {
      return false;
    }

    return resumeNorm.startsWith(currentNorm) || (current.length < 140 && tokenOverlapRatio(currentNorm, resumeNorm) >= 0.55);
  }

  function tokenOverlapRatio(leftNorm, rightNorm) {
    const leftTokens = new Set(String(leftNorm || "").split(/\s+/).filter((token) => token.length > 1));
    const rightTokens = new Set(String(rightNorm || "").split(/\s+/).filter((token) => token.length > 1));
    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return 0;
    }

    let overlap = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) {
        overlap += 1;
      }
    }

    return overlap / Math.min(leftTokens.size, rightTokens.size);
  }

  async function repairWorkdayParsedEducation(resumeProfile) {
    const result = {
      applied: false,
      fields: [],
      skipped: "",
      debug: ""
    };

    const educationItems = Array.isArray(resumeProfile.education) ? resumeProfile.education : [];
    const education = educationItems.find((item) => item && item.expectedGraduationYear);
    const expectedYear = normalizeExpectedGraduationYear(education && education.expectedGraduationYear);
    if (!education || !expectedYear) {
      result.skipped = "no expected graduation year in resume";
      return result;
    }

    const container = findEducationContainerForResumeItem(education);
    if (!container) {
      result.skipped = "no education container";
      return result;
    }

    const expectedYearField = findExpectedGraduationYearField(container);
    if (!expectedYearField) {
      result.skipped = "no expected graduation year field";
      return result;
    }

    if (expectedGraduationYearLooksCommitted(container, expectedYearField, expectedYear)) {
      return result;
    }

    const filled = await fillExpectedGraduationYearField(expectedYearField, expectedYear, container);
    result.debug = summarizeExpectedGraduationYearField(expectedYearField, container, expectedYear);
    mark(expectedYearField, filled ? "filled" : "skipped");
    if (filled) {
      result.applied = true;
      result.fields.push("expected graduation year");
    } else {
      result.skipped = `expected graduation year still ${String(getCurrentValue(expectedYearField) || "").trim() || "blank"}`;
    }

    return result;
  }

  function summarizeExpectedGraduationYearField(field, container, expectedYear) {
    const props = getFrameworkEventProps(field);
    const context = normalize(getElementContext(field));
    const tag = field && field.tagName ? field.tagName.toLowerCase() : "";
    const type = field && field.getAttribute ? field.getAttribute("type") || "" : "";
    const role = field && field.getAttribute ? field.getAttribute("role") || "" : "";
    const value = String(getCurrentValue(field) || "").trim();
    const ariaNow = field && field.getAttribute ? field.getAttribute("aria-valuenow") || "" : "";
    const committed = expectedGraduationYearLooksCommitted(container, field, expectedYear) ? "yes" : "no";
    return visibleSnippet(`expected=${expectedYear}; value=${value}; aria=${ariaNow}; tag=${tag}; type=${type}; role=${role}; frameworkProps=${props.length}; committed=${committed}; context=${context}`, 260);
  }

  function normalizeExpectedGraduationYear(value) {
    const match = String(value || "").match(/\b(20\d{2}|19\d{2})\b/);
    return match ? match[1] : "";
  }

  async function fillExpectedGraduationYearField(field, expectedYear, container) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await commitWorkdayYearStepperValue(field, expectedYear);
      await delay(300 + attempt * 150);
      if (expectedGraduationYearLooksCommitted(container, field, expectedYear)) {
        return true;
      }
    }

    return fillExpectedGraduationYearWithTrustedInput(field, expectedYear, container);
  }

  async function fillExpectedGraduationYearWithTrustedInput(field, expectedYear, container) {
    focusAndSelectTextLikeElement(field);
    const response = await requestTrustedTextInsertion(expectedYear);
    if (!response || response.ok === false) {
      return false;
    }

    await delay(260);
    commitWorkdayDateSegments([field]);
    await delay(220);
    return expectedGraduationYearLooksCommitted(container, field, expectedYear);
  }

  function requestTrustedTextInsertion(text) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          type: "APPLICATION_AUTOFILL_INSERT_TRUSTED_TEXT",
          text
        }, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, error: error.message });
            return;
          }

          resolve(response || { ok: false, error: "No trusted text response." });
        });
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  async function commitWorkdayYearStepperValue(field, expectedYear) {
    clearStaleWorkdayAccessibilityValue(field);

    try {
      field.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (_error) {
      // Non-blocking; focus and events below are the important pieces.
    }

    const previousValue = String(getCurrentValue(field) || "");
    const filledByDateSegment = fillWorkdayDateSegment(field, expectedYear);
    if (filledByDateSegment && normalizeExpectedGraduationYear(getCurrentValue(field)) === expectedYear) {
      notifyFrameworkValueChange(field, expectedYear, previousValue);
      commitWorkdayDateSegments([field]);
      return;
    }

    field.focus({ preventScroll: true });
    clickTextLikeElement(field);

    try {
      if (typeof field.select === "function") {
        field.select();
      } else if (typeof field.setSelectionRange === "function") {
        field.setSelectionRange(0, previousValue.length);
      }
    } catch (_error) {
      // Number inputs may not expose text selection APIs.
    }

    field.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      composed: true,
      cancelable: true,
      inputType: "deleteContentBackward",
      data: null
    }));
    setNativeInputValueForFramework(field, "");
    field.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "deleteContentBackward",
      data: null
    }));

    field.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      composed: true,
      cancelable: true,
      inputType: "insertText",
      data: expectedYear
    }));
    setNativeInputValueForFramework(field, expectedYear);
    notifyFrameworkValueChange(field, expectedYear, previousValue);
    field.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: expectedYear
    }));
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: document.body }));
    field.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));

    try {
      field.blur();
    } catch (_error) {
      // Some wrapped controls do not expose blur.
    }
  }

  function clearStaleWorkdayAccessibilityValue(field) {
    if (!field || !field.removeAttribute) {
      return;
    }

    field.removeAttribute("aria-valuenow");
    field.removeAttribute("aria-valuetext");
  }

  function notifyFrameworkValueChange(field, value, previousValue) {
    const propsList = getFrameworkEventProps(field);
    if (propsList.length === 0) {
      return;
    }

    const eventTypes = [
      ["onBeforeInput", "beforeinput"],
      ["onInput", "input"],
      ["onChange", "change"],
      ["onBlur", "blur"]
    ];

    for (const props of propsList) {
      for (const [handlerName, type] of eventTypes) {
        const handler = props && props[handlerName];
        if (typeof handler !== "function") {
          continue;
        }

        try {
          handler(makeFrameworkValueEvent(field, type, value, previousValue));
        } catch (_error) {
          // Native events below remain the primary path.
        }
      }
    }
  }

  function getFrameworkEventProps(field) {
    const props = [];
    let current = field;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      for (const key of Object.keys(current)) {
        if (/^__react(?:Props|EventHandlers)\$/.test(key) && current[key]) {
          props.push(current[key]);
        }
      }
    }

    return props;
  }

  function makeFrameworkValueEvent(field, type, value, previousValue) {
    return {
      type,
      target: field,
      currentTarget: field,
      nativeEvent: { type, target: field, data: value, previousValue },
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: false,
      data: value,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      persist() {},
      isDefaultPrevented() {
        return this.defaultPrevented;
      },
      isPropagationStopped() {
        return false;
      }
    };
  }

  function setNativeInputValueForFramework(field, value) {
    const previousValue = String(getCurrentValue(field) || "");
    setNativeValue(field, value);

    const tracker = field && field._valueTracker;
    if (tracker && typeof tracker.setValue === "function") {
      tracker.setValue(previousValue);
    }
  }

  function expectedGraduationYearLooksCommitted(container, field, expectedYear) {
    const currentValue = normalizeExpectedGraduationYear(getCurrentValue(field));
    const context = [
      rawVisibleText(container, 6000),
      getElementContext(field),
      field.getAttribute("aria-label") || "",
      field.getAttribute("aria-valuetext") || "",
      field.getAttribute("aria-valuenow") || ""
    ].join("\n");
    const currentValueMatch = String(context || "").match(/current value is\s+(\d{4})/i);

    if (currentValueMatch) {
      return currentValueMatch[1] === expectedYear;
    }

    return currentValue === expectedYear;
  }

  function getEducationEntryFields(container) {
    const controls = Array.from(container.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter((element) => isVisibleControl(element) && !isFileInput(element));
    const searchFields = controls.filter((element) => normalize(element.getAttribute("placeholder") || "") === "search");
    return {
      degree: searchFields[0] || findEducationFieldByContext(controls, ["degree"]),
      fieldOfStudy: searchFields[1] || findEducationFieldByContext(controls, ["field of study", "field study"]),
      expectedYear: findExpectedGraduationYearField(container)
    };
  }

  function findEducationFieldByContext(controls, terms) {
    return controls.find((element) => {
      const context = normalize(getElementContext(element));
      return hasAny(context, terms);
    }) || null;
  }

  async function fillEducationPicker(field, searchTexts, expectedText, options = {}) {
    const queries = Array.isArray(searchTexts) ? searchTexts : [searchTexts];
    const cleanQueries = Array.from(new Set(queries.map((value) => String(value || "").trim()).filter(Boolean)));
    if (!field || cleanQueries.length === 0) {
      return false;
    }
    if (!String(getCurrentValue(field) || "").trim() && educationPickerAlreadySelected(field, expectedText || cleanQueries[0], options)) {
      return false;
    }

    closeOpenPicker(field);
    await delay(100);

    if (clearMismatchedPickerSelection(field, expectedText || cleanQueries[0], options)) {
      await delay(180);
    }

    if (options.kind === "degree") {
      return fillDegreeEducationPicker(field, cleanQueries, expectedText || cleanQueries[0]);
    }

    for (const query of cleanQueries) {
      await openAndSearchPicker(field, query);

      const option = await findPickerOptionWithScroll(expectedText || query, query, options);
      if (option) {
        choosePickerOption(option);
        await delay(220);
        field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        mark(field, "filled");
        return true;
      }

      closeOpenPicker(field);
      await delay(160);
    }

    return false;
  }

  async function fillDegreeEducationPicker(field, cleanQueries, expectedText) {
    const degreeQueries = Array.from(new Set([
      ...cleanQueries,
      "M.S.",
      "Master of Science",
      "Master"
    ].filter(Boolean)));

    for (const query of degreeQueries) {
      await openAndSearchPicker(field, query);

      const option = await findPickerOptionWithScroll(expectedText || query, query, { kind: "degree", maxAttempts: 14 });
      if (option) {
        choosePickerOption(option);
        await delay(260);
        field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        mark(field, "filled");
        return true;
      }

      closeOpenPicker(field);
      await delay(160);
    }

    if (await expandDegreeCountry(field, "United States of America")) {
      for (const query of degreeQueries) {
        await openAndSearchPicker(field, query, { preservePicker: true });

        const option = await findPickerOptionWithScroll(expectedText || query, query, { kind: "degree", maxAttempts: 18 });
        if (option) {
          choosePickerOption(option);
          await delay(260);
          field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          mark(field, "filled");
          return true;
        }
      }
    }

    return false;
  }

  async function expandDegreeCountry(field, countryText) {
    await openAndSearchPicker(field, countryText);

    const country = await findPickerOptionWithScroll(countryText, "United States", { kind: "country", maxAttempts: 36 });
    if (!country) {
      closeOpenPicker(field);
      await delay(160);
      return false;
    }

    choosePickerOption(country, { submenu: true });
    await delay(420);
    return true;
  }

  async function openAndSearchPicker(field, query, options = {}) {
    if (!options.preservePicker) {
      closeOpenPicker(field);
      await delay(70);
    }

    field.focus({ preventScroll: true });
    field.click();
    await delay(120);
    await fillPlainTextControl(field, "");
    await delay(80);
    await fillPlainTextControl(field, query);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, composed: true }));
    await delay(900);
  }

  function clearMismatchedPickerSelection(field, expectedText, options = {}) {
    const expected = normalize(expectedText);
    if (!field || !expected) {
      return false;
    }

    const selectedTargets = getSelectedPickerItemsNearField(field);
    for (const target of selectedTargets) {
      const label = getElementAccessibleText(target);
      if (!label || pickerSelectionMatchesExpected(label, expected, options)) {
        continue;
      }

      const clearControl = findPickerItemClearControl(target);
      if (clearControl) {
        clearControl.click();
        return true;
      }

      target.focus({ preventScroll: true });
      target.click();
      dispatchDeleteKey(target, "Delete");
      dispatchDeleteKey(target, "Backspace");
      return true;
    }

    field.focus({ preventScroll: true });
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true, composed: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", code: "Backspace", bubbles: true, composed: true }));
    return false;
  }

  function getSelectedPickerItemsNearField(field) {
    const targets = [];
    const seen = new Set();
    let current = field.parentElement;

    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      const candidates = Array.from(current.querySelectorAll("[aria-selected='true'], [role='option'], [role='listitem'], [role='listbox']"))
        .filter(isVisibleElement)
        .filter((element) => {
          const label = getElementAccessibleText(element);
          return label && (
            hasAny(label, ["press delete to clear item", "items selected"]) ||
            element.getAttribute("aria-selected") === "true"
          );
        });

      for (const candidate of candidates) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          targets.push(candidate);
        }
      }
    }

    return targets;
  }

  function getElementAccessibleText(element) {
    return normalize([
      visibleText(element),
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || ""
    ].join(" "));
  }

  function pickerSelectionMatchesExpected(selectionText, expectedText, options = {}) {
    if (options.kind === "degree") {
      return isAcceptableDegreePickerMatch(selectionText, expectedText);
    }

    const selection = normalize(selectionText);
    const expected = normalize(expectedText);
    return Boolean(selection && expected && (selection.includes(expected) || expected.includes(selection)));
  }

  function findPickerItemClearControl(target) {
    return Array.from(target.querySelectorAll("button, [role='button'], [aria-label], [title]"))
      .filter(isVisibleElement)
      .find((element) => {
        const label = getElementAccessibleText(element);
        return hasAny(label, ["remove", "delete", "clear"]) || /^[x×]$/.test(String(visibleText(element) || "").trim());
      }) || null;
  }

  function dispatchDeleteKey(target, key) {
    const code = key === "Delete" ? "Delete" : "Backspace";
    const eventInit = { key, code, bubbles: true, composed: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    if (document.activeElement && document.activeElement !== target) {
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      document.activeElement.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }
    document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    document.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  async function fillPlainTextControl(field, value) {
    if (!field) {
      return;
    }

    field.focus({ preventScroll: true });
    field.click();
    setTextControlValue(field, value);
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.setAttribute("value", value);
      field.setAttribute("aria-valuenow", value);
      field.setAttribute("aria-valuetext", value);
    }
    dispatchSearchInputEvents(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: String(value).slice(-1) || "Backspace", bubbles: true, composed: true }));
    await delay(90);
  }

  async function findPickerOptionWithScroll(expectedText, fallbackText, options = {}) {
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const option = findVisiblePickerOption(expectedText, options) || findVisiblePickerOption(fallbackText, options);
      if (option) {
        return option;
      }

      if (!scrollVisiblePickerLists()) {
        break;
      }

      await delay(180);
    }

    return null;
  }

  function choosePickerOption(option, options = {}) {
    const target = option.querySelector("input[type='radio'], [role='radio'], button, [role='option'], [role='treeitem']") || option;
    const rect = option.getBoundingClientRect();
    const clientX = options.submenu ? Math.max(rect.left + 8, rect.right - 14) : rect.left + Math.max(8, rect.width / 2);
    const clientY = rect.top + Math.max(6, rect.height / 2);
    const pointTarget = document.elementFromPoint(clientX, clientY) || target;
    pointTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    pointTarget.click();
    pointTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    if (pointTarget !== target) {
      return;
    }
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    target.click();
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
  }

  function closeOpenPicker(field) {
    const eventInit = { key: "Escape", code: "Escape", bubbles: true, composed: true, cancelable: true };
    if (field) {
      field.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      field.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }
    if (document.activeElement) {
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      document.activeElement.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }
    document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    document.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function scrollVisiblePickerLists() {
    let moved = false;
    const lists = Array.from(document.querySelectorAll("[role='listbox'], [role='tree'], [data-automation-id*='promptOption'], [data-automation-id*='searchResult']"))
      .filter(isVisibleElement);

    for (const list of lists) {
      const before = list.scrollTop;
      const step = Math.max(160, Math.floor((list.clientHeight || 240) * 0.8));
      list.scrollTop = Math.min(list.scrollTop + step, list.scrollHeight || list.scrollTop + step);
      list.dispatchEvent(new Event("scroll", { bubbles: true, composed: true }));
      if (list.scrollTop !== before) {
        moved = true;
      }
    }

    return moved;
  }

  function dispatchSearchInputEvents(field, value) {
    try {
      field.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value
      }));
      field.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value
      }));
    } catch (_error) {
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
  }

  function educationPickerAlreadySelected(field, expectedText, options = {}) {
    const expected = normalize(expectedText);
    if (!expected) {
      return false;
    }

    let current = field.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      const text = normalize(visibleText(current));
      if (options.kind === "degree" && text && isAcceptableDegreePickerMatch(text, expected)) {
        return true;
      }
      if (options.kind !== "degree" && text && (text.includes(expected) || expected.includes(text))) {
        return true;
      }
    }

    return false;
  }

  function findVisiblePickerOption(expectedText, options = {}) {
    const expected = normalize(expectedText);
    if (!expected) {
      return null;
    }

    const pickerOptions = Array.from(document.querySelectorAll("[role='option'], [role='treeitem'], [data-automation-id*='promptOption'], [data-automation-id*='searchResult'], li, div"))
      .filter(isVisibleElement)
      .map((element) => ({
        element,
        text: normalize(visibleText(element))
      }))
      .filter((item) => item.text && item.text.length <= 220);

    if (options.kind === "country") {
      const exactCountry = pickerOptions.find((item) => item.text === expected);
      if (exactCountry) {
        return exactCountry.element;
      }
      return pickerOptions.find((item) => item.text.includes(expected) || expected.includes(item.text))?.element || null;
    }

    if (options.kind === "degree") {
      return findDegreePickerOption(pickerOptions, expected);
    }

    const exact = pickerOptions.find((item) => item.text === expected);
    if (exact) {
      return exact.element;
    }

    const contains = pickerOptions.find((item) => !isConflictingPickerMatch(item.text, expected) && (item.text.includes(expected) || expected.includes(item.text)));
    if (contains) {
      return contains.element;
    }

    return pickerOptions.find((item) => !isConflictingPickerMatch(item.text, expected) && tokenOverlapRatio(item.text, expected) >= 0.85)?.element || null;
  }

  function findDegreePickerOption(options, expected) {
    const matches = options
      .filter((item) => isAcceptableDegreePickerMatch(item.text, expected))
      .map((item) => ({
        ...item,
        score: scoreDegreePickerOption(item.text, expected)
      }))
      .sort((left, right) => right.score - left.score || left.text.length - right.text.length);

    return matches.length > 0 ? matches[0].element : null;
  }

  function scoreDegreePickerOption(optionText, expectedText) {
    const option = normalize(optionText);
    const expected = normalize(expectedText);
    let score = 0;

    if (option === expected) {
      score += 100;
    }
    if (option.includes(expected) || expected.includes(option)) {
      score += 60;
    }
    if (hasAny(option, ["m s", "ms"])) {
      score += 20;
    }
    if (hasAny(option, ["master"])) {
      score += 15;
    }
    if (hasAny(option, ["science", "sciences"])) {
      score += 10;
    }

    return score;
  }

  function isAcceptableDegreePickerMatch(optionText, expectedText) {
    const option = normalize(optionText);
    const expected = normalize(expectedText);
    if (!option || !expected) {
      return false;
    }

    if (hasAny(option, ["not found", "dnf", "bachelor", "b s", "bs", "associate", "doctor", "doctoral", "phd", "dma", "certificate", "diploma", "ged"])) {
      return false;
    }

    if (hasAny(expected, ["master", "m s", "ms"])) {
      if (!hasAny(option, ["master", "masters", "mast", "m s", "ms"])) {
        return false;
      }
      return true;
    }

    if (hasAny(expected, ["bachelor", "b s", "bs"])) {
      return hasAny(option, ["bachelor", "b s", "bs"]) &&
        !hasAny(option, ["master", "associate", "doctor", "certificate", "diploma", "ged"]);
    }

    return !isConflictingPickerMatch(option, expected) &&
      (option === expected || option.includes(expected) || expected.includes(option) || tokenOverlapRatio(option, expected) >= 0.85);
  }

  function isConflictingPickerMatch(optionText, expectedText) {
    const option = normalize(optionText);
    const expected = normalize(expectedText);
    if (!option || !expected) {
      return true;
    }

    if (!hasAny(expected, ["not found"]) && hasAny(option, ["not found", "dnf"])) {
      return true;
    }

    const degreeFamilies = [
      ["master", "ms", "m s"],
      ["bachelor", "bs", "b s"],
      ["doctor", "doctoral", "phd", "dma"],
      ["associate"],
      ["certificate", "diploma", "ged"]
    ];

    for (const family of degreeFamilies) {
      const expectedHasFamily = hasAny(expected, family);
      const optionHasFamily = hasAny(option, family);
      if (!expectedHasFamily && optionHasFamily && hasAny(expected, ["master", "bachelor", "doctor", "associate", "science"])) {
        return true;
      }
    }

    if (hasAny(expected, ["master"]) && hasAny(option, ["bachelor", "associate", "doctor", "certificate", "diploma", "ged"])) {
      return true;
    }
    if (hasAny(expected, ["bachelor"]) && hasAny(option, ["master", "associate", "doctor", "certificate", "diploma", "ged"])) {
      return true;
    }
    if (hasAny(expected, ["general"]) && hasAny(option, ["other", "technology", "technician", "technologies", "hardware", "software"])) {
      return true;
    }

    return false;
  }

  function getDegreeSearchText(education) {
    const degreeFull = String(education && education.degreeFull ? education.degreeFull : "");
    const degree = String(education && education.degree ? education.degree : "");
    const field = String(education && education.fieldOfStudy ? education.fieldOfStudy : "");
    const combined = normalize(`${degreeFull} ${degree} ${field}`);

    if (hasAny(combined, ["master"]) && hasAny(combined, ["science", "engineering", "computer"])) {
      return "Master of Science";
    }
    if (hasAny(combined, ["master"])) {
      return "Master";
    }
    if (hasAny(combined, ["bachelor"]) && hasAny(combined, ["science", "engineering", "computer"])) {
      return "Bachelor of Science";
    }
    if (hasAny(combined, ["bachelor"])) {
      return "Bachelor";
    }

    return degreeFull || degree;
  }

  function getDegreeSearchTexts(education) {
    const primary = getDegreeSearchText(education);
    const combined = normalize(`${education && education.degreeFull || ""} ${education && education.degree || ""}`);
    const values = [primary];

    if (hasAny(combined, ["master"])) {
      values.push("Master of Science", "M.S.", "MS", "Master");
    }
    if (hasAny(combined, ["bachelor"])) {
      values.push("Bachelor of Science", "B.S.", "BS", "Bachelor");
    }

    return values;
  }

  function getDegreeExpectedText(education) {
    const searchText = getDegreeSearchText(education);
    return normalize(searchText) === "master of science" ? "M.S. Master of Science" : searchText;
  }

  function getFieldOfStudySearchText(education) {
    const field = String(education && education.fieldOfStudy ? education.fieldOfStudy : "").trim();
    if (!field) {
      return "";
    }

    return /,\s*general$/i.test(field) ? field : `${field}, General`;
  }

  function getFieldOfStudySearchTexts(education) {
    const primary = getFieldOfStudySearchText(education);
    const raw = String(education && education.fieldOfStudy ? education.fieldOfStudy : "").trim();
    return [primary, primary.replace(/,\s*/g, " "), raw].filter(Boolean);
  }

  function getFieldOfStudyExpectedText(education) {
    return getFieldOfStudySearchText(education);
  }

  function findEducationContainerForResumeItem(education) {
    const schoolName = String(education && education.school ? education.school : "").trim();
    if (!schoolName) {
      return findVisibleEducationContainer();
    }

    const schoolShortName = stripSchoolLocation(schoolName);
    const schoolFields = Array.from(document.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter((element) => {
        if (!isVisibleControl(element)) {
          return false;
        }

        const currentValue = getCurrentValue(element);
        const context = getElementContext(element);
        return scoreTextMatch(currentValue, schoolName) > 0 ||
          scoreTextMatch(currentValue, schoolShortName) > 0 ||
          scoreTextMatch(context, schoolName) > 0 ||
          scoreTextMatch(context, schoolShortName) > 0;
      });

    for (const schoolField of schoolFields) {
      let current = schoolField.parentElement;
      for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
        const normalized = normalize(visibleText(current));
        if (
          hasAny(normalized, ["education"]) &&
          hasAny(normalized, ["degree", "field of study", "school or university"]) &&
          !hasAny(normalized, ["work experience", "resume cv and cover letter"])
        ) {
          return current;
        }
      }
    }

    return findVisibleEducationContainer();
  }

  function stripSchoolLocation(value) {
    return String(value || "").split(",")[0].trim();
  }

  function findVisibleEducationContainer() {
    const candidates = Array.from(document.querySelectorAll("section, form, fieldset, [role='group'], div"))
      .filter(isVisibleElement)
      .map((element) => ({
        element,
        text: rawVisibleText(element, 10000)
      }))
      .map((item) => ({
        ...item,
        normalized: normalize(item.text)
      }))
      .filter((item) => {
        if (!item.normalized || item.text.length > 7000) {
          return false;
        }

        return hasAny(item.normalized, ["education"]) &&
          hasAny(item.normalized, ["school or university", "school university"]) &&
          hasAny(item.normalized, ["degree"]) &&
          hasAny(item.normalized, ["field of study", "field study"]) &&
          hasAny(item.normalized, ["actual or expected", "expected", "yyyy"]) &&
          !hasAny(item.normalized, ["work experience"]);
      })
      .sort((left, right) => left.text.length - right.text.length);

    return candidates.length > 0 ? candidates[0].element : null;
  }

  function findExpectedGraduationYearField(container) {
    const controls = Array.from(container.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter((element) => isVisibleControl(element) && !isFileInput(element));
    const yearFields = controls.filter((element) => {
      const value = String(getCurrentValue(element) || "").trim();
      const placeholder = normalize(element.getAttribute("placeholder") || "");
      const context = normalize(getElementContext(element));
      return (placeholder === "yyyy" || hasAny(context, ["actual or expected", "expected"])) && (!value || /^\d{4}$/.test(value));
    });

    return yearFields[yearFields.length - 1] || null;
  }

  function scoreApplicationFileInput(input) {
    const attachmentSection = getAttachmentSectionElement();
    const pageText = normalize(rawVisibleText(document.body, 120000));
    const isAttachmentStep = hasAny(pageText, ["resume cv and cover letter", "please attach both", "cover letter"]);
    const context = normalize([
      input.accept || "",
      input.name || "",
      input.id || "",
      input.getAttribute("aria-label") || "",
      getElementContext(input)
    ].join(" "));
    let score = 0;

    if (isVisibleControl(input)) {
      score += 3;
    }
    if (attachmentSection && attachmentSection.contains(input)) {
      score += 30;
    } else if (isAttachmentStep) {
      score -= 12;
    }
    if (isAttachmentStep && hasAny(context, ["quick apply", "upload resume or cv", "drop file here"])) {
      score -= 20;
    }
    if (hasAny(context, ["resume", "cv", "curriculum vitae", "cover letter"])) {
      score += 8;
    }
    if (hasAny(context, ["upload", "drop file", "select files", "doc", "docx", "pdf", "file"])) {
      score += 4;
    }
    if (/\.(?:docx?|pdf)|application\/|text\//i.test(input.accept || "")) {
      score += 3;
    }

    return score;
  }

  function applyWorkdaySkills(skills) {
    const value = String(skills || "").trim();
    if (!value) {
      return { applied: false, skipped: "empty_skills" };
    }

    const field = findSkillsField();
    if (!field) {
      return { applied: false, skipped: "no_skills_field" };
    }

    const currentValue = getCurrentValue(field);
    if (String(currentValue || "").trim()) {
      return { applied: false, skipped: "skills_already_filled" };
    }

    setTextControlValue(field, value);
    dispatchInputEvents(field);
    mark(field, "filled");
    return { applied: true, skipped: "" };
  }

  function setTextControlValue(field, value) {
    if (field && field.getAttribute("contenteditable") === "true") {
      field.textContent = value;
      return;
    }

    setNativeValue(field, value);
  }

  function findSkillsField() {
    const candidates = Array.from(document.querySelectorAll(`${TEXT_FIELD_SELECTOR}, textarea`))
      .filter((element) => isFillable(element) && !isFileInput(element))
      .map((element) => ({
        element,
        score: scoreSkillsField(element)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    return candidates.length > 0 ? candidates[0].element : null;
  }

  function scoreSkillsField(element) {
    const context = normalize(getElementContext(element));
    let score = 0;

    if (hasAny(context, ["skills"])) {
      score += 8;
    }
    if (hasAny(context, ["separate each skill", "comma", "skill with a comma"])) {
      score += 6;
    }
    if (element.tagName.toLowerCase() === "textarea" || element.getAttribute("contenteditable") === "true") {
      score += 2;
    }

    return score;
  }

  function dispatchFileInputEvents(input) {
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function dispatchFileDropEvents(input, transfer) {
    const targets = findApplicationDropTargets(input);
    if (targets.length === 0 || !transfer) {
      return;
    }

    for (const target of targets) {
      for (const type of ["dragenter", "dragover", "drop"]) {
        const event = createFileDragEvent(type, transfer);
        if (type === "dragover") {
          event.preventDefault();
        }
        target.dispatchEvent(event);
      }
    }
  }

  function findApplicationDropTargets(input) {
    const targets = [];
    const seen = new Set();
    const add = (element) => {
      if (element && !seen.has(element)) {
        seen.add(element);
        targets.push(element);
      }
    };

    add(input);
    const attachmentSection = getAttachmentSectionElement();
    if (attachmentSection) {
      add(attachmentSection);
    }

    let current = input ? input.parentElement : null;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const normalized = normalize(visibleText(current));
      if (hasAny(normalized, ["upload", "drop file", "select files", "resume", "cover letter"])) {
        add(current);
      }
    }

    add(document.body);
    return targets;
  }

  function createFileDragEvent(type, transfer) {
    try {
      return new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      });
    } catch (_error) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        configurable: true,
        value: transfer
      });
      return event;
    }
  }

  function extractRequirements(text) {
    const lines = String(text || "")
      .split(/\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const wanted = [];
    let collecting = false;

    for (const line of lines) {
      const normalized = normalize(line);
      if (hasAny(normalized, ["requirement", "qualification", "minimum", "preferred", "skill", "knowledge"])) {
        collecting = true;
      }

      if (collecting) {
        wanted.push(line);
      }

      if (collecting && wanted.length >= 45) {
        break;
      }
    }

    return visibleSnippet(wanted.join("\n"), 6000);
  }

  function nearestJobContainer(anchor) {
    const selectors = [
      "[data-automation-id*='job']",
      "[data-automation-id*='Job']",
      "[role='listitem']",
      "li",
      "article",
      "section",
      "tr"
    ];

    for (const selector of selectors) {
      const match = anchor.closest(selector);
      if (match && visibleText(match).length < 5000) {
        return match;
      }
    }

    let parent = anchor.parentElement;
    for (let depth = 0; parent && depth < 4; depth += 1) {
      const text = visibleText(parent);
      if (text.length > 20 && text.length < 5000) {
        return parent;
      }
      parent = parent.parentElement;
    }

    return anchor;
  }

  function extractJobTitle(anchor, container) {
    const titleNode = container && container.querySelector(
      "h1, h2, h3, [data-automation-id*='jobTitle'], [data-automation-id*='JobTitle'], [data-automation-id*='title'], [data-automation-id*='Title']"
    );
    const title = visibleSnippet(titleNode ? visibleText(titleNode) : visibleText(anchor), 180);
    return title.replace(/\s+\|\s+.*$/, "").trim();
  }

  function looksLikeJobLink(href, anchor) {
    const haystack = normalize(`${href} ${visibleText(anchor)} ${anchor.getAttribute("aria-label") || ""}`);
    if (hasAny(haystack, ["job", "jobs", "requisition", "position", "student employment", "workday"])) {
      return true;
    }

    const container = nearestJobContainer(anchor);
    const containerText = normalize(visibleText(container));
    return hasAny(containerText, ["job id", "requisition", "posted", "location", "student worker", "apply"]);
  }

  function findApplyButtons() {
    return Array.from(document.querySelectorAll("button, a[href], [role='button']"))
      .map((element) => ({
        text: visibleSnippet(visibleText(element) || element.getAttribute("aria-label") || "", 120),
        href: element.href || element.getAttribute("href") || ""
      }))
      .filter((item) => normalize(item.text).includes("apply"))
      .slice(0, 10);
  }

  function extractJobId(text) {
    const match = String(text || "").match(/\b(?:JR|R|REQ)[-\s]?\d{3,}\b/i) || String(text || "").match(/\b\d{5,}\b/);
    return match ? match[0].replace(/\s+/g, "") : "";
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

  function normalizeJobId(value) {
    const match = String(value || "").match(/\bJR[-\s]?\d{3,}\b/i);
    return match ? match[0].replace(/[-\s]/g, "").toUpperCase() : "";
  }

  function extractLabeledValue(text, labels) {
    const lines = String(text || "")
      .split(/\n| {2,}/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const label of labels) {
      const pattern = new RegExp(`^${label}\\s*:?\\s*(.+)$`, "i");
      const match = lines.map((line) => line.match(pattern)).find(Boolean);
      if (match) {
        return visibleSnippet(match[1], 160);
      }
    }

    return "";
  }

  function toAbsoluteUrl(href) {
    try {
      return new URL(href, window.location.href).href;
    } catch (_error) {
      return "";
    }
  }

  function buildElementRecord(element) {
    const context = getElementContext(element);
    const controlType = getControlType(element);

    return {
      fieldId: assignFieldId(element),
      controlType,
      tagName: element.tagName.toLowerCase(),
      inputType: (element.getAttribute("type") || "").toLowerCase(),
      label: summarizeContext(context),
      context: visibleSnippet(context, 700),
      name: element.getAttribute("name") || "",
      elementId: element.id || "",
      placeholder: element.getAttribute("placeholder") || "",
      autocomplete: element.getAttribute("autocomplete") || "",
      required: Boolean(element.required || element.getAttribute("aria-required") === "true"),
      disabled: Boolean(element.disabled),
      readOnly: Boolean(element.readOnly),
      unsupported: controlType === "file",
      currentValue: getCurrentValue(element),
      options: getElementOptions(element)
    };
  }

  function buildRadioGroupRecord(fieldId, group) {
    const context = group.map((radio) => getElementContext(radio)).join(" ");
    const selected = group.find((radio) => radio.checked);

    return {
      fieldId,
      controlType: "radio",
      tagName: "input",
      inputType: "radio",
      label: summarizeContext(context),
      context: visibleSnippet(context, 700),
      name: group[0] ? group[0].name || "" : "",
      elementId: group[0] ? group[0].id || "" : "",
      placeholder: "",
      autocomplete: "",
      required: group.some((radio) => radio.required || radio.getAttribute("aria-required") === "true"),
      disabled: group.every((radio) => radio.disabled),
      readOnly: false,
      unsupported: false,
      currentValue: selected ? selected.value || getChoiceContext(selected) : "",
      options: group.map((radio) => ({
        value: radio.value || "",
        label: summarizeContext(getChoiceContext(radio)),
        checked: Boolean(radio.checked),
        disabled: Boolean(radio.disabled)
      }))
    };
  }

  function applyStagedAnswers(answers) {
    ensureHighlightStyle();

    const stats = {
      applied: 0,
      skipped: 0,
      failed: 0,
      appliedLabels: [],
      skippedFieldIds: []
    };

    for (const answer of Array.isArray(answers) ? answers : []) {
      try {
        const fieldId = answer && answer.fieldId ? String(answer.fieldId) : "";
        if (!fieldId) {
          stats.skipped += 1;
          continue;
        }

        const radioGroup = Array.from(
          document.querySelectorAll(`input[type="radio"][${RADIO_GROUP_ID_ATTR}="${cssEscape(fieldId)}"]`)
        ).filter(isFillable);

        const target = document.querySelector(`[${FIELD_ID_ATTR}="${cssEscape(fieldId)}"]`);
        const applied = radioGroup.length > 0
          ? applyAnswerToRadioGroup(radioGroup, answer)
          : target
            ? applyAnswerToElement(target, answer)
            : false;

        if (applied) {
          stats.applied += 1;
          stats.appliedLabels.push(answer.label || fieldId);
        } else {
          stats.skipped += 1;
          stats.skippedFieldIds.push(fieldId);
        }
      } catch (_error) {
        stats.failed += 1;
      }
    }

    return stats;
  }

  function applyAnswerToElement(element, answer) {
    if (!isFillable(element)) {
      mark(element, "unsupported");
      return false;
    }

    const value = answer.choiceValue ?? answer.value;

    if (element.matches("select")) {
      const filled = fillSelect(element, stringValue(value));
      mark(element, filled ? "filled" : "skipped");
      return filled;
    }

    if (element.matches('input[type="checkbox"]')) {
      const filled = applyAnswerToCheckbox(element, value);
      mark(element, filled ? "filled" : "skipped");
      return filled;
    }

    const filled = fillTextLike(element, value === undefined || value === null ? "" : String(value));
    mark(element, filled ? "filled" : "skipped");
    return filled;
  }

  function applyAnswerToRadioGroup(group, answer) {
    const desired = answer.choiceValue ?? answer.value;
    const target = group.find((radio) => optionMatches(radio, desired, getChoiceContext(radio)));

    if (!target) {
      group.forEach((radio) => mark(radio, "skipped"));
      return false;
    }

    setChecked(target, true);
    group.forEach((radio) => mark(radio, radio === target ? "filled" : "skipped"));
    return true;
  }

  function applyAnswerToCheckbox(checkbox, value) {
    if (typeof value === "boolean") {
      setChecked(checkbox, value);
      return true;
    }

    const desired = normalize(value);
    if (["yes", "true", "checked", "select", "selected", "1"].includes(desired)) {
      setChecked(checkbox, true);
      return true;
    }

    if (["no", "false", "unchecked", "clear", "0"].includes(desired)) {
      setChecked(checkbox, false);
      return true;
    }

    return false;
  }

  function record(stats, handled) {
    if (!handled) {
      return;
    }

    if (handled.status === "filled") {
      stats.filled += 1;
      if (handled.label) {
        stats.filledLabels.push(handled.label);
      }
      return;
    }

    if (handled.status === "unsupported") {
      stats.unsupported += 1;
      return;
    }

    stats.skipped += 1;
    if (handled.label) {
      stats.skippedLabels.push(handled.label);
    }
  }

  function fillSingleElement(element, profile) {
    const context = getElementContext(element);
    const value = resolveValue(element, context, profile);
    const label = summarizeContext(context);

    if (!value) {
      mark(element, "skipped");
      return { status: "skipped", label };
    }

    if (isFileInput(element)) {
      mark(element, "unsupported");
      return { status: "unsupported", label };
    }

    if (element.matches("select")) {
      const filled = fillSelect(element, value);
      mark(element, filled ? "filled" : "skipped");
      return { status: filled ? "filled" : "skipped", label };
    }

    if (element.matches('input[type="checkbox"]')) {
      const filled = fillCheckbox(element, value, getChoiceContext(element) || context);
      mark(element, filled ? "filled" : "skipped");
      return { status: filled ? "filled" : "skipped", label };
    }

    const actualValue = value.kind === "today" ? formatToday(element, context, profile) : value.value;
    const filled = fillTextLike(element, actualValue);
    mark(element, filled ? "filled" : "skipped");
    return { status: filled ? "filled" : "skipped", label };
  }

  function fillRadioGroup(group, profile) {
    const groupContext = group.map((radio) => getElementContext(radio)).join(" ");
    const value = resolveValue(group[0], groupContext, profile);
    const label = summarizeContext(groupContext);

    if (!value) {
      group.forEach((radio) => mark(radio, "skipped"));
      return { status: "skipped", label };
    }

    const desired = value.value;
    const target = group.find((radio) => optionMatches(radio, desired, getChoiceContext(radio)));

    if (!target) {
      group.forEach((radio) => mark(radio, "skipped"));
      return { status: "skipped", label };
    }

    setChecked(target, true);
    group.forEach((radio) => mark(radio, radio === target ? "filled" : "skipped"));
    return { status: "filled", label };
  }

  function fillSelect(select, value) {
    const desiredValues = getSelectAliases(value.value).map(normalize).filter(Boolean);
    if (desiredValues.length === 0) {
      return false;
    }

    const options = Array.from(select.options);
    const candidates = options.filter((option) => !option.disabled && option.value !== "");
    const match =
      candidates.find((option) => desiredValues.includes(normalize(option.textContent))) ||
      candidates.find((option) => desiredValues.includes(normalize(option.value))) ||
      candidates.find((option) => desiredValues.some((desired) => normalize(option.textContent).includes(desired))) ||
      candidates.find((option) => desiredValues.some((desired) => desired.includes(normalize(option.textContent)))) ||
      candidates.find((option) => desiredValues.some((desired) => desired.includes(normalize(option.value))));

    if (!match) {
      return false;
    }

    select.value = match.value;
    dispatchInputEvents(select);
    return true;
  }

  function getSelectAliases(value) {
    const raw = String(value || "");
    const normalized = normalize(raw);
    const aliases = new Set([raw]);

    if (normalized === "arizona") {
      aliases.add("AZ");
    }

    if (normalized === "az") {
      aliases.add("Arizona");
    }

    if (normalized === "united states") {
      aliases.add("United States of America");
      aliases.add("USA");
      aliases.add("US");
    }

    if (normalized === "masters" || normalized === "master s") {
      aliases.add("Master");
      aliases.add("Masters");
      aliases.add("Master's Degree");
      aliases.add("Graduate");
    }

    if (isNonDisclosureAnswer(raw)) {
      aliases.add("I don't wish to answer");
      aliases.add("I do not want to answer");
      aliases.add("I choose not to answer");
      aliases.add("I choose not to self-identify");
      aliases.add("I do not wish to self-identify");
      aliases.add("Decline to answer");
      aliases.add("Decline to self-identify");
      aliases.add("Not Declared");
      aliases.add("Not Disclosed");
    }

    return Array.from(aliases);
  }

  function fillCheckbox(checkbox, value, context) {
    const desired = normalize(value.value);
    const optionText = normalize(context);

    if (desired === "yes") {
      if (hasAny(optionText, ["no", "not eligible", "decline"])) {
        return false;
      }
      setChecked(checkbox, true);
      return true;
    }

    if (desired === "no" && hasAny(optionText, [" no ", "not eligible", "i am not", "decline"])) {
      setChecked(checkbox, true);
      return true;
    }

    return false;
  }

  function fillTextLike(element, value) {
    if (!value) {
      return false;
    }

    element.focus({ preventScroll: true });

    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      setNativeValue(element, value);
    }

    dispatchInputEvents(element);

    if (element.getAttribute("role") === "combobox" || element.getAttribute("aria-autocomplete")) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }

    return true;
  }

  async function autofillKnownApplicationFields(profile) {
    const stats = {
      applied: 0,
      skipped: 0,
      fields: [],
      needsValues: []
    };

    await fillKnownNativeApplicationQuestions(profile, stats);
    await fillKnownVoluntaryDisclosures(profile, stats);
    await fillKnownSelfIdentification(profile, stats);
    await fillKnownWorkdayDropdownQuestions(profile, stats);
    await ensureFederalWorkStudyDropdown(profile, stats);
    return stats;
  }

  async function fillKnownNativeApplicationQuestions(profile, stats) {
    const seenRadioGroups = new Set();
    const elements = Array.from(document.querySelectorAll(CONTROL_SELECTOR)).filter(isFillable);

    for (const element of elements) {
      try {
        if (element.matches('input[type="radio"]')) {
          const name = element.name || getStableKey(element);
          if (seenRadioGroups.has(name)) {
            continue;
          }
          seenRadioGroups.add(name);

          const group = getRadioGroup(element);
          const context = getKnownApplicationQuestionContext(element, group.map((radio) => getElementContext(radio)).join(" "));
          const value = getKnownApplicationQuestionAnswer(context, profile);
          if (!value) {
            continue;
          }

          const target = group.find((radio) => optionMatches(radio, value.value, getChoiceContext(radio)));
          if (!target) {
            stats.skipped += 1;
            group.forEach((radio) => mark(radio, "skipped"));
            continue;
          }

          if (!await setCheckedWithTrustedClick(target, true)) {
            stats.skipped += 1;
            group.forEach((radio) => mark(radio, "skipped"));
            continue;
          }
          group.forEach((radio) => mark(radio, radio === target ? "filled" : "skipped"));
          recordApplicationQuestionFill(stats, context);
          continue;
        }

        const context = getKnownApplicationQuestionContext(element, getElementContext(element));
        const value = getKnownApplicationQuestionAnswer(context, profile);
        if (!value) {
          continue;
        }

        let filled = false;
        if (element.matches("select")) {
          filled = fillSelect(element, value);
        } else if (element.matches('input[type="checkbox"]')) {
          filled = await fillKnownApplicationCheckboxQuestion(element, value, getChoiceContext(element) || context);
        } else {
          filled = fillTextLike(element, value.value);
        }

        mark(element, filled ? "filled" : "skipped");
        if (filled) {
          recordApplicationQuestionFill(stats, context);
        } else {
          stats.skipped += 1;
        }
      } catch (_error) {
        stats.skipped += 1;
      }
    }
  }

  async function fillKnownApplicationCheckboxQuestion(checkbox, value, context) {
    const desired = normalize(value.value);
    const optionText = normalize(context);

    if (desired === "yes") {
      if (hasAny(optionText, ["no", "not eligible", "decline"])) {
        return false;
      }
      return setCheckedWithTrustedClick(checkbox, true);
    }

    if (desired === "no" && hasAny(optionText, [" no ", "not eligible", "i am not", "decline"])) {
      return setCheckedWithTrustedClick(checkbox, true);
    }

    return false;
  }

  async function fillKnownVoluntaryDisclosures(profile, stats) {
    const disclosures = profile.voluntaryDisclosures || {};

    fillVoluntaryDisclosureRadio(["hispanic or latino descent"], disclosures.hispanicOrLatino, stats, "Hispanic/Latino descent");
    fillVoluntaryDisclosureCheckboxGroup(["ethnicity which most accurately describes", "how you identify yourself"], disclosures.ethnicity, stats, "ethnicity");
    await fillVoluntaryDisclosureChoice(["please select your gender", "select your gender"], disclosures.gender, stats, "gender");
    await fillVoluntaryDisclosureChoice(["please select your veteran status", "veteran status"], disclosures.veteranStatus, stats, "veteran status");
    fillVoluntaryDisclosureAttestation(disclosures.acceptTerms, stats);
  }

  function fillVoluntaryDisclosureRadio(contextTerms, desiredValue, stats, missingLabel) {
    const value = stringValue(desiredValue);
    if (!value) {
      noteMissingRadioValue(contextTerms, stats, missingLabel);
      return false;
    }

    const container = findQuestionContainerByTerms(contextTerms, 'input[type="radio"]');
    if (!container) {
      return false;
    }

    const radios = Array.from(container.querySelectorAll('input[type="radio"]')).filter(isFillable);
    const target = radios.find((radio) => optionMatches(radio, value.value, getChoiceContext(radio)));
    if (!target) {
      stats.skipped += 1;
      radios.forEach((radio) => mark(radio, "skipped"));
      return false;
    }

    setChecked(target, true);
    radios.forEach((radio) => mark(radio, radio === target ? "filled" : "skipped"));
    recordApplicationQuestionFill(stats, visibleText(container));
    return true;
  }

  function fillVoluntaryDisclosureCheckboxGroup(contextTerms, desiredValue, stats, missingLabel) {
    const value = stringValue(desiredValue);
    if (!value) {
      noteMissingCheckboxValue(contextTerms, stats, missingLabel);
      return false;
    }

    const container = findQuestionContainerByTerms(contextTerms, 'input[type="checkbox"]');
    if (!container) {
      return false;
    }

    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(isFillable);
    const desired = value.value;
    const target = checkboxes.find((checkbox) => choiceTextMatchesDesired(getChoiceContext(checkbox), desired));
    if (!target) {
      stats.skipped += 1;
      checkboxes.forEach((checkbox) => mark(checkbox, "skipped"));
      return false;
    }

    setChecked(target, true);
    if (isNonDisclosureAnswer(desired)) {
      for (const checkbox of checkboxes) {
        if (checkbox !== target && checkbox.checked) {
          setChecked(checkbox, false);
        }
      }
    }

    checkboxes.forEach((checkbox) => mark(checkbox, checkbox === target ? "filled" : "skipped"));
    recordApplicationQuestionFill(stats, visibleText(container));
    return true;
  }

  async function fillVoluntaryDisclosureChoice(contextTerms, desiredValue, stats, missingLabel) {
    const value = stringValue(desiredValue);
    if (!value) {
      noteMissingChoiceValue(contextTerms, stats, missingLabel);
      return false;
    }

    const container = findQuestionContainerByTerms(contextTerms, "[role='combobox'], [aria-haspopup], button");
    if (!container) {
      return false;
    }

    const control = findBestChoiceControlInContainer(container, contextTerms);
    if (!control) {
      return false;
    }

    const result = await fillWorkdayChoiceControl(control, value.value);
    if (result === "filled") {
      recordApplicationQuestionFill(stats, visibleText(container));
      return true;
    }

    if (result === "skipped") {
      stats.skipped += 1;
    }

    return result === "already";
  }

  function fillVoluntaryDisclosureAttestation(desiredValue, stats) {
    const value = normalize(desiredValue);
    if (!["yes", "true", "checked", "accept", "accepted", "1"].includes(value)) {
      noteMissingAttestationValue(stats);
      return false;
    }

    const container = findQuestionContainerByTerms(["legal equivalent of a signature", "accepting the terms"], 'input[type="checkbox"]');
    if (!container) {
      return false;
    }

    const checkbox = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(isFillable)[0];
    if (!checkbox) {
      return false;
    }

    setChecked(checkbox, true);
    mark(checkbox, "filled");
    recordApplicationQuestionFill(stats, visibleText(container));
    return true;
  }

  async function fillKnownSelfIdentification(profile, stats) {
    const container = findSelfIdentificationContainer();
    if (!container) {
      return;
    }

    fillSelfIdentificationName(container, profile, stats);
    await fillSelfIdentificationDate(container, profile, stats);
    await fillSelfIdentificationDisabilityStatus(container, profile, stats);
  }

  function findSelfIdentificationContainer() {
    const candidates = Array.from(document.querySelectorAll("main, form, section, [role='main'], [data-automation-id], div"))
      .filter((element) => element instanceof HTMLElement)
      .filter(isVisibleElement)
      .map((element) => ({
        element,
        text: normalize(visibleText(element))
      }))
      .filter((candidate) =>
        candidate.text.length > 0 &&
        candidate.text.length < 12000 &&
        hasAll(candidate.text, ["voluntary self identification of disability", "cc 305"])
      )
      .sort((left, right) => left.text.length - right.text.length);

    return candidates.length > 0 ? candidates[0].element : null;
  }

  function fillSelfIdentificationName(container, profile, stats) {
    const value = stringValue((profile.personal || {}).fullName);
    if (!value) {
      return false;
    }

    const field = Array.from(container.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter(isFillable)
      .find((element) => {
        const context = normalize(getElementContext(element));
        return hasAny(context, ["name"]) && !hasAny(context, ["employee id", "if applicable"]);
      });

    if (!field) {
      return false;
    }

    const filled = fillTextLike(field, value.value);
    mark(field, filled ? "filled" : "skipped");
    if (filled) {
      recordApplicationQuestionFill(stats, "Voluntary Self-Identification of Disability Name");
    } else {
      stats.skipped += 1;
    }
    return filled;
  }

  async function fillSelfIdentificationDate(container, profile, stats) {
    const today = getArizonaTodayParts();
    if (!selfIdentificationDateHasValidationError(container) && selfIdentificationDateLooksFilled(container, today)) {
      recordApplicationQuestionFill(stats, "Voluntary Self-Identification of Disability Date");
      return true;
    }

    if (await fillSelfIdentificationDateFields(container, today) || await fillSelfIdentificationDateWithCalendar(container, today)) {
      recordApplicationQuestionFill(stats, "Voluntary Self-Identification of Disability Date");
      return true;
    }

    stats.skipped += 1;
    return false;
  }

  function findSelfIdentificationDateFields(container) {
    const dateContainer = findQuestionContainerByTerms(["date", "mm/dd/yyyy"], TEXT_FIELD_SELECTOR) || container;
    const fields = Array.from(dateContainer.querySelectorAll(TEXT_FIELD_SELECTOR))
      .filter(isFillable)
      .filter((element) => {
        const context = normalize(getElementContext(element));
        return !hasAny(context, ["employee id", "name"]);
      });

    const byContext = (terms) => fields.find((element) => hasAny(normalize(getElementContext(element)), terms));
    return {
      month: byContext(["month", "mm"]) || fields[0] || null,
      day: byContext(["day", "dd"]) || fields[1] || null,
      year: byContext(["year", "yyyy"]) || fields[2] || null
    };
  }

  async function fillSelfIdentificationDateFields(container, today) {
    const fields = findSelfIdentificationDateFields(container);
    if (!fields.month || !fields.day || !fields.year) {
      return false;
    }

    const parts = [
      [fields.month, today.month],
      [fields.day, today.day],
      [fields.year, today.year]
    ];

    for (const [field, value] of parts) {
      if (!await fillWorkdayDateSegmentReliably(field, value)) {
        return false;
      }
    }

    commitWorkdayDateSegments(parts.map(([field]) => field));
    await delay(250);
    return selfIdentificationDateLooksFilled(container, today);
  }

  async function fillSelfIdentificationDateWithCalendar(container, today) {
    const calendarButton = findSelfIdentificationCalendarButton(container);
    if (!calendarButton) {
      return false;
    }

    clickTextLikeElement(calendarButton);
    await delay(250);

    const todayButton = findCalendarDateButton(today);
    if (!todayButton) {
      closeOpenPicker(calendarButton);
      return false;
    }

    choosePickerOption(todayButton);
    await delay(300);
    const fields = findSelfIdentificationDateFields(container);
    commitWorkdayDateSegments([fields.month, fields.day, fields.year].filter(Boolean));
    return selfIdentificationDateLooksFilled(container, today);
  }

  function findSelfIdentificationCalendarButton(container) {
    return Array.from(container.querySelectorAll("button"))
      .filter(isVisibleElement)
      .find((button) => {
        const text = normalize([
          visibleText(button),
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
          getElementContext(button)
        ].join(" "));
        return hasAny(text, ["calendar"]);
      }) || null;
  }

  function findCalendarDateButton(today) {
    const monthName = normalize(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Phoenix",
      month: "long"
    }).format(new Date()));
    const day = String(Number(today.day));
    const year = String(today.year);

    return Array.from(document.querySelectorAll("button"))
      .filter(isVisibleElement)
      .find((button) => {
        const text = normalize([
          visibleText(button),
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || ""
        ].join(" "));
        return hasAny(text, [monthName]) && hasAny(text, [day]) && hasAny(text, [year]);
      }) || null;
  }

  function selfIdentificationDateLooksFilled(container, today) {
    const fields = findSelfIdentificationDateFields(container);
    if (
      fields.month &&
      fields.day &&
      fields.year &&
      dateSegmentMatches(fields.month, today.month) &&
      dateSegmentMatches(fields.day, today.day) &&
      dateSegmentMatches(fields.year, today.year)
    ) {
      return true;
    }

    const candidates = [
      `${Number(today.month)}/${Number(today.day)}/${today.year}`,
      `${today.month}/${today.day}/${today.year}`
    ].map(normalize);
    const text = normalize(visibleText(container));

    return candidates.some((candidate) => text.includes(candidate));
  }

  function selfIdentificationDateHasValidationError(container) {
    const fields = findSelfIdentificationDateFields(container);
    const dateFields = [fields.month, fields.day, fields.year].filter(Boolean);
    if (dateFields.some((field) => field.getAttribute("aria-invalid") === "true")) {
      return true;
    }

    const context = normalize(dateFields.map((field) => getElementContext(field)).join(" "));
    return hasAll(context, ["date", "required"]);
  }

  async function fillWorkdayDateSegmentReliably(element, value) {
    if (!element) {
      return false;
    }

    clearStaleWorkdayAccessibilityValue(element);

    try {
      element.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (_error) {
      // Focusing and trusted input below are the important pieces.
    }

    if (await fillWorkdayDateSegmentWithTrustedInput(element, value)) {
      return true;
    }

    const filled = fillWorkdayDateSegment(element, value);
    if (filled) {
      commitWorkdayDateSegments([element]);
      await delay(120);
    }

    return dateSegmentMatches(element, value);
  }

  async function fillWorkdayDateSegmentWithTrustedInput(element, value) {
    const desired = String(value || "").trim();
    if (!desired) {
      return false;
    }

    focusAndSelectTextLikeElement(element);
    const response = await requestTrustedTextInsertion(desired);
    if (!response || response.ok === false) {
      return false;
    }

    await delay(180);
    commitWorkdayDateSegments([element]);
    await delay(120);
    return dateSegmentMatches(element, desired);
  }

  function fillWorkdayDateSegment(element, value) {
    const desired = String(value || "").trim();
    if (!desired) {
      return false;
    }

    const variants = [desired];
    const unpadded = desired.replace(/^0+(\d)$/, "$1");
    if (unpadded && unpadded !== desired) {
      variants.push(unpadded);
    }

    for (const variant of variants) {
      focusAndSelectTextLikeElement(element);
      if (insertTextWithEditingCommand(element, variant) && dateSegmentMatches(element, desired)) {
        return true;
      }

      setTextLikeValueWithoutBlur(element, variant);
      dispatchTextInputEvents(element, variant);
      if (dateSegmentMatches(element, desired)) {
        return true;
      }
    }

    return dateSegmentMatches(element, desired);
  }

  function focusAndSelectTextLikeElement(element) {
    element.focus({ preventScroll: true });
    clickTextLikeElement(element);

    if (typeof element.select === "function") {
      element.select();
      return;
    }

    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function clickTextLikeElement(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const clientX = rect.left + Math.min(Math.max(6, rect.width / 2), rect.width - 2);
    const clientY = rect.top + Math.min(Math.max(6, rect.height / 2), rect.height - 2);
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    element.click();
  }

  function insertTextWithEditingCommand(element, value) {
    try {
      const inserted = document.execCommand("insertText", false, value);
      dispatchTextInputEvents(element, value);
      return inserted || dateSegmentMatches(element, value);
    } catch (_error) {
      return false;
    }
  }

  function setTextLikeValueWithoutBlur(element, value) {
    if (element.isContentEditable) {
      element.textContent = value;
      return;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeValue(element, value);
      return;
    }

    element.textContent = value;
  }

  function dispatchTextInputEvents(element, value) {
    try {
      element.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: value,
        inputType: "insertText"
      }));
    } catch (_error) {
      // Some extension contexts cannot construct InputEvent with data; the plain input event below is enough there.
    }

    try {
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: value,
        inputType: "insertText"
      }));
    } catch (_error) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function commitWorkdayDateSegments(fields) {
    for (const field of fields) {
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    for (const field of fields) {
      field.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }

  function dateSegmentMatches(element, desiredValue) {
    const desired = String(desiredValue || "").trim();
    const current = getTextLikeCurrentValue(element);
    if (!current) {
      return false;
    }

    if (current === desired) {
      return true;
    }

    const desiredNumber = Number(desired);
    const currentNumber = Number(current);
    return Number.isFinite(desiredNumber) && Number.isFinite(currentNumber) && desiredNumber === currentNumber;
  }

  function getTextLikeCurrentValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const value = String(element.value || "").trim();
      if (value) {
        return value;
      }

      return String(element.getAttribute("aria-valuenow") || element.getAttribute("aria-valuetext") || "").trim();
    }

    return String(element.textContent || element.getAttribute("aria-valuenow") || element.getAttribute("aria-valuetext") || "").trim();
  }

  async function fillSelfIdentificationDisabilityStatus(container, profile, stats) {
    const desiredValue = ((profile.selfIdentification || {}).disabilityStatus || "").trim();
    const group = findSelfIdentificationDisabilityCheckboxes(container);
    if (group.length === 0) {
      return false;
    }

    if (!desiredValue) {
      if (!group.some((checkbox) => checkbox.checked)) {
        addNeededValue(stats, "disability status");
      }
      return false;
    }

    const target = group.find((checkbox) => choiceTextMatchesDesired(getChoiceContext(checkbox), desiredValue));
    if (!target) {
      stats.skipped += 1;
      group.forEach((checkbox) => mark(checkbox, "skipped"));
      return false;
    }

    const selected = await setCheckedWithTrustedClick(target, true);
    group.forEach((checkbox) => mark(checkbox, checkbox === target ? "filled" : "skipped"));

    if (!selected || !target.checked) {
      stats.skipped += 1;
      return false;
    }

    recordApplicationQuestionFill(stats, "Voluntary Self-Identification of Disability Status");
    return true;
  }

  function findSelfIdentificationDisabilityCheckboxes(container) {
    const questionContainer =
      findQuestionContainerByTerms(["please check one of the boxes below"], 'input[type="checkbox"]') ||
      findQuestionContainerByTerms(["yes i have a disability", "i do not want to answer"], 'input[type="checkbox"]') ||
      container;

    return Array.from(questionContainer.querySelectorAll('input[type="checkbox"]')).filter(isFillable);
  }

  function noteMissingRadioValue(contextTerms, stats, missingLabel) {
    const container = findQuestionContainerByTerms(contextTerms, 'input[type="radio"]');
    if (!container) {
      return;
    }

    const radios = Array.from(container.querySelectorAll('input[type="radio"]')).filter(isFillable);
    if (!radios.some((radio) => radio.checked)) {
      addNeededValue(stats, missingLabel || summarizeApplicationQuestionContext(visibleText(container)));
    }
  }

  function noteMissingCheckboxValue(contextTerms, stats, missingLabel) {
    const container = findQuestionContainerByTerms(contextTerms, 'input[type="checkbox"]');
    if (!container) {
      return;
    }

    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(isFillable);
    if (!checkboxes.some((checkbox) => checkbox.checked)) {
      addNeededValue(stats, missingLabel || summarizeApplicationQuestionContext(visibleText(container)));
    }
  }

  function noteMissingChoiceValue(contextTerms, stats, missingLabel) {
    const container = findQuestionContainerByTerms(contextTerms, "[role='combobox'], [aria-haspopup], button");
    if (!container) {
      return;
    }

    const control = findBestChoiceControlInContainer(container, contextTerms);
    if (!control || !workdayChoiceControlHasAnyValue(control)) {
      addNeededValue(stats, missingLabel || summarizeApplicationQuestionContext(visibleText(container)));
    }
  }

  function noteMissingAttestationValue(stats) {
    const container = findQuestionContainerByTerms(["legal equivalent of a signature", "accepting the terms"], 'input[type="checkbox"]');
    if (!container) {
      return;
    }

    const checkbox = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(isFillable)[0];
    if (checkbox && !checkbox.checked) {
      addNeededValue(stats, "legal signature attestation");
    }
  }

  function addNeededValue(stats, label) {
    const value = summarizeApplicationQuestionContext(label);
    if (value && !stats.needsValues.includes(value)) {
      stats.needsValues.push(value);
    }
  }

  function findQuestionContainerByTerms(terms, controlSelector) {
    const controls = Array.from(document.querySelectorAll(controlSelector)).filter((element) => {
      if (element.matches && element.matches("input, select, textarea")) {
        return isFillable(element);
      }
      return isVisibleElement(element);
    });

    for (const control of controls) {
      const directContext = normalize(getElementContext(control));
      if (hasAll(directContext, terms)) {
        return nearestUsefulContainer(control) || control.parentElement;
      }

      let current = control.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = normalize(visibleText(current));
        if (!text || text.length > 1200) {
          continue;
        }

        if (hasAll(text, terms)) {
          return current;
        }
      }
    }

    return null;
  }

  function findBestChoiceControlInContainer(container, contextTerms = []) {
    return Array.from(container.querySelectorAll([
      "[role='combobox']",
      "[aria-haspopup='listbox']",
      "[aria-haspopup='tree']",
      "[aria-haspopup='menu']",
      "[aria-haspopup='true']",
      "[data-automation-id*='select']",
      "[data-automation-id*='Select']",
      "[data-automation-id*='dropdown']",
      "[data-automation-id*='Dropdown']",
      "button"
    ].join(",")))
      .filter((element) => element instanceof HTMLElement)
      .filter(isVisibleElement)
      .filter(isLikelyWorkdayChoiceControl)
      .sort((left, right) => scoreChoiceControl(right, contextTerms) - scoreChoiceControl(left, contextTerms))[0] || null;
  }

  function scoreChoiceControl(element, contextTerms = []) {
    const context = normalize(getElementContext(element));
    const text = normalize(visibleText(element));
    let score = 0;
    if (contextTerms.length > 0 && hasAll(context, contextTerms)) {
      score += 40;
    }
    if (element.getAttribute("role") === "combobox") {
      score += 10;
    }
    if (hasAny(normalize(element.getAttribute("aria-haspopup") || ""), ["listbox", "tree", "menu", "true"])) {
      score += 6;
    }
    if (hasAny(text, ["select one"])) {
      score += 4;
    }
    return score;
  }

  function choiceTextMatchesDesired(choiceText, desiredValue) {
    return scoreChoiceOptionText(choiceText, desiredValue) > 0;
  }

  function isNonDisclosureAnswer(value) {
    return hasAny(normalize(value), [
      "i do not wish to answer",
      "i dont wish to answer",
      "decline",
      "not declared",
      "choose not",
      "do not want to answer"
    ]);
  }

  async function fillKnownWorkdayDropdownQuestions(profile, stats) {
    const controls = findWorkdayQuestionDropdownControls();
    const handledContexts = new Set();

    for (const control of controls) {
      const context = getKnownApplicationQuestionContext(control, getElementContext(control));
      const value = getKnownApplicationQuestionAnswer(context, profile);
      const contextKey = normalize(context);
      if (!value || !contextKey || handledContexts.has(contextKey)) {
        continue;
      }

      try {
        const result = await fillWorkdayChoiceControl(control, value.value);
        if (result === "filled") {
          recordApplicationQuestionFill(stats, context);
          handledContexts.add(contextKey);
        } else if (result === "already") {
          handledContexts.add(contextKey);
        } else {
          stats.skipped += 1;
        }
      } catch (_error) {
        stats.skipped += 1;
      }
    }
  }

  async function ensureFederalWorkStudyDropdown(profile, stats) {
    const value = stringValue((profile.eligibility || {}).federalWorkStudyEligible);
    if (!value) {
      return false;
    }

    const container = findQuestionContainerByTerms(["federal work study"], "[role='combobox'], [aria-haspopup], button");
    if (!container) {
      return false;
    }

    const control = findBestChoiceControlInContainer(container, ["federal work study"]);
    if (!control || workdayChoiceControlHasValue(control, value.value)) {
      return false;
    }

    const result = await fillWorkdayChoiceControl(control, value.value);
    if (result === "filled" || result === "already") {
      recordApplicationQuestionFill(stats, "Federal Work Study eligibility");
      return true;
    }

    stats.skipped += 1;
    return false;
  }

  function findWorkdayQuestionDropdownControls() {
    const selector = [
      "button",
      "[role='combobox']",
      "[aria-haspopup='listbox']",
      "[aria-haspopup='tree']",
      "[aria-haspopup='menu']",
      "[data-automation-id*='select']",
      "[data-automation-id*='Select']",
      "[data-automation-id*='dropdown']",
      "[data-automation-id*='Dropdown']",
      "[data-automation-id*='prompt']",
      "[data-automation-id*='Prompt']"
    ].join(",");

    return Array.from(document.querySelectorAll(selector))
      .filter((element) => element instanceof HTMLElement)
      .filter(isVisibleElement)
      .filter(isLikelyWorkdayChoiceControl);
  }

  function isLikelyWorkdayChoiceControl(element) {
    const role = normalize(element.getAttribute("role") || "");
    const ariaHasPopup = normalize(element.getAttribute("aria-haspopup") || "");
    const automationId = normalize(element.getAttribute("data-automation-id") || "");
    const text = normalize(visibleText(element));

    return (
      role === "combobox" ||
      hasAny(ariaHasPopup, ["listbox", "tree", "menu", "true"]) ||
      hasAny(automationId, ["select", "dropdown", "prompt"]) ||
      (element.tagName.toLowerCase() === "button" && hasAny(text, ["select one", "yes", "no"]))
    );
  }

  async function fillWorkdayChoiceControl(control, desiredValue) {
    if (workdayChoiceControlHasValue(control, desiredValue)) {
      mark(control, "filled");
      return "already";
    }

    closeOpenPicker(control);
    await delay(80);
    clickWorkdayChoiceControl(control);
    await delay(350);

    let option = findWorkdayChoiceOption(control, desiredValue);
    if (!option) {
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, composed: true }));
      await delay(220);
      option = findWorkdayChoiceOption(control, desiredValue);
    }

    if (!option) {
      closeOpenPicker(control);
      mark(control, "skipped");
      return "skipped";
    }

    choosePickerOption(option);
    await delay(260);
    dispatchInputEvents(control);
    mark(control, "filled");
    return "filled";
  }

  function clickWorkdayChoiceControl(control) {
    control.focus({ preventScroll: true });
    const rect = control.getBoundingClientRect();
    const clientX = rect.left + Math.max(8, rect.width / 2);
    const clientY = rect.top + Math.max(6, rect.height / 2);
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    control.click();
    control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
  }

  function workdayChoiceControlHasValue(control, desiredValue) {
    const current = normalize(visibleText(control) || control.getAttribute("aria-label") || "");
    if (!workdayChoiceControlHasAnyValue(control)) {
      return false;
    }

    return scoreChoiceOptionText(current, desiredValue) >= 90;
  }

  function workdayChoiceControlHasAnyValue(control) {
    const current = normalize(visibleText(control) || control.getAttribute("aria-label") || "");
    return Boolean(current && !hasAny(current, ["select one", "select an option", "choose"]));
  }

  function findWorkdayChoiceOption(control, desiredValue) {
    const roleSelector = [
      "[role='option']",
      "[role='menuitem']",
      "[role='treeitem']",
      "[data-automation-id*='promptOption']",
      "[data-automation-id*='PromptOption']",
      "[data-automation-id*='selectOption']",
      "[data-automation-id*='SelectOption']",
      "[data-automation-id*='menuItem']",
      "[data-automation-id*='MenuItem']"
    ].join(",");
    const fallbackSelector = `${roleSelector}, li, [role='listitem'], button, div`;
    const roots = getWorkdayChoiceOptionRoots(control);

    return bestWorkdayChoiceOption(collectChoiceOptionCandidates(roots, roleSelector, control), desiredValue) ||
      bestWorkdayChoiceOption(collectChoiceOptionCandidates([document], roleSelector, control), desiredValue) ||
      bestWorkdayChoiceOption(collectChoiceOptionCandidates(roots, fallbackSelector, control), desiredValue);
  }

  function getWorkdayChoiceOptionRoots(control) {
    const roots = [];
    const seen = new Set();
    const add = (element) => {
      if (element && !seen.has(element)) {
        seen.add(element);
        roots.push(element);
      }
    };

    for (const attr of ["aria-controls", "aria-owns"]) {
      const ids = (control.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
      for (const id of ids) {
        add(document.getElementById(id));
      }
    }

    Array.from(document.querySelectorAll([
      "[role='listbox']",
      "[role='menu']",
      "[role='tree']",
      "[data-automation-id*='prompt']",
      "[data-automation-id*='Prompt']",
      "[data-automation-id*='popover']",
      "[data-automation-id*='Popover']",
      "[data-automation-id*='popup']",
      "[data-automation-id*='Popup']"
    ].join(",")))
      .filter(isVisibleElement)
      .forEach(add);

    return roots;
  }

  function collectChoiceOptionCandidates(roots, selector, control) {
    const candidates = [];
    const seen = new Set();

    for (const root of roots) {
      if (!root || !root.querySelectorAll) {
        continue;
      }

      const elements = [
        root instanceof Element && root.matches(selector) ? root : null,
        ...Array.from(root.querySelectorAll(selector))
      ].filter(Boolean);

      for (const element of elements) {
        if (seen.has(element) || !isVisibleElement(element) || element === control || element.contains(control) || control.contains(element)) {
          continue;
        }

        const text = getChoiceOptionText(element);
        if (!text || text.length > 120) {
          continue;
        }

        seen.add(element);
        candidates.push({ element, text });
      }
    }

    return candidates;
  }

  function bestWorkdayChoiceOption(candidates, desiredValue) {
    const matches = candidates
      .map((candidate) => ({
        ...candidate,
        score: scoreChoiceOptionText(candidate.text, desiredValue)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.text.length - right.text.length);

    return matches.length > 0 ? matches[0].element : null;
  }

  function getChoiceOptionText(element) {
    return visibleSnippet([
      visibleText(element),
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || ""
    ].join(" "), 120);
  }

  function scoreChoiceOptionText(optionText, desiredValue) {
    const option = normalize(optionText);
    const aliases = getSelectAliases(desiredValue).map(normalize).filter(Boolean);
    const desired = normalize(desiredValue);

    if (!option || aliases.length === 0) {
      return 0;
    }

    if (aliases.includes(option)) {
      return 100;
    }

    if (desired === "yes") {
      return hasAny(option, ["yes"]) && !hasAny(option, ["no"]) ? 90 : 0;
    }

    if (desired === "no") {
      return hasAny(option, ["no"]) && !hasAny(option, ["yes"]) ? 90 : 0;
    }

    if (aliases.some((alias) => option.includes(alias) || alias.includes(option))) {
      return 60;
    }

    return 0;
  }

  function getKnownApplicationQuestionContext(element, fallbackContext) {
    const direct = String(fallbackContext || getElementContext(element) || "");
    if (getKnownApplicationQuestionKind(direct)) {
      return direct;
    }

    let current = element.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const text = visibleText(current);
      if (!text || text.length > 950) {
        continue;
      }

      if (getKnownApplicationQuestionKind(text)) {
        return text;
      }
    }

    return "";
  }

  function getKnownApplicationQuestionAnswer(rawContext, profile) {
    const kind = getKnownApplicationQuestionKind(rawContext);
    const eligibility = profile.eligibility || {};

    if (kind === "requiresSponsorship") {
      return stringValue(eligibility.requiresSponsorship);
    }

    if (kind === "workAuthorizedWithoutSponsorship") {
      return stringValue(eligibility.workAuthorizedWithoutSponsorship);
    }

    if (kind === "federalWorkStudyEligible") {
      return stringValue(eligibility.federalWorkStudyEligible);
    }

    if (kind === "enrolledInAsuClasses") {
      return stringValue(eligibility.enrolledInAsuClasses);
    }

    if (kind === "adult18OrOlder") {
      return stringValue(eligibility.adult18OrOlder);
    }

    return null;
  }

  function getKnownApplicationQuestionKind(rawContext) {
    const context = normalize(rawContext);
    const kinds = [];

    if (isSponsorshipQuestion(context)) {
      kinds.push("requiresSponsorship");
    }

    if (isWorkAuthorizationQuestion(context)) {
      kinds.push("workAuthorizedWithoutSponsorship");
    }

    if (isFederalWorkStudyQuestion(context)) {
      kinds.push("federalWorkStudyEligible");
    }

    if (isAsuEnrollmentQuestion(context)) {
      kinds.push("enrolledInAsuClasses");
    }

    if (isAdultQuestion(context)) {
      kinds.push("adult18OrOlder");
    }

    return kinds.length === 1 ? kinds[0] : "";
  }

  function recordApplicationQuestionFill(stats, context) {
    stats.applied += 1;
    const label = summarizeApplicationQuestionContext(context);
    if (label && !stats.fields.includes(label)) {
      stats.fields.push(label);
    }
  }

  function summarizeApplicationQuestionContext(context) {
    return visibleSnippet(String(context || "")
      .replace(/\*/g, " ")
      .replace(/\bselect one\b/ig, " ")
      .replace(/\s+/g, " ")
      .trim(), 120);
  }

  function resolveValue(element, rawContext, profile) {
    const context = normalize(rawContext);
    const personal = profile.personal || {};
    const eligibility = profile.eligibility || {};
    const application = profile.application || {};

    const custom = resolveCustomAnswer(context, application.customAnswers || []);
    if (custom) {
      return stringValue(custom);
    }

    if (isSensitiveOrDifferentPersonContext(context)) {
      return null;
    }

    if (isTodayContext(context)) {
      return { kind: "today", value: "today" };
    }

    if (isSponsorshipQuestion(context)) {
      return stringValue(eligibility.requiresSponsorship);
    }

    if (isWorkAuthorizationQuestion(context)) {
      return stringValue(eligibility.workAuthorizedWithoutSponsorship);
    }

    if (isFederalWorkStudyQuestion(context)) {
      return stringValue(eligibility.federalWorkStudyEligible);
    }

    if (isAsuEnrollmentQuestion(context)) {
      return stringValue(eligibility.enrolledInAsuClasses);
    }

    if (isAdultQuestion(context)) {
      return stringValue(eligibility.adult18OrOlder);
    }

    if (hasAll(context, ["preferred", "name"])) {
      return stringValue(personal.preferredName || personal.firstName);
    }

    if (hasAll(context, ["first", "name"]) || hasAll(context, ["given", "name"])) {
      return stringValue(personal.firstName);
    }

    if (hasAll(context, ["last", "name"]) || hasAll(context, ["family", "name"]) || hasAll(context, ["surname"])) {
      return stringValue(personal.lastName);
    }

    if (hasAny(context, ["full name", "legal name"]) && !hasAny(context, ["company", "employer", "school"])) {
      return stringValue(personal.fullName);
    }

    if (hasAny(context, ["email", "e mail"])) {
      return stringValue(personal.email);
    }

    if (hasAny(context, ["phone", "mobile", "cell"])) {
      return stringValue(personal.phone);
    }

    if (hasAny(context, ["linkedin", "linked in"])) {
      return stringValue(personal.linkedIn);
    }

    if (hasAny(context, ["github", "git hub"])) {
      return stringValue(personal.github);
    }

    if (hasAny(context, ["portfolio", "website", "web site", "personal site"])) {
      return stringValue(personal.website || personal.github);
    }

    if (hasAny(context, ["street address", "address line 1", "address 1"])) {
      return stringValue(personal.streetAddress);
    }

    if (hasAny(context, ["city", "town"])) {
      return stringValue(personal.city);
    }

    if (hasAny(context, ["state", "province", "region"])) {
      return stringValue(isSelectLike(element) ? personal.stateFull || personal.state : personal.state);
    }

    if (hasAny(context, ["zip", "postal"])) {
      return stringValue(personal.postalCode);
    }

    if (hasAny(context, ["country", "nation"])) {
      return stringValue(personal.country);
    }

    if (hasAny(context, ["summary", "bio", "about yourself"])) {
      return stringValue(application.shortBio);
    }

    return null;
  }

  function resolveCustomAnswer(context, customAnswers) {
    for (const item of customAnswers) {
      if (!item || !item.match || !item.value) {
        continue;
      }

      const terms = Array.isArray(item.match) ? item.match : [item.match];
      if (terms.some((term) => normalize(term) && context.includes(normalize(term)))) {
        return item.value;
      }
    }

    return null;
  }

  function isSensitiveOrDifferentPersonContext(context) {
    return hasAny(context, [
      "emergency contact",
      "reference",
      "referee",
      "supervisor email",
      "supervisor phone",
      "manager email",
      "manager phone",
      "parent",
      "guardian",
      "dependent",
      "ssn",
      "social security",
      "bank account",
      "routing number",
      "credit card",
      "driver license",
      "passport",
      "password"
    ]);
  }

  function isTodayContext(context) {
    return (
      hasAny(context, ["today date", "todays date", "date signed", "signature date"]) ||
      (hasAny(context, ["date"]) && hasAny(context, ["today", "signed", "signature"]))
    );
  }

  function isSponsorshipQuestion(context) {
    if (
      hasAny(context, ["without sponsorship", "without asu sponsorship"]) &&
      hasAny(context, ["eligible", "authorized", "work"])
    ) {
      return false;
    }

    return (
      hasAny(context, ["sponsorship", "sponsor"]) &&
      hasAny(context, ["require", "need", "future", "now", "visa", "immigration"])
    );
  }

  function isWorkAuthorizationQuestion(context) {
    return (
      hasAny(context, ["eligible to work", "authorized to work", "legally authorized"]) ||
      (hasAny(context, ["work in the united states", "work in u s", "work in usa"]) && hasAny(context, ["eligible", "authorized", "authorization"])) ||
      (hasAny(context, ["work", "employment"]) && hasAny(context, ["authorized", "eligible"]) && hasAny(context, ["united states", "u s", "usa"]))
    );
  }

  function isFederalWorkStudyQuestion(context) {
    return hasAny(context, ["federal work study", "work study", "fws"]);
  }

  function isAsuEnrollmentQuestion(context) {
    return (
      hasAny(context, ["enrolled", "enrollment", "student"]) &&
      hasAny(context, ["asu", "arizona state", "classes", "class"])
    );
  }

  function isAdultQuestion(context) {
    return hasAny(context, ["18 years", "eighteen", "older than 18", "at least 18"]);
  }

  function stringValue(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    return { kind: "text", value: String(value) };
  }

  function getElementContext(element) {
    const pieces = [];

    for (const label of Array.from(element.labels || [])) {
      pieces.push(visibleText(label));
    }

    addAttributePieces(element, pieces, [
      "aria-label",
      "placeholder",
      "name",
      "id",
      "autocomplete",
      "title",
      "data-automation-id",
      "data-qa-id"
    ]);

    for (const attr of ["aria-labelledby", "aria-describedby"]) {
      const ids = (element.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const related = document.getElementById(id);
        if (related) {
          pieces.push(visibleText(related));
        }
      }
    }

    const group = nearestUsefulContainer(element);
    if (group) {
      pieces.push(visibleText(group).slice(0, 700));
    }

    return pieces.filter(Boolean).join(" ");
  }

  function getChoiceContext(element) {
    const pieces = [element.value || ""];

    for (const label of Array.from(element.labels || [])) {
      pieces.push(visibleText(label));
    }

    addAttributePieces(element, pieces, ["aria-label", "title", "data-automation-id", "data-qa-id"]);

    const directLabel = element.closest("label");
    if (directLabel) {
      pieces.push(visibleText(directLabel));
    } else if (element.parentElement) {
      const parentText = visibleText(element.parentElement);
      if (parentText.length < 140) {
        pieces.push(parentText);
      }
    }

    return pieces.filter(Boolean).join(" ");
  }

  function addAttributePieces(element, pieces, attrs) {
    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (value) {
        pieces.push(value);
      }
    }
  }

  function nearestUsefulContainer(element) {
    const selectors = [
      "fieldset",
      '[role="group"]',
      '[role="radiogroup"]',
      '[data-automation-id*="formField"]',
      '[data-automation-id*="form-field"]',
      ".formField",
      ".form-field",
      "label",
      "tr",
      "li"
    ];

    for (const selector of selectors) {
      const match = element.closest(selector);
      if (match && visibleText(match).length < 900) {
        return match;
      }
    }

    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1) {
      const text = visibleText(parent);
      if (text.length > 0 && text.length < 600) {
        return parent;
      }
      parent = parent.parentElement;
    }

    return null;
  }

  function assignFieldId(element) {
    const existing = element.getAttribute(FIELD_ID_ATTR);
    if (existing) {
      return existing;
    }

    const id = `field-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    element.setAttribute(FIELD_ID_ATTR, id);
    return id;
  }

  function assignRadioGroupId(group) {
    const existing = group.find((radio) => radio.getAttribute(RADIO_GROUP_ID_ATTR));
    if (existing) {
      return existing.getAttribute(RADIO_GROUP_ID_ATTR);
    }

    const id = `radio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    group.forEach((radio) => radio.setAttribute(RADIO_GROUP_ID_ATTR, id));
    return id;
  }

  function getControlType(element) {
    if (element.matches("select")) {
      return "select";
    }

    if (element.matches("textarea")) {
      return "textarea";
    }

    if (element.isContentEditable) {
      return "contenteditable";
    }

    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "file") {
      return type;
    }

    return "text";
  }

  function getCurrentValue(element) {
    if (element.matches("select")) {
      const selected = Array.from(element.selectedOptions || []);
      if (element.multiple) {
        return selected.map((option) => option.value || option.textContent || "");
      }
      return selected[0] ? selected[0].value || selected[0].textContent || "" : element.value || "";
    }

    if (element.matches('input[type="checkbox"]')) {
      return Boolean(element.checked);
    }

    if (element.matches('input[type="file"]')) {
      return "";
    }

    if (element.isContentEditable) {
      return element.textContent || "";
    }

    return element.value || "";
  }

  function getElementOptions(element) {
    if (element.matches("select")) {
      return Array.from(element.options || []).map((option) => ({
        value: option.value || "",
        label: visibleSnippet(option.textContent || "", 180),
        selected: Boolean(option.selected),
        disabled: Boolean(option.disabled)
      }));
    }

    if (element.matches('input[type="checkbox"]')) {
      return [
        {
          value: element.value || "on",
          label: summarizeContext(getChoiceContext(element)),
          checked: Boolean(element.checked),
          disabled: Boolean(element.disabled)
        }
      ];
    }

    return [];
  }

  function createSessionId() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRadioGroup(radio) {
    if (radio.name) {
      return Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscape(radio.name)}"]`)).filter(isFillable);
    }

    const container = nearestUsefulContainer(radio);
    return Array.from((container || document).querySelectorAll('input[type="radio"]')).filter(isFillable);
  }

  function getStableKey(element) {
    return element.id || element.name || getElementContext(element).slice(0, 80);
  }

  function optionMatches(element, desired, context) {
    const desiredNorm = normalize(desired);
    const value = normalize(element.value);
    const label = normalize(context);

    if (desiredNorm === "yes") {
      return value === "yes" || label.includes(" yes ") || label.endsWith(" yes") || label === "yes";
    }

    if (desiredNorm === "no") {
      return value === "no" || label.includes(" no ") || label.endsWith(" no") || label === "no";
    }

    return value === desiredNorm || label.includes(desiredNorm);
  }

  function getArizonaTodayParts() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Phoenix",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function formatToday(element, context, profile) {
    const map = getArizonaTodayParts();
    const iso = `${map.year}-${map.month}-${map.day}`;
    const us = `${map.month}/${map.day}/${map.year}`;
    const normalized = normalize(context);

    if (element.type === "date" || normalized.includes("yyyy mm dd")) {
      return iso;
    }

    if ((profile.application || {}).todayDateFormat === "YYYY-MM-DD") {
      return iso;
    }

    return us;
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function setChecked(element, checked) {
    if (element.checked !== checked) {
      element.click();
    }
    element.checked = checked;
    dispatchInputEvents(element);
  }

  async function setCheckedWithTrustedClick(element, checked) {
    if (element.checked !== checked) {
      try {
        element.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_error) {
        // Trusted click below uses the current viewport position.
      }

      const response = await requestTrustedClick(element);
      if (!response || response.ok === false) {
        element.click();
      }
      await delay(260);
    }

    if (element.checked !== checked) {
      element.click();
      await delay(180);
    }

    dispatchInputEvents(element);
    return element.checked === checked;
  }

  function requestTrustedClick(element) {
    const rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    if (!rect || !rect.width || !rect.height) {
      return Promise.resolve({ ok: false, error: "Element has no clickable bounds." });
    }

    const x = rect.left + Math.min(Math.max(6, rect.width / 2), rect.width - 2);
    const y = rect.top + Math.min(Math.max(6, rect.height / 2), rect.height - 2);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          type: "APPLICATION_AUTOFILL_TRUSTED_CLICK",
          x,
          y
        }, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, error: error.message });
            return;
          }

          resolve(response || { ok: false, error: "No trusted click response." });
        });
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function ensureHighlightStyle() {
    if (document.getElementById(FILL_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = FILL_STYLE_ID;
    style.textContent = `
      [data-application-autofill="filled"] {
        outline: 2px solid #0f9d58 !important;
        outline-offset: 2px !important;
      }

      [data-application-autofill="skipped"] {
        outline: 2px solid #f4b400 !important;
        outline-offset: 2px !important;
      }

      [data-application-autofill="unsupported"] {
        outline: 2px solid #db4437 !important;
        outline-offset: 2px !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clearHighlights() {
    document.querySelectorAll("[data-application-autofill]").forEach((element) => {
      element.removeAttribute("data-application-autofill");
    });
  }

  function mark(element, status) {
    element.setAttribute("data-application-autofill", status);
  }

  function highlightSkippedFields() {
    Array.from(document.querySelectorAll(CONTROL_SELECTOR)).forEach((element) => {
      if (isFillable(element) && !element.getAttribute("data-application-autofill")) {
        element.setAttribute("data-application-autofill", "skipped");
      }
    });
  }

  function isFillable(element) {
    if (!element || element.disabled || element.readOnly) {
      return false;
    }

    if (isFileInput(element)) {
      return false;
    }

    const type = (element.getAttribute("type") || "").toLowerCase();
    if (["hidden", "password", "submit", "button", "reset"].includes(type)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isVisibleControl(element) {
    if (!element || element.disabled) {
      return false;
    }

    const type = (element.getAttribute("type") || "").toLowerCase();
    if (["hidden", "password", "submit", "button", "reset"].includes(type)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isVisibleElement(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isFileInput(element) {
    return element.matches && element.matches('input[type="file"]');
  }

  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) {
        return;
      }

      results.push(...Array.from(node.querySelectorAll(selector)));
      const shadowHosts = Array.from(node.querySelectorAll("*")).filter((element) => element.shadowRoot);
      for (const host of shadowHosts) {
        visit(host.shadowRoot);
      }
    };

    visit(root);
    return results;
  }

  function isSelectLike(element) {
    return element.matches && element.matches("select");
  }

  function summarizeContext(context) {
    return visibleSnippet(context, 90);
  }

  function visibleText(element) {
    if (!element) {
      return "";
    }

    return visibleSnippet(element.innerText || element.textContent || "", 900);
  }

  function rawVisibleText(element, maxLength) {
    if (!element) {
      return "";
    }

    return String(element.innerText || element.textContent || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function visibleSnippet(text, maxLength) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^\w]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasAny(context, terms) {
    return terms.some((term) => {
      const normalized = normalize(term);
      return normalized && (` ${context} `).includes(` ${normalized} `);
    });
  }

  function hasAll(context, terms) {
    return terms.every((term) => hasAny(context, [term]));
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
