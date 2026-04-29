function mapCategory(category, type) {
  if (!category) return 'outros';

  const map = {
    uber: 'transporte',
    gasolina: 'transporte',
    mercado: 'alimentacao',
    ifood: 'alimentacao',
    aluguel: 'moradia'
  };

  return map[category] || category;
}

module.exports = { mapCategory };
