const Anthropic = require('@anthropic-ai/sdk');

async function handleAllofyChat(req, res) {
  try {
    const { system, messages } = req.body;
    if(!messages || !messages.length) {
      return res.status(400).json({ error: 'Mensagens inválidas' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: system || 'Você é o Allofy, uma IA financeira pessoal.',
      messages: messages
    });

    const reply = response.content?.[0]?.text || 'Não consegui processar sua pergunta.';
    res.json({ reply });
  } catch(e) {
    console.error('Allofy chat error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { handleAllofyChat };
