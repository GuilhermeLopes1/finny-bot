# FinnyBot V42 — Google Play Billing

## Correções

- `GOOGLE_PLAY_CREDENTIALS` passou a ser obrigatória e exclusiva para a Play Developer API.
- Removido o fallback perigoso para `GOOGLE_CREDENTIALS`, que pertence ao Firebase Admin.
- Validação estrutural da conta de serviço antes de chamar a Google.
- Erros de permissão `401/403` agora retornam `google_play_permission_pending` com HTTP 503 e `retryable: true`.
- Respostas para compra ausente, autenticação e indisponibilidade receberam códigos estáveis.
- Logs registram somente o hash abreviado do token, nunca o purchase token completo.
- `.env.example` atualizado e referências antigas ao Mercado Pago removidas.

## Variáveis obrigatórias no Render

```text
GOOGLE_PLAY_CREDENTIALS
GOOGLE_PLAY_PACKAGE_NAME=com.allofinancas
GOOGLE_PLAY_PRODUCT_MONTHLY=allofy_pro_monthly
GOOGLE_PLAY_PRODUCT_YEARLY=allofy_pro_yearly
CRON_SECRET
```
