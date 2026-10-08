# usage-limits

Mod do Claude Code que mostra quanto do seu plano você está gastando e quanto tempo ele dura:

- **Linha de status e faixa acima do prompt**: % usado dos limites de 5h e semanal, duração estimada em horas no ritmo atual, tempo até o reset, tokens e custo da sessão.
- **`/limites`**: painel com barras, ritmo, projeção até o reset, composição dos tokens e o cartão **Qual modelo usar**.
- **Recomendação de modelo**: quando o ritmo não chega ao reset, sugere a troca menos disruptiva (ex.: "use Opus para orquestrar e Haiku para executar") e mostra quanto o limite passa a durar.
- **`/economia on|off`**: o fio principal continua no modelo atual e os novos subagentes rodam em Claude Haiku 5.5.
- **Avisos** em 80%, 95%, ao esgotar e quando a projeção indica que o limite acaba antes do reset.

Os percentuais vêm da API e valem para a conta inteira, em qualquer máquina. Os tokens por janela e o gasto por modelo são contados em cada máquina, a partir das sessões com o mod.

## Instalar

Requer o Claude Code atualizado (`claude update`) e uma conta de assinatura (Pro/Max) para ver os limites.

Num terminal, abra `claude` e digite:

```
/plugin install usage-limits --marketplace kevinmedeiros/claude-mods
```

Responda `y` para adicionar o marketplace e escolha o escopo **user**. O mod passa a rodar em todas as sessões do Claude Code dessa máquina: terminal, aba Code do Claude Desktop e IDEs.

## Atualizar

```
/plugin update usage-limits
```

## Desenvolver

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
