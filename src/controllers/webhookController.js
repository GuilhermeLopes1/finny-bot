const { saveTransaction } = require('../services/firebaseService');

async function handleWebhook(req, res) {
  try {
    const message = req.body.Body || '';

    console.log("📩 Mensagem recebida:", message);

    // 🔥 Exemplo simples
    await saveTransaction("test-user", {
      type: "expense",
      amount: 10,
      description: message,
      category: "outros"
    });

    res.send("OK");
  } catch (e) {
    console.error(e);
    res.send("Erro");
  }
}

module.exports = { handleWebhook };
