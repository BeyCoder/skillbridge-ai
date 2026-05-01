const form = document.getElementById("profileForm");
const customAnswers = document.getElementById("customAnswers");
const resetButton = document.getElementById("resetButton");
const statusBox = document.getElementById("status");
const defaults = ApplicationAutofillDefaults;
const BRIDGE_BASE_URL = "http://127.0.0.1:17366";
const NEW_EXPERIENCE_DRAFT_KEY = "applicationTailor.newExperienceDraft";
const ACTIVE_STORY_DRAFTS_KEY = "applicationTailor.activeStoryDrafts";
const ACTIVE_STORY_QUESTIONS_KEY = "applicationTailor.activeStoryQuestionJobs";
const STORY_DRAFT_QUESTIONS_KEY = "applicationTailor.storyDraftQuestions";
const autosaveTimers = new Map();
const draftControlsByKey = new Map();
const activeDraftPolls = new Set();
const activeQuestionPolls = new Set();
const draftPollsWithEditableQuestions = new Set();

const refreshKnowledgeButton = document.getElementById("refreshKnowledgeButton");
const addSkillForm = document.getElementById("addSkillForm");
const addExperienceForm = document.getElementById("addExperienceForm");
const newSkillKeyword = document.getElementById("newSkillKeyword");
const newExperienceTitle = document.getElementById("newExperienceTitle");
const newExperienceSkills = document.getElementById("newExperienceSkills");
const newExperienceStory = document.getElementById("newExperienceStory");
const newExperienceDraftPrompt = document.getElementById("newExperienceDraftPrompt");
const newExperienceDraftQuestions = document.getElementById("newExperienceDraftQuestions");
const generateNewExperienceStoryButton = document.getElementById("generateNewExperienceStoryButton");
const generateNewExperienceQuestionsButton = document.getElementById("generateNewExperienceQuestionsButton");
const knowledgeSummary = document.getElementById("knowledgeSummary");
const knowledgeFilter = document.getElementById("knowledgeFilter");
const pendingKnowledge = document.getElementById("pendingKnowledge");
const approvedSkills = document.getElementById("approvedSkills");
const approvedExperiences = document.getElementById("approvedExperiences");
const knowledgeStatusBox = document.getElementById("knowledgeStatus");
let activeKnowledgeJobFilter = normalizeJobId(new URLSearchParams(window.location.search).get("jobId"));
let latestKnowledge = null;

document.addEventListener("DOMContentLoaded", loadProfile);
document.addEventListener("DOMContentLoaded", loadKnowledge);
document.addEventListener("DOMContentLoaded", loadNewExperienceDraft);
document.addEventListener("DOMContentLoaded", scrollToFilteredKnowledge);
form.addEventListener("submit", saveProfile);
resetButton.addEventListener("click", resetProfile);
refreshKnowledgeButton.addEventListener("click", loadKnowledge);
addSkillForm.addEventListener("submit", addSkill);
addExperienceForm.addEventListener("submit", addExperience);
generateNewExperienceStoryButton.addEventListener("click", generateNewExperienceStory);
generateNewExperienceQuestionsButton.addEventListener("click", generateNewExperienceQuestions);
newExperienceTitle.addEventListener("input", scheduleNewExperienceDraftSave);
newExperienceSkills.addEventListener("input", scheduleNewExperienceDraftSave);
newExperienceStory.addEventListener("input", scheduleNewExperienceDraftSave);
newExperienceDraftPrompt.addEventListener("input", scheduleNewExperienceDraftSave);
registerDraftControls("new-experience-draft", {
  item: null,
  titleInput: newExperienceTitle,
  skillsInput: newExperienceSkills,
  storyTextarea: newExperienceStory,
  promptTextarea: newExperienceDraftPrompt,
  questionsElement: newExperienceDraftQuestions,
  buttonElement: generateNewExperienceStoryButton,
  questionsButtonElement: generateNewExperienceQuestionsButton
});

async function loadProfile() {
  const stored = await chrome.storage.sync.get({ profile: defaults.defaultProfile });
  const profile = defaults.deepMerge(defaults.defaultProfile, stored.profile || {});
  populateForm(profile);
}

