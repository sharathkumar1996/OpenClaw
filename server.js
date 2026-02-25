// server.js — EA MCQ Agent System backend
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { reviewQuestion } from './agents.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ── Serve UI ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    groq: !!process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes('your_'),
    openrouter: !!process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.includes('your_'),
    anthropic: !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('your_'),
  });
});

// ── Parse uploaded CSV/TSV ────────────────────────────────────────────────────
app.post('/api/parse', upload.single('file'), (req, res) => {
  try {
    let raw;
    if (req.file) {
      raw = req.file.buffer.toString('utf-8');
    } else if (req.body.data) {
      raw = req.body.data;
    } else {
      return res.status(400).json({ error: 'No data provided' });
    }

    const delimiter = raw.includes('\t') ? '\t' : ',';
    const records = parse(raw, {
      delimiter,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });

    const questions = records.map(normalizeRow).filter(q => q.question);
    res.json({ questions, count: questions.length });
  } catch (e) {
    res.status(400).json({ error: 'Parse error: ' + e.message });
  }
});

// ── Review single question (SSE streaming) ────────────────────────────────────
app.post('/api/review', express.json(), async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  // Server-Sent Events for live agent log streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    // Monkey-patch: stream agent logs in real time by reviewing the question
    const result = await reviewQuestion(question);

    // Send logs first
    for (const log of result.agentLog) {
      sendEvent('log', { message: log });
    }

    // Send final result
    sendEvent('result', { result });
    sendEvent('done', {});
  } catch (e) {
    sendEvent('error', { message: e.message });
  } finally {
    res.end();
  }
});

// ── Review all questions (SSE streaming) ─────────────────────────────────────
app.post('/api/review-all', express.json(), async (req, res) => {
  const { questions } = req.body;
  if (!questions?.length) return res.status(400).json({ error: 'No questions provided' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  sendEvent('start', { total: questions.length });

  const results = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    sendEvent('progress', { index: i, code: q.code, question: q.question.substring(0, 80) });

    try {
      const result = await reviewQuestion(q);
      results.push({ index: i, ...result });

      // Stream key log lines
      for (const log of result.agentLog) {
        sendEvent('log', { index: i, message: log });
      }

      sendEvent('question-done', { index: i, result });
    } catch (e) {
      sendEvent('question-error', { index: i, error: e.message });
      results.push({ index: i, status: 'error', needsHuman: true, queries: '⚠ Error: ' + e.message });
    }

    // Small delay to avoid rate limits
    if (i < questions.length - 1) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  sendEvent('complete', { total: questions.length, results });
  res.end();
});

// ── Export reviewed data as CSV ───────────────────────────────────────────────
app.post('/api/export', express.json(), (req, res) => {
  const { questions, results } = req.body;
  if (!questions?.length) return res.status(400).json({ error: 'No data to export' });

  const resultMap = {};
  for (const r of (results || [])) {
    resultMap[r.index] = r;
  }

  const rows = questions.map((q, i) => {
    const r = resultMap[i] || {};
    return {
      'Code': q.code || '',
      'Chapter': q.chapter || '',
      'Unit': q.unit || '',
      'Question': q.question || '',
      'Option A': q.optionA || '',
      'Option B': q.optionB || '',
      'Option C': q.optionC || '',
      'Option D': q.optionD || '',
      'Original Answer': q.rightOption || '',
      'AI Column Answer': q.aiAnswer || '',
      'Final Answer': r.finalAnswer || q.finalAnswer || '',
      'Answer Verdict': r.answerVerdict || '',
      'Answer Confidence': r.answerConfidence || '',
      'Difficulty': r.difficulty || q.difficulty || '',
      'Difficulty Changed': r.difficultyChanged ? 'Yes' : 'No',
      'Question Type': r.questionType || q.category || '',
      'Unit Match': r.unitMatch === false ? `No — suggest: ${r.suggestedUnit}` : 'Yes',
      'Explanation Quality': r.explanationQuality || '',
      'Explanation Score': r.explanationScore || '',
      'Explanation Suggestion': r.explanationSuggestion || '',
      'Needs Calculation': r.needsCalculation ? 'Yes' : 'No',
      'Calculation Steps': r.calculationSteps || '',
      'Thresholds': r.thresholds || '',
      'Memory Trick': r.memoryTrick || '',
      'Memory Trick Type': r.memoryType || '',
      'Key Concept': r.keyConceptSummary || '',
      'Needs Human Review': r.needsHuman ? 'YES' : 'No',
      'Answer Conflict': r.hasConflict ? 'YES' : 'No',
      'Queries': r.queries || q.queries || '',
      'Final Explanation': q.finalExplanation || q.feedback || '',
    };
  });

  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="ea_mcq_reviewed.csv"');
  res.send(csv);
});

// ── Normalise column names from any Excel export ──────────────────────────────
function normalizeRow(row) {
  const keys = Object.keys(row);
  const get = (...aliases) => {
    for (const alias of aliases) {
      const k = keys.find(k => k.toLowerCase().includes(alias.toLowerCase()));
      if (k) return (row[k] || '').trim();
    }
    return '';
  };
  return {
    code:             get('code', 'id', 'e2-', 'question id'),
    chapter:          get('chapter', 'ch_'),
    unit:             get('final sub unit', 'sub unit', 'unit'),
    question:         get('question'),
    optionA:          get('option a', 'optiona'),
    optionB:          get('option b', 'optionb'),
    optionC:          get('option c', 'optionc'),
    optionD:          get('option d', 'optiond'),
    rightOption:      get('right option', 'right answer', 'manual'),
    feedback:         get('general feedback', 'feedback'),
    aiAnswer:         get('aimatch', 'ai match', 'ai answer', ' ai'),
    finalAnswer:      get('final answer'),
    finalExplanation: get('final explanation'),
    difficulty:       get('difficulty'),
    category:         get('category'),
    queries:          get('queries'),
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 EA MCQ Agent System running on http://localhost:${PORT}`);
  console.log(`   Groq:        ${process.env.GROQ_API_KEY?.includes('your_') ? '❌ not set' : '✅ configured'}`);
  console.log(`   OpenRouter:  ${process.env.OPENROUTER_API_KEY?.includes('your_') ? '❌ not set' : '✅ configured'}`);
  console.log(`\n   Open http://localhost:${PORT} in your browser\n`);
});
