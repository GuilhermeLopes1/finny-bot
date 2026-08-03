# Implantação do Allofy com OpenAI Luna

## 1. Atualize primeiro o backend

Suba **todo o conteúdo deste projeto** para o repositório do FinnyBot. O `package.json`, o `package-lock.json`, a pasta `src` e a pasta `test` fazem parte da atualização.

No Render, confirme as variáveis:

```text
OPENAI_API_KEY=<chave configurada diretamente no Render>
OPENAI_MODEL=gpt-5.6-luna
OPENAI_TIMEOUT_MS=45000
ALLOWED_ORIGINS=https://allofinancas.com,https://www.allofinancas.com
ALLOFY_DAILY_LIMIT=20
AI_DAILY_LIMIT=40
AI_MINUTE_LIMIT=8
```

Mantenha também as variáveis já usadas pelo Firebase, Mercado Pago e notificações. Não coloque chaves reais no GitHub.

Depois do deploy, abra `https://finny-bot.onrender.com/health` e confirme que a API responde.

## 2. Atualize o aplicativo

Somente depois de o backend estar publicado, suba **todo o conteúdo do ZIP do Allo Finanças** para o repositório do site. O service worker mudou de versão e atualizará o cache dos usuários.

## 3. Teste com uma conta Pro

1. Entre no aplicativo.
2. Abra o Allofy e pergunte “quanto gastei este mês?”.
3. Feche e abra o aplicativo e confirme que o histórico permanece.
4. Peça “lembre que minha prioridade é quitar dívidas” e confirme em outra mensagem.
5. Importe uma fatura de teste e confira cada valor e data antes de salvar.
6. Use o botão de lixeira do Allofy e confirme que o histórico é apagado.

## Observação

O Allofy consulta dados, mas não cria, altera nem apaga transações sozinho. Essa limitação evita alterações financeiras sem confirmação do usuário.