async function saveProfile(event) {
  event.preventDefault();

  try {
    const profile = readForm();
    await chrome.storage.sync.set({ profile });
    statusBox.textContent = "Saved.";
  } catch (error) {
    statusBox.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function resetProfile() {
  const preservedSensitiveAnswers = readPreservedSensitiveAnswersFromForm();
  const profile = defaults.deepClone(defaults.defaultProfile);
  applyPreservedSensitiveAnswers(profile, preservedSensitiveAnswers);
  await chrome.storage.sync.set({ profile });
  populateForm(profile);
  statusBox.textContent = "Defaults restored; saved disclosure choices kept.";
}

function populateForm(profile) {
  for (const element of Array.from(form.elements)) {
    if (!element.name) {
      continue;
    }

    element.value = getPath(profile, element.name) || "";
  }

  customAnswers.value = JSON.stringify(profile.application.customAnswers || [], null, 2);
}

function readForm() {
  const profile = defaults.deepClone(defaults.defaultProfile);

  for (const element of Array.from(form.elements)) {
    if (!element.name) {
      continue;
    }

    setPath(profile, element.name, element.value.trim());
  }

  try {
    profile.application.customAnswers = JSON.parse(customAnswers.value || "[]");
  } catch (_error) {
    throw new Error("Custom answers must be valid JSON.");
  }

  if (!Array.isArray(profile.application.customAnswers)) {
    throw new Error("Custom answers JSON must be an array.");
  }

  return profile;
}

function readPreservedSensitiveAnswersFromForm() {
  const preserved = {};
  const prefixes = ["voluntaryDisclosures.", "selfIdentification."];

  for (const element of Array.from(form.elements)) {
    if (!element.name || !prefixes.some((prefix) => element.name.startsWith(prefix))) {
      continue;
    }

    setPath(preserved, element.name, element.value.trim());
  }

  return preserved;
}

function applyPreservedSensitiveAnswers(profile, preserved) {
  for (const key of ["voluntaryDisclosures", "selfIdentification"]) {
    profile[key] = {
      ...(profile[key] || {}),
      ...((preserved || {})[key] || {})
    };
  }
}

function getPath(object, path) {
  return path.split(".").reduce((current, key) => (current ? current[key] : undefined), object);
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let target = object;

  for (const part of parts.slice(0, -1)) {
    target[part] = target[part] || {};
    target = target[part];
  }

  target[parts[parts.length - 1]] = value;
}

async function loadKnowledge() {
  setKnowledgeStatus("Loading knowledge base...");

  try {
    const data = await bridgeFetch("/knowledge");
    renderKnowledge(data.knowledge);
    await resumeActiveStoryDrafts();
    await resumeActiveStoryQuestionJobs();
    setKnowledgeStatus("");
  } catch (error) {
    renderKnowledge(null);
    setKnowledgeStatus(friendlyBridgeError(error));
  }
}

async function addSkill(event) {
  event.preventDefault();
  const keyword = newSkillKeyword.value.trim();
  if (!keyword) {
    setKnowledgeStatus("Add a skill keyword first.");
    return;
  }

  try {
    const data = await bridgeFetch("/knowledge/item", {
      method: "POST",
      body: JSON.stringify({
        item: {
          type: "skill",
          keyword,
          status: "approved"
        }
      })
    });
    newSkillKeyword.value = "";
    renderKnowledge(data.knowledge);
    setKnowledgeStatus("Skill approved.");
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
  }
}

async function addExperience(event) {
  event.preventDefault();
  const title = newExperienceTitle.value.trim();
  const story = newExperienceStory.value.trim();
  if (!title || !story) {
    setKnowledgeStatus("Add a title and story before saving an experience.");
    return;
  }

  try {
    const data = await bridgeFetch("/knowledge/item", {
      method: "POST",
      body: JSON.stringify({
        item: {
          type: "experience",
          title,
          story,
          skills: splitSkills(newExperienceSkills.value),
          status: "approved"
        }
      })
    });
    newExperienceTitle.value = "";
    newExperienceSkills.value = "";
    newExperienceStory.value = "";
    newExperienceDraftPrompt.value = "";
    await chrome.storage.local.remove(NEW_EXPERIENCE_DRAFT_KEY);
    await removeDraftQuestionState("new-experience-draft");
    await removeActiveStoryQuestionJob("new-experience-draft");
    await renderStoredDraftQuestions(draftControlsByKey.get("new-experience-draft"));
    renderKnowledge(data.knowledge);
    setKnowledgeStatus("Experience story approved.");
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
  }
}

async function loadNewExperienceDraft() {
  const stored = await chrome.storage.local.get({ [NEW_EXPERIENCE_DRAFT_KEY]: null });
  const draft = stored[NEW_EXPERIENCE_DRAFT_KEY];
  if (!draft || typeof draft !== "object") {
    await renderStoredDraftQuestions(draftControlsByKey.get("new-experience-draft"));
    return;
  }

  newExperienceTitle.value = draft.title || "";
  newExperienceSkills.value = draft.skills || "";
  newExperienceStory.value = draft.story || "";
  newExperienceDraftPrompt.value = draft.draftPrompt || "";
  await renderStoredDraftQuestions(draftControlsByKey.get("new-experience-draft"));
  await resumeActiveStoryDrafts();
  await resumeActiveStoryQuestionJobs();
}

function scheduleNewExperienceDraftSave() {
  scheduleAutosave("new-experience-draft", async () => {
    const draft = {
      title: newExperienceTitle.value,
      skills: newExperienceSkills.value,
      story: newExperienceStory.value,
      draftPrompt: newExperienceDraftPrompt.value,
      updatedAt: new Date().toISOString()
    };

    if (!draft.title.trim() && !draft.skills.trim() && !draft.story.trim() && !draft.draftPrompt.trim()) {
      await chrome.storage.local.remove(NEW_EXPERIENCE_DRAFT_KEY);
      await removeDraftQuestionState("new-experience-draft");
      await removeActiveStoryQuestionJob("new-experience-draft");
      await renderStoredDraftQuestions(draftControlsByKey.get("new-experience-draft"));
      setKnowledgeStatus("New story draft cleared.");
      return;
    }

    await chrome.storage.local.set({ [NEW_EXPERIENCE_DRAFT_KEY]: draft });
    setKnowledgeStatus("New story draft autosaved.");
  });
}

async function generateNewExperienceStory() {
  await generateStoryDraft({
    item: {
      type: "experience",
      title: newExperienceTitle.value.trim() || "Experience story",
      story: newExperienceStory.value.trim(),
      skills: splitSkills(newExperienceSkills.value),
      status: "pending"
    },
    draftKey: "new-experience-draft",
    titleInput: newExperienceTitle,
    skillsInput: newExperienceSkills,
    storyTextarea: newExperienceStory,
    promptTextarea: newExperienceDraftPrompt,
    buttonElement: generateNewExperienceStoryButton
  });
}

async function generateNewExperienceQuestions() {
  await generateStoryQuestions({
    item: {
      type: "experience",
      title: newExperienceTitle.value.trim() || "Experience story",
      story: newExperienceStory.value.trim(),
      skills: splitSkills(newExperienceSkills.value),
      status: "pending"
    },
    draftKey: "new-experience-draft",
    titleInput: newExperienceTitle,
    skillsInput: newExperienceSkills,
    storyTextarea: newExperienceStory,
    promptTextarea: newExperienceDraftPrompt,
    buttonElement: generateNewExperienceQuestionsButton
  });
}

function renderKnowledge(knowledge) {
  latestKnowledge = knowledge;
  clearRenderedDraftControls();
  const skills = Array.isArray(knowledge && knowledge.skills) ? knowledge.skills : [];
  const experiences = Array.isArray(knowledge && knowledge.experiences) ? knowledge.experiences : [];
  const summary = knowledge && knowledge.summary ? knowledge.summary : null;

  knowledgeSummary.textContent = summary
    ? `${summary.approvedSkills} approved skills, ${summary.approvedExperiences} approved stories, ${summary.pendingSkills + summary.pendingExperiences} pending review items.`
    : "Start the local bridge to review skills and stories.";

  const allPendingItems = skills.concat(experiences).filter((item) => item.status === "pending");
  const pendingItems = activeKnowledgeJobFilter
    ? allPendingItems.filter((item) => itemHasSourceJobId(item, activeKnowledgeJobFilter))
    : allPendingItems;
  renderKnowledgeFilter(allPendingItems, pendingItems);
  renderList(
    pendingKnowledge,
    pendingItems,
    renderPendingCard,
    activeKnowledgeJobFilter
      ? `No pending skills or stories for ${activeKnowledgeJobFilter}.`
      : "No pending skills or stories yet."
  );
  renderList(approvedSkills, skills.filter((item) => item.status === "approved"), renderApprovedSkill, "No approved skills yet.");
  renderList(approvedExperiences, experiences.filter((item) => item.status === "approved"), renderApprovedExperience, "No approved stories yet.");
}

function renderKnowledgeFilter(allPendingItems, pendingItems) {
  knowledgeFilter.replaceChildren();
  if (!activeKnowledgeJobFilter) {
    knowledgeFilter.hidden = true;
    return;
  }

  knowledgeFilter.hidden = false;
  const text = document.createElement("p");
  text.textContent = `Showing ${pendingItems.length} of ${allPendingItems.length} pending ${allPendingItems.length === 1 ? "item" : "items"} for ${activeKnowledgeJobFilter}.`;
  knowledgeFilter.appendChild(text);

  const clearButton = button("Show All Pending", "button small secondary", () => {
    activeKnowledgeJobFilter = "";
    const url = new URL(window.location.href);
    url.searchParams.delete("jobId");
    window.history.replaceState(null, "", url.toString());
    if (latestKnowledge) {
      renderKnowledge(latestKnowledge);
    }
  });
  knowledgeFilter.appendChild(clearButton);
}

function itemHasSourceJobId(item, jobId) {
  const sources = Array.isArray(item && item.sourceJobIds) ? item.sourceJobIds : [];
  return sources.some((sourceJobId) => normalizeJobId(sourceJobId) === jobId);
}

function scrollToFilteredKnowledge() {
  if (!activeKnowledgeJobFilter) {
    return;
  }

  setTimeout(() => {
    const section = document.getElementById("knowledgeSection");
    if (section) {
      section.scrollIntoView({ block: "start" });
    }
  }, 80);
}

function renderList(container, items, renderer, emptyText) {
  container.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    container.appendChild(renderer(item));
  }
}

function renderPendingCard(item) {
  const card = document.createElement("article");
  card.className = "knowledgeCard";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = item.type === "skill" ? "Pending skill" : "Pending story";
  card.appendChild(eyebrow);

  if (item.type === "skill") {
    const keyword = labeledInput("Skill keyword", item.keyword || "");
    card.appendChild(keyword.label);
    card.appendChild(sourceLine(item));
    card.appendChild(actionRow([
      button("Approve", "button", async () => {
        await knowledgeAction("approve", item, { keyword: keyword.input.value.trim() });
      }),
      button("Reject", "button secondary", async () => {
        await knowledgeAction("reject", item);
      })
    ]));
    return card;
  }

  const title = labeledInput("Story title", item.title || "");
  const skills = labeledInput("Related skills", (item.skills || []).join(", "));
  const story = labeledTextarea("Skill use-cases or rough idea", item.story || "", 5);
  const draftPrompt = labeledTextarea(
    "AI draft prompt",
    "",
    3,
    "Optional: tell AI what to focus on, format differently, or ask clarification questions."
  );
  const draftQuestions = draftQuestionsBox();
  card.appendChild(title.label);
  if (item.prompt) {
    const prompt = document.createElement("p");
    prompt.className = "prompt";
    prompt.textContent = item.prompt;
    card.appendChild(prompt);
  }
  card.appendChild(skills.label);
  card.appendChild(story.label);
  card.appendChild(draftPrompt.label);
  card.appendChild(draftQuestions);
  card.appendChild(sourceLine(item));
  const autosaveNote = autosaveLine();
  card.appendChild(autosaveNote);
  bindExperienceAutosave({
    item,
    titleInput: title.input,
    skillsInput: skills.input,
    storyTextarea: story.textarea,
    autosaveNote
  });
  const draftKey = experienceDraftKey(item);
  const aiDraftButton = button("AI Draft", "button secondary", async (event) => {
    await generateStoryDraft({
      item,
      draftKey,
      titleInput: title.input,
      skillsInput: skills.input,
      storyTextarea: story.textarea,
      promptTextarea: draftPrompt.textarea,
      buttonElement: event.currentTarget
    });
  });
  const aiQuestionsButton = button("AI Questions", "button secondary", async (event) => {
    await generateStoryQuestions({
      item,
      draftKey,
      titleInput: title.input,
      skillsInput: skills.input,
      storyTextarea: story.textarea,
      promptTextarea: draftPrompt.textarea,
      buttonElement: event.currentTarget
    });
  });
  registerDraftControls(draftKey, {
    item,
    titleInput: title.input,
    skillsInput: skills.input,
    storyTextarea: story.textarea,
    promptTextarea: draftPrompt.textarea,
    questionsElement: draftQuestions,
    buttonElement: aiDraftButton,
    questionsButtonElement: aiQuestionsButton,
    autosaveNote
  });
  card.appendChild(actionRow([
    aiDraftButton,
    aiQuestionsButton,
    button("Approve", "button", async () => {
      const storyValue = story.textarea.value.trim();
      if (!storyValue) {
        setKnowledgeStatus("Add a proof story before approving this experience.");
        story.textarea.focus();
        return;
      }
      await knowledgeAction("approve", item, {
        title: title.input.value.trim(),
        story: storyValue,
        skills: splitSkills(skills.input.value)
      });
    }),
    button("Reject", "button secondary", async () => {
      await knowledgeAction("reject", item);
    })
  ]));
  return card;
}

function renderApprovedSkill(item) {
  const chip = document.createElement("article");
  chip.className = "skillChip";
  const text = document.createElement("span");
  text.textContent = item.keyword;
  chip.appendChild(text);
  chip.appendChild(button("Delete", "button tiny secondary", async () => {
    await knowledgeAction("delete", item);
  }));
  return chip;
}

function renderApprovedExperience(item) {
  const card = document.createElement("article");
  card.className = "knowledgeCard";

  const title = labeledInput("Story title", item.title || "");
  const skills = labeledInput("Related skills", (item.skills || []).join(", "));
  const story = labeledTextarea("Experience story", item.story || "", 5);
  const draftPrompt = labeledTextarea(
    "AI draft prompt",
    "",
    3,
    "Optional: tell AI what to focus on, format differently, or ask clarification questions."
  );
  const draftQuestions = draftQuestionsBox();

  card.appendChild(title.label);
  card.appendChild(skills.label);
  card.appendChild(story.label);
  card.appendChild(draftPrompt.label);
  card.appendChild(draftQuestions);
  card.appendChild(sourceLine(item));
  const autosaveNote = autosaveLine();
  card.appendChild(autosaveNote);
  bindExperienceAutosave({
    item,
    titleInput: title.input,
    skillsInput: skills.input,
    storyTextarea: story.textarea,
    autosaveNote
  });
  const draftKey = experienceDraftKey(item);
  const aiDraftButton = button("AI Draft", "button secondary", async (event) => {
    await generateStoryDraft({
      item,
      draftKey,
      titleInput: title.input,
      skillsInput: skills.input,
      storyTextarea: story.textarea,
      promptTextarea: draftPrompt.textarea,
      buttonElement: event.currentTarget
    });
  });
  const aiQuestionsButton = button("AI Questions", "button secondary", async (event) => {
    await generateStoryQuestions({
      item,
      draftKey,
      titleInput: title.input,
      skillsInput: skills.input,
      storyTextarea: story.textarea,
      promptTextarea: draftPrompt.textarea,
      buttonElement: event.currentTarget
    });
  });
  registerDraftControls(draftKey, {
    item,
    titleInput: title.input,
    skillsInput: skills.input,
    storyTextarea: story.textarea,
    promptTextarea: draftPrompt.textarea,
    questionsElement: draftQuestions,
    buttonElement: aiDraftButton,
    questionsButtonElement: aiQuestionsButton,
    autosaveNote
  });
  card.appendChild(actionRow([
    aiDraftButton,
    aiQuestionsButton,
    button("Save", "button", async () => {
      await saveKnowledgeItem({
        ...item,
        title: title.input.value.trim(),
        skills: splitSkills(skills.input.value),
        story: story.textarea.value.trim(),
        status: "approved"
      }, "Story saved.");
    }),
    button("Delete", "button secondary", async () => {
      await knowledgeAction("delete", item);
    })
  ]));
  return card;
}

async function generateStoryDraft({ item, draftKey, titleInput, skillsInput, storyTextarea, promptTextarea, buttonElement }) {
  const controls = draftControlsByKey.get(draftKey);
  if (controls) {
    controls.item = item;
  }
  if (activeDraftPolls.has(draftKey) || activeQuestionPolls.has(draftKey)) {
    return;
  }
  const previousText = buttonElement.textContent;
  buttonElement.disabled = true;
  buttonElement.textContent = "Drafting...";
  setKnowledgeStatus(storyTextarea.value.trim()
    ? "AI is tailoring your rough notes..."
    : "AI is generating story ideas...");

  try {
    const draftItem = {
      ...item,
      title: titleInput.value.trim() || item.title || "Experience story",
      skills: splitSkills(skillsInput.value),
      story: storyTextarea.value.trim()
    };
    const data = await bridgeFetch("/knowledge/story-draft", {
      method: "POST",
      body: JSON.stringify({
        item: draftItem,
        rawIdea: storyTextarea.value.trim(),
        userPrompt: promptTextarea ? promptTextarea.value.trim() : ""
      })
    });
    await saveActiveStoryDraft(draftKey, data.draftJob);
    await pollStoryDraftForControls(draftKey, data.draftJob && data.draftJob.draftId);
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
  } finally {
    if (!activeDraftPolls.has(draftKey)) {
      buttonElement.disabled = false;
      buttonElement.textContent = previousText;
    }
  }
}

async function generateStoryQuestions({ item, draftKey, titleInput, skillsInput, storyTextarea, promptTextarea, buttonElement }) {
  const controls = draftControlsByKey.get(draftKey);
  if (controls) {
    controls.item = item;
  }
  if (activeDraftPolls.has(draftKey) || activeQuestionPolls.has(draftKey)) {
    return;
  }

  const previousText = buttonElement.textContent;
  buttonElement.disabled = true;
  buttonElement.textContent = "Asking...";
  if (controls) {
    if (controls.questionsButtonElement) {
      controls.questionsButtonElement.disabled = true;
    }
    setDraftQuestionActionsDisabled(controls, true);
  }
  setKnowledgeStatus("AI is generating follow-up questions from the story and source job context...");

  try {
    const currentQuestionState = await getDraftQuestionState(draftKey);
    const draftItem = {
      ...item,
      title: titleInput.value.trim() || item.title || "Experience story",
      skills: splitSkills(skillsInput.value),
      story: storyTextarea.value.trim()
    };
    const data = await bridgeFetch("/knowledge/story-questions", {
      method: "POST",
      body: JSON.stringify({
        item: draftItem,
        existingQuestions: currentQuestionState.questions.map((question) => question.text).join("\n"),
        userPrompt: promptTextarea ? promptTextarea.value.trim() : ""
      })
    });
    await saveActiveStoryQuestionJob(draftKey, data.draftJob);
    await pollStoryQuestionsForControls(draftKey, data.draftJob && data.draftJob.draftId);
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
  } finally {
    if (!activeQuestionPolls.has(draftKey)) {
      buttonElement.disabled = false;
      buttonElement.textContent = previousText;
      if (controls) {
        if (controls.questionsButtonElement) {
          controls.questionsButtonElement.disabled = false;
        }
        setDraftQuestionActionsDisabled(controls, false);
      }
    }
  }
}

async function pollStoryDraftForControls(draftKey, draftId, options = {}) {
  const controls = draftControlsByKey.get(draftKey);
  if (!controls) {
    return;
  }
  if (activeDraftPolls.has(draftKey)) {
    return;
  }

  activeDraftPolls.add(draftKey);
  if (options.keepQuestionInputsEnabled) {
    draftPollsWithEditableQuestions.add(draftKey);
  }
  const previousText = controls.buttonElement.textContent;
  controls.buttonElement.disabled = true;
  controls.buttonElement.textContent = "Drafting...";
  setDraftFieldsDisabled(controls, true, {
    keepQuestionInputsEnabled: Boolean(options.keepQuestionInputsEnabled)
  });

  try {
    const currentQuestionState = await getDraftQuestionState(draftKey);
    const preserveQuestions = getPreservedQuestionsForDraft(currentQuestionState, options);
    const draftJob = await pollStoryDraft(draftId, (message) => {
      setKnowledgeStatus(message);
      if (controls.autosaveNote) {
        controls.autosaveNote.textContent = message;
      }
    });
    if (controls.promptTextarea) {
      controls.promptTextarea.value = "";
      controls.promptTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    controls.storyTextarea.value = draftJob.story || "";
    controls.storyTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    const questionState = await setDraftQuestions(controls, draftJob.questions || "", { preserveQuestions });
    await removeActiveStoryDraft(draftKey);
    const readyMessage = draftJob.questions
      ? "AI draft ready. Questions are shown below the prompt field."
      : draftJob.rawIdeaUsed
        ? "AI draft ready. Edit it, then approve or save."
        : "AI use-case draft ready. Verify details, then approve or save.";
    setKnowledgeStatus(readyMessage);
    if (controls.autosaveNote) {
      controls.autosaveNote.textContent = "AI draft restored and autosaving.";
    }
    if (questionState.questions.length > 0) {
      focusFirstDraftQuestion(controls);
    } else {
      controls.storyTextarea.focus();
    }
  } catch (error) {
    await removeActiveStoryDraft(draftKey);
    setKnowledgeStatus(friendlyBridgeError(error));
    if (controls.autosaveNote) {
      controls.autosaveNote.textContent = friendlyBridgeError(error);
    }
  } finally {
    activeDraftPolls.delete(draftKey);
    draftPollsWithEditableQuestions.delete(draftKey);
    setDraftFieldsDisabled(controls, false, {
      keepQuestionInputsEnabled: Boolean(options.keepQuestionInputsEnabled)
    });
    controls.buttonElement.disabled = false;
    controls.buttonElement.textContent = previousText;
  }
}

async function pollStoryQuestionsForControls(draftKey, draftId) {
  const controls = draftControlsByKey.get(draftKey);
  if (!controls || !draftId || activeQuestionPolls.has(draftKey)) {
    return;
  }

  activeQuestionPolls.add(draftKey);
  const buttonElement = controls.questionsButtonElement;
  const previousText = buttonElement ? buttonElement.textContent : "";
  if (buttonElement) {
    buttonElement.disabled = true;
    buttonElement.textContent = "Asking...";
  }
  setDraftQuestionActionsDisabled(controls, true);

  try {
    const existingState = await getDraftQuestionState(draftKey);
    const draftJob = await pollStoryQuestions(draftId, (message) => {
      setKnowledgeStatus(message);
      if (controls.autosaveNote) {
        controls.autosaveNote.textContent = message;
      }
    });
    const questionState = await setDraftQuestions(controls, draftJob.questions || "", {
      preserveQuestions: existingState.questions
    });
    await removeActiveStoryQuestionJob(draftKey);
    setKnowledgeStatus(questionState.questions.length > existingState.questions.length
      ? "AI follow-up questions added."
      : "AI did not add new follow-up questions.");
    if (controls.autosaveNote) {
      controls.autosaveNote.textContent = "AI follow-up questions restored.";
    }
    if (questionState.questions.length > 0) {
      focusFirstDraftQuestion(controls);
    }
  } catch (error) {
    await removeActiveStoryQuestionJob(draftKey);
    setKnowledgeStatus(friendlyBridgeError(error));
    if (controls.autosaveNote) {
      controls.autosaveNote.textContent = friendlyBridgeError(error);
    }
  } finally {
    activeQuestionPolls.delete(draftKey);
    setDraftQuestionActionsDisabled(controls, false);
    if (buttonElement) {
      buttonElement.disabled = false;
      buttonElement.textContent = previousText;
    }
  }
}

function setDraftFieldsDisabled(controls, disabled, options = {}) {
  controls.titleInput.disabled = disabled;
  controls.skillsInput.disabled = disabled;
  controls.storyTextarea.disabled = disabled;
  if (controls.promptTextarea) {
    controls.promptTextarea.disabled = disabled;
  }
  if (controls.questionsButtonElement) {
    controls.questionsButtonElement.disabled = disabled;
  }
  if (options.keepQuestionInputsEnabled) {
    setDraftQuestionActionsDisabled(controls, disabled);
  } else {
    setDraftQuestionPanelDisabled(controls, disabled);
  }
  controls.storyTextarea.setAttribute("aria-busy", disabled ? "true" : "false");
}

function setDraftQuestionPanelDisabled(controls, disabled) {
  if (!controls || !controls.questionsElement) {
    return;
  }
  for (const element of controls.questionsElement.querySelectorAll("textarea, button")) {
    if (element.classList.contains("aiQuestionsToggle")) {
      continue;
    }
    element.disabled = disabled;
  }
}

function setDraftQuestionActionsDisabled(controls, disabled) {
  if (!controls || !controls.questionsElement) {
    return;
  }
  for (const element of controls.questionsElement.querySelectorAll("button")) {
    if (element.classList.contains("aiQuestionsToggle")) {
      continue;
    }
    element.disabled = disabled;
  }
}

function draftQuestionsBox() {
  const box = document.createElement("div");
  box.className = "aiQuestions";
  box.hidden = true;
  return box;
}

async function setDraftQuestions(controls, questions, options = {}) {
  if (!controls || !controls.questionsElement) {
    return emptyDraftQuestionState();
  }

  clearDraftQuestionSaveTimer(controls.draftKey);
  const parsedQuestions = parseDraftQuestions(questions);
  const existingState = await getDraftQuestionState(controls.draftKey);
  const preservedQuestions = cleanDraftQuestionList(options.preserveQuestions);
  const nextQuestions = mergeDraftQuestionLists(preservedQuestions, parsedQuestions);
  const state = {
    collapsed: nextQuestions.length > 0 ? Boolean(existingState.collapsed) : false,
    questions: mergeQuestionAnswers(nextQuestions, existingState.questions),
    updatedAt: new Date().toISOString()
  };

  if (state.questions.length > 0) {
    await saveDraftQuestionState(controls.draftKey, state);
  } else {
    await removeDraftQuestionState(controls.draftKey);
  }
  renderDraftQuestions(controls, state);
  return state;
}

async function clearDraftQuestions(controls) {
  if (!controls || !controls.questionsElement) {
    return emptyDraftQuestionState();
  }
  clearDraftQuestionSaveTimer(controls.draftKey);
  await removeDraftQuestionState(controls.draftKey);
  const state = emptyDraftQuestionState();
  renderDraftQuestions(controls, state);
  return state;
}

async function renderStoredDraftQuestions(controls) {
  if (!controls || !controls.questionsElement) {
    return emptyDraftQuestionState();
  }
  const state = await getDraftQuestionState(controls.draftKey);
  renderDraftQuestions(controls, state);
  return state;
}

function renderDraftQuestions(controls, state) {
  const box = controls.questionsElement;
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const answeredCount = questions.filter((question) => String(question.answer || "").trim()).length;
  box.replaceChildren();
  box.hidden = questions.length === 0;
  box.dataset.collapsed = state.collapsed ? "true" : "false";

  if (questions.length === 0) {
    return;
  }

  const header = document.createElement("div");
  header.className = "aiQuestionsHeader";

  const title = document.createElement("p");
  title.className = "aiQuestionsTitle";
  title.textContent = `${questions.length} AI follow-up ${questions.length === 1 ? "question" : "questions"} (${answeredCount} answered)`;
  header.appendChild(title);

  const toggle = button(state.collapsed ? "Open" : "Collapse", "button tiny secondary", async () => {
    const nextState = {
      ...state,
      collapsed: !state.collapsed,
      updatedAt: new Date().toISOString()
    };
    await saveDraftQuestionState(controls.draftKey, nextState);
    renderDraftQuestions(controls, nextState);
  });
  toggle.classList.add("aiQuestionsToggle");
  header.appendChild(toggle);
  box.appendChild(header);

  const content = document.createElement("div");
  content.className = "aiQuestionsContent";
  content.hidden = Boolean(state.collapsed);

  questions.forEach((question, index) => {
    const item = document.createElement("div");
    item.className = "aiQuestionItem";

    const label = document.createElement("label");
    label.className = "aiQuestionField";

    const meta = document.createElement("div");
    meta.className = "aiQuestionMeta";

    const text = document.createElement("span");
    text.className = "aiQuestionText";
    text.textContent = question.text;
    meta.appendChild(text);

    const badge = document.createElement("span");
    badge.className = "aiQuestionBadge";
    setQuestionBadgeState(badge, question.answer);
    meta.appendChild(badge);
    label.appendChild(meta);

    const answer = document.createElement("textarea");
    answer.rows = 2;
    answer.placeholder = "Answer";
    answer.value = question.answer || "";
    answer.dataset.questionId = question.id;
    answer.addEventListener("input", () => {
      state.questions[index].answer = answer.value;
      state.updatedAt = new Date().toISOString();
      setQuestionBadgeState(badge, answer.value);
      scheduleDraftQuestionStateSave(controls.draftKey, state);
    });
    label.appendChild(answer);
    item.appendChild(label);

    item.appendChild(actionRow([
      button("Send", "button tiny", async (event) => {
        await submitDraftQuestionAnswers(controls, state, event.currentTarget, {
          questionIds: [question.id]
        });
      }),
      button("Delete", "button tiny secondary", async () => {
        await deleteDraftQuestion(controls, state, question.id);
      })
    ]));
    content.appendChild(item);
  });

  content.appendChild(actionRow([
    button("More Questions", "button small secondary", async (event) => {
      await generateStoryQuestions({
        item: controls.item || { type: "experience", status: "pending" },
        draftKey: controls.draftKey,
        titleInput: controls.titleInput,
        skillsInput: controls.skillsInput,
        storyTextarea: controls.storyTextarea,
        promptTextarea: controls.promptTextarea,
        buttonElement: event.currentTarget
      });
    }),
    button("Send Answered to AI", "button small", async (event) => {
      await submitDraftQuestionAnswers(controls, state, event.currentTarget);
    })
  ]));
  box.appendChild(content);

  if (activeDraftPolls.has(controls.draftKey)) {
    if (draftPollsWithEditableQuestions.has(controls.draftKey)) {
      setDraftQuestionActionsDisabled(controls, true);
    } else {
      setDraftQuestionPanelDisabled(controls, true);
    }
  }
}

function setQuestionBadgeState(badge, answerValue) {
  const answered = Boolean(String(answerValue || "").trim());
  badge.dataset.state = answered ? "answered" : "open";
  badge.textContent = answered ? "Answered" : "Needs answer";
}

async function deleteDraftQuestion(controls, state, questionId) {
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const nextState = {
    ...state,
    questions: questions.filter((question) => question.id !== questionId),
    updatedAt: new Date().toISOString()
  };
  clearDraftQuestionSaveTimer(controls.draftKey);
  await saveDraftQuestionState(controls.draftKey, nextState);
  renderDraftQuestions(controls, nextState);
  setKnowledgeStatus(nextState.questions.length > 0 ? "Follow-up question deleted." : "Follow-up questions cleared.");
}

async function submitDraftQuestionAnswers(controls, state, submitButton, options = {}) {
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const requestedIds = Array.isArray(options.questionIds) ? new Set(options.questionIds) : null;
  const selectedQuestions = questions.filter((question) => {
    if (requestedIds) {
      return requestedIds.has(question.id);
    }
    return Boolean(String(question.answer || "").trim());
  });
  const missingRequested = selectedQuestions.find((question) => !String(question.answer || "").trim());
  if (requestedIds && missingRequested) {
    setKnowledgeStatus("Answer this AI follow-up question before sending it back.");
    focusDraftQuestion(controls, missingRequested.id);
    return;
  }
  if (selectedQuestions.length === 0) {
    setKnowledgeStatus("Answer at least one AI follow-up question before sending it back.");
    focusFirstDraftQuestion(controls);
    return;
  }
  const selectedIds = new Set(selectedQuestions.map((question) => question.id));
  const preservedQuestions = questions.filter((question) => !selectedIds.has(question.id));

  const previousText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "Sending...";
  clearDraftQuestionSaveTimer(controls.draftKey);
  setDraftQuestionActionsDisabled(controls, true);
  setKnowledgeStatus("Sending your answers to AI...");

  try {
    const draftItem = {
      ...(controls.item || {}),
      type: "experience",
      title: controls.titleInput.value.trim() || (controls.item && controls.item.title) || "Experience story",
      skills: splitSkills(controls.skillsInput.value),
      story: controls.storyTextarea.value.trim(),
      status: controls.item && controls.item.status ? controls.item.status : "pending"
    };
    const data = await bridgeFetch("/knowledge/story-draft", {
      method: "POST",
      body: JSON.stringify({
        item: draftItem,
        rawIdea: controls.storyTextarea.value.trim(),
        userPrompt: buildQuestionAnswerPrompt(selectedQuestions, controls.promptTextarea ? controls.promptTextarea.value.trim() : "")
      })
    });
    await saveActiveStoryDraft(controls.draftKey, data.draftJob, {
      submittedQuestionIds: Array.from(selectedIds),
      keepQuestionInputsEnabled: true
    });
    const nextState = {
      ...state,
      questions: preservedQuestions,
      updatedAt: new Date().toISOString()
    };
    await saveDraftQuestionState(controls.draftKey, nextState);
    renderDraftQuestions(controls, nextState);
    await pollStoryDraftForControls(controls.draftKey, data.draftJob && data.draftJob.draftId, {
      preserveQuestions: preservedQuestions,
      submittedQuestionIds: Array.from(selectedIds),
      keepQuestionInputsEnabled: true
    });
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
    await renderStoredDraftQuestions(controls);
  } finally {
    if (!activeDraftPolls.has(controls.draftKey) && submitButton.isConnected) {
      submitButton.disabled = false;
      submitButton.textContent = previousText;
      setDraftQuestionActionsDisabled(controls, false);
    }
  }
}

function buildQuestionAnswerPrompt(questions, extraPrompt) {
  const answers = questions
    .map((question, index) => [
      `Question ${index + 1}: ${question.text}`,
      `Answer ${index + 1}: ${String(question.answer || "").trim()}`
    ].join("\n"))
    .join("\n\n");
  const promptParts = [
    "The user answered the previous AI clarification questions. Revise STORY_DRAFT so the answered details are incorporated into the final story text when relevant. Do not repeat answered questions in STORY_QUESTIONS. Ask only new follow-up questions that are still necessary.",
    answers
  ];
  if (extraPrompt) {
    promptParts.push(`Additional current user prompt:\n${extraPrompt}`);
  }
  return promptParts.join("\n\n");
}

function focusFirstDraftQuestion(controls) {
  const firstAnswer = controls.questionsElement.querySelector(".aiQuestionField textarea");
  if (firstAnswer) {
    firstAnswer.focus();
  }
}

function focusDraftQuestion(controls, questionId) {
  const answer = controls.questionsElement.querySelector(`.aiQuestionField textarea[data-question-id="${cssEscape(questionId)}"]`);
  if (answer) {
    answer.focus();
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(String(value || ""));
  }
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function parseDraftQuestions(questions) {
  const text = String(questions || "").trim();
  if (!text) {
    return [];
  }

  let lines = text
    .split(/\r?\n/)
    .map((line) => normalizeQuestionText(line))
    .filter(Boolean);

  if (lines.length <= 1) {
    const numberedItems = text
      .split(/\s+(?=(?:question\s*)?\d+\s*[.):]\s+)/i)
      .map((line) => normalizeQuestionText(line))
      .filter(Boolean);
    if (numberedItems.length > lines.length) {
      lines = numberedItems;
    }
  }

  return lines.map((question, index) => ({
    id: createDraftQuestionId(question, index),
    text: question,
    answer: ""
  }));
}

function normalizeQuestionText(line) {
  return String(line || "")
    .replace(/^\s*(?:[-*]|(?:question\s*)?\d+\s*[.):])\s*/i, "")
    .replace(/^(?:needs confirmation|confirmation needed|missing detail|missing details|follow-up|open question)\s*:\s*/i, "")
    .trim();
}

function mergeQuestionAnswers(questions, previousQuestions) {
  const previousById = new Map();
  const previousByText = new Map();
  for (const question of Array.isArray(previousQuestions) ? previousQuestions : []) {
    previousById.set(question.id, question.answer || "");
    previousByText.set(question.text, question.answer || "");
  }
  return questions.map((question) => ({
    ...question,
    answer: previousById.get(question.id) || previousByText.get(question.text) || question.answer || ""
  }));
}

function mergeDraftQuestionLists(...questionLists) {
  const seen = new Set();
  const merged = [];
  for (const question of questionLists.flatMap((list) => cleanDraftQuestionList(list))) {
    const key = question.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(question);
  }
  return merged;
}

function cleanDraftQuestionList(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((question, index) => {
      const text = String(question.text || "").trim();
      if (!text) {
        return null;
      }
      return {
        id: question.id || createDraftQuestionId(text, index),
        text,
        answer: String(question.answer || "")
      };
    })
    .filter(Boolean);
}

function getPreservedQuestionsForDraft(currentQuestionState, options = {}) {
  if (Array.isArray(options.preserveQuestions)) {
    return cleanDraftQuestionList(options.preserveQuestions);
  }
  if (!Array.isArray(options.submittedQuestionIds)) {
    return [];
  }
  const submittedIds = new Set(options.submittedQuestionIds);
  return cleanDraftQuestionList(currentQuestionState.questions)
    .filter((question) => !submittedIds.has(question.id));
}

function createDraftQuestionId(text, index) {
  let hash = 0;
  for (const char of text) {
    hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  }
  return `question-${index + 1}-${hash.toString(36)}`;
}

function emptyDraftQuestionState() {
  return {
    collapsed: false,
    questions: []
  };
}

async function getDraftQuestionStates() {
  const stored = await chrome.storage.local.get({ [STORY_DRAFT_QUESTIONS_KEY]: {} });
  const states = stored[STORY_DRAFT_QUESTIONS_KEY];
  return states && typeof states === "object" ? states : {};
}

async function getDraftQuestionState(draftKey) {
  if (!draftKey) {
    return emptyDraftQuestionState();
  }
  const states = await getDraftQuestionStates();
  return cleanDraftQuestionState(states[draftKey]);
}

async function saveDraftQuestionState(draftKey, state) {
  if (!draftKey) {
    return;
  }
  const cleanState = cleanDraftQuestionState(state);
  const states = await getDraftQuestionStates();
  if (cleanState.questions.length === 0) {
    delete states[draftKey];
  } else {
    states[draftKey] = {
      ...cleanState,
      updatedAt: state.updatedAt || new Date().toISOString()
    };
  }
  await chrome.storage.local.set({ [STORY_DRAFT_QUESTIONS_KEY]: states });
}

async function removeDraftQuestionState(draftKey) {
  if (!draftKey) {
    return;
  }
  clearDraftQuestionSaveTimer(draftKey);
  const states = await getDraftQuestionStates();
  if (!states[draftKey]) {
    return;
  }
  delete states[draftKey];
  await chrome.storage.local.set({ [STORY_DRAFT_QUESTIONS_KEY]: states });
}

function cleanDraftQuestionState(state) {
  if (!state || typeof state !== "object") {
    return emptyDraftQuestionState();
  }
  return {
    collapsed: Boolean(state.collapsed),
    questions: cleanDraftQuestionList(state.questions)
  };
}

function scheduleDraftQuestionStateSave(draftKey, state) {
  scheduleAutosave(`draft-questions-${draftKey}`, async () => {
    await saveDraftQuestionState(draftKey, state);
  });
}

function clearDraftQuestionSaveTimer(draftKey) {
  const key = `draft-questions-${draftKey}`;
  clearTimeout(autosaveTimers.get(key));
  autosaveTimers.delete(key);
}

async function pollStoryDraft(draftId, onProgress = null) {
  if (!draftId) {
    throw new Error("AI story helper did not return a draft ID.");
  }

  for (;;) {
    await delay(1200);
    const data = await bridgeFetch(`/knowledge/story-draft/status?draftId=${encodeURIComponent(draftId)}`);
    const draftJob = data.draftJob || {};
    if (draftJob.progressMessage) {
      if (onProgress) {
        onProgress(draftJob.progressMessage);
      } else {
        setKnowledgeStatus(draftJob.progressMessage);
      }
    }
    if (draftJob.status === "ready") {
      return draftJob;
    }
    if (draftJob.status === "failed") {
      throw new Error(draftJob.error || "AI story helper failed.");
    }
  }
}

async function pollStoryQuestions(draftId, onProgress = null) {
  if (!draftId) {
    throw new Error("AI follow-up question helper did not return a draft ID.");
  }

  for (;;) {
    await delay(1200);
    const data = await bridgeFetch(`/knowledge/story-questions/status?draftId=${encodeURIComponent(draftId)}`);
    const draftJob = data.draftJob || {};
    if (draftJob.progressMessage) {
      if (onProgress) {
        onProgress(draftJob.progressMessage);
      } else {
        setKnowledgeStatus(draftJob.progressMessage);
      }
    }
    if (draftJob.status === "ready") {
      return draftJob;
    }
    if (draftJob.status === "failed") {
      throw new Error(draftJob.error || "AI follow-up question helper failed.");
    }
  }
}

function registerDraftControls(draftKey, controls) {
  const registeredControls = {
    ...controls,
    draftKey
  };
  draftControlsByKey.set(draftKey, registeredControls);
  renderStoredDraftQuestions(registeredControls).catch((error) => {
    setKnowledgeStatus(friendlyBridgeError(error));
  });
}

function clearRenderedDraftControls() {
  for (const key of Array.from(draftControlsByKey.keys())) {
    if (key !== "new-experience-draft") {
      draftControlsByKey.delete(key);
    }
  }
}

function experienceDraftKey(item) {
  return `experience-${item.id}`;
}

async function getActiveStoryDrafts() {
  const stored = await chrome.storage.local.get({ [ACTIVE_STORY_DRAFTS_KEY]: {} });
  const drafts = stored[ACTIVE_STORY_DRAFTS_KEY];
  return drafts && typeof drafts === "object" ? drafts : {};
}

async function saveActiveStoryDraft(draftKey, draftJob, metadata = {}) {
  if (!draftKey || !draftJob || !draftJob.draftId) {
    return;
  }

  const drafts = await getActiveStoryDrafts();
  drafts[draftKey] = {
    draftId: draftJob.draftId,
    rawIdeaUsed: Boolean(draftJob.rawIdeaUsed),
    submittedQuestionIds: Array.isArray(metadata.submittedQuestionIds) ? metadata.submittedQuestionIds : [],
    keepQuestionInputsEnabled: Boolean(metadata.keepQuestionInputsEnabled),
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [ACTIVE_STORY_DRAFTS_KEY]: drafts });
}

