# Changelog V40 — Backend Google Play

## Removido

- Rotas de criação de pagamento por Mercado Pago.
- Pagamento PIX.
- Cancelamento externo pelo backend antigo.
- Webhook do Mercado Pago e seu utilitário de validação.
- Variáveis de ambiente do Mercado Pago.

## Adicionado

- Verificação de assinatura com `purchases.subscriptionsv2.get`.
- Reconhecimento de compra no servidor.
- Associação única de `purchaseToken` a UID.
- Armazenamento interno de tokens para reconciliação e RTDN.
- Endpoint RTDN com validação OIDC de audience e conta de serviço.
- Idempotência por `messageId` nas notificações.
- Reconciliação periódica e endpoint protegido por `CRON_SECRET`.
- Suporte a `linkedPurchaseToken` e `expiredPurchaseToken`.
- Seleção do token ativo com maior validade para evitar regressão de plano.
- Separação de validades Google Play, manual, prêmio, indicação e legado.
- Campos Google Play na resposta paginada do painel Admin.
- Ações administrativas de concessão, extensão e revogação manual com recomposição segura das demais fontes Pro.

## Segurança

- Verificação de compra exige token Firebase.
- Produto precisa pertencer à lista configurada no servidor.
- Compra já vinculada não pode ser transferida para outro usuário.
- Coleções internas Google Play bloqueadas pelas regras do Firestore.
- Cancelamento e reembolso de assinatura Google Play não são simulados pelo frontend.

## Testes

- 46 testes automatizados do backend.
- Casos específicos de Google Play, rotas externas removidas, reconhecimento, seleção de token, regras e preservação de validade.
