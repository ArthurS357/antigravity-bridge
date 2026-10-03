# Antigravity Bridge (MCP Server)

Servidor MCP em Node.js/TypeScript para integrar o Claude Code à CLI headless do Google Antigravity (`agy`).

## O que é (e o que não é)

A ponte é um **delegador**: ela repassa um prompt autocontido ao `agy`, que roda **em outro processo**, com contexto próprio, num diretório neutro e vazio, **sem acesso à conversa do Claude nem ao editor**. O `agy` só sabe o que o prompt disser. Ela **não** é um inspetor do IDE Antigravity: não lê o estado do editor, não abre arquivos nele e não mantém sessão entre chamadas. Cada chamada é independente e **bloqueia** até o `agy` terminar ou estourar o tempo.

Serve para tarefas longas ou volumosas que cabem inteiras num prompt (varredura de codebase, relatório longo, segunda opinião), preservando o contexto do orquestrador.

## Requisitos

- **Node.js ≥ 22.18.0**: o servidor roda direto de `src/index.ts`, com type stripping nativo, sem etapa de build.
- **`agy` (CLI do Antigravity) no `PATH`**, já autenticado. Testado com o `agy` 1.2.16. Confira com `agy --version`; sem ele a ferramenta se anuncia como `INDISPONÍVEL`. A ponte não instala o `agy`.
- **Claude Code** (ou outro cliente MCP stdio). O comportamento de timeout descrito abaixo foi medido no Claude Code 2.1.286.

## Instalação

```bash
git clone https://github.com/ArthurS357/antigravity-bridge.git antigravity-bridge
cd antigravity-bridge
npm install
npm link        # expõe o comando global `antigravity-mcp`
claude mcp add antigravity-bridge -s user -- antigravity-mcp
```