async function removeActiveStoryDraft(draftKey) {
  const drafts = await getActiveStoryDrafts();
  if (!drafts[draftKey]) {
    return;
  }
  delete drafts[draftKey];
  await chrome.storage.local.set({ [ACTIVE_STORY_DRAFTS_KEY]: drafts });
}

async function getActiveStoryQuestionJobs() {
  const stored = await chrome.storage.local.get({ [ACTIVE_STORY_QUESTIONS_KEY]: {} });
  const jobs = stored[ACTIVE_STORY_QUESTIONS_KEY];
  return jobs && typeof jobs === "object" ? jobs : {};
}

async function saveActiveStoryQuestionJob(draftKey, draftJob) {
  if (!draftKey || !draftJob || !draftJob.draftId) {
    return;
  }

  const jobs = await getActiveStoryQuestionJobs();
  jobs[draftKey] = {
    draftId: draftJob.draftId,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [ACTIVE_STORY_QUESTIONS_KEY]: jobs });
}

async function removeActiveStoryQuestionJob(draftKey) {
  const jobs = await getActiveStoryQuestionJobs();
  if (!jobs[draftKey]) {
    return;
  }
  delete jobs[draftKey];
  await chrome.storage.local.set({ [ACTIVE_STORY_QUESTIONS_KEY]: jobs });
}

