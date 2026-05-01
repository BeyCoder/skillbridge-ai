const BRIDGE_BASE_URL = "http://127.0.0.1:17366";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "APPLICATION_AUTOFILL_FETCH_READINESS_STATUSES") {
    fetchKnownApplicationStatuses(message.jobIds || []).then(
      (applications) => sendResponse({ ok: true, applications }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message.type === "APPLICATION_AUTOFILL_MARK_JOB_DISPOSITIONS") {
    markJobDispositions(message.jobs || [], message.disposition).then(
      (results) => sendResponse({ ok: true, results }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message.type === "APPLICATION_AUTOFILL_OPEN_APPLICATION_ARTIFACTS") {
    openApplicationArtifacts(message.jobId).then(
      (opened) => sendResponse({ ok: true, opened }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message.type === "APPLICATION_AUTOFILL_OPEN_KNOWLEDGE_REVIEW") {
    openKnowledgeReview(message.jobId).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message.type === "APPLICATION_AUTOFILL_GET_NAVIGATION_HISTORY") {
    getNavigationHistory(message.tabId).then(
      (history) => sendResponse({ ok: true, history }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message.type === "APPLICATION_AUTOFILL_INSERT_TRUSTED_TEXT") {
    insertTrustedText(sender && sender.tab && sender.tab.id, message.text).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message.type === "APPLICATION_AUTOFILL_TRUSTED_CLICK") {
    dispatchTrustedClick(sender && sender.tab && sender.tab.id, message.x, message.y).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  return false;
});

async function fetchKnownApplicationStatuses(jobIds) {
  const query = encodeURIComponent((Array.isArray(jobIds) ? jobIds : []).join(","));
  const response = await fetch(`${BRIDGE_BASE_URL}/application/statuses?jobIds=${query}`);
  const data = await response.json();

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Bridge returned HTTP ${response.status}.`);
  }

  return Array.isArray(data.applications) ? data.applications : [];
}

async function markJobDispositions(jobs, disposition) {
  const normalizedJobs = Array.isArray(jobs) ? jobs : [jobs];
  const results = [];
  for (const job of normalizedJobs) {
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

    results.push(data);
  }

  return results;
}

async function openApplicationArtifacts(jobId) {
  const response = await fetch(`${BRIDGE_BASE_URL}/application/open`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ jobId })
  });
  const data = await response.json();

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Bridge returned HTTP ${response.status}.`);
  }

  return Array.isArray(data.opened) ? data.opened : [];
}

function openKnowledgeReview(jobId) {
  return new Promise((resolve, reject) => {
    try {
      const normalizedJobId = normalizeJobId(jobId);
      const optionsPath = normalizedJobId
        ? `options.html?jobId=${encodeURIComponent(normalizedJobId)}`
        : "options.html";
      chrome.tabs.create({ url: chrome.runtime.getURL(optionsPath) }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getNavigationHistory(tabId) {
  if (!tabId) {
    throw new Error("No tab was available for navigation history.");
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const history = await chrome.debugger.sendCommand(target, "Page.getNavigationHistory");
    return {
      currentIndex: Number(history && history.currentIndex),
      entries: Array.isArray(history && history.entries)
        ? history.entries.map((entry) => ({
          id: entry.id,
          url: entry.url || "",
          title: entry.title || "",
          transitionType: entry.transitionType || ""
        }))
        : []
    };
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_error) {
      // The tab may have detached during navigation; nothing else to clean up.
    }
  }
}

async function insertTrustedText(tabId, text) {
  if (!tabId) {
    throw new Error("No tab was available for trusted text insertion.");
  }

  const value = String(text || "");
  if (!value) {
    throw new Error("No trusted text was provided.");
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await selectFocusedText(target);
    for (const char of value) {
      await dispatchTrustedCharacter(target, char);
    }
    await delay(120);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_error) {
      // The tab may have detached during navigation; nothing else to clean up.
    }
  }
}

async function dispatchTrustedClick(tabId, x, y) {
  if (!tabId) {
    throw new Error("No tab was available for trusted click.");
  }

  const clientX = Number(x);
  const clientY = Number(y);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    throw new Error("Trusted click coordinates were invalid.");
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: clientX,
      y: clientY
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clientX,
      y: clientY,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clientX,
      y: clientY,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    await delay(120);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_error) {
      // The tab may have detached during navigation; nothing else to clean up.
    }
  }
}

async function selectFocusedText(target) {
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 55,
    modifiers: 4
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 0,
    modifiers: 4
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 0,
    modifiers: 4
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 55
  });
}

async function dispatchTrustedCharacter(target, char) {
  const descriptor = getKeyDescriptor(char);
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "char",
    key: descriptor.key,
    code: descriptor.code,
    text: char,
    unmodifiedText: char,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode
  });
}

function getKeyDescriptor(char) {
  if (/^\d$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      keyCode: 48 + Number(char)
    };
  }

  const upper = char.toUpperCase();
  return {
    key: char,
    code: `Key${upper}`,
    keyCode: upper.charCodeAt(0)
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJobId(value) {
  const match = String(value || "").match(/\bJR[-\s]?\d{3,}\b/i);
  return match ? match[0].replace(/[-\s]/g, "").toUpperCase() : "";
}
