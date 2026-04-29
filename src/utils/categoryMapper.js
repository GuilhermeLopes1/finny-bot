const categoryMap = {
  transporte: [
    'uber', '99', 'taxi', 'gasolina', 'combustivel', 'onibus'
  ],
  alimentacao: [
    'ifood', 'lanche', 'mercado', 'restaurante', 'comida', 'pizza'
  ],
  moradia: [
    'aluguel', 'luz', 'agua', 'internet'
  ],
  lazer: [
    'netflix', 'cinema', 'jogo', 'spotify'
  ],
  saude: [
    'farmacia', 'remedio', 'medico'
  ],
  renda: [
    'salario', 'freela', 'pagamento', 'pix'
  ]
};

function mapCategory(text, type) {
  text = text.toLowerCase();

  for (const [category, keywords] of Object.entries(categoryMap)) {
    if (keywords.some(k => text.includes(k))) {
      return category;
    }
  }

  return type === 'income' ? 'renda' : 'outros';
}

module.exports = { mapCategory };