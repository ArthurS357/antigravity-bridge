# Timeouts

Há dois lados: o **servidor** (a ponte e o `agy`) e o **cliente** (Claude Code). O primeiro limite a vencer encerra a chamada.

## Tabela

| Limite | Valor | Faixa / ajuste | Quem decide |
|---|---|---|---|
| Padrão do servidor | **600 s** (10 min) | `AGY_TIMEOUT_MS` no registro do MCP: `10000`–`3600000`. Fora da faixa, vazio ou não numérico → volta ao padrão com aviso no stderr | Usuário, no `claude mcp add` (vale após reiniciar) |
| Por chamada | omitido = `AGY_TIMEOUT_MS` | `timeout_ms`: `10000`–`3600000` (10 s–1 h). Fora da faixa → `InvalidParams` **antes** de spawnar | **Você**, a cada chamada |
| Backstop do Node | timeout + 10 s | fixo | Ponte. A folga deixa o `agy` emitir o envelope com o `conversation_id` |
| Retomada automática | `min(timeout, 60 s)` | só com `AGY_RESUME_ON_TIMEOUT=true` | Ponte |
| `resume_conversation` | `AGY_TIMEOUT_MS` | `timeout_ms` da própria chamada (sem teto de 60 s) | Você |
| Total do cliente (`tools/call`) | 100.000.000 ms (≈ **27,8 h**) | `timeout` no registro ou `MCP_TOOL_TIMEOUT` | Irrelevante: muito acima de 1 h |
| Ociosidade do cliente | **30 min** sem resposta nem progresso, checado a cada 30 s | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (`0` desliga) | Neutralizado pelo heartbeat (abaixo) |
| Auto-background do cliente | 120 s, atrás de feature flag | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | Não é corte: a chamada vira tarefa em background |

## Heartbeat

Durante a chamada, a ponte envia `notifications/progress` na hora e depois a cada 30 s ("agy em execução há Ns (limite Ms)"). Cada notificação zera o relógio de ociosidade do cliente, e é isso que permite `timeout_ms` acima de 30 min. O progresso mede o **relógio**, não o trabalho do `agy`.

## O que está medido e o que é inferência

- **Medido** (Claude Code 2.1.286): chamadas reais de 45 s, 137 s, 317 s e **516 s** voltaram sem corte (app desktop, 2026-10-02).
- **Medido com o harness `test/measure.mjs`** (2026-10-03, dublê do `agy` dormindo 1900 s): **com heartbeat** completou em 1908 s, com 64 notificações a cada 30 s; **sem heartbeat** o cliente cortou aos 1810 s com `sent no response or progress for 1800s`. Portanto `timeout_ms` acima de 30 min funciona **por causa do heartbeat**.
- **Sem medição**: o efeito de `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`. Versões do cliente sem o timeout de ociosidade (por exemplo o `claude` 2.1.186 do npm) nunca cortam chamadas silenciosas.

## Qual usar

| Situação | Faça |
|---|---|
| Tarefa típica (análise de alguns arquivos, um relatório) | Omita `timeout_ms` (600 s) |
| Tarefa sabidamente longa (varredura de repo grande, refatoração ampla) | `timeout_ms` entre `1200000` e `1800000` |
| Teste rápido / sonda | `timeout_ms: 60000` (o `agy` leva ~10 s só para subir, então não desça disso) |
| Precisa de mais de 30 min | Prefira dividir em chamadas menores. Se não der, `timeout_ms` até `3600000` (comprovado até 1908 s, com heartbeat) |
| Timeout já aconteceu uma vez | Repita com `timeout_ms` maior (≈ 2× o anterior) **antes** de pensar em `resume_conversation` |

Lembre que cada chamada **bloqueia** o agente que a fez pelo tempo inteiro. Um `timeout_ms` alto não custa nada se a tarefa terminar cedo, mas uma tarefa travada prende o turno até o limite.
