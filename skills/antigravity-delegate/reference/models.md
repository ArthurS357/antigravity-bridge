# Modelos e esforço (`model` / `effort`)

Fonte: `service/model-catalog.ts` do Antigravity Bridge v1.9.0, verificado contra `agy models` no agy 1.2.5. Toda combinação inválida é **rejeitada localmente, sem spawnar o `agy`** (erro instantâneo e gratuito). Valor fora do enum vira `InvalidParams` do SDK.

## Os 18 valores aceitos em `model`

### 14 slugs completos (esforço já embutido — **não passe `effort`**)

| Família | Slugs |
|---|---|
| Gemini 3.8 Flash | `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low` |
| Gemini 3.7 Flash | `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low` |
| Gemini 3.6 Flash | `gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low` |
| Gemini 3.1 Pro | `gemini-3.1-pro-high`, `gemini-3.1-pro-low` (não existe `-medium`) |
| Claude | `claude-sonnet-4-6`, `claude-opus-4-6-thinking` |
| GPT | `gpt-oss-120b-medium` |

### 4 nomes base (**exigem `effort`**)

| Nome base | `effort` aceito |
|---|---|
| `gemini-3.8-flash` | `low`, `medium`, `high` |
| `gemini-3.7-flash` | `low`, `medium`, `high` |
| `gemini-3.6-flash` | `low`, `medium`, `high` |
| `gemini-3.1-pro` | `low`, `high` — **sem `medium`** |

## Regras de `effort`

1. **Sem `model`**: `effort` sozinho é válido e se aplica ao modelo default do IDE.
2. **Nome base**: `effort` obrigatório, dentro da lista da tabela acima.
3. **Slug completo Gemini** (`…-high/-medium/-low`): `effort` proibido, porque o esforço já está no nome.
4. **Claude e GPT** (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`): não suportam `effort`.

## Exemplos

| Chamada | Resultado |
|---|---|
| `{}` (nenhum dos dois) | ✅ default do IDE |
| `{"effort":"low"}` | ✅ default do IDE com esforço baixo |
| `{"model":"gemini-3.8-flash-high"}` | ✅ |
| `{"model":"gemini-3.8-flash","effort":"medium"}` | ✅ equivale a `gemini-3.8-flash-medium` |
| `{"model":"gemini-3.1-pro","effort":"high"}` | ✅ |
| `{"model":"claude-sonnet-4-6"}` | ✅ |
| `{"model":"gemini-3.8-flash"}` | ❌ exige `effort` (o erro sugere o slug `gemini-3.8-flash-high`) |
| `{"model":"gemini-3.1-pro","effort":"medium"}` | ❌ 3.1 Pro só aceita `low`/`high` |
| `{"model":"gemini-3.8-flash-high","effort":"low"}` | ❌ conflito: o slug já embute o esforço |
| `{"model":"claude-sonnet-4-6","effort":"high"}` | ❌ modelo não suporta `effort` |
| `{"model":"gemini-3.5-flash-high"}` | ❌ fora do enum (família 3.5 aposentada no agy 1.2.5) |

## Como escolher

- **Sem preferência do usuário**: omita `model`. O default do IDE é o caminho mais barato de manter.
- **Tarefa mecânica e volumosa** (inventário, agregação de logs, extração): Flash `-low` ou `-medium`.
- **Raciocínio difícil** (arquitetura, bug sutil, segunda opinião): `gemini-3.1-pro-high` ou `claude-opus-4-6-thinking`.
- **Cotas separadas**: `gemini-*`, `claude-*` e `gpt-*` consomem cotas distintas no Antigravity. Se uma família estourar a cota, troque de família.

## Drift do catálogo

O enum é estático e o `agy` se autoatualiza. No startup a ponte compara o enum com `agy models` e avisa no stderr (`modelos novos no agy ainda não listados no enum` / `modelos do enum que o agy não reporta mais`). Um slug que o `agy` deixou de conhecer custa uma ida e volta para ouvir "is not recognized as a known model". Nesse caso, omita `model` e avise o usuário.
