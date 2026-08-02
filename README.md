# Allo Finanças API

Backend do Allo Finanças para pagamentos, importação de faturas, Allofy, AlloPoints e notificações push.

## Execução

```bash
npm install
npm start
```

O serviço exige as credenciais do Firebase Admin e as chaves dos provedores usados em produção. Consulte `.env.example` e configure os segredos no ambiente de hospedagem, sem adicioná-los ao repositório.

## Rotas principais

- `GET /health` — saúde da API
- `GET /pricing` — preços dos planos
- `POST /create-payment` e `POST /create-payment-pix` — pagamentos
- `POST /webhook-mp` — retorno do Mercado Pago
- `POST /import-pdf` — importação de fatura
- `POST /ai-analysis` — análise financeira
- `POST /allofy-chat` — assistente financeiro por texto

As integrações de mensageria e áudio foram removidas. O nome público da API permanece independente do domínio atual de hospedagem, preservando a compatibilidade com o aplicativo.
