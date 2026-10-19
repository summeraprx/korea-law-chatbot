# Korea Law Helper — prototype

A multilingual AI chatbot that helps foreigners in Korea (and Koreans) understand **Korean law** and prepare before they go to the police, immigration, a court, an employer or a lawyer.

## How it keeps answers accurate

Every answer goes through three steps before the user sees it:

1. **Research with the official database only.** The AI (Claude) cannot answer from memory. It must look up the statutes and court precedents through the **law.go.kr Open API** (국가법령정보센터, run by the Ministry of Government Legislation) and quote the exact articles it retrieved.
2. **Independent check.** A second AI call, acting as a fact-checker that did not write the draft, compares every legal claim against the retrieved text: law names, article numbers, penalties, deadlines, translations and logic. It corrects the answer or marks unconfirmed claims.
3. **Automatic citation check.** Code scans the final answer for every `○○법 제N조` citation and confirms that exact article was actually fetched. Anything not fetched is shown to the user in an amber warning.

The user sees a stamp on each answer: green **"Checked against law.go.kr"**, or amber **"Some points could not be confirmed"**. Links to each article on law.go.kr are listed under *Official sources*.

## Features

- Answers in **any language** the user writes in. The interface comes in 12 languages: English, 한국어, 简体中文, 日本語, Tiếng Việt, ไทย, Русский, Монгол, Oʻzbekcha, नेपाली, Bahasa Indonesia and Filipino.
- Korean legal terms are kept in Korean next to the translation, so users can show them to officials.
- Uses logic, not emotion. Every answer follows the same structure: short answer → what the law says (Korean quote + translation) → how it applies → what to do now → what to prepare → where to get help → questions that could change the answer.
- **Case sheet.** After chatting, the user can create a two-language summary (their language + Korean) of the timeline, status, relevant law, evidence and questions for the lawyer. They can print it or save it as a PDF.
- Emergency panel with official help lines (112, 119, 1345, 132, 1366, 1577-1366, 1350, 1330).
- **Privacy.** Conversations are not saved anywhere, either in the browser or on the server.

## Choose the AI

| `AI_PROVIDER` | Cost | Privacy | Accuracy |
|---|---|---|---|
| `ollama` (default when no Anthropic key is set) | Free | Nothing leaves your computer | Lower; good for building and testing |
| `anthropic` | Paid (set a spend limit) | Not used for training by default | Best; recommended before real users |

**Free setup with Ollama:**
1. Install Ollama from https://ollama.com/download and open it.
2. Download a model that fits your Mac's memory (Apple menu → About This Mac):
   - 8 GB: `ollama pull gemma4`
   - 16 GB: `ollama pull gemma4:12b` (the default)
   - 24 GB or more: `ollama pull gemma4:26b`, then set `OLLAMA_MODEL=gemma4:26b` in `.env`
3. Never use a model whose name ends in `cloud`. Those run online, not on your Mac.

Local models are slower; one answer can take a few minutes.

## Setup (Mac)

1. Install Node.js 18.18 or newer from https://nodejs.org.
2. Get the two keys:
   - **Anthropic API key**: https://console.anthropic.com
   - **law.go.kr Open API key (`OC`)**: sign up at https://open.law.go.kr, then apply for Open API use (OPEN API 신청). You choose the `OC` value yourself on that form (check it with 중복확인), and you can see it later under 마이페이지 → API인증키관리. Tick **목록 JSON** and **본문 JSON** for 대한민국 현행법령 and for 판례. **Register the IP address or domain of the computer or server that will call the API**, or the API returns an error page instead of data.
3. In Terminal:
   ```bash
   cd "~/Desktop/Korean law based consult for foreigner in Korea/korea-law-chatbot"
   cp .env.example .env      # then open .env and paste both keys
   npm install
   npm start
   ```
4. Open http://localhost:3000.

Run the tests with `npm test`.

## Project layout

```
server/
  index.js      web server, /api/chat (streams progress, then the checked answer)
  agent.js      AI research loop + independent verification step
  lawApi.js     law.go.kr Open API client (search, articles, precedents)
  citations.js  mechanical citation check
  prompts.js    the rules the AI must follow (edit with care)
public/         the website (HTML/CSS/JS, no build step)
test/           parser + citation-checker tests
```

## Before a public launch: important

- **Legal-services regulation.** Korea's Attorney-at-Law Act (변호사법), in particular Article 109, restricts non-lawyers from providing legal services such as legal consultation for money. Talk to a Korean lawyer about how to position and charge for a B2C service. For example, keep it "legal information" rather than case-specific advice, partner with a law firm, or use a referral model. Several Korean legal-tech companies have faced disputes over this.
- **Have lawyers test it.** Collect real questions (visa, criminal, labor, housing, stalking and domestic violence), have a Korean lawyer grade the answers, and adjust `server/prompts.js`.
- **Translations.** The interface translations should be reviewed by native speakers.
- **Hosting.** Deploy on a server with a fixed IP or domain that is registered with law.go.kr. Replace the simple in-memory rate limit with a real one. Add HTTPS, privacy terms and a log policy that does not store conversations.
- **Cost.** Each question makes several AI calls (research plus verification). For lower cost, set `VERIFY_MODEL` or `MODEL` to `claude-sonnet-5-5` in `.env`, but test accuracy first.
- **Not yet verified against the live law.go.kr API.** The parser was built from the official API guide and tested with sample data. On first run, try a few questions and check the *Official sources* panel to confirm that the article text is coming through correctly.
