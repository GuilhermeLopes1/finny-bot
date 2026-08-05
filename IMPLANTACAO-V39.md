# Implantação do FinnyBot V39

## 1. Backup

Preserve a versão atual do Render e exporte o Firestore antes da implantação.

## 2. Variáveis do Render

Use o arquivo `.env.example` como lista de referência. Revise especialmente:

- `GOOGLE_CREDENTIALS`
- `PUBLIC_API_URL`
- `ALLOWED_ORIGINS`
- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- limites de uso da IA
- chaves VAPID
- `CRON_SECRET`

## 3. Publicação

1. Publique este backend.
2. Valide o endpoint de saúde.
3. Teste que rotas protegidas retornam 401 sem token.
4. Publique `firestore_rules.txt` no Firebase.
5. Publique o frontend V39.

## 4. Mercado Pago

Configure o webhook para:

```text
https://SEU-SERVICO.onrender.com/webhook-mp
```

Use exatamente o mesmo segredo em `MP_WEBHOOK_SECRET`. Teste assinatura, PIX, cancelamento e repetição de evento com credenciais de teste antes da produção.

## 5. Ranking

A apuração do mês anterior é retomada periodicamente, portanto não depende de uma única execução no dia 1. Verifique os logs após a primeira inicialização e confirme o documento idempotente de apuração.

## 6. Testes locais

```bash
npm test
node --check src/server.js
```

## 7. Observação de migração

O backend consegue hidratar perfis antigos e V39. Ao gravar novas transações pelo FinnyBot, realiza a migração segura quando necessário e passa a usar `users/{uid}/transactions`.