async function resumeActiveStoryDrafts() {
  const drafts = await getActiveStoryDrafts();
  for (const [draftKey, draft] of Object.entries(drafts)) {
    if (!draft || !draft.draftId || activeDraftPolls.has(draftKey) || !draftControlsByKey.has(draftKey)) {
      continue;
    }
    setKnowledgeStatus("Resuming AI draft after refresh...");
    pollStoryDraftForControls(draftKey, draft.draftId, {
      submittedQuestionIds: Array.isArray(draft.submittedQuestionIds) ? draft.submittedQuestionIds : [],
      keepQuestionInputsEnabled: Boolean(draft.keepQuestionInputsEnabled)
    });
  }
}

async function resumeActiveStoryQuestionJobs() {
  const jobs = await getActiveStoryQuestionJobs();
  for (const [draftKey, job] of Object.entries(jobs)) {
    if (!job || !job.draftId || activeQuestionPolls.has(draftKey) || !draftControlsByKey.has(draftKey)) {
      continue;
    }
    setKnowledgeStatus("Resuming AI follow-up questions after refresh...");
    pollStoryQuestionsForControls(draftKey, job.draftId);
  }
}

function bindExperienceAutosave({ item, titleInput, skillsInput, storyTextarea, autosaveNote }) {
  const save = () => {
    autosaveNote.textContent = "Autosaving...";
    scheduleAutosave(`experience-${item.id}`, async () => {
      const patch = {
        title: titleInput.value.trim(),
        skills: splitSkills(skillsInput.value),
        story: storyTextarea.value.trim()
      };

      if (!patch.title) {
        autosaveNote.textContent = "Add a title to autosave.";
        return;
      }

      if (item.status === "approved") {
        await bridgeFetch("/knowledge/item", {
          method: "POST",
          body: JSON.stringify({
            item: {
              ...item,
              ...patch,
              status: "approved"
            }
          })
        });
      } else {
        await bridgeFetch("/knowledge/action", {
          method: "POST",
          body: JSON.stringify({
            action: "pending",
            type: "experience",
            id: item.id,
            patch
          })
        });
      }

      item.title = patch.title;
      item.skills = patch.skills;
      item.story = patch.story;
      autosaveNote.textContent = `Autosaved ${formatAutosaveTime(new Date())}.`;
    }, (error) => {
      autosaveNote.textContent = friendlyBridgeError(error);
    });
  };

  titleInput.addEventListener("input", save);
  skillsInput.addEventListener("input", save);
  storyTextarea.addEventListener("input", save);
}

