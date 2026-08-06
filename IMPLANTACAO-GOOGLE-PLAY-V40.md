# Implantação do backend V40 — Google Play

## 1. Render

Atualize o repositório do FinnyBot e configure as variáveis de `.env.example` no serviço.

Obrigatórias para faturamento:

```text
GOOGLE_PLAY_CREDENTIALS={JSON_COMPLETO_DA_CONTA_DE_SERVICO}
GOOGLE_PLAY_PACKAGE_NAME=com.allofinancas
GOOGLE_PLAY_PRODUCT_MONTHLY=allofy_pro_monthly
GOOGLE_PLAY_PRODUCT_YEARLY=allofy_pro_yearly
GOOGLE_PLAY_RTDN_AUDIENCE=https://finny-bot.onrender.com/google-play/rtdn
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT=CONTA-RDTN@PROJETO.iam.gserviceaccount.com
CRON_SECRET=SEGREDO_LONGO_E_ALEATORIO
```

Faça um deploy com limpeza de cache. O comando continua:

```bash
npm start
```

## 2. Google Play Developer API

1. Ative a Google Play Android Developer API no projeto Google Cloud escolhido.
2. Crie ou selecione uma conta de serviço.
3. Dê acesso dessa conta ao aplicativo no Play Console, incluindo a permissão necessária para consultar pedidos/assinaturas e dados financeiros.
4. Coloque o JSON da conta em `GOOGLE_PLAY_CREDENTIALS` no Render.

## 3. Produtos de assinatura

Crie dois produtos de assinatura com IDs exatamente iguais aos abaixo:

```text
allofy_pro_monthly
allofy_pro_yearly
```

Estrutura recomendada para esta implementação:

- `allofy_pro_monthly`: um plano básico autorrenovável mensal.
- `allofy_pro_yearly`: um plano básico autorrenovável anual.

Ative preço, disponibilidade no Brasil e os planos básicos. Os preços mostrados no aplicativo serão os preços localizados retornados pela Google Play.

## 4. RTDN e Pub/Sub

1. Crie um tópico Pub/Sub.
2. No tópico, adicione `google-play-developer-notifications@system.gserviceaccount.com` como **Pub/Sub Publisher**.
3. Informe o nome completo do tópico na configuração de notificações da monetização no Play Console.
4. Crie uma assinatura **push** para:

```text
https://finny-bot.onrender.com/google-play/rtdn
```

5. Marque a autenticação da assinatura push e escolha uma conta de serviço própria.
6. Use como audience exatamente a mesma URL do endpoint.
7. Coloque o e-mail dessa conta em `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT`.
8. Garanta que o agente de serviço do Pub/Sub possa gerar o token OIDC para essa conta (`Service Account Token Creator`).

O endpoint rejeita notificações sem token válido, e-mail esperado ou audience correto.

## 5. Regras do Firestore

Publique `firestore_rules.txt` (mesmo conteúdo do `firestore.rules` do frontend). As regras bloqueiam o cliente nas coleções internas; o Firebase Admin SDK continua tendo acesso.

## 6. Teste

- Use uma faixa de teste interno.
- Adicione a conta também em **testadores de licença**, não apenas na lista da faixa.
- Instale o aplicativo pelo link oficial da faixa de teste.
- Confirme compra mensal, compra anual, restauração, cancelamento, renovação e expiração.
- Confira os logs do Render e os documentos internos criados no Firestore.

## 7. Ordem de publicação

1. Backend V40 no Render.
2. Variáveis Google Play e deploy bem-sucedido.
3. Regras do Firestore V40.
4. Frontend V40.
5. TWA/Bubblewrap com Play Billing habilitado.
6. Novo `.aab` na faixa de teste interno.
7. Produtos e RTDN configurados.
8. Teste completo antes da produção.
