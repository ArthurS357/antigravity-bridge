# Plano: empacotar o Antigravity Bridge como plugin do Claude Code

Estado: **implementado no repositório em 2026-10-03** (`.claude-plugin/`, `dist/server.mjs`, `npm run build:plugin`, `test/plugin.test.mjs`). Validado com o Claude Code 2.1.186, a versão que `claude --version` mostrou nessa data. A versão 2.1.286 citada antes neste plano e no README não confere com a instalada e não foi revista.

## Estrutura final

A raiz do repositório é, ao mesmo tempo, o pacote npm, o plugin e o marketplace:

```
antigravity-bridge/
├── .claude-plugin/
│   ├── plugin.json         # manifesto + mcpServers inline
│   └── marketplace.json    # marketplace de um plugin só (source "./")
├── skills/antigravity-delegate/   # fonte da verdade da skill
├── dist/server.mjs         # bundle esbuild (~746 KB), COMMITADO; .gitattributes o marca -text
├── src/ lib/ service/ module/     # código-fonte (inalterado)
├── test/  package.json  README.md  LICENSE  .gitattributes
```

`plugin.json`:

```json
{
  "name": "antigravity-bridge",
  "version": "1.9.0",
  "description": "Delega tarefas autocontidas ao Antigravity (agy) via MCP, com a skill que ensina quando e como delegar.",
  "author": { "name": "ArthurS357" },
  "license": "MIT",
  "mcpServers": {
    "antigravity-bridge": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"] }
  }
}
```

(O arquivo real também traz `homepage`, `repository` e `keywords`.)

## Decisões e motivos

1. **Código dentro do plugin, como bundle.** O servidor importa `@modelcontextprotocol/sdk` e `zod`, e nada garante que a instalação do plugin rode `npm install`. O bundle (`esbuild src/index.ts --bundle --platform=node --format=esm --target=node22.18`) **roda sem `node_modules` e sem `src/`**. Isso foi testado copiando só o `server.mjs` para uma pasta vazia: handshake e `tools/list` normais. Sem source map e sem `--define`, então as `AGY_*` continuam sendo lidas em tempo de execução. Alternativas descartadas: commitar `node_modules` (59 MB) e depender de um hook de `npm install`, que concorre com o startup do servidor. Custo: `dist/` vira artefato versionado. O `.gitattributes` o marca `-text` para o `core.autocrlf` não trocar as quebras de linha.
2. **`mcpServers` inline no `plugin.json`, não em `.mcp.json` na raiz.** Funciona (testado). Um `.mcp.json` na raiz também seria lido como configuração de *projeto* por quem abrir o repositório no Claude Code, onde `${CLAUDE_PLUGIN_ROOT}` não existe. Usar `${CLAUDE_PLUGIN_ROOT}` é obrigatório: `./src/…` seria relativo ao diretório de trabalho, não ao plugin.
3. **Skill dentro do plugin.** Está em `skills/antigravity-delegate/` e, no plugin, aparece como `antigravity-bridge:antigravity-delegate`. O `SKILL.md` cita os dois prefixos de ferramenta.
4. **Distribuição: marketplace próprio no mesmo repositório**, chamado `antigravity-bridge`. A entrada do plugin não repete `version`: a fonte é o `plugin.json`, e o teste o amarra ao `package.json`. A submissão ao diretório oficial fica para quando houver uso real.
5. **`agy` é pré-requisito do usuário.** Um plugin não instala o Antigravity CLI. Sem o `agy`, a ferramenta se anuncia `INDISPONÍVEL`.
6. **`AGY_*` pelo ambiente, sem `env` no manifesto.** O servidor do plugin herda o ambiente do Claude Code, então basta o bloco `env` do `~/.claude/settings.json` ou uma variável do sistema. As duas vias foram medidas: com `--settings`, `AGY_TIMEOUT_MS=124000` e `AGY_RESUME_ON_TIMEOUT=true` chegaram ao servidor do plugin; com variável de processo, `AGY_TIMEOUT_MS=123000` também chegou. `userConfig` foi descartado: dá mais trabalho e faz perguntas na instalação, sem ganho sobre o `env`. Um `env` no manifesto também foi descartado, porque embutiria defaults que o usuário teria de contornar.

## O que muda para quem já usa a ponte (medido)

- **Nome das ferramentas muda:** `mcp__antigravity-bridge__run_antigravity_task` (registro por `claude mcp add`) vira `mcp__plugin_antigravity-bridge_antigravity-bridge__run_antigravity_task`. Entradas de `permissions.allow` com o nome antigo **não casam**, e voltam os pedidos de confirmação.
- **Registro duplo:** com o servidor de usuário e o do plugin ativos, as duas famílias de ferramentas aparecem ao mesmo tempo. Migração: `claude mcp remove antigravity-bridge -s user` antes de instalar o plugin.
- **Skill duplicada:** com a cópia em `~/.claude/skills/` e o plugin ativos, aparecem `antigravity-delegate` e `antigravity-bridge:antigravity-delegate`.
- **Variáveis de ambiente:** o `env` do registro de usuário não passa para o plugin. `AGY_SKIP_PERMISSIONS=true` continua opt-in e **não** vai embutido no manifesto.

## Pré-requisitos para o usuário final

Node.js ≥ 22.18.0 (o bundle é ESM para Node 22), `agy` no `PATH` e autenticado, Claude Code com suporte a plugins.

## Passos para publicar

1. ~~Preencher `author`, `repository`, titular do `LICENSE` e `owner.name` do marketplace~~ (feito: ArthurS357).
2. ~~Adicionar `npm run build:plugin` (esbuild como devDependency), commitar `dist/server.mjs` e criar o teste que reconstrói e compara~~ (feito: `test/plugin.test.mjs`, que também confere a versão do `plugin.json`).
3. ~~Criar `.claude-plugin/plugin.json` e `marketplace.json`~~ (feito).
4. ~~`claude plugin validate`~~ (feito: marketplace e plugin passam sem avisos).
5. ~~Teste local com `--plugin-dir`~~ (feito: as duas ferramentas listam com o novo prefixo, a skill aparece como `antigravity-bridge:antigravity-delegate`, e uma chamada real devolveu `ok`). O registro de usuário foi removido só durante o teste e restaurado em seguida.
6. ~~Publicar no GitHub~~ (feito: `github.com/ArthurS357/antigravity-bridge`; os commits do catálogo e deste plano ainda aguardam push). Depois: `/plugin marketplace add ArthurS357/antigravity-bridge` e `/plugin install antigravity-bridge@antigravity-bridge`.
7. Instalar de verdade numa conta limpa e repetir as checagens: o servidor conecta, as duas ferramentas listam e a skill aparece.

## O que ainda falta

- **Instalação via marketplace não foi testada** (só `--plugin-dir`): depende do push dos commits pendentes e da validação pós-reinício do servidor de usuário.
- **CI ainda não existe:** `tsc --noEmit`, `npm test` (inclui a checagem de `dist/` e o isolamento do log) e `claude plugin validate`.
- **Versão em dois lugares** (`package.json` e `plugin.json`): o teste pega divergência, mas o bump continua manual.
- ~~**Catálogo de modelos** desatualizado (`claude-*-4-6` aposentados, `claude-*-5-5-*` novos)~~ (feito em 2026-10-03, contra `agy models` do 1.2.16).
- ~~**`gpt-oss-120b` base** não exposta~~ (feito em 2026-10-03: base com `effort` opcional, só `medium`).
- ~~**Testes gravando no log real**~~ (feito: `ANTIGRAVITY_LOG_DIR` aponta a suíte para `test/.generated/logs`).
