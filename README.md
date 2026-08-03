# Allo Finanças API

Backend do Allo Finanças para pagamentos, importação de faturas, Allofy, AlloPoints, notificações push e administração segura do Firebase Authentication.

## Execução

```bash
npm install
npm start
```

O serviço exige as credenciais do Firebase Admin e a chave da OpenAI. Consulte `.env.example` e configure os segredos no ambiente de hospedagem, sem adicioná-los ao repositório.

## Configuração no Render

Configure as variáveis abaixo no painel **Environment** do serviço:

- `GOOGLE_CREDENTIALS`: JSON completo da conta de serviço do Firebase
- `OPENAI_API_KEY`: chave secreta criada no projeto da OpenAI
- `OPENAI_MODEL`: `gpt-5.6-luna`
- `ALLOWED_ORIGINS`: `https://allofinancas.com,https://www.allofinancas.com`
- `ALLOFY_DAILY_LIMIT`: limite diário por usuário (padrão: `20`)
- `AI_MINUTE_LIMIT`: proteção contra muitas solicitações seguidas (padrão: `8`)

Nunca coloque `OPENAI_API_KEY` no código do site ou no GitHub. Depois de atualizar o repositório do backend, faça um novo deploy no Render antes de publicar o frontend.

## Rotas principais

- `GET /health` — saúde da API
- `GET /pricing` — preços dos planos
- `POST /create-payment` e `POST /create-payment-pix` — pagamentos
- `POST /webhook-mp` — retorno do Mercado Pago
- `POST /import-pdf` — importação estruturada de fatura
- `POST /ai-analysis` — análise financeira e importações por texto/imagem
- `POST /allofy-chat` — assistente financeiro com ferramentas de consulta
- `GET /allofy-history` — histórico autenticado do Allofy
- `DELETE /allofy-history` — apaga o histórico do usuário
- `GET /admin/health` — saúde da integração administrativa
- `GET /admin/users` — metadados reais das contas do Firebase Authentication
- `GET /admin/users/:uid` — identidade e acesso de uma conta
- `POST /admin/users/:uid/action` — bloquear, revogar sessões, verificar e-mail, atualizar ou excluir conta

Todas as rotas de inteligência artificial e `/admin/*` exigem um token Firebase válido. O Allofy deriva o usuário do token, nunca de um identificador enviado pelo navegador. As rotas de IA também aplicam limites por minuto e por dia no servidor.

O Allofy usa a Responses API da OpenAI com o modelo configurado em `OPENAI_MODEL`, histórico salvo no Firebase e ferramentas de leitura para consultar transações, contas, cartões, metas, dívidas, cofres e o módulo motorista. Ele não altera dados financeiros autonomamente.

O nome público da API permanece independente do domínio atual de hospedagem, preservando a compatibilidade com o aplicativo.
