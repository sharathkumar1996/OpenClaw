// ─────────────────────────────────────────────────────────────────────────────
// agents.js  —  Multi-agent MCQ Review System
// Each agent is a specialist. Orchestrator decides who reviews what.
// Free tier: Groq (primary) + OpenRouter (fallback/secondary)
// ─────────────────────────────────────────────────────────────────────────────

// ── Model roster (all free) ───────────────────────────────────────────────────
const MODELS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1/chat/completions',
    getKey: () => process.env.GROQ_API_KEY,
    models: {
      fast:    'llama-3.1-8b-instant',       // fastest, simple tasks
      smart:   'llama-3.3-70b-versatile',    // best free model for complex tasks
      reason:  'deepseek-r1-distill-llama-70b' // reasoning tasks
    }
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1/chat/completions',
    getKey: () => process.env.OPENROUTER_API_KEY,
    models: {
      fast:   'meta-llama/llama-3.2-3b-instruct:free',
      smart:  'meta-llama/llama-3.1-70b-instruct:free',
      reason: 'deepseek/deepseek-r1:free'
    }
  }
};

// ── Core LLM call with fallback ───────────────────────────────────────────────
async function callLLM(messages, { provider = 'groq', tier = 'smart', temperature = 0.1 } = {}) {
  const providerCfg = MODELS[provider];
  const model = providerCfg.models[tier];
  const apiKey = providerCfg.getKey();

  if (!apiKey || apiKey.includes('your_')) {
    throw new Error(`Missing API key for ${provider}. Check your .env file.`);
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/ea-mcq-review';
    headers['X-Title'] = 'EA MCQ Review System';
  }

  const body = { model, messages, temperature, max_tokens: 1200 };

  const res = await fetch(providerCfg.baseURL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider} API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return text.trim();
}

// ── Safe JSON parse (strips markdown fences) ──────────────────────────────────
function parseJSON(raw) {
  const clean = raw
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // strip deepseek reasoning
    .trim();
  // Find JSON object
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');
  return JSON.parse(clean.slice(start, end + 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT DEFINITIONS
// Each agent: { name, expertise, provider, tier, run(question) → result }
// ─────────────────────────────────────────────────────────────────────────────

// ── Agent 1: Orchestrator ─────────────────────────────────────────────────────
// Reads the question and decides which agents to invoke + in what order
export async function orchestrate(question, agentLog) {
  const log = (msg) => { agentLog.push(msg); console.log(msg); };

  log(`🎯 Orchestrator: Analyzing question ${question.code}...`);

  // Orchestrator uses smart model to plan
  const planPrompt = `You are an orchestrator for an EA (Enrolled Agent) exam MCQ review system.
Analyze this question and decide which specialist agents to invoke.

Question: ${question.question}
Options: A) ${question.optionA}  B) ${question.optionB}  C) ${question.optionC}  D) ${question.optionD}
Current Answer: ${question.rightOption} | AI Column Answer: ${question.aiAnswer} | Final: ${question.finalAnswer}
Chapter: ${question.chapter} | Unit: ${question.unit}
Has explanation: ${question.finalExplanation ? 'yes' : 'no'}
Difficulty set: ${question.difficulty || 'not set'}

Available agents:
- answer_verifier: Verifies correct answer using tax law knowledge (always needed)
- conflict_analyzer: Analyzes when manual answer != AI answer (needed if they differ)
- difficulty_rater: Rates Easy/Medium/Hard (always needed)
- unit_checker: Checks if question belongs to stated unit (always needed)
- explanation_critic: Reviews explanation quality (needed if explanation exists)
- memory_trick_generator: Creates memory tricks/mnemonics (always needed)
- calculation_checker: Checks if calculation steps needed (needed for numerical questions)

Respond ONLY with JSON:
{
  "agents": ["answer_verifier", "difficulty_rater", ...],
  "reasoning": "brief reason for this selection",
  "hasAnswerConflict": true/false,
  "isNumerical": true/false
}`;

  try {
    const raw = await callLLM(
      [{ role: 'user', content: planPrompt }],
      { provider: 'groq', tier: 'fast' }
    );
    const plan = parseJSON(raw);
    log(`🎯 Orchestrator plan: [${plan.agents.join(', ')}] — ${plan.reasoning}`);
    return plan;
  } catch (e) {
    log(`⚠ Orchestrator fallback to default plan: ${e.message}`);
    return {
      agents: ['answer_verifier', 'difficulty_rater', 'unit_checker', 'explanation_critic', 'memory_trick_generator'],
      reasoning: 'Default full review',
      hasAnswerConflict: question.rightOption !== question.aiAnswer,
      isNumerical: /\$|million|thousand|percent|%/.test(question.question)
    };
  }
}

// ── Agent 2: Answer Verifier ──────────────────────────────────────────────────
export async function answerVerifier(question, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`✅ Answer Verifier: Checking correct answer...`);

  const prompt = `You are an IRS Enrolled Agent exam expert specializing in answer verification.
Your ONLY job: determine the correct answer to this multiple-choice tax question.

Question: ${question.question}
A) ${question.optionA}
B) ${question.optionB}
C) ${question.optionC}
D) ${question.optionD}

Current manual answer: ${question.rightOption}
AI-generated answer in data: ${question.aiAnswer}
Final answer in data: ${question.finalAnswer}

Analyze each option against current IRS/tax law. Be precise and cite the rule.

Respond ONLY with JSON:
{
  "correctAnswer": "A/B/C/D",
  "confidence": "high/medium/low",
  "reasoning": "specific IRS rule or tax code basis",
  "manualAnswerCorrect": true/false,
  "aiAnswerCorrect": true/false,
  "verdict": "both_correct/both_wrong/manual_correct/ai_correct/uncertain",
  "needsHumanReview": true/false,
  "humanReviewReason": "reason if needsHumanReview is true"
}`;

  try {
    // Use reasoning model for answer verification — most important task
    let raw;
    try {
      raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'reason' });
    } catch {
      raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'smart' });
    }
    const result = parseJSON(raw);
    log(`✅ Answer Verifier: ${result.correctAnswer} (${result.confidence} confidence) — ${result.verdict}`);
    return result;
  } catch (e) {
    // Fallback to OpenRouter
    try {
      const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'openrouter', tier: 'smart' });
      const result = parseJSON(raw);
      log(`✅ Answer Verifier (OpenRouter fallback): ${result.correctAnswer}`);
      return result;
    } catch (e2) {
      log(`⚠ Answer Verifier failed: ${e2.message}`);
      return { correctAnswer: '?', confidence: 'low', verdict: 'uncertain', needsHumanReview: true, humanReviewReason: 'Agent failed: ' + e2.message };
    }
  }
}

