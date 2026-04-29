const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const { handleWebhook } = require('./controllers/webhookController');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('🚀 FinnyBot online');
});

app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
});
