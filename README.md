# EA MCQ Agent Review System

Multi-agent AI system for bulk MCQ review — 100% free using Groq + OpenRouter.

## Agent Architecture

```
Orchestrator (Groq fast)
    ├── Answer Verifier     → Verifies correct answer using IRS tax law (Groq reasoning)
    ├── Conflict Analyzer   → Resolves manual vs AI answer conflicts (Groq smart)
    ├── Difficulty Rater    → Easy / Medium / Hard (Groq fast)
    ├── Unit Checker        → Verifies unit placement + Static/Year-Dependent (Groq fast)
    ├── Explanation Critic  → Reviews explanation quality (Groq smart)
    ├── Memory Trick Gen    → Creates mnemonics for exam prep (Groq fast)
    └── Calculation Checker → Flags questions needing calculation steps (Groq fast)
```

The Orchestrator reads each question and **decides which agents to invoke** — no agents are hardcoded. Agents run in parallel where possible.

## Setup (GitHub Codespaces)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up API keys
```bash
cp .env.example .env
```

Edit `.env` and add your free keys:
- **Groq** (free, no credit card): https://console.groq.com → API Keys
- **OpenRouter** (free tier): https://openrouter.ai → Keys

### 3. Start the server
```bash
npm start
```

Open the port in Codespaces (usually port 3000) → your browser opens the UI.

## Usage

1. Paste your tab-separated Excel data or upload a CSV/TSV
2. Click **Load Questions** — all questions appear in the sidebar
3. Click **Review All** — agents process every question
4. Watch the **Agent Console** for live logs
5. Click any question to see full AI review detail
6. Edit the **Queries** field for any question
7. Click **Export CSV** — ready to paste back into your LMS

## What agents review per question

| Check | Agent | Free Model |
|-------|-------|-----------|
| Correct answer verification | Answer Verifier | `deepseek-r1` on Groq |
| Manual vs AI answer conflict | Conflict Analyzer | `llama-3.3-70b` on Groq |
| Difficulty level | Difficulty Rater | `llama-3.1-8b` on Groq |
| Unit placement | Unit Checker | `llama-3.1-8b` on Groq |
| Static vs Year-Dependent | Unit Checker | `llama-3.1-8b` on Groq |
| Explanation quality | Explanation Critic | `llama-3.3-70b` on Groq |
| Calculation steps needed | Calculation Checker | `llama-3.1-8b` on Groq |
| Memory tricks / mnemonics | Memory Trick Gen | `llama-3.1-8b` on Groq |

## Adding more agents later

1. Export a new agent function in `agents.js`
2. Add it to the `orchestrate()` available agents list
3. Call it in the parallel section of `reviewQuestion()`

## When to upgrade to Claude Opus

Add `ANTHROPIC_API_KEY` to `.env`. Future: route only `needsHuman: true` questions to Opus.