function autosaveLine() {
  const note = document.createElement("p");
  note.className = "autosaveNote";
  note.textContent = "Autosaves while you type.";
  return note;
}

function scheduleAutosave(key, save, onError = null) {
  clearTimeout(autosaveTimers.get(key));
  autosaveTimers.set(key, setTimeout(async () => {
    try {
      await save();
    } catch (error) {
      if (onError) {
        onError(error);
      } else {
        setKnowledgeStatus(friendlyBridgeError(error));
      }
    } finally {
      autosaveTimers.delete(key);
    }
  }, 900));
}

function formatAutosaveTime(date) {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

async function knowledgeAction(action, item, patch = {}) {
  try {
    const data = await bridgeFetch("/knowledge/action", {
      method: "POST",
      body: JSON.stringify({
        action,
        type: item.type,
        id: item.id,
        patch
      })
    });
    if (action === "delete" || action === "reject") {
      await removeDraftQuestionState(experienceDraftKey(item));
      await removeActiveStoryQuestionJob(experienceDraftKey(item));
    }
    renderKnowledge(data.knowledge);
    setKnowledgeStatus(action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Deleted.");
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
  }
}

async function saveKnowledgeItem(item, message) {
  try {
    const data = await bridgeFetch("/knowledge/item", {
      method: "POST",
      body: JSON.stringify({ item })
    });
    renderKnowledge(data.knowledge);
    setKnowledgeStatus(message || "Saved.");
  } catch (error) {
    setKnowledgeStatus(friendlyBridgeError(error));
  }
}

function labeledInput(text, value) {
  const label = document.createElement("label");
  label.textContent = text;
  const input = document.createElement("input");
  input.value = value;
  label.appendChild(input);
  return { label, input };
}

function labeledTextarea(text, value, rows, placeholder = "") {
  const label = document.createElement("label");
  label.textContent = text;
  label.className = "wide";
  const textarea = document.createElement("textarea");
  textarea.rows = rows;
  textarea.value = value;
  textarea.placeholder = placeholder;
  label.appendChild(textarea);
  return { label, textarea };
}

function sourceLine(item) {
  const source = document.createElement("p");
  source.className = "sourceLine";
  const jobs = Array.isArray(item.sourceJobIds) && item.sourceJobIds.length > 0
    ? item.sourceJobIds.join(", ")
    : "Manual";
  source.textContent = `Source: ${jobs}`;
  return source;
}

function actionRow(buttons) {
  const row = document.createElement("div");
  row.className = "actions compactActions";
  for (const item of buttons) {
    row.appendChild(item);
  }
  return row;
}

function button(text, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function splitSkills(value) {
  return String(value || "")
    .split(/,|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeJobId(value) {
  const match = String(value || "").match(/\bJR[-\s]?\d{3,}\b/i);
  return match ? match[0].replace(/[-\s]/g, "").toUpperCase() : "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function setKnowledgeStatus(message) {
  knowledgeStatusBox.textContent = message;
}

function friendlyBridgeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Failed to fetch")) {
    return "Start the v2 local bridge, then refresh this page.";
  }
  return message || "Something went wrong.";
}
