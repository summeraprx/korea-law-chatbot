import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answer } from './agent.js';
import { getProvider } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- very small per-IP rate limit (replace with a real one in production) ---
const hits = new Map();
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 30);
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT;
}

app.get('/api/health', (req, res) => {
  const ai = getProvider();
  res.json({ ok: true, provider: ai.name, model: ai.model(), aiReady: ai.ready(), lawOc: !!process.env.LAW_OC });
});

// Server-Sent Events over POST: streams progress, then the checked answer.
app.post('/api/chat', async (req, res) => {
  const { messages, lang, mode } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return res.status(400).json({ error: 'messages must be a non-empty array (max 40).' });
  }
  const history = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }))
    // merge consecutive messages from the same role (e.g. two assistant turns after a case sheet)
    .reduce((acc, m) => {
      const last = acc[acc.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else acc.push({ ...m });
      return acc;
    }, []);
  while (history.length && history[0].role !== 'user') history.shift();
  const isSummary = mode === 'summary';
  if (history.length === 0 || (!isSummary && history[history.length - 1].role !== 'user')) {
    return res.status(400).json({ error: 'The last message must be from the user.' });
  }
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many questions this hour. Please try again later.' });
  if (!getProvider().ready()) return res.status(503).json({ error: 'Server is missing ANTHROPIC_API_KEY (or set AI_PROVIDER=ollama).' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    const result = await answer({
      history,
      lang: typeof lang === 'string' ? lang.slice(0, 200) : 'auto',
      mode: mode === 'summary' ? 'summary' : 'chat',
      onEvent: send,
    });
    send('answer', result);
  } catch (e) {
    console.error(e);
    const msg = e?.status === 401 ? 'The AI service rejected the API key.'
      : /Ollama/.test(e?.message || '') ? e.message
      : 'Something went wrong while preparing the answer. Please try again.';
    send('error', { error: msg });
  } finally {
    clearInterval(ping);
    res.end();
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Korea Law Helper running at http://localhost:${port}`);
  const ai = getProvider();
  console.log(`AI: ${ai.name} (${ai.model()})`);
  if (!ai.ready()) console.warn('⚠ ANTHROPIC_API_KEY is not set (.env)');
  if (!process.env.LAW_OC) console.warn('⚠ LAW_OC is not set (.env) — law lookups will fail');
});