// ── Agent 3: Conflict Analyzer ────────────────────────────────────────────────
export async function conflictAnalyzer(question, answerResult, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`⚡ Conflict Analyzer: Investigating answer discrepancy...`);

  const prompt = `You are a conflict resolution specialist for EA exam MCQ answers.
There is a discrepancy between answers. Analyze and resolve it.

Question: ${question.question}
A) ${question.optionA}  B) ${question.optionB}  C) ${question.optionC}  D) ${question.optionD}

Manual answer in data: ${question.rightOption}
AI column answer in data: ${question.aiAnswer}
Final answer in data: ${question.finalAnswer}
Answer Verifier concluded: ${answerResult.correctAnswer} (${answerResult.verdict})

Look at each answer carefully. Consider:
1. Is the manual answer based on old tax law?
2. Is the AI answer hallucinated?
3. Could there be a typo/data entry error?
4. Is this a genuinely ambiguous question?

Respond ONLY with JSON:
{
  "resolution": "manual_correct/ai_correct/both_wrong/genuinely_ambiguous",
  "finalRecommendedAnswer": "A/B/C/D",
  "conflictType": "data_entry_error/outdated_law/ai_hallucination/ambiguous_question/unclear",
  "explanation": "clear explanation of why this conflict exists and how to resolve",
  "escalateToHuman": true/false,
  "escalationReason": "reason if escalating"
}`;

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'smart' });
    const result = parseJSON(raw);
    log(`⚡ Conflict Analyzer: ${result.resolution} — ${result.conflictType}`);
    return result;
  } catch (e) {
    log(`⚠ Conflict Analyzer failed: ${e.message}`);
    return { resolution: 'genuinely_ambiguous', finalRecommendedAnswer: '?', conflictType: 'unclear', escalateToHuman: true, escalationReason: e.message };
  }
}

