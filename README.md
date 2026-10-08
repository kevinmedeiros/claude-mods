# kevin-mods

Mods do Claude Code. Cada um é um plugin: instale só o que fizer sentido em cada máquina.

| Plugin | O que faz |
|---|---|
| `usage-limits` | Limites de 5h e semanal na linha de status e acima do prompt: % usado, duração estimada em horas, tokens, custo, quanto cada projeto gastou e qual modelo usar para o limite durar até o reset. `/limites`, `/economia`. |
| `fluxo` | `/handoff` resume onde você parou e grava em `.claude/handoff.md`; na outra máquina, a próxima sessão mostra o handoff acima do prompt. Avisa com som quando um turno longo termina. |
| `unity-tools` | Ao editar um `.cs`, compila o assembly com `dotnet build` e entrega os erros ao Claude. `/testes` roda EditMode/PlayMode em batch (e o Claude pode rodar sozinho pela ferramenta `unity_tests`). `/build-servidor` gera o build Linux dedicado. Guardas: nada de editar `Library/`, `Temp/`, cenas/prefabs à mão, criar `.meta` à mão ou usar `UnityEngine` no núcleo. `/unity` abre o painel. |
| `blender-preview` | Depois de cada mudança pelo Blender MCP, mostra a miniatura da cena, triângulos, ossos, texturas e animações contra o orçamento do jogo. Ao exportar um `.glb`, confere o arquivo e avisa o Claude. `/blender`, `/glb <arquivo>`. |

## Instalar

Requer o Claude Code atualizado (`claude update`). Num terminal, abra `claude` e instale um por vez:

```
/plugin install usage-limits --marketplace kevinmedeiros/claude-mods
/plugin install fluxo --marketplace kevinmedeiros/claude-mods
/plugin install unity-tools --marketplace kevinmedeiros/claude-mods
/plugin install blender-preview --marketplace kevinmedeiros/claude-mods
```

Responda `y` para adicionar o marketplace (só na primeira vez) e escolha o escopo **user**. Os plugins passam a rodar em todas as sessões do Claude Code da máquina: terminal, aba Code do Claude Desktop e IDEs.

Para ajustar as opções (caminho do Unity, orçamento de triângulos, tempo do turno longo...), use `/plugin` e abra o plugin.

### Requisitos por plugin

- `unity-tools`: Unity Hub com a versão do projeto. Para a checagem de compilação, o .NET SDK (`dotnet`) e os `.csproj` gerados pelo Unity (Preferences > External Tools > Regenerate project files). Os testes em batch precisam do editor fechado para aquele projeto. O build do servidor precisa do módulo *Linux Dedicated Server Build Support*.
- `blender-preview`: Blender aberto com o add-on MCP conectado ao Claude Code.

## Atualizar

```
/plugin update usage-limits
```

(um por plugin; ou `/plugin` > Marketplaces > kevin-mods > Update)

## Desenvolver

```
claude plugin validate plugins/<plugin>
claude plugin test plugins/<plugin>
claude --plugin-dir plugins/<plugin>
```
