# Simulador Pagar.me (API v5)

Simulador local da API v5 da Pagar.me para testes locais e em pipeline. Requisições, VOs, status, códigos HTTP,
formatos de resposta e webhooks devem ser **idênticos** aos da Pagar.me; o pagamento em si é simulado.

Stack: TypeScript · Fastify · Zod · Vitest.

## Regras de trabalho

1. **Implementar por etapas, seguindo `PLANO_DE_IMPLEMENTACAO.md`.**
2. **Ao concluir uma etapa, PARAR.** Apresentar ao usuário um resumo do que foi feito, o resultado dos testes e
   o que ficou pendente, e **aguardar autorização explícita** antes de iniciar a próxima etapa. Nunca começar a
   etapa seguinte, nem parcialmente, sem essa permissão. Isso vale também depois de um resumo de contexto ou em
   uma nova sessão.
3. **Manter o plano atualizado:** marcar cada checkbox ao concluir o item, colocar 🟨 na etapa em andamento e só
   colocar ✅ na tabela de progresso depois que o usuário aprovar a etapa.
4. Uma etapa só está concluída com typecheck, lint e testes passando. Se algo falhar ou ficar de fora, informar.
5. **Fidelidade à Pagar.me:** consultar `docs/pagarme/` antes de implementar cada endpoint. Quando o schema e o
   exemplo de resposta divergirem no `openapi.json`, vale o exemplo. Em comportamentos não documentados, perguntar
   ao usuário em vez de inventar.
6. Mudanças de escopo ou de decisões do plano devem ser combinadas com o usuário antes.

## Referências

- `docs/pagarme/INDEX.md`: índice da documentação baixada (arquivo → título → URL)
- `docs/pagarme/openapi.json`: spec compilada (`x-doc-url` aponta para a página de origem)
- `scripts/download_docs.sh` / `scripts/merge_openapi.py`: baixar a documentação de novo / regerar a spec