// ── Agent 4: Difficulty Rater ─────────────────────────────────────────────────
export async function difficultyRater(question, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`📊 Difficulty Rater: Assessing difficulty level...`);

  const prompt = `You are an EA exam difficulty assessment specialist.
Rate the difficulty of this multiple choice question for the IRS Enrolled Agent exam.

Question: ${question.question}
A) ${question.optionA}  B) ${question.optionB}  C) ${question.optionC}  D) ${question.optionD}
Explanation: ${question.finalExplanation || question.feedback || 'none'}

Difficulty criteria:
- Easy: Direct recall, single concept, clear distractors
- Medium: Requires understanding of a rule + application, some tricky distractors  
- Hard: Multi-step reasoning, exception to a rule, or easily confused similar concepts

Current difficulty set: ${question.difficulty || 'not set'}

Respond ONLY with JSON:
{
  "difficulty": "Easy/Medium/Hard",
  "reasoning": "one sentence why",
  "currentRatingCorrect": true/false,
  "suggestedChange": "keep/change to Easy/change to Medium/change to Hard"
}`;

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'fast' });
    const result = parseJSON(raw);
    log(`📊 Difficulty Rater: ${result.difficulty} (${result.suggestedChange})`);
    return result;
  } catch (e) {
    log(`⚠ Difficulty Rater failed: ${e.message}`);
    return { difficulty: question.difficulty || 'Medium', reasoning: 'Agent failed', currentRatingCorrect: true, suggestedChange: 'keep' };
  }
}

// ── Agent 5: Unit Checker ─────────────────────────────────────────────────────
export async function unitChecker(question, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`📂 Unit Checker: Verifying unit placement...`);

  const prompt = `You are an EA exam curriculum specialist. Check if this question is in the right unit.

Chapter: ${question.chapter}
Unit: ${question.unit}
Question: ${question.question}
Options: A) ${question.optionA}  B) ${question.optionB}  C) ${question.optionC}  D) ${question.optionD}

The EA exam covers: Part 1 (Individual), Part 2 (Business), Part 3 (Representation).
Common units: Individual Income, Business Taxation, Partnerships, Corporations, 
Estate & Gift, Exempt Organizations, IRS Procedures, Representation, etc.

Does this question belong in the stated unit? If not, which unit better fits?

Respond ONLY with JSON:
{
  "belongsInUnit": true/false,
  "confidence": "high/medium/low",
  "reasoning": "why it does or doesn't belong",
  "suggestedUnit": "same unit or better unit name",
  "questionType": "Static Question/Year-Dependent",
  "yearDependentReason": "if year-dependent, what changes year to year"
}`;

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'fast' });
    const result = parseJSON(raw);
    log(`📂 Unit Checker: ${result.belongsInUnit ? '✓ correct unit' : '✗ wrong unit → ' + result.suggestedUnit}`);
    return result;
  } catch (e) {
    log(`⚠ Unit Checker failed: ${e.message}`);
    return { belongsInUnit: true, confidence: 'low', reasoning: 'Agent failed', suggestedUnit: question.unit, questionType: 'Static Question' };
  }
}

// ── Agent 6: Explanation Critic ───────────────────────────────────────────────
export async function explanationCritic(question, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`📝 Explanation Critic: Reviewing explanation quality...`);

  const explanation = question.finalExplanation || question.feedback || '';
  if (!explanation) {
    log(`📝 Explanation Critic: No explanation found — flagging for creation`);
    return { quality: 'Missing', score: 0, missingElements: ['Full explanation needed'], improvementSuggestion: 'No explanation exists — needs to be written from scratch', needsCalculation: false };
  }

  const prompt = `You are an EA exam explanation quality specialist.
Review this explanation for a multiple-choice tax question.

Question: ${question.question}
Correct Answer: ${question.finalAnswer || question.rightOption}
Options: A) ${question.optionA}  B) ${question.optionB}  C) ${question.optionC}  D) ${question.optionD}

Current Explanation:
${explanation}

Evaluate:
1. Does it explain WHY the correct answer is right?
2. Does it explain WHY each wrong option is wrong?
3. Is it clear for exam prep (not too technical, not too vague)?
4. Does it cite the relevant IRS form, code section, or rule?
5. Would a student understand this without prior knowledge?

Respond ONLY with JSON:
{
  "quality": "Excellent/Good/Needs Improvement/Poor",
  "score": 1-10,
  "strengths": "what is good about it",
  "missingElements": ["list", "of", "missing", "things"],
  "improvementSuggestion": "specific actionable suggestion",
  "needsCalculation": true/false,
  "calculationNote": "what calculation to add if needsCalculation is true"
}`;

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'smart' });
    const result = parseJSON(raw);
    log(`📝 Explanation Critic: ${result.quality} (${result.score}/10)`);
    return result;
  } catch (e) {
    log(`⚠ Explanation Critic failed: ${e.message}`);
    return { quality: 'Unknown', score: 5, missingElements: [], improvementSuggestion: 'Agent failed — manual review needed', needsCalculation: false };
  }
}