Sem `npm link`, registre o caminho absoluto: `claude mcp add antigravity-bridge -s user -- node /caminho/para/antigravity-bridge/src/index.ts`. Reinicie o Claude Code depois de registrar. As variáveis de ambiente e as opções de registro estão em [Variáveis de Ambiente](#variáveis-de-ambiente) e nos [exemplos de registro](#exemplos-de-registro-claude-mcp-add).

A skill [`antigravity-delegate`](skills/antigravity-delegate/SKILL.md) ensina o orquestrador a usar a ponte (quando delegar, modelo, timeout, retomada). Ela vive no repositório e **não** é instalada pelo `claude mcp add`; copie-a para `~/.claude/skills/`:

```bash
cp -r skills/antigravity-delegate ~/.claude/skills/
```

### Como plugin

O repositório também é um plugin do Claude Code (e um marketplace de um plugin só). O plugin traz o servidor e a skill juntos, sem `npm install`: o servidor roda de `dist/server.mjs`, um bundle esbuild autocontido (~746 KB, sem `node_modules`).

```
/plugin marketplace add ArthurS357/antigravity-bridge
/plugin install antigravity-bridge@antigravity-bridge
```

Para testar a partir de um clone, sem instalar: `claude --plugin-dir /caminho/para/antigravity-bridge`.

Requisitos iguais aos de cima: Node.js ≥ 22.18.0 e `agy` no `PATH`, autenticado.

**Variáveis `AGY_*`.** O manifesto não define nenhuma; o servidor herda o ambiente do Claude Code. Defina-as no bloco `env` do `~/.claude/settings.json` (ou no ambiente do sistema):

```json
{ "env": { "AGY_TIMEOUT_MS": "600000", "AGY_SKIP_PERMISSIONS": "true" } }
```

Medido: com `AGY_TIMEOUT_MS` e `AGY_RESUME_ON_TIMEOUT` no `env` das configurações, o servidor do plugin anunciou o timeout e a retomada configurados. `AGY_SKIP_PERMISSIONS` segue opt-in e não vem ligado; leia o [alerta de segurança](#️-alerta-de-segurança-prompt-injection) antes de ligar. O `env` das configurações vale para todo processo que o Claude Code inicia, não só para este servidor.

**Migrando do servidor de usuário para o plugin:**

- Os nomes das ferramentas mudam: `mcp__antigravity-bridge__*` vira `mcp__plugin_antigravity-bridge_antigravity-bridge__*`. Entradas de `permissions.allow` com o nome antigo não valem para o plugin.
- Com os dois ativos, as duas famílias de ferramentas aparecem ao mesmo tempo. Remova o registro de usuário antes: `claude mcp remove antigravity-bridge -s user`.
- A skill do plugin aparece como `antigravity-bridge:antigravity-delegate`. Se você copiou a skill para `~/.claude/skills/`, as duas aparecem; apague a cópia.
- O `env` do registro de usuário (`claude mcp add --env ...`) não passa para o plugin. Mova os valores para o `settings.json`.

**Mantenedores:** depois de mudar o código, rode `npm run build:plugin` e commite `dist/server.mjs`. O `npm test` falha se o bundle estiver desatualizado ou se a versão do `.claude-plugin/plugin.json` divergir da do `package.json`.

## Ferramentas

| Ferramenta | Parâmetros | O que faz |
|---|---|---|
| `run_antigravity_task` | `prompt` (obrigatório), `context_files`, `model`, `effort`, `timeout_ms`, `json_output`, `json_schema` | Executa a tarefa no `agy` e devolve a resposta final. |
| `resume_conversation` | `conversation_id` (obrigatório), `timeout_ms`, `json_output` | Recupera a resposta que uma conversa já **concluiu**. Não continua um turno cortado. |

Use **caminhos absolutos** no prompt e em `context_files`: o `agy` não roda no seu projeto.

### Modelos e `effort`

`model` aceita 25 valores: 18 slugs completos, com o esforço já embutido (`gemini-3.8-flash-high`, `gemini-3.1-pro-low`, `claude-opus-5-5-high`, `claude-sonnet-5-5-medium`, `gpt-oss-120b-medium`, …), e 7 nomes base (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b`). Catálogo verificado contra `agy models` no agy 1.2.16 em 2026-10-03, quando os `claude-*-4-6` foram aposentados. Regras:

- Sem `model`: vale o default do IDE, e `effort` sozinho (`low`/`medium`/`high`) se aplica a ele.
- **Nome base** exige `effort`; o `gemini-3.1-pro` só aceita `low` e `high`. Exceção: `gpt-oss-120b` roda sem `effort` e só aceita `medium`.
- **Slug completo** não aceita `effort`, porque o esforço já está no nome (vale também para `gpt-oss-120b-medium`).
- Combinação inválida é rejeitada localmente, antes de spawnar o `agy` (sem custo).

A lista completa e exemplos válidos e inválidos estão em [`skills/antigravity-delegate/reference/models.md`](skills/antigravity-delegate/reference/models.md).

## Skills do `agy`

Medido com o `agy` 1.2.16 (Windows), chamando o binário real, direto e pela ponte:

- **As skills carregam em modo headless**, inclusive com `--disable-slash-commands`, que a ponte passa (na chamada principal e nas duas retomadas) sempre que a sondagem de capacidades detecta a flag, e via `run_antigravity_task`. O teste usou duas skills de sonda com uma palavra-código que só existia no corpo do `SKILL.md`: o `agy` listou as skills e devolveu a palavra, numa chamada direta e pela ponte.
- **`--disable-slash-commands` não esconde skills.** Ele desliga a expansão de `/comando` no prompt. Um `/nome-da-skill` literal no prompt foi atendido igual com e sem a flag, porque o modelo acha a skill pelo nome. O efeito exato da flag sobre comandos de usuário não foi isolado, mas ela não é inerte: com ela, o `agy` avisa que `--mode plan has no effect`. A retomada passa a flag também, para rodar com o mesmo conjunto de flags da chamada original.
- **Onde ele procura:** `~/.gemini/config/skills/` (global; no ambiente de desenvolvimento, um link simbólico para `~/.claude/skills/`), `.agents/skills/` do workspace (subindo a partir do cwd) e as skills embutidas. `~/.gemini/skills/` **não** é lido: skills que existiam só ali ficaram invisíveis. O formato é `skills/<nome>/SKILL.md` com `name` e `description` no frontmatter; só nome e descrição entram no contexto, e o corpo é lido quando o modelo ativa a skill. Se `~/.gemini/config/skills` for um link para `~/.claude/skills`, as skills do Claude Code chegam ao `agy` (no ambiente testado chegam, e ele enxergava ~182 skills).
- **Retomada** (`--conversation`): as skills também estão disponíveis. Uma skill nunca lida na conversa original foi ativada corretamente após a retomada.
- **Skills do projeto não chegam por padrão.** O `agy` roda num cwd neutro (ver `AGY_CWD`), então o `.agents/skills/` do seu projeto fica fora da busca (comportamento documentado pelo `agy`, não testado aqui). Contorno: cite a skill pelo nome no prompt e use caminhos absolutos, ou aponte `AGY_CWD` para o projeto, ciente de que `GEMINI.md`, `AGENTS.md` e as regras dele passam a entrar em toda tarefa.
- **Custo:** um prompt de uma linha consome ~28–34k tokens de entrada no `agy`. Parte disso é o índice de skills (name e description de cada uma); a proporção não foi medida.

Nenhuma flag nova foi necessária.

## Log de atividade e privacidade

A ponte grava **o prompt enviado e a resposta recebida** em `~/.mcp-servers/antigravity-bridge/mcp-activity.log` (rotacionado em `mcp-activity.log.1` aos 5 MiB). O diretório fica na sua pasta pessoal e independe de onde o código está instalado (`ANTIGRAVITY_LOG_DIR` o sobrepõe; a suíte de testes usa isso para gravar em `test/.generated/logs/`), e o arquivo cresce com o conteúdo das suas tarefas: **não o publique nem o anexe a issues sem revisar**. O `.gitignore` do repositório já o exclui.

## Arquitetura

O código é organizado em quatro camadas. As dependências fluem numa direção só — `module/` → `service/` → `src/` — com `lib/` disponível para todas. A única exceção é `src/index.ts`, que é a raiz de composição e por isso enxerga todo mundo.

| Arquivo | Responsabilidade |
|---|---|
| `src/index.ts` | Ponto de entrada. Registra as duas tools MCP e conecta o transporte stdio. |
| `src/config.ts` | Lê e valida `AGY_TIMEOUT_MS` (10000–3600000), `AGY_RESUME_ON_TIMEOUT`, `AGY_SKIP_PERMISSIONS`; monta o orçamento de cada chamada (`--print-timeout` + backstop do Node) e o teto da retomada automática. |
| `src/constants.ts` | Constantes puras: timeouts, buffers, caminhos de log, nomes das env vars, flags sondadas. |
| `src/types.ts` | Vocabulário de tipos compartilhado (envelope, capabilities, erros) e seus type guards. |
| `src/args-builder.ts` | Monta o prompt enriquecido e o argv de cada chamada, garantindo a forma `--flag=valor`. |
| `src/logger.ts` | stderr padronizado e log de atividade com rotação por tamanho. |
| `src/result.ts` | Fábrica do resultado MCP, compartilhada entre o schema e os caminhos de erro. |
| `lib/process-runner.ts` | **Único** ponto do código que spawna processo. `execFile` com array de argumentos, sem shell, `windowsHide`, `maxBuffer` e `AbortSignal`. |
| `service/capabilities.ts` | Detecção de capabilities (F-11), sondagem de flags e mensagem de binário indisponível. |
| `service/model-catalog.ts` | Catálogo de modelos, regras de esforço, `buildModelArgs` e os avisos de inconsistência/drift. |
| `service/envelope.ts` | Parsing do envelope JSON, desempacotamento da resposta e formatação do `usage`. |
| `service/timeout-resume.ts` | Detecção de timeout, extração do `conversation_id`, a retomada única e o log de custo dela. |
| `service/failure-report.ts` | Classifica a falha (cancelamento e `maxBuffer` são terminais) e decide entre retomar ou reportar. |
| `module/schema.ts` | Contrato público das tools: títulos, descrições sensíveis às capabilities e `inputSchema` (inclui `timeout_ms`). |
| `module/antigravity-tool.ts` | A tool `run_antigravity_task`: valida contra as capabilities, spawna com o orçamento da chamada e traduz o envelope em resposta ou falha. |
| `module/resume-tool.ts` | A tool `resume_conversation`: retomada explícita por `conversation_id`, sem retomada automática encadeada. |
| `module/heartbeat.ts` | `notifications/progress` a cada 30 s durante uma chamada, para o cliente MCP não abortá-la por ociosidade. |

Nada é compilado: `package.json#bin` aponta direto para `src/index.ts` e o Node faz type stripping em tempo de carga (≥ 22.18). `tsc` é usado só como verificador (`npm run typecheck`), o que também é o motivo de os imports relativos carregarem a extensão `.ts` de verdade. A exceção é o plugin, que roda `dist/server.mjs`, um bundle gerado por `npm run build:plugin` e commitado (ver [Como plugin](#como-plugin)).

## ⚠️ Alerta de Segurança: Prompt Injection

Este servidor foi configurado para operar de forma autônoma (`headless`) utilizando a flag de delegação direta.
Quando a variável de ambiente `AGY_SKIP_PERMISSIONS=true` está ativa, a ferramenta **não pedirá confirmação** para executar ações locais.

**NUNCA** mantenha esta integração ativa com permissões ignoradas ao realizar auditorias em:
- Repositórios de terceiros recém-clonados.
- Arquivos de código de fontes não confiáveis.
- Conteúdos de web scraping ou documentações externas.

Textos maliciosos ingeridos pelo Claude podem ser repassados ao `agy` e executados silenciosamente com os privilégios do seu usuário atual.

Nenhum modo do `agy` (`--mode=plan`, `--mode=accept-edits`, `--sandbox`) impede a leitura de arquivos, e com skip ligado nenhum deles restringe nada. Por isso o bridge não oferece um parâmetro `mode`. Medição completa, modelo de ameaça e o incidente que motivou a auditoria estão em [SECURITY.md](SECURITY.md).

**Arquivos de config com segredo também vazam pelo orquestrador.** Um `cat` ou `Read` do Claude Code sobre, por exemplo, `~/.gemini/config/mcp_config.json` grava o conteúdo inteiro, chaves incluídas, no transcript da sessão. O bridge não tem como impedir isso; use regras `permissions.deny` no Claude Code e não guarde segredos em texto puro nesses arquivos.

## Comandos Operacionais

### 1. Desativar a ponte temporariamente (Auditoria de Código de Terceiros)
Remova o servidor antes de iniciar a sessão de análise de dados não confiáveis:
```bash
claude mcp remove antigravity-bridge -s user
```

### 2. Reativar em modo restrito (sem skip)
Em headless não há confirmação manual: comandos de terminal são **negados**, mas leitura e escrita de arquivos continuam conforme as permissões do `agy` (ver SECURITY.md).
```bash
claude mcp add antigravity-bridge -s user -- antigravity-mcp
```

### 3. Reativar em Modo Autônomo (Fluxo de trabalho local confiável)
```bash
claude mcp add antigravity-bridge -s user --env AGY_SKIP_PERMISSIONS=true -- antigravity-mcp
```

## Contrato de retorno

Um retorno de sucesso significa que a tarefa foi concluída. Qualquer outra coisa volta como `isError`, com o motivo e o `conversation_id` — **nunca como conteúdo parcial**.

Isso importa porque o `agy` sai com código 0 em execuções que não realizou. Verificado contra o agy 1.2.5, três formas distintas de falha chegam com `"status":"SUCCESS"`:

| Envelope observado | O que realmente aconteceu |
|---|---|
| `{"status":"SUCCESS","response":"","denied_actions":[{"action":"command"}]}` | Modo headless não consegue pedir confirmação, então *soft-denied* a ferramenta. A tarefa não rodou. |
| `{"status":"SUCCESS","response":""}` + stderr `print timeout after 3m0s` | Timeout. O `conversation_id` continua válido e a retomada automática o reconhece. |
| `{"status":"SUCCESS","response":""}` | Execução sem resposta. Resposta vazia é falha, não sucesso vazio. |
| `{"status":"SUCCESS","response":"<texto plausível>"}` + stderr `[agy] print timeout after 25s with turn in progress` | Timeout que cortou o turno **depois** de o modelo escrever prosa. O texto parcial é descartado: ele é indistinguível de uma resposta pronta no ponto de chamada. |

Por isso a checagem vive em `service/envelope.ts` (`evaluateEnvelope`) e é usada tanto pela chamada original quanto pela retomada: uma ferramenta que devolve resultado parcial com cara de sucesso ensina o orquestrador a desconfiar dela, o que é pior do que falhar alto.

### Permissões do `agy` em modo headless

O `agy` lê as permissões da CLI de **`~/.gemini/antigravity-cli/settings.json`** (não do `~/.gemini/settings.json`, que é o do IDE). Sem uma regra correspondente, o padrão `toolPermission=request-review` faz o modo print negar a ferramenta silenciosamente:

```json
{ "permissions": { "allow": ["read_file(*)"] } }
```

`read_file(*)` cobre leitura de arquivo e listagem de diretório, **inclusive arquivos de credencial** (`~/.ssh/`, configs de MCP com chave). A documentação embutida do `agy` desaconselha o curinga; prefira `read_file(/caminho/absoluto)` por diretório de trabalho. Regras `command(...)` exigem correspondência **exata** com a linha de comando gerada pelo modelo (`command(git *)` e `command(git)` não casam), o que torna a pré-aprovação de shell impraticável na prática — para isso use `AGY_SKIP_PERMISSIONS=true`, ciente do risco descrito acima.

## Variáveis de Ambiente

| Variável | Padrão | Efeito |
|---|---|---|
| `AGY_TIMEOUT_MS` | `600000` (10 min) | Tempo máximo de execução de uma tarefa. Alimenta o `--print-timeout` do próprio `agy`; o backstop do Node fica 10s acima (`AGY_TIMEOUT_MS + 10_000`), para que o `agy` sempre consiga emitir o envelope JSON antes de ser morto — é dele que sai o `conversation_id` usado na retomada. Aceita de `10000` a `3600000` (1 h); fora da faixa, não numérico ou vazio cai no padrão com aviso no stderr. Pode ser sobreposto por chamada com `timeout_ms`. |
| `AGY_RESUME_ON_TIMEOUT` | `false` (desligado) | Só `true` (case-insensitive) habilita a retomada automática após timeout. Veja a seção dedicada abaixo — **isso gasta tokens**. |
| `AGY_SKIP_PERMISSIONS` | (desligado) | Somente `true` ativa `--dangerously-skip-permissions`. Veja o alerta de segurança acima. Aplicado tanto na chamada original quanto numa eventual retomada. |
| `ANTIGRAVITY_LOG_DIR` | `~/.mcp-servers/antigravity-bridge` | Diretório do log de atividade. Existe para a suíte de testes não gravar no log real; vazio cai no padrão. |
| `AGY_CWD` | `%TEMP%/antigravity-bridge-cwd` | Diretório em que o `agy` é executado. O padrão é um diretório neutro e vazio: o `agy` descobre `GEMINI.md`, `AGENTS.md` e `.agents/rules/*.md` a partir do próprio cwd, então herdar o do cliente MCP faria o projeto onde o orquestrador estava entrar silenciosamente em toda tarefa delegada. Consequência: **caminhos relativos ao seu projeto não resolvem** — use caminhos absolutos no prompt e em `context_files`. As regras globais do usuário (`~/.gemini/GEMINI.md`) e as skills globais são carregadas independentemente do cwd e não são afetadas. |

O estado efetivo é impresso no startup:

```
[antigravity-bridge] timeout efetivo: 600000ms (--print-timeout=600s, backstop Node 610000ms, retomada 60000ms; faixa aceita 10000-3600000ms, também por chamada via timeout_ms) — padrão; ajuste com AGY_TIMEOUT_MS
[antigravity-bridge] retomada automática: desabilitada (use AGY_RESUME_ON_TIMEOUT=true para habilitar)
```

### Exemplos de registro (`claude mcp add`)

Timeout padrão (10 min), sem retomada automática — configuração mais barata, timeouts devolvem o `conversation_id` para retomada manual:
```bash
claude mcp add antigravity-bridge -s user -- antigravity-mcp
```

Retomada automática habilitada (o timeout já é de 10 minutos por padrão) — para tarefas longas onde perder o resultado por um timeout custa mais caro do que o turno extra da retomada. Veja o aviso de custo e de alcance na seção abaixo:
```bash
claude mcp add antigravity-bridge -s user --env AGY_RESUME_ON_TIMEOUT=true -- antigravity-mcp
```

Timeout padrão, sem retomada, modo autônomo (permissões ignoradas — ver alerta de segurança):
```bash
claude mcp add antigravity-bridge -s user --env AGY_SKIP_PERMISSIONS=true -- antigravity-mcp
```

## Timeout por chamada (`timeout_ms`)

`run_antigravity_task` e `resume_conversation` aceitam `timeout_ms` (inteiro, `10000`–`3600000`). Ele sobrepõe `AGY_TIMEOUT_MS` **só naquela chamada** — tanto o `--print-timeout` quanto o backstop do Node, que mantém a folga de 10s — e o stderr registra `timeout custom: 1200000ms (--print-timeout=1200s)`. Fora da faixa, o SDK rejeita a chamada com `InvalidParams` antes de spawnar qualquer coisa. O `agy` 1.2.15 aceita valores bem acima de 1 h (`--print-timeout=999999s`); o teto de 1 h é escolha da ponte.

## Timeout do cliente MCP (Claude Code)

O cliente também tem limites, e se um deles vencer antes do servidor o `agy` é morto sem devolver envelope (e sem `conversation_id`). Verificado no Claude Code **2.1.286** (lido do binário e medido no app desktop em 2026-10-02):

| Limite do cliente | Padrão (servidor stdio) | Como mudar | Efeito sobre esta ponte |
|---|---|---|---|
| Timeout total de `tools/call` | 100.000.000 ms (≈ 27,8 h) | `timeout` (ms) no registro do servidor, ou `MCP_TOOL_TIMEOUT` | Nenhum: muito acima de 1 h. |
| Timeout de **ociosidade** ("sem resposta nem progresso") | 1.800.000 ms (30 min), checado a cada 30 s | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (0 desliga), ou `timeout` no registro | Neutralizado pelo heartbeat abaixo. Sem ele, `timeout_ms` acima de ~30 min seria cortado pelo cliente. |
| Auto-background | 120 s, atrás de feature flag | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | Não é corte: a chamada vira tarefa em background. Não ocorreu nas medições. |

Medição: chamadas reais ao `agy` (com `Start-Sleep`) pelo app desktop voltaram com sucesso em 45 s, 137 s, 317 s e **516 s** de parede, sem cancelamento. No log de atividade, **nenhum** timeout real veio do cliente: os de ~124 s eram o antigo `--print-timeout=120s` fixo da ponte, e o de 604 s era o `AGY_TIMEOUT_MS=600000`.

O padrão de 600 s, portanto, fica abaixo de todos os limites do cliente e **não foi alterado**.

**Chamadas acima de 30 min: medido (2026-10-03).** O heartbeat é o que impede o corte por ociosidade. Mesmo cliente (Claude Code 2.1.286, `claude -p`), mesmo dublê do `agy` dormindo 1900 s, mudando só o heartbeat ([`test/measure.mjs`](test/measure.mjs)):

| Cenário | Heartbeat | Parede | Resultado |
|---|---|---|---|
| `t1900` | ligado | 1908,4 s | **Completou**: 64 notificações `notifications/progress` (aos 6 s, 36 s, … 1896 s), intervalo médio de 30,0 s, nenhum `notifications/cancelled` |
| `t1900nb` | desligado | 1809,9 s | **Cortado** pelo cliente no limite de 30 min, 0 notificações: `MCP server "agy" tool "run_antigravity_task" sent no response or progress for 1800s; aborting. …` |

Com `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=60000` e sono de 150 s o contraste se repete em ~2 min: sem heartbeat o corte vem aos ~68 s; com heartbeat a chamada completa (159,7 s, 6 notificações). O efeito de `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` continua **não medido**.

**Chamadas em série.** O Claude Code só executa em paralelo ferramentas MCP com `readOnlyHint: true`. Esta ponte não declara isso (o `agy` escreve arquivos), então várias chamadas no mesmo turno rodam **uma de cada vez**, e a espera total é a soma. Medido: 4 chamadas despachadas juntas levaram ~17 min, em sequência.

**Paralelismo via subagentes.** A serialização vale **por agente**. Chamadas feitas por subagentes diferentes (ferramenta `Agent` em background, uma chamada por subagente) rodam em paralelo de verdade: o servidor MCP é um só, e cada `tools/call` vira um processo `agy` próprio. Medido em 2026-10-03 no app desktop (Claude Code 2.1.286), com `Start-Sleep -Seconds 60` no `agy` e horários do log de atividade:

| Chamadas simultâneas | Despacho (1ª → última) | Duração de cada uma no servidor | Parede total (1º envio → último retorno) | Se fossem em série |
|---|---|---|---|---|
| 2 | 0,9 s | 75,6 s / 75,7 s | 83,6 s | ~151 s |
| 3 | 3,3 s | 74,7 s / 74,1 s / 74,7 s | 81,9 s | ~224 s |

Nenhuma chamada esperou pela outra. O custo, porém, não é pequeno: só para dormir, cada `agy` consumiu entre 38k e 107k tokens. A skill `antigravity-delegate` (em `~/.claude/skills/`) ensina esse padrão ao orquestrador.

### Heartbeat de progresso

Durante a chamada, as duas tools enviam `notifications/progress` (na hora e a cada 30 s) quando o cliente manda `progressToken`, o que o Claude Code sempre faz. Cada notificação zera o relógio de ociosidade do cliente e aparece na UI como `agy em execução há Ns (limite Ms)`. O heartbeat não estende nada além do backstop do próprio servidor (timeout + 10 s).

O progresso é do **relógio**, não do trabalho do `agy`: no modo `json` o `agy` não emite nada até o fim (só o `--output-format=stream-json` emite eventos), e adotar `stream-json` mudaria o contrato do envelope.

### Cancelamento vindo do cliente

Um `notifications/cancelled` do cliente vira `AbortSignal` no servidor, que encerra o `agy` e registra no stderr e no log de atividade: `Execução cancelada pelo cliente MCP após Nms (motivo do cliente: …); sem conversation_id (o agy só o emite ao terminar).`. O tempo decorrido separa um Esc do usuário (segundos) de um corte por timeout do cliente (minutos). No modo `json` o `conversation_id` só chega no fim, então uma chamada cortada no meio normalmente não tem id para retomar.

## Erro de timeout estruturado

Todo timeout que termina **sem** resposta recuperada volta como `isError` e carrega o mesmo corpo em `structuredContent` e como a última linha do texto (clientes que só exibem `content` ainda o recebem):

```json
{"error":"timeout","elapsed_ms":600123,"conversation_id":"d34121e7-9e45-40cf-a071-3376086f2fe0","resume_hint":"Use resume_conversation ou 'agy --conversation=d34121e7-9e45-40cf-a071-3376086f2fe0'"}
```

Sem `conversation_id` disponível o campo vem `null` e a dica manda repetir a tarefa com `timeout_ms` maior.

## `resume_conversation`

Retomada **explícita**, por `conversation_id` (UUID), separada da retomada automática: só roda quando o cliente chama. Executa `agy --conversation=<id> --print="Recupere a resposta final…" --output-format=json --print-timeout=<…>` e devolve o payload como a ferramenta principal. Parâmetros: `conversation_id` (obrigatório), `timeout_ms` e `json_output` (opcionais, mesmo comportamento da ferramenta principal).

- **Nunca encadeia retomadas**: se ela própria estourar o tempo, devolve o erro estruturado acima, mesmo com `AGY_RESUME_ON_TIMEOUT=true`.
- **Sem o teto de 60s** da retomada automática: aqui quem escolhe o orçamento é o chamador.
- **Alcance:** ela recupera o que o `agy` **concluiu**. Um turno cortado no meio pelo timeout não continua; num teste real (`timeout_ms=10000` numa tarefa grande) a retomada respondeu que nada havia sido produzido e custou ~33k tokens. Para tarefa longa, repetir com `timeout_ms` maior costuma ser melhor que retomar.

## Retomada automática após timeout

**Desligada por padrão** (`AGY_RESUME_ON_TIMEOUT=false`). Quando desligada, um timeout devolve o erro original com a instrução manual e **não spawna nenhum processo adicional**:

```
timeout após 302145ms; retome manualmente com: agy --conversation <id>
{"error":"timeout","elapsed_ms":302145,"conversation_id":"<id>","resume_hint":"…"}
```

Quando habilitada (`AGY_RESUME_ON_TIMEOUT=true`) e a execução estoura o tempo com um `conversation_id` disponível, a ponte faz **uma única** tentativa de retomada com `agy --conversation=<id> --print=...` (limitada a `min(timeout da chamada, 60s)`) e devolve a resposta recuperada como se a chamada original tivesse sucedido.

> ⚠️ **Custo:** a retomada é um **turno real do modelo** — ela não lê um cache, ela pede ao `agy` para reler a conversa e devolver a resposta final, o que aparece no `usage` do envelope como tokens normais. Habilite só se o custo de perder o resultado de uma tarefa longa for maior do que o custo de mais um turno.

Toda retomada que realmente executa e sucede tem o seu custo registrado, no stderr e no log de atividade:

```
[antigravity-bridge] retomada consumiu tokens: input=1234, output=567 (total=1801)
```

Campos que o `agy` não reportar aparecem como `?`, e o `total` é derivado das partes quando a CLI o omite. Se o envelope vier sem bloco `usage` algum, o registro vira `[antigravity-bridge] aviso: retomada sem dados de usage`. Nada disso é emitido quando a retomada está desabilitada, quando ela falha, ou numa chamada normal — só o gasto real é contabilizado.

Se a retomada (habilitada) falhar, o erro traz o motivo e a instrução manual:

```
timeout após 302145ms; tentativa de retomada falhou (motivo: ...). Retome manualmente com: agy --conversation <id>
```

Não há tentativa de retomada quando: `AGY_RESUME_ON_TIMEOUT` não é `true`, o cliente MCP cancelou a chamada, a saída estourou o `maxBuffer`, o erro não é de timeout, não há `conversation_id`, ou a versão do `agy` não expõe `--conversation`.

## Movendo o projeto

Mover a pasta do código **não** muda o registro do MCP se ele foi feito pelo nome do comando (`-- antigravity-mcp`), mas quebra o atalho global. O que fazer depois de mover:

1. **Refaça o `npm link`** na nova pasta (`cd <nova-pasta> && npm link`). O comando global `antigravity-mcp` é um atalho para a pasta antiga; se ela sumir, o servidor deixa de conectar. Confira com `npm ls -g --depth=0`: a linha de `antigravity-mcp-server` deve apontar para a nova pasta.
2. **Re-registre o MCP só se usou caminho absoluto** (`claude mcp add … -- node <caminho>/src/index.ts`): `claude mcp remove antigravity-bridge -s user` e adicione de novo com o caminho novo.
3. **`npm install`** na nova pasta, se `node_modules` não foi junto. Valide com `npm test`.
4. **Reinicie o Claude Code.** O servidor é lido no startup.

O que **não** muda: o log de atividade (em `~/.mcp-servers/antigravity-bridge/`, salvo `ANTIGRAVITY_LOG_DIR`), as variáveis de ambiente do registro e a skill instalada em `~/.claude/skills/`.

O que se perde: o Claude Code guarda o histórico de conversas e a confiança na pasta pelo **caminho do projeto**. Depois de mover, `claude -c` e a lista de conversas não mostram as sessões antigas, e a pasta nova pede confirmação de confiança de novo. O código e o registro do MCP não são afetados.

## Testes

Suíte completa em [`test/`](test/), rodando com o test runner nativo do Node:

```bash
npm test
```

Os testes sobem a ponte real (`src/index.ts` e os módulos que ela compõe) e falam com ela pelo protocolo MCP stdio de verdade (`initialize` → `tools/list` → `tools/call`); o único ponto substituído é o binário `agy`, trocado por um dublê em [`test/helpers/fake-agy.mjs`](test/helpers/fake-agy.mjs) cujo comportamento é controlado por variáveis de ambiente (`FAKE_MODE`, `FAKE_RESUME`, `FAKE_HELP_OMIT`, `FAKE_NO_CONVERSATION`, `FAKE_MODELS`).

Como `lib/process-runner.ts` é o único launcher, [`test/helpers/build-test-server.mjs`](test/helpers/build-test-server.mjs) copia a árvore de produção e reescreve **uma única linha** para apontar ao dublê — e falha ruidosamente se aquela linha sair do lugar, em vez de deixar os testes baterem no `agy` de verdade. O número de chamadores de `runAgy` (5) virou invariante verificada pela suíte.

Cobertura (130 casos):

- **Estrutura modular**: só `process-runner` importa `child_process`; `src/` não depende de `service/` nem de `module/`; nenhum módulo importa o entry point; todo import relativo carrega `.ts`; nenhum arquivo passa de 250 linhas.
- **Timeout configurável** (`AGY_TIMEOUT_MS`): padrão de 600000, customizado, os extremos 10000 e 3600000, valores inválidos (`abc`, `-5`, `0`, vazio, `9999`, `3600001`) e a folga de 10s do backstop.
- **`timeout_ms` por chamada**: sobrepõe só aquela chamada, log `timeout custom`, extremos aceitos, rejeição Zod de `9999`/`3600001`/negativo/não numérico sem spawnar, e o backstop do Node que acompanha o override.
- **Timeout estruturado**: `structuredContent` e JSON no texto, `conversation_id` `null`, timeout disfarçado de `SUCCESS`, retomada automática falha vs. sucesso, erro comum sem bloco.
- **`resume_conversation`**: `tools/list` com as duas ferramentas, execução e payload, `timeout_ms`/`json_output`, timeout sem retomada encadeada (com `AGY_RESUME_ON_TIMEOUT=true`), parcial descartado, UUID inválido, `--flag=valor`, `AGY_SKIP_PERMISSIONS`.
- **Heartbeat e cliente**: progresso imediato e a cada 30 s, crescente, que **para** quando a chamada termina; nada sem `progressToken`; limite anunciado segue o `timeout_ms`; token numérico; heartbeat na `resume_conversation`; cancelamento do cliente registrado com tempo e motivo; descrição sem promessa de paralelismo e sem `readOnlyHint`.
- **Construção de argumentos**: cada combinação de `model`/`effort` (slug canônico, nome base, effort sozinho, e as quatro combinações inválidas rejeitadas sem spawnar processo), `json_schema`, `json_output`, sanitização de `context_files` e prompt que se parece com uma flag.
- **Detecção de capabilities** (F-11): as seis flags sondadas incluindo `--conversation`, aviso de flag ausente, rejeição local de `json_schema`/`model`/`effort` não suportados, consistência do catálogo e aviso de drift.
- **`AGY_RESUME_ON_TIMEOUT`**: ausente/`false`/inválido → desabilitado; `true`/`TRUE` → habilitado; log de startup em ambos os casos.
- **Retomada automática**: sucesso nos três formatos de timeout observados na prática (envelope com exit 1, exit 0, e timeout só em stderr sem JSON), preservação de `--json-schema`, teto de 60s.
- **Log de custo da retomada**: `usage` completo, grafia alternativa `prompt`/`completion`, `usage` parcial, envelope sem `usage`, e os três casos em que nada deve ser registrado.
- **Retomada automática — falhas**: `not found`, resposta vazia, ausência de `conversation_id`, `agy` sem suporte a `--conversation`.
- **Falso positivo do stderr**: execução bem-sucedida cujo stderr cita `--print-timeout` (tarefa em background) e resposta que *cita* a linha de timeout — nenhuma das duas pode ser reprovada.
- **Contrato do envelope**: `denied_actions` com e sem texto, `SUCCESS` de resposta vazia, timeout disfarçado de `SUCCESS` (com e sem retomada habilitada), retomada negada, e `status` minúsculo que **não** pode reprovar uma execução boa.
- **cwd neutro do spawn**: `AGY_CWD` fixa o diretório do filho; sem ela o filho cai no diretório neutro e não herda o cwd do servidor.
- **Casos que não devem retomar**: erro comum, backstop do Node, estouro de `maxBuffer`, cancelamento MCP.
- **Premissas de segurança**: zero `shell:` em toda a árvore, gate de permissões num único ponto consultado pelas duas chamadas, e a forma `--flag=valor` verificada argumento a argumento numa chamada real com retomada.

### Medir o timeout do cliente (`test/measure.mjs`)

Fora do `npm test` (leva de segundos a ~32 min). Usa o **cliente real** (`claude -p`) contra a ponte de teste com o dublê do `agy` em `FAKE_MODE=sleep`, então custa poucos tokens do Claude e nenhum do `agy`. O tráfego passa por [`test/helpers/mcp-tap.mjs`](test/helpers/mcp-tap.mjs), que registra cada linha JSON-RPC com horário; dali saem os heartbeats, o `progressToken` enviado e qualquer `notifications/cancelled`.

```bash
export CLAUDE_BIN="$APPDATA/Claude/claude-code/<versão>/<hash>/claude.exe"   # build com o idle timeout
node test/measure.mjs t40:40                                   # valida: ≥1 heartbeat
node test/measure.mjs t1900:1900 t1900nb:1900:noheartbeat      # com e sem heartbeat
node test/measure.mjs idle:150:noheartbeat:CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=60000   # ~2 min
```

Cada cenário é `nome:segundos[:flag...]`, com `noheartbeat` (cópia de teste cujo heartbeat nunca envia; o código de produção não muda) ou `NOME=valor` (variável de ambiente do `claude`). `ANTIGRAVITY_DISABLE_HEARTBEAT=1` aplica `noheartbeat` a todos. Por cenário imprime parede, completou/cortou, nº de heartbeats e intervalo médio, `progressToken`, cancelamentos e a mensagem exata do corte; os logs brutos ficam em `test/.generated/measure-*` (ignorada pelo `.gitignore`). Ao terminar, o script apaga as pastas `measure-*` com mais de 7 dias; `--keep-logs` desliga a limpeza.

**Defina `CLAUDE_BIN`.** O harness só mede o idle em um cliente que o tenha:

- **2.1.286** (embutido no app desktop, em `%APPDATA%\Claude\claude-code\<versão>\<hash>\claude.exe`) **tem** o timeout de ociosidade e o corta no limite.
- **2.1.186** (o `claude` do npm, resolvido por padrão) **não tem** a string `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` no binário e nunca corta uma chamada silenciosa: com ele o controle sem heartbeat completou (sono de 150 s com idle de 60 s), o que invalida o controle sem avisar.

O `claude.cmd` do npm não pode ser executado por `spawn` do Node (`EINVAL`); o harness localiza o `claude.exe` por trás do shim.