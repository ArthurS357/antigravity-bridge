# Plano: empacotar o Antigravity Bridge como plugin do Claude Code

Estado: **protótipo validado em pasta temporária; nada foi alterado no projeto** além de `skills/`, `LICENSE`, `.gitignore` e metadados do `package.json`. Medido com o Claude Code 2.1.286.

## Estrutura final proposta

A raiz do repositório é, ao mesmo tempo, o pacote npm, o plugin e o marketplace:

```
antigravity-bridge/
├── .claude-plugin/
│   ├── plugin.json         # manifesto + mcpServers inline
│   └── marketplace.json    # marketplace de um plugin só (source "./")
├── skills/antigravity-delegate/   # já está aqui: fonte da verdade da skill
├── dist/server.mjs         # bundle esbuild (~746 KB), COMMITADO
├── src/ lib/ service/ module/     # código-fonte (inalterado)
├── test/  package.json  README.md  LICENSE
```

`plugin.json` (o que foi testado):

```json
{
  "name": "antigravity-bridge",
  "version": "1.9.0",
  "description": "Delega tarefas autocontidas ao Antigravity (agy) via MCP, com a skill que ensina quando e como delegar.",
  "license": "MIT",
  "mcpServers": {
    "antigravity-bridge": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"] }
  }
}
```

## Decisões e motivos

1. **Código dentro do plugin, como bundle.** O servidor importa `@modelcontextprotocol/sdk` e `zod`, e nada garante que a instalação do plugin rode `npm install` (premissa não testada, ver "O que ainda falta"). O bundle (`esbuild --bundle --platform=node --format=esm`) **roda sem `node_modules` e sem `src/`**: testado numa pasta sem nenhum dos dois, handshake e `tools/list` normais. Alternativas descartadas: commitar `node_modules` (59 MB) e depender de um hook de `npm install` (corre contra o startup do servidor). Custo: `dist/` vira artefato versionado e o README ("nada é compilado") precisa de uma ressalva.
2. **`mcpServers` inline no `plugin.json`, não em `.mcp.json` na raiz.** Funciona (testado). Um `.mcp.json` na raiz também seria lido como configuração de *projeto* por quem abrir o repositório no Claude Code, onde `${CLAUDE_PLUGIN_ROOT}` não existe. Usar `${CLAUDE_PLUGIN_ROOT}` é obrigatório: `./src/…` seria relativo ao diretório de trabalho, não ao plugin.
3. **Skill dentro do plugin.** Já está em `skills/antigravity-delegate/`. Como plugin ela aparece como `/antigravity-bridge:antigravity-delegate`. O `SKILL.md` já cita os dois prefixos de ferramenta.
4. **Distribuição: marketplace próprio no mesmo repositório** (`marketplace.json` validado). Submissão ao diretório oficial fica para depois, quando houver uso real.
5. **`agy` é pré-requisito do usuário.** Um plugin não instala o Antigravity CLI. O README já diz isso em "Requisitos"; sem o `agy` a ferramenta se anuncia `INDISPONÍVEL`.

## O que muda para quem já usa a ponte (medido)

- **Nome das ferramentas muda:** `mcp__antigravity-bridge__run_antigravity_task` (registro por `claude mcp add`) vira `mcp__plugin_antigravity-bridge_antigravity-bridge__run_antigravity_task`. Entradas de `permissions.allow` com o nome antigo **não casam**, e voltam os pedidos de confirmação.
- **Registro duplo:** com o servidor de usuário e o do plugin ativos, as duas famílias de ferramentas aparecem ao mesmo tempo (observado). Migração: `claude mcp remove antigravity-bridge -s user` antes de instalar o plugin.
- **Variáveis de ambiente:** o plugin não define nenhuma. `AGY_SKIP_PERMISSIONS=true` continua opt-in e **não** deve ir embutido no manifesto.

## Pré-requisitos para o usuário final

Node.js ≥ 22.18.0 (o bundle é ESM para Node 22), `agy` no `PATH` e autenticado, Claude Code com suporte a plugins.

## Passos para publicar

1. ~~Preencher `author`, `repository` e o titular do `LICENSE`~~ (feito: TR57). Falta `owner.name` do marketplace (`TR57`) quando o `marketplace.json` for criado.
2. Adicionar `npm run build:plugin` (esbuild como devDependency) e commitar `dist/server.mjs`; um teste que reconstrói e compara evita bundle velho.
3. Criar `.claude-plugin/plugin.json` e `marketplace.json` na raiz e sincronizar `version` com o `package.json` (hoje são dois lugares).
4. `claude plugin validate .` (passou no protótipo, com o aviso de `author`).
5. Publicar no GitHub, depois no Claude Code: `/plugin marketplace add ArthurS357/antigravity-bridge` e `/plugin install antigravity-bridge@antigravity-marketplace`.
6. Instalar de verdade numa conta limpa e repetir: servidor conecta, as duas ferramentas listam, a skill aparece.

## O que ainda falta

- **Instalação via marketplace não foi testada** (só `--plugin-dir`), para não alterar a configuração do usuário.
- **Configuração de `AGY_*` no plugin:** testar `userConfig` (`claude plugin configure`) ou `env` do `settings.json` para `AGY_TIMEOUT_MS`, `AGY_RESUME_ON_TIMEOUT` e `AGY_SKIP_PERMISSIONS`; não verificado.
- **`npm audit fix`:** 4 vulnerabilidades em dependências de produção (`fast-uri` alta; `hono`, `ip-address`, `qs` moderadas), todas transitivas do SDK e de transportes HTTP que o servidor stdio não usa; correção disponível, mas altera o lockfile e não foi aplicada.
- **CI:** `npm test`, `tsc --noEmit`, `plugin validate` e a checagem de `dist/` atualizado.
- **Placeholders:** autor/titular (`TR57`) e URL do repositório preenchidos; resta `owner.name` no `marketplace.json`, ainda não criado.