// ── Agent 7: Memory Trick Generator ──────────────────────────────────────────
export async function memoryTrickGenerator(question, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`💡 Memory Trick Generator: Creating mnemonic...`);

  const prompt = `You are a creative EA exam study coach specializing in memory techniques.
Create a memorable trick to remember the answer to this tax question.

Question: ${question.question}
Correct Answer: ${question.finalAnswer || question.rightOption}
The answer is: ${question[`option${(question.finalAnswer || question.rightOption)}`] || ''}
Key concept: ${question.unit}

Create a memory trick that is:
- Short (1-2 sentences max)
- Catchy or uses a rhyme/acronym/visual story
- Directly tied to the key concept
- Easy to recall under exam pressure

Respond ONLY with JSON:
{
  "memoryTrick": "the actual memory trick",
  "type": "acronym/rhyme/story/visual/association",
  "keyConceptSummary": "one-line summary of the core concept to remember"
}`;

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'fast', temperature: 0.7 });
    const result = parseJSON(raw);
    log(`💡 Memory Trick: [${result.type}] ${result.memoryTrick}`);
    return result;
  } catch (e) {
    log(`⚠ Memory Trick Generator failed: ${e.message}`);
    return { memoryTrick: '', type: 'none', keyConceptSummary: '' };
  }
}

// ── Agent 8: Calculation Checker ─────────────────────────────────────────────
export async function calculationChecker(question, agentLog) {
  const log = (msg) => agentLog.push(msg);
  log(`🔢 Calculation Checker: Checking if calculation steps needed...`);

  const prompt = `You are an EA exam calculation specialist.
Determine if this question requires calculation steps to be shown in the explanation.

Question: ${question.question}
Options: A) ${question.optionA}  B) ${question.optionB}  C) ${question.optionC}  D) ${question.optionD}
Correct Answer: ${question.finalAnswer || question.rightOption}
Current Explanation: ${question.finalExplanation || 'none'}

Does this question involve any numbers, thresholds, percentages, or formulas?
If yes, should the explanation show step-by-step calculation?

Respond ONLY with JSON:
{
  "requiresCalculation": true/false,
  "calculationSteps": "step by step calculation if required, empty string if not",
  "thresholdsInvolved": ["list of dollar/percentage thresholds relevant to this question"],
  "formulaUsed": "name of formula or rule (e.g. 'Schedule M-3 threshold: $10M assets')"
}`;

  try {
    const raw = await callLLM([{ role: 'user', content: prompt }], { provider: 'groq', tier: 'fast' });
    const result = parseJSON(raw);
    log(`🔢 Calculation Checker: ${result.requiresCalculation ? 'Calculation needed' : 'No calculation needed'}`);
    return result;
  } catch (e) {
    log(`⚠ Calculation Checker failed: ${e.message}`);
    return { requiresCalculation: false, calculationSteps: '', thresholdsInvolved: [], formulaUsed: '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN REVIEW FUNCTION  —  runs all agents for one question
// ─────────────────────────────────────────────────────────────────────────────
export async function reviewQuestion(question) {
  const agentLog = [];
  const startTime = Date.now();

  try {
    // Step 1: Orchestrator plans
    const plan = await orchestrate(question, agentLog);

    // Step 2: Run agents in parallel where possible
    const agentSet = new Set(plan.agents);

    const [answerResult, difficultyResult, unitResult] = await Promise.all([
      agentSet.has('answer_verifier') ? answerVerifier(question, agentLog) : Promise.resolve(null),
      agentSet.has('difficulty_rater') ? difficultyRater(question, agentLog) : Promise.resolve(null),
      agentSet.has('unit_checker') ? unitChecker(question, agentLog) : Promise.resolve(null),
    ]);

    // Step 3: Run dependent agents
    const hasConflict = question.rightOption !== question.aiAnswer ||
                        question.rightOption !== question.finalAnswer ||
                        answerResult?.verdict === 'uncertain';

    const [conflictResult, explanationResult, memoryResult, calcResult] = await Promise.all([
      (agentSet.has('conflict_analyzer') || hasConflict) && answerResult
        ? conflictAnalyzer(question, answerResult, agentLog)
        : Promise.resolve(null),
      agentSet.has('explanation_critic') ? explanationCritic(question, agentLog) : Promise.resolve(null),
      agentSet.has('memory_trick_generator') ? memoryTrickGenerator(question, agentLog) : Promise.resolve(null),
      (agentSet.has('calculation_checker') || plan.isNumerical) ? calculationChecker(question, agentLog) : Promise.resolve(null),
    ]);

    // Step 4: Synthesize final result
    const finalAnswer = conflictResult?.finalRecommendedAnswer ||
                        answerResult?.correctAnswer ||
                        question.finalAnswer ||
                        question.rightOption;

    const needsHuman = answerResult?.needsHumanReview ||
                       conflictResult?.escalateToHuman ||
                       answerResult?.confidence === 'low' ||
                       answerResult?.verdict === 'uncertain';

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    agentLog.push(`✓ Complete in ${elapsed}s — ${plan.agents.length} agents ran`);

    // Build queries summary
    const queryParts = [];
    if (needsHuman) queryParts.push(`⚠ HUMAN REVIEW NEEDED: ${answerResult?.humanReviewReason || conflictResult?.escalationReason || 'Uncertain answer'}`);
    if (conflictResult && hasConflict) queryParts.push(`Answer conflict: ${conflictResult.conflictType} — ${conflictResult.explanation}`);
    if (difficultyResult && !difficultyResult.currentRatingCorrect) queryParts.push(`Difficulty: change to ${difficultyResult.difficulty}`);
    if (!unitResult?.belongsInUnit) queryParts.push(`Unit mismatch: move to "${unitResult?.suggestedUnit}"`);
    if (explanationResult?.quality === 'Needs Improvement' || explanationResult?.quality === 'Poor') queryParts.push(`Explanation: ${explanationResult.improvementSuggestion}`);
    if (calcResult?.requiresCalculation) queryParts.push(`Add calculation: ${calcResult.calculationSteps}`);
    if (!queryParts.length) queryParts.push('c) Kept as is — all checks passed');

    return {
      // Status
      status: 'done',
      needsHuman,
      hasConflict,
      elapsed,
      agentLog,
      plan,

      // Answer
      finalAnswer,
      correctAnswer: answerResult?.correctAnswer,
      answerVerdict: answerResult?.verdict,
      answerConfidence: answerResult?.confidence,
      answerReasoning: answerResult?.reasoning,

      // Conflict
      conflictType: conflictResult?.conflictType,
      conflictExplanation: conflictResult?.explanation,

      // Difficulty
      difficulty: difficultyResult?.difficulty || question.difficulty,
      difficultyReasoning: difficultyResult?.reasoning,
      difficultyChanged: difficultyResult ? !difficultyResult.currentRatingCorrect : false,

      // Unit
      unitMatch: unitResult?.belongsInUnit,
      suggestedUnit: unitResult?.suggestedUnit,
      questionType: unitResult?.questionType || question.category,
      yearDependentReason: unitResult?.yearDependentReason,

      // Explanation
      explanationQuality: explanationResult?.quality,
      explanationScore: explanationResult?.score,
      explanationImprovements: explanationResult?.missingElements?.join('; '),
      explanationSuggestion: explanationResult?.improvementSuggestion,

      // Calculation
      needsCalculation: calcResult?.requiresCalculation,
      calculationSteps: calcResult?.calculationSteps,
      thresholds: calcResult?.thresholdsInvolved?.join(', '),

      // Memory
      memoryTrick: memoryResult?.memoryTrick,
      memoryType: memoryResult?.type,
      keyConceptSummary: memoryResult?.keyConceptSummary,

      // Queries column
      queries: queryParts.join(' | ')
    };

  } catch (e) {
    agentLog.push(`💥 System error: ${e.message}`);
    return {
      status: 'error',
      needsHuman: true,
      hasConflict: false,
      agentLog,
      queries: `⚠ SYSTEM ERROR — needs human review: ${e.message}`,
      difficulty: question.difficulty,
      finalAnswer: question.finalAnswer || question.rightOption
    };
  }
}
