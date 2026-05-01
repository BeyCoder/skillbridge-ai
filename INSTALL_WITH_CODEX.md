# Install SkillBridge AI With Codex

SkillBridge AI is designed to run locally. Each user uses their own Codex or ChatGPT subscription, so the project does not need a hosted AI backend or a shared API key.

This is important for privacy and accessibility: no SkillBridge server sees the user's resume or application materials, and the maintainer does not need to operate a paid AI service.

## Architecture

- Chrome extension: reads supported job pages and application steps in the user's browser.
- Local bridge: runs on `http://127.0.0.1:17366` and stores generated application files locally.
- Codex: runs from the user's own account/subscription to tailor materials and draft experience stories.
- Local files: the user keeps their own `Master Resume.md`, generated documents, logs, and skill/story knowledge base on their machine.

## Codex Setup Prompt

Use this prompt in Codex after cloning the repo:

```text
I cloned the SkillBridge AI repo and want to install it locally.

Please set it up without using a hosted backend. Use my own local Codex/ChatGPT subscription for AI work.

Tasks:
1. Inspect the repo and explain the architecture briefly.
2. Check that Node.js and Python 3 are available.
3. Tell me where to put my canonical resume as `Master Resume.md`.
4. If `Master Resume.md` is missing, create a safe template with headings I can fill in.
5. Start the local bridge with `node bridge/mcp-http-bridge.js`.
6. Confirm the bridge health endpoint works at `http://127.0.0.1:17366/health`.
7. Give me Chrome steps to load the repo folder as an unpacked extension.
8. Help me open the extension options page and fill in my profile defaults.

Important:
- Do not upload my resume or generated application files anywhere.
- Do not create shared API keys.
- Do not submit job applications for me.
- Keep all generated application materials local unless I explicitly ask otherwise.
```

## Manual Setup

1. Clone or download the repo.
2. Put your resume source at the workspace root as `Master Resume.md`.
3. Start the bridge:

```sh
node bridge/mcp-http-bridge.js
```

4. Open Chrome and go to `chrome://extensions`.
5. Enable Developer Mode.
6. Click `Load unpacked`.
7. Select the SkillBridge AI extension folder.
8. Open the extension options and fill in your profile defaults.

## Optional Environment Variables

- `SKILLBRIDGE_WORKSPACE_ROOT`: folder containing `Master Resume.md`, `AGENTS.md`, and `generated-applications-v2`.
- `APPLICATION_OUTPUT_DIR`: custom output folder for generated applications.
- `CODEX_BIN`: custom path to the Codex executable.
- `SKILLBRIDGE_RESUME_FILE_NAME`: custom generated resume filename.
- `SKILLBRIDGE_COVER_LETTER_FILE_NAME`: custom generated cover letter filename.

## Privacy Model

SkillBridge AI does not use a central SkillBridge server. The local bridge coordinates files on the user's machine and calls the user's own Codex installation. The user's resume and generated materials are not sent to a SkillBridge backend. When Codex drafts materials, the job posting, resume content, and approved knowledge needed for that draft are handled through the user's own Codex/ChatGPT account and plan.

## License Reminder

SkillBridge AI is source-available under the PolyForm Strict License 1.0.0. Personal and noncommercial use is allowed. Commercial use, redistribution, sublicensing, and modified versions require prior written permission from the copyright holder.
