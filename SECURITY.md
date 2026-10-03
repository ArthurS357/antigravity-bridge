# Segurança

## Modelo de ameaça

O Antigravity Bridge é um **delegador**: repassa um prompt à CLI `agy`, que roda como processo filho **com as permissões do seu usuário**. Não há sandbox. O bridge garante só o que está no código:

- `execFile` sem shell e toda flag com valor na forma `--flag=valor`, para que um prompt não injete flags no `agy` (incluindo `--dangerously-skip-permissions`);
- caracteres de controle removidos de `context_files`;
- `cwd` neutro e vazio, para que o projeto do orquestrador não vire contexto implícito.

O que o `agy` pode **fazer** depende das permissões dele, não do bridge. Medido com o `agy` 1.2.16 (Windows), com `read_file(*)` liberado em `~/.gemini/antigravity-cli/settings.json`:

| Configuração | Lê arquivo de credencial | Cria arquivo | Roda comando no terminal |
|---|---|---|---|
| padrão (sem skip) | sim | sim | negado |
| `--mode=accept-edits` | sim | sim | negado |
| `--mode=plan` **sem** `--disable-slash-commands` | sim | não | negado |
| `--mode=plan` + skip | sim | **sim** (o modelo disse que adiou, mas criou) | **sim** |
| `--sandbox` + skip | sim | sim | sim, inclusive ler arquivo fora do `cwd` |

Com `--disable-slash-commands`, que o bridge sempre passa, o `agy` avisa que `--mode plan has no effect`. **Nenhum modo do `agy` impede leitura de arquivos**, e com skip ligado nenhum deles restringe nada. Por isso o bridge não expõe um parâmetro `mode`: ele daria uma impressão de segurança que o `agy` não entrega.

### `AGY_SKIP_PERMISSIONS=true`

Faz o bridge passar `--dangerously-skip-permissions` em toda chamada e em toda retomada. Com isso:

- o `agy` executa comandos de terminal **sem confirmação**;
- **qualquer arquivo legível pelo seu usuário** pode ser lido, inclusive `~/.ssh/`, `~/.aws/credentials`, `~/.npmrc`, `~/.git-credentials` e configs de MCP com chave de API;
- texto malicioso que o orquestrador ingeriu (repositório de terceiros, página raspada, documentação externa, issue, PR) pode virar prompt do `agy` e ser executado em silêncio.

**Não use** ao trabalhar com código ou conteúdo que você não controla. Remova o servidor (`claude mcp remove antigravity-bridge -s user`) antes dessas sessões.

**Sem skip** o risco cai, mas não some: comandos são negados, mas leitura (com `read_file(*)`) e escrita de arquivos continuam funcionando.

A redução real de superfície fica nas permissões do próprio `agy`, em `~/.gemini/antigravity-cli/settings.json`:

- troque `read_file(*)` por diretórios específicos (`read_file(/caminho/absoluto)`); a documentação embutida do `agy` desaconselha o curinga;
- considere a política *Non-Workspace File Access* = `deny` (não testada junto com skip).

### Log de atividade

`~/.antigravity-bridge/logs/mcp-activity.log` (e `.1`; o diretório muda com `ANTIGRAVITY_LOG_DIR`) guarda **cada prompt e cada resposta em texto puro**. Se o `agy` ler uma credencial e citá-la, ela fica no log, e também na conversa do orquestrador. O `.gitignore` exclui o log. Não o anexe a issues sem revisar.

## Incidente de 2026-10-03: chave de API em log de sessão

**O que aconteceu.** Durante o desenvolvimento, uma sessão do Claude Code rodou `cat ~/.gemini/config/mcp_config.json` pela ferramenta **Bash** para inspecionar a configuração do `agy`. O arquivo guardava em texto puro uma chave de API do Stitch (argumento `--header X-Goog-Api-Key:…` do `mcp-remote`), e a saída inteira entrou no transcript da sessão, em `~/.claude/projects/<projeto>/<sessão>.jsonl`.

**Causa.** Ferramenta do orquestrador (Bash do Claude Code), não o bridge e não o `agy`. A varredura mostrou a chave apenas no próprio arquivo de config e nesse transcript: não está no log do bridge, nos dados do `agy`, em nenhum arquivo do repositório nem em diretório sincronizado com nuvem. O diretório não é versionado em git.

**O que fazer.**

1. **Rotacione a chave** no console do Google Cloud/Stitch. Apagar o transcript não desfaz o fato de ela ter sido enviada à API do modelo.
2. Depois de rotacionar, apague o transcript afetado se quiser. Cada sessão é um arquivo `.jsonl` independente, então dá para remover só ela.

**Como evitar a recorrência.**

- Não guarde segredos em texto puro em arquivos de config que agentes inspecionam. Se o cliente suportar, use referência a variável de ambiente do sistema (o `mcp-remote` expande `${VAR}` nos argumentos; confirme que o processo pai repassa o ambiente).
- Bloqueie a leitura desses arquivos pelos agentes. No Claude Code, regras `permissions.deny` em `~/.claude/settings.json`, por exemplo `Read(~/.gemini/config/mcp_config.json)`. Isso não cobre `cat` via Bash: para esse caminho, revise comandos que tocam configs antes de aprovar.
- ACLs de arquivo (`icacls`/`chmod`) **não protegem** contra este cenário: os agentes rodam como o seu próprio usuário.

## Dependências

`npm audit` em 2026-10-03: 4 vulnerabilidades (1 alta, 3 moderadas), **todas transitivas** via `@modelcontextprotocol/sdk@1.30.0`.

| Pacote | Severidade | Origem | Alcançável aqui? |
|---|---|---|---|
| Pacote | Severidade | Origem | Alcançável aqui? | Corrigido para |
|---|---|---|---|---|
| `hono` | moderada | transporte HTTP do SDK | Não: o servidor só importa `StdioServerTransport`. | 4.13.1 → 4.13.12 |
| `qs` | moderada | `express` (transporte HTTP) | Não, mesmo motivo. | 6.15.3 → 6.16.0 |
| `ip-address` | moderada | `express-rate-limit` (transporte HTTP) | Não, mesmo motivo. | 10.5.0 → 10.7.3 |
| `fast-uri` | alta | `ajv`, carregado pelo `server/index.js` do SDK | Improvável: os CVEs são de normalização de host/URI (SSRF, confusão de host); o `ajv` só valida schemas locais, sem buscar URIs. | 3.1.5 → 3.1.8 |

**Decisão:** corrigido com `npm audit fix` (sem `--force`). Só o `package-lock.json` mudou, dentro dos ranges já declarados; o `package.json` ficou intacto. Depois do fix: `npm audit` com 0 vulnerabilidades, `npm test` 131/131, `tsc --noEmit` limpo e handshake MCP real (`initialize` + `tools/list`) respondendo as duas ferramentas.

## Reportar uma vulnerabilidade

Use *Security → Report a vulnerability* no GitHub do repositório (aviso privado). Não abra issue pública com detalhes de exploração.
