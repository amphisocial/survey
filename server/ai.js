const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const SKILLS_DIR = path.join(PROMPTS_DIR, 'skills');

function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function stripComments(text) {
  return String(text || '').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim();
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? '');
}

function loadSkills(envVar, defaults) {
  const names = String(process.env[envVar] || defaults).split(',').map((x) => x.trim()).filter(Boolean);
  return names.map((name) => readTextFile(path.join(SKILLS_DIR, `${name}.md`)).trim()).filter(Boolean).join('\n\n');
}

function safeJsonFromText(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  throw new Error('AI response was not valid JSON.');
}

function resolveProvider() {
  const raw = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const aliases = { anthropic: 'claude', claude: 'claude', openai: 'openai', gpt: 'openai', google: 'gemini', gemini: 'gemini' };
  if (aliases[raw]) return aliases[raw];
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'fallback';
}

async function callOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Return strict JSON only. Do not include markdown fences or commentary.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.25,
      response_format: { type: 'json_object' }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'OpenAI request failed.');
  return payload.choices?.[0]?.message?.content || '';
}

async function callGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
  const model = encodeURIComponent(process.env.GEMINI_MODEL || 'gemini-1.5-flash');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.25, responseMimeType: 'application/json' }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Gemini request failed.');
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
}

async function callClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: 'Return strict JSON only. Do not include markdown fences or commentary.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Anthropic request failed.');
  return (payload.content || []).map((part) => part.text || '').join('\n');
}

async function callModel(prompt) {
  const provider = resolveProvider();
  if (provider === 'openai') return { provider, text: await callOpenAI(prompt) };
  if (provider === 'gemini') return { provider, text: await callGemini(prompt) };
  if (provider === 'claude') return { provider, text: await callClaude(prompt) };
  throw new Error('No AI provider is configured. Set AI_PROVIDER and an API key in .env.');
}

function buildSurveyPrompt({ topic, description, audience, goal, transcript }) {
  const template = readTextFile(path.join(PROMPTS_DIR, 'survey-builder.md'));
  const skills = loadSkills('SURVEY_SKILLS', 'unbiased-wording,live-audience-polling,customer-discovery,tag-cloud-design');
  const secret = stripComments(readTextFile(path.join(SKILLS_DIR, 'secret-sauce.md')));
  return renderTemplate(template, {
    topic: topic || 'Not specified',
    description: description || 'Not specified',
    audience: audience || 'Not specified',
    goal: goal || 'Not specified',
    transcript: transcript || '',
    skills,
    secret
  });
}

function fallbackSurvey({ topic, description }) {
  const title = topic ? `${topic} Survey` : 'Live Feedback Survey';
  return {
    title,
    description: description || 'A short live survey created from your prompt.',
    questions: [
      { type: 'single_choice', question: 'How would you rate your overall experience?', options: ['Excellent', 'Good', 'Fair', 'Poor'], rationale: 'Measures overall sentiment.' },
      { type: 'tag_cloud', question: 'What is one word that best describes your reaction?', options: [], rationale: 'Creates a fast audience signal.' },
      { type: 'multi_select', question: 'What should we focus on next?', options: ['Speed', 'Quality', 'Cost', 'Communication', 'Follow-up'], rationale: 'Identifies priority areas.' }
    ],
    suggestedActivationMode: 'one_at_a_time',
    qualityChecks: { neutralWording: true, shortEnoughForMobile: true, noDoubleBarreledQuestions: true },
    fallback: true
  };
}

async function generateSurveyDraft(input) {
  const prompt = buildSurveyPrompt(input);
  try {
    const { provider, text } = await callModel(prompt);
    const parsed = safeJsonFromText(text);
    return { provider, parsed };
  } catch (error) {
    console.warn('[ai:fallbackSurvey]', error.message);
    return { provider: 'fallback', parsed: fallbackSurvey(input) };
  }
}

function buildAnalysisPrompt({ survey, questions, results }) {
  const template = readTextFile(path.join(PROMPTS_DIR, 'results-analysis.md'));
  const skills = loadSkills('ANALYSIS_SKILLS', 'unbiased-wording,tag-cloud-design');
  return renderTemplate(template, {
    survey: JSON.stringify(survey || {}, null, 2),
    questions: JSON.stringify(questions || [], null, 2),
    results: JSON.stringify(results || {}, null, 2),
    skills
  });
}

async function analyzeResults(input) {
  const prompt = buildAnalysisPrompt(input);
  try {
    const { provider, text } = await callModel(prompt);
    return { provider, parsed: safeJsonFromText(text) };
  } catch (error) {
    console.warn('[ai:fallbackAnalysis]', error.message);
    return {
      provider: 'fallback',
      parsed: {
        executiveSummary: 'AI provider is not configured, so a basic analysis was generated. Review the charts and raw responses for details.',
        highlights: [],
        risks: [],
        suggestedFollowUps: []
      }
    };
  }
}

function tagCloudFromTexts(texts) {
  const stop = new Set('the,a,an,and,or,but,if,of,to,in,on,for,with,at,by,is,are,was,were,be,been,it,this,that,these,those,i,we,you,they,our,my,your,very,more,most,less,not,none,n/a,na'.split(','));
  const counts = new Map();
  for (const text of texts || []) {
    const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (word.length < 3 || stop.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([text, count]) => ({ text, count }));
}

module.exports = { generateSurveyDraft, analyzeResults, tagCloudFromTexts, safeJsonFromText, resolveProvider };
