# Allofy API V40 — Google Play Billing

Backend do Allofy para assinatura Pro pela Google Play, IA, importação de faturas, notificações, AlloPoints e administração segura.

## Execução

```bash
npm install
npm start
```

Node.js 18 ou superior.

## Variáveis principais

Consulte `.env.example`. Os segredos devem ficar no Render, nunca no frontend ou no GitHub.

- `GOOGLE_CREDENTIALS`: credencial do Firebase Admin.
- `GOOGLE_PLAY_CREDENTIALS`: conta de serviço com acesso à Google Play Developer API. Pode ser a mesma credencial, desde que tenha as permissões necessárias no Play Console.
- `GOOGLE_PLAY_PACKAGE_NAME`: `com.allofinancas`.
- `GOOGLE_PLAY_PRODUCT_MONTHLY`: `allofy_pro_monthly`.
- `GOOGLE_PLAY_PRODUCT_YEARLY`: `allofy_pro_yearly`.
- `GOOGLE_PLAY_RTDN_AUDIENCE`: URL exata do endpoint RTDN.
- `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT`: conta de serviço usada para assinar o push Pub/Sub.
- `CRON_SECRET`: segredo longo usado pela reconciliação protegida.

## Rotas Google Play

- `GET /google-play/config` — retorna pacote e IDs públicos dos produtos.
- `GET /google-play/status` — estado da assinatura do usuário autenticado.
- `POST /google-play/verify-subscription` — valida o `purchaseToken` na Google Play, registra a compra, reconhece a assinatura e recalcula o direito Pro.
- `POST /google-play/rtdn` — recebe notificações autenticadas do Pub/Sub.
- `POST /google-play/reconcile` — reconciliação protegida por `x-cron-secret`.

As rotas antigas de PIX e Mercado Pago não fazem parte da V40.

## Segurança da assinatura

- O UID vem do token Firebase autenticado.
- O navegador nunca decide se uma assinatura é válida.
- O backend usa `purchases.subscriptionsv2.get` como fonte do estado.
- Cada token fica vinculado a uma única conta.
- A compra é reconhecida no servidor.
- Tokens antigos não encurtam uma assinatura mais nova.
- Validades de prêmio, indicação, liberação manual e legado são preservadas separadamente.
- As coleções `google_play_purchases` e `google_play_rtdn_events` são inacessíveis pelo cliente.

## Outras rotas

As rotas de IA, importação, Allofy, AlloPoints, notificações e `/admin/*` permanecem no `src/server.js`. Rotas sensíveis exigem autenticação Firebase e as rotas administrativas exigem conta Admin.

## Implantação

Leia `IMPLANTACAO-GOOGLE-PLAY-V40.md` antes de publicar.
