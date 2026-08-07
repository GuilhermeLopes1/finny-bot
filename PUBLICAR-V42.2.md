# Publicação rápida — FinnyBot V42.2

## O que esta versão corrige

Evita que uma **nova compra/resassinatura** herde para sempre um `linkedPurchaseToken` que ficou historicamente associado ao UID errado.

A regra nova é:

- token atual já vinculado a outro UID → **bloqueia**;
- restauração antiga/compra já reconhecida tentando trocar de UID → **bloqueia**;
- token novo, ainda não reconhecido e criado recentemente → o UID Firebase autenticado no checkout pode assumir o **novo token**, mesmo que o token histórico esteja divergente;
- o token histórico é marcado como substituído e deixa de conceder Pro ao UID antigo;
- RTDN não herda automaticamente UID de registros legados sem `ownershipVersion: 2`.

## Publicar no GitHub

1. Faça backup do repositório atual do FinnyBot.
2. Extraia este ZIP.
3. Substitua o conteúdo do repositório do backend pelos arquivos desta pasta.
4. Não envie `.env`, JSON de conta de serviço ou outras credenciais ao GitHub.
5. Commit sugerido: `Correção vínculo Google Play V42.2`.
6. Push para a branch usada pelo Render.

## Render

Nenhuma nova variável é obrigatória.

Confirme que continuam configuradas:

```text
GOOGLE_PLAY_CREDENTIALS
GOOGLE_PLAY_PACKAGE_NAME=com.allofinancas
GOOGLE_PLAY_PRODUCT_MONTHLY=allofy_pro_monthly
GOOGLE_PLAY_PRODUCT_YEARLY=allofy_pro_yearly
CRON_SECRET
```

Opcionalmente, você pode configurar:

```text
GOOGLE_PLAY_FRESH_PURCHASE_WINDOW_MINUTES=30
```

Sem essa variável, o padrão já é 30 minutos.

Depois faça `Deploy latest commit`.

## Teste

1. Entre em uma conta Allofy de teste.
2. Faça uma compra nova ou resassinatura pela Google Play.
3. O Render deve registrar `POST /google-play/verify-subscription` com HTTP 200.
4. O documento do novo token em `google_play_purchases` deve conter:
   - `uid` da conta autenticada;
   - `ownershipVersion: 2`;
   - `ownershipSource`;
   - `ownerUidHash`;
   - `ownershipVerifiedAt`.
5. Se houver um histórico antigo divergente, o log mostrará um aviso de vínculo histórico e o token antigo será marcado com `supersededByPurchaseTokenHash`.
6. Feche e abra o app para confirmar que o Pro persiste.

## Importante

Não é necessário gerar outro AAB para esta V42.2. A alteração é somente no backend.
