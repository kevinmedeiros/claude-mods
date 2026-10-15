<div align="center">

# claude-mods

**Mods para o Claude Code: veja quanto tempo o seu plano dura, tenha o roadmap à vista, passe o trabalho de uma máquina para outra e dê ao Claude olhos para o Unity e o Blender.**

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)
[![Plugins do Claude Code](https://img.shields.io/badge/Claude%20Code-plugins-d97757)](https://code.claude.com/docs)
![Mods](https://img.shields.io/badge/mods-6-informational)
![Testes](https://img.shields.io/badge/testes-90%20passando-brightgreen)

[English](README.md) · [Português](README.pt-BR.md)

<img src="docs/terminal.svg" alt="Claude Code no terminal: uma faixa acima do prompt mostra o limite de 5h em 38% durando até renovar e o semanal em 41% acabando em ~52h, um aviso com a correção em um clique, três sessões abertas com tokens e custo e a linha de status do Unity" width="100%">

</div>

---

Mods do Claude Code são plugins de **function hooks**: TypeScript que roda dentro do Claude Code e pode desenhar painéis e faixas, criar comandos, observar as ferramentas e devolver contexto ao modelo. Este repositório é um marketplace com seis deles, feitos para o uso diário num plano Max e em projetos de jogo.

| Mod | O que entrega |
|---|---|
| [**usage-limits**](#usage-limits) | Os limites de 5h e semanal com **quanto tempo duram** no ritmo atual, tokens e custo de todas as sessões abertas, gasto por projeto, acompanhamento dos créditos de API e uma recomendação de modelo para você não ficar sem uso antes do reset. |
| [**fluxo**](#fluxo) | `/handoff` grava onde você parou para a próxima sessão, em outra máquina, continuar de lá; e som e notificação quando um turno longo termina. |
| [**tarefas**](#tarefas) | As tarefas do projeto num `TASKS.md` simples: painel, a próxima tarefa acima do prompt com os botões *Começar* e *Feita*, e o Claude criando e concluindo tarefas enquanto trabalha. |
| [**roadmap**](#roadmap) | Em que ponto o projeto está no roadmap: as fases numa trilha e o trabalho num quadro kanban, uma linha acima do prompt com a fase, o % e o botão *Fazer*, um aviso quando os commits passam à frente do roadmap, e o Claude marcando o que terminou com a evidência. |
| [**unity-tools**](#unity-tools) | Erros de compilação entregues ao Claude segundos depois de ele editar um `.cs`, testes EditMode/PlayMode que ele pode rodar sozinho, painel de build do servidor dedicado e guardas que o mantêm longe de `Library/`, cenas e `.meta`. |
| [**blender-preview**](#blender-preview) | Miniatura da cena do Blender com orçamento de triângulos, ossos e texturas, e conferência de cada `.glb` que o Claude exporta. |

## Instalar

Precisa de um Claude Code recente (testado da 2.1.286 à 2.1.295). Num terminal, abra o `claude` e instale os mods que quiser:

```
/plugin install usage-limits --marketplace kevinmedeiros/claude-mods
/plugin install fluxo --marketplace kevinmedeiros/claude-mods
/plugin install tarefas --marketplace kevinmedeiros/claude-mods
/plugin install roadmap --marketplace kevinmedeiros/claude-mods
/plugin install unity-tools --marketplace kevinmedeiros/claude-mods
/plugin install blender-preview --marketplace kevinmedeiros/claude-mods
```

Na primeira vez, responda `y` para adicionar o marketplace e escolha o escopo **user**. A partir daí os mods rodam em todas as sessões do Claude Code da máquina: terminal, aba Code do Claude Desktop e extensões de IDE. Reabra as sessões que já estavam abertas.

Atualize com `/plugin update <mod>`; ajuste as opções em `/plugin` → o mod → configurar.

---

## usage-limits

<img src="docs/desktop-pane.svg" alt="Painel /limites no Claude Desktop: cartão de 5h em 38% com barra, projeção hachurada até o reset e marcador de ritmo uniforme; cartão semanal em 41% em vermelho avisando que no ritmo atual acaba cerca de 80h antes do reset; e a composição dos tokens da sessão" width="560" align="right">

Os percentuais vêm dos próprios cabeçalhos de limite da Anthropic, então valem para **a conta inteira**: todas as sessões, todas as máquinas e o claude.ai. Em cima deles o mod responde o que a página de uso não responde: *isso dura até o reset?*

- **Linha de status e faixa acima do prompt** com o % de cada limite, quanto ele dura no ritmo atual (ou *dura até renovar*), quando renova, e tokens e custo de todas as sessões abertas. Uma linha de aviso só aparece quando um limite acaba antes de renovar, com a correção num botão.
- **▾ Minimizar** recolhe a faixa numa linha (`5h 2%  Sem 91% △`); **▴** traz de volta. A escolha vale para as próximas sessões.
- **Painel `/limites`** (o *Detalhes* da faixa): um cartão por limite, com um anel que mostra o uso, a projeção até renovar e o marcador de ritmo uniforme, quanto dura, quando renova e o ritmo; os cenários de modelo numa tabela; e as sessões abertas com a parte de cada uma no custo.
- **Todas as sessões abertas** na máquina, com projeto, modelo, tokens, custo e fatia do total, mais o total do dia.
- **Gasto por projeto** em cada janela, para saber qual projeto está queimando a semana.
- **Recomendação de modelo.** Quando o ritmo não chega ao reset, sugere a troca menos disruptiva, como *"use Opus para orquestrar e Haiku para executar"*, e mostra quanto o limite passaria a durar.
- **Modo economia** (`/economia on`). O fio principal mantém o modelo e os subagentes novos rodam em Claude Haiku 5.5.
- **Créditos de API.** Opcional, com uma Admin API key do Console: gasto do crédito mensal por modelo, ritmo por dia e quando ele acaba.
- **↻ Atualizar** para pegar a leitura mais nova que qualquer sessão da máquina recebeu.
- **Avisos** em 80%, em 95%, ao esgotar e quando a projeção indica que o limite acaba antes do reset.

<br clear="right">

| Opção | Padrão | |
|---|---|---|
| `adminApiKey` | — | Chave `sk-ant-admin…` da organização do Console que recebe os créditos de API do plano. Guardada em armazenamento seguro. |
| `apiMonthlyCredit` | `200` | Max 5x: 100 · Max 20x: 200 |
| `apiCycleDay` | `1` | Dia do mês em que o crédito renova |

<details>
<summary><b>Como a projeção funciona</b></summary>

- **Janela de 5h:** o ritmo da última hora, ou a média da janela quando ela acabou de começar. Horas restantes = (100 − usado) ÷ ritmo.
- **Janela semanal:** os pontos que a conta gastou nas últimas 24 horas, nunca com menos de um dia de histórico, para uma primeira manhã intensa não virar o ritmo da semana inteira. Isso inclui outras máquinas e a madrugada.
- **Horas de trabalho** (semanal, extra): o mod mede quantos pontos semanais cada ponto do 5h custa, dentro de uma mesma janela de 5h, e multiplica pelo ritmo do 5h. Reage em minutos a uma troca de modelo.
- **Cenários de modelo:** o gasto das últimas três horas ativas é precificado por modelo pela tabela da API, e cada cenário o reprecifica com um modelo mais barato. A assinatura pode pesar os modelos de outro jeito, então trate os números como estimativa.
- **Atualidade:** uma sessão só fica sabendo do % da conta pelas próprias respostas da API. As sessões da mesma máquina compartilham a leitura mais nova, e a faixa avisa *"leitura há 2h"* quando passa de 10 minutos.

</details>

## fluxo

Continue em outra máquina de onde parou.

- **`/handoff [observação]`** (ou `/passagem`, se outro plugin já tiver um `/handoff`) faz o Claude Haiku 5.5 resumir a sessão (onde parou, o que foi feito, próximos passos, cuidados) e grava em `.claude/handoff.md`, com os arquivos alterados e o estado do git.
- **Handoff automático** (desligado por padrão). Com `autoHandoff` ligado, todo turno que edita arquivos atualiza a lista, então fica registro mesmo se a sessão cair.
- **Na outra máquina**, a próxima sessão no projeto mostra *"↪ Handoff de MacBook (há 3h): …"* acima do prompt, com os botões **Continuar daqui**, **Ver** e **Dispensar**.
- **Aviso de turno longo:** notificação e, no macOS, um som quando um turno passa de 3 minutos. Pode também falar em voz alta.

O arquivo de handoff viaja junto com o projeto, por git ou por pasta sincronizada. Se preferir deixá-lo fora do git, adicione `.claude/handoff.md` ao `.gitignore` e sincronize a pasta.

| Opção | Padrão |
|---|---|
| `longTurnMinutes` | `3` |
| `sound` / `speak` | `true` / `false` |
| `autoHandoff` | `false` (ligue para atualizar o arquivo a cada turno que edita) |
| `handoffPath` | `.claude/handoff.md` |

## tarefas

A lista do que falta no projeto, num `TASKS.md` na raiz (o mesmo formato da skill de tarefas do Claude, então você, o Claude e o seu editor podem mexer nele).

- **Acima do prompt:** *"▶ Próxima: portar a esquiva para o FishNet · 7 abertas"* com **Começar** (escreve o prompt para você), **✓ Feita** e **Tarefas**.
- **`/tarefas`** abre o painel: Ativas, Aguardando, Algum dia e as feitas recentes, um campo para criar tarefa, **Começar**, **✓** e **↑** (passa de Algum dia para Ativas).
- **`/tarefa <título> [- contexto]`** cria uma pelo prompt.
- **O Claude mantém a lista em dia.** Ele ganha as ferramentas `task_add`, `task_done` e `task_list`: registra o que fica para depois e marca como feita quando termina, sempre com aviso na tela. Desligue em `claudeCanEdit`.
- **`/tarefas importar`** traz as pendências das suas notas (seções como *Pendente*, *Próximos passos* ou *Next steps*) e as caixas abertas de `BACKLOG.md` / `ROADMAP.md` para *Algum dia*, sem duplicar.
- **Com o fluxo**, o `/handoff` leva as tarefas abertas para a outra máquina.

| Opção | Padrão |
|---|---|
| `tasksPath` | `TASKS.md` |
| `showBand` | `true` |
| `claudeCanEdit` | `true` |

## roadmap

Em que ponto o projeto está no roadmap, num `docs/roadmap.json` que o Claude atualiza enquanto trabalha.

- **Acima do prompt:** uma linha, *"Fase 2 ▰▰▱▱▱▱▱▱▱▱ 16%  › Login por e-mail (Claude)  comigo: 3"*, com **Fazer** (escreve o pedido para você), **Roadmap** e **Ocultar**. Numa janela estreita, os extras saem antes de o nome da tarefa ser cortado.
- **`/roadmap`** abre o painel: as fases numa trilha, o cartão da fase atual (barra, %, contagens e gate) e um quadro kanban com *Agora*, *Próximas*, *Esperando* e *Feito*, até quatro cartões por coluna e um *+8 de N* para ver mais, com o filtro *Comigo*. O cartão abre no lugar, com o detalhe e o botão **Fazer agora** (**Ver o que falta** quando ele está bloqueado ou espera outra tarefa). Itens e fases podem ter um rótulo curto (`short`).
- **Aviso de desatualizado.** Quando o projeto passa de 10 commits sem mexer no roadmap, a faixa e o painel avisam.
- **O Claude mantém o roadmap em dia.** Ele ganha as ferramentas `roadmap_status`, `roadmap_update` e `roadmap_add`: marca o que terminou com a evidência (um commit, um teste, um arquivo) e cria os itens que surgirem, sempre com aviso na tela. O `roadmap_status` acha o id de qualquer item por palavras do título, e depois de cada `git commit` o Claude é lembrado de marcar o que o commit terminou. Desligue as ferramentas de escrita em `claudeCanEdit`.
- **Linha de status** com a fase e o %.

O formato do arquivo, com um exemplo, está no [README do mod](plugins/roadmap/README.md) (em inglês).

| Opção | Padrão |
|---|---|
| `file` | `docs/roadmap.json` |
| `showBand` | `true` |
| `staleAfter` | `10` (commits; `0` desliga o aviso) |
| `claudeCanEdit` | `true` |

## unity-tools

Liga em qualquer sessão cuja pasta tenha um projeto Unity. Ele procura `ProjectSettings/` acima da pasta da sessão ou até dois níveis abaixo.

- **Erros de compilação no contexto do Claude.** Depois que o Claude edita um `.cs`, o mod compila aquele assembly com `dotnet build` a partir do `.csproj` que o Unity gera, fora do projeto, em `Temp/`, em cerca de 1 segundo. Os erros voltam junto com o resultado da ferramenta. Arquivos novos que o Unity ainda não listou entram também.
- **`/testes [editmode|playmode|tudo]`** roda o Test Runner do Unity em batch e mostra o resultado no painel `/unity`, com o botão *mandar falhas pro Claude*. O próprio Claude pode chamar a ferramenta `unity_tests` para conferir as mudanças dele.
- **`/build-servidor`** gera o build do servidor dedicado Linux e mostra o log ao vivo. Avisa se faltar o módulo *Linux Dedicated Server*.
- **Guardas** recusam, com um motivo que o Claude entende:
  - editar `Library/`, `Temp/`, `Logs/` ou `UserSettings/`;
  - escrever `.unity` ou `.prefab` à mão;
  - criar ou apagar `.meta` à mão;
  - usar `UnityEngine` numa pasta de núcleo sem engine.

| Opção | Padrão | |
|---|---|---|
| `projectPath` | automático | Pasta do projeto, se a detecção falhar |
| `unityPath` | caminho do Unity Hub para a versão do projeto | |
| `coreDir` | `Assets/Scripts/Core` | Pasta sem engine; vazio desliga a guarda |
| `compileCheck` | `true` | |
| `allowSceneEdits` | `false` | |
| `serverBuildPath` | `Builds/Server/Server.x86_64` | |
| `buildMethod` | — | ex.: `MyGame.Editor.BuildServer.Build`; vazio usa `-buildLinux64Player` |

**Requisitos:**
- Unity Hub com a versão do editor do projeto.
- O .NET SDK (`dotnet`), para a checagem de compilação.
- Arquivos de projeto gerados: Preferences → External Tools → *Regenerate project files*.
- Os testes em batch precisam do editor fechado para aquele projeto.

## blender-preview

Funciona com o Blender conectado ao Claude Code por um servidor MCP do Blender.

- **Depois de cada mudança** que o Claude faz na cena pelo Blender MCP, o mod renderiza uma miniatura e mede triângulos por objeto, ossos, materiais, texturas e animações contra o seu orçamento. `/blender` abre o painel.
- **A cada export de `.glb`**, lê o arquivo e entrega ao Claude um relatório: tamanho, triângulos, skin e ossos, animações e tamanho das texturas, com aviso para o que passar do orçamento.
- **`/glb <arquivo>`** confere qualquer `.glb`.

| Opção | Padrão |
|---|---|
| `maxTriangles` | `20000` |
| `maxBones` | `100` |
| `maxTextureSize` | `2048` |
| `autoPreview` | `true` |
| `server` | `Blender` |

---

## Privacidade

Tudo fica na sua máquina.

- **Arquivos locais.** Os mods gravam em `~/.claude/usage-limits/`, no armazenamento de cada plugin e em `.claude/handoff.md`, `TASKS.md` e `docs/roadmap.json` no seu projeto.
- **Requisições de rede:**
  - o `usage-limits` chama a API de custo do Console, e só se você configurar uma Admin key;
  - o `fluxo` chama o Claude Haiku 5.5 quando você roda `/handoff`;
  - nada mais sai da máquina.
- **Processos locais:** o `unity-tools` roda o `dotnet` e o editor do Unity; o `blender-preview` fala com o seu Blender local pelo MCP; o `roadmap` roda comandos do `git` só de leitura (`rev-parse`, `log`, `rev-list`, `diff`) para contar os commits desde a última mudança no roadmap.

## Desenvolvimento

```
plugins/<mod>/
  .claude-plugin/plugin.json   manifesto e opções
  hooks/register.tsx           o módulo de hooks
  hooks/*.ts                   lógica pura (com testes)
  tests/*.test.ts              rodados pelo `claude plugin test`
  types/index.d.ts             o contrato de estado do mod
```

```bash
claude plugin validate plugins/usage-limits
claude plugin test plugins/usage-limits
claude --plugin-dir plugins/usage-limits
```

Com `--plugin-dir`, o mod recarrega a cada vez que você salva. Para gerar de novo as imagens deste README, rode `bun docs/generate-previews.ts`; elas são desenhadas com o próprio código dos mods. Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE) © Kevin Medeiros. Sem vínculo com a Anthropic.
