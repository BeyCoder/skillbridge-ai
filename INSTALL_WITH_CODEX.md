# Install SkillBridge AI With Codex

SkillBridge AI is designed to run locally. Each user uses their own Codex or ChatGPT plan, so the project does not need a hosted AI backend or a shared API key. No additional fees.

This is important for privacy and accessibility: no SkillBridge server sees the user's resume or application materials, and the maintainer does not need to operate a paid AI service.

GitHub repo: [https://github.com/BeyCoder/skillbridge-ai](https://github.com/BeyCoder/skillbridge-ai)

## Architecture

- Chrome extension: reads supported job pages and application steps in the user's browser.
- Local MCP/HTTP bridge: runs on `http://127.0.0.1:17366`, coordinates the browser extension with Codex, and stores generated application files locally.
- Codex: runs from the user's own account/subscription to tailor materials and draft experience stories.
- Local files: the user keeps their own `Master Resume.md`, generated documents, logs, and skill/story knowledge base on their machine.

## Initial Resume Setup

SkillBridge AI uses `Master Resume.md` as the local canonical resume source. On first run, create this file in the repo/workspace root before tailoring a job.

If you already have a resume in PDF, DOCX, or text format, keep the file local and ask Codex to convert or summarize it into `Master Resume.md`. Do not commit your real resume to GitHub. The repo includes `Master Resume.example.md` as a safe public template.

## Codex Setup Prompt

Use this prompt in Codex to install from the GitHub repo:

```text
Install SkillBridge AI from this GitHub repo:
https://github.com/BeyCoder/skillbridge-ai

Please set it up locally without using a hosted backend. Use my own Codex/ChatGPT plan for AI work.

Tasks:
1. Clone the repo if it is not already on my machine. If it is already cloned, use the existing folder.
2. Inspect the repo and explain the architecture briefly.
3. Check that Node.js and Python 3 are available.
4. Help me set up my initial resume source as `Master Resume.md` in the local repo/workspace root.
5. If I already have a PDF, DOCX, or text resume, help me convert or summarize it into `Master Resume.md` while keeping it local.
6. If `Master Resume.md` is missing and I do not provide a resume, create a safe template with headings I can fill in.
7. Start the local MCP/HTTP bridge with `node bridge/mcp-http-bridge.js`.
8. Confirm the bridge health endpoint works at `http://127.0.0.1:17366/health`.
9. Give me Chrome steps to load the repo folder as an unpacked extension.
10. Help me open the extension options page and fill in my profile defaults.

Important:
- Do not upload my resume or generated application files anywhere.
- Do not create shared API keys.
- Do not submit job applications for me.
- Keep all generated application materials local unless I explicitly ask otherwise.
```

## Manual Setup

1. Clone or download the repo:

```sh
git clone https://github.com/BeyCoder/skillbridge-ai.git
cd skillbridge-ai
```

2. Add your initial resume source at the workspace root as `Master Resume.md`. If your resume is currently a PDF, DOCX, or plain text file, use Codex to convert it into this Markdown file locally.
3. Start the local MCP/HTTP bridge:

```sh
node bridge/mcp-http-bridge.js
```

4. Open Chrome and go to `chrome://extensions`.
5. Enable Developer Mode.
6. Click `Load unpacked`.
7. Select the SkillBridge AI extension folder.
8. Open the extension options and fill in your profile defaults.

## GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/pages.yml` that publishes the static project page from `docs/`.

After publishing the repository, open GitHub repository settings, go to `Pages`, and make sure the build and deployment source is set to `GitHub Actions`. The project page will be available at:

`https://beycoder.github.io/skillbridge-ai/`

## Optional Environment Variables

- `SKILLBRIDGE_WORKSPACE_ROOT`: folder containing `Master Resume.md`, `AGENTS.md`, and `generated-applications-v2`.
- `APPLICATION_OUTPUT_DIR`: custom output folder for generated applications.
- `CODEX_BIN`: custom path to the Codex executable.
- `SKILLBRIDGE_RESUME_FILE_NAME`: custom generated resume filename.
- `SKILLBRIDGE_COVER_LETTER_FILE_NAME`: custom generated cover letter filename.

## Privacy Model

SkillBridge AI does not use a central SkillBridge server. The local MCP/HTTP bridge coordinates files on the user's machine and calls the user's own Codex installation. The user's resume and generated materials are not sent to a SkillBridge backend. When Codex drafts materials, the job posting, resume content, and approved knowledge needed for that draft are handled through the user's own Codex/ChatGPT account and plan.

## License Reminder

SkillBridge AI is source-available under the PolyForm Strict License 1.0.0. Personal and noncommercial use is allowed. Commercial use, redistribution, sublicensing, and modified versions require prior written permission from the copyright holder.
