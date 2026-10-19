// AI providers. Pick one in .env with AI_PROVIDER=ollama (free, runs on your own computer)
// or AI_PROVIDER=anthropic (Claude API, paid, most accurate).
//
// Both expose the same small interface used by agent.js:
//   start(system, history)                  -> state
//   step(state, tools, { allowTools })      -> { text, calls: [{ id, name, input }] }
//   addToolResults(state, results)          -> void   results: [{ id, name, content, isError }]
//   structured({ system, user, schema, name }) -> object matching schema

import Anthropic from '@anthropic-ai/sdk';

export function providerName() {
  return (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama')).toLowerCase();
}

export function getProvider() {
  return providerName() === 'anthropic' ? anthropicProvider : ollamaProvider;
}

// ---------------------------------------------------------------- Anthropic (Claude)
let anthropicClient;
const claude = () => (anthropicClient ||= new Anthropic());
const CLAUDE_MODEL = () => process.env.MODEL || 'claude-opus-5-5';
const CLAUDE_VERIFY_MODEL = () => process.env.VERIFY_MODEL || process.env.MODEL || 'claude-opus-5-5';

const anthropicProvider = {
  name: 'anthropic',
  model: () => CLAUDE_MODEL(),
  maxToolChars: 60000,
  ready: () => !!process.env.ANTHROPIC_API_KEY,
  start(system, history) {
    return { system, messages: history.map((m) => ({ role: m.role, content: m.content })) };
  },
  async step(state, tools, { allowTools }) {
    const res = await claude().messages.create({
      model: CLAUDE_MODEL(),
      max_tokens: 8000,
      system: state.system,
      tools,
      tool_choice: allowTools ? { type: 'auto' } : { type: 'none' },
      messages: state.messages,
    });
    state.messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, calls: res.stop_reason === 'tool_use' ? calls : [] };
  },
  addToolResults(state, results) {
    state.messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
    });
  },
  async structured({ system, user, schema, name }) {
    const res = await claude().messages.create({
      model: CLAUDE_VERIFY_MODEL(),
      max_tokens: 10000,
      system,
      tools: [{ name, description: 'Submit the result.', input_schema: schema }],
      tool_choice: { type: 'tool', name },
      messages: [{ role: 'user', content: user }],
    });
    const call = res.content.find((b) => b.type === 'tool_use');
    if (!call) throw new Error('No structured result');
    return call.input;
  },
};

// ---------------------------------------------------------------- Ollama (local, free)
const OLLAMA_URL = () => (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || 'gemma4:12b';
const OLLAMA_VERIFY_MODEL = () => process.env.OLLAMA_VERIFY_MODEL || OLLAMA_MODEL();
const NUM_CTX = () => Number(process.env.OLLAMA_NUM_CTX || 16384);

async function ollamaChat(body) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: false, keep_alive: '30m', ...body, options: { num_ctx: NUM_CTX(), temperature: 0.2, ...(body.options || {}) } }),
      signal: AbortSignal.timeout(10 * 60 * 1000), // local models can be slow
    });
  } catch (e) {
    throw new Error(`Cannot reach Ollama at ${OLLAMA_URL()}. Is the Ollama app running?`);
  }
  if (!res.ok) {
    const t = await res.text();
    if (/not found/i.test(t)) throw new Error(`Ollama model "${body.model}" is not downloaded. Run: ollama pull ${body.model}`);
    throw new Error(`Ollama error ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

const toOllamaTools = (tools) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// ":cloud" models run on Ollama's servers, which would break the "nothing leaves your computer" promise.
if (/(:|-)cloud$/.test(process.env.OLLAMA_MODEL || '')) {
  console.warn('⚠ OLLAMA_MODEL is a cloud model: conversations will leave this computer. Use a local model instead.');
}

const ollamaProvider = {
  name: 'ollama',
  model: () => OLLAMA_MODEL(),
  maxToolChars: 12000, // smaller context window than Claude
  ready: () => true,
  start(system, history) {
    return { messages: [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))] };
  },
  async step(state, tools, { allowTools }) {
    const data = await ollamaChat({
      model: OLLAMA_MODEL(),
      messages: state.messages,
      ...(allowTools ? { tools: toOllamaTools(tools) } : {}),
    });
    const msg = data.message || {};
    state.messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    const calls = (msg.tool_calls || []).map((c, i) => {
      let input = c.function?.arguments ?? {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
      return { id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name, input };
    });
    return { text: (msg.content || '').trim(), calls: allowTools ? calls : [] };
  },
  addToolResults(state, results) {
    for (const r of results) {
      state.messages.push({ role: 'tool', tool_name: r.name, content: r.isError ? `ERROR: ${r.content}` : r.content });
    }
  },
  async structured({ system, user, schema }) {
    const data = await ollamaChat({
      model: OLLAMA_VERIFY_MODEL(),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      format: schema, // Ollama structured outputs: reply must match this JSON schema
    });
    const raw = data.message?.content || '';
    try {
      return JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Verifier did not return valid JSON');
    }
  },
};
