# Plano de Implementação — Simulador Pagar.me (API v5)

Simulador local da API v5 da Pagar.me para testes locais e em pipeline, sem conta Pagar.me e sem ngrok.
Não processa pagamentos de verdade, mas **requisições, VOs, status, códigos HTTP e formatos de resposta
devem ser idênticos aos da Pagar.me**, incluindo o comportamento dos simuladores oficiais (cartões de teste,
valor-limite do Pix, CEPs do boleto) e o disparo de webhooks.

**Stack:** TypeScript · Fastify · Zod · Vitest · tsx · Docker
**Escopo da v1 (fluxo principal):** clientes, endereços, cartões, tokenização, pedidos e cobranças
(cartão de crédito, Pix, boleto), webhooks e endpoints de controle do simulador.

> ⛔ **Regra de progressão:** ao concluir cada etapa, a implementação **para**. A etapa seguinte só começa
> com a autorização explícita do usuário. Essa regra também está em `CLAUDE.md`.

## Progresso

| # | Etapa | Status |
|---|-------|--------|
| 1 | Fundação do projeto | ⬜ |
| 2 | Clientes, endereços e cartões | ⬜ |
| 3 | Webhooks | ⬜ |
| 4 | Pedidos com cartão de crédito | ⬜ |
| 5 | Pix e boleto | ⬜ |
| 6 | Operações de cobrança | ⬜ |
| 7 | Controle do simulador e cenários assíncronos | ⬜ |
| 8 | Empacotamento para pipeline e documentação | ⬜ |

Legenda: ⬜ não iniciada · 🟨 em andamento · ✅ concluída (aprovada pelo usuário)

## Decisões que valem para todas as etapas

- **Fonte da verdade:** `docs/pagarme/` (páginas da documentação) e `docs/pagarme/openapi.json` (spec compilada).
  Quando o schema e o exemplo de resposta divergem, **vale o exemplo**: o schema publicado tem 83 divergências
  conhecidas (ex.: `metadata` tipado como `string`).
- **Atenção:** o exemplo `200` de `POST /orders` no `openapi.json` é na verdade um objeto de cobrança.
  O formato de pedido deve vir de `GET /orders/{order_id}` (`reference/obter-pedido.md`) e das páginas de cada
  meio de pagamento (`reference/cartao-de-credito-1.md`, `pix-2.md`, `boleto-1.md`).
- **Base path:** `/core/v5`, igual à API real. Para usar o simulador, o cliente só troca o host.
- **Endpoints de controle** (não existem na Pagar.me) ficam fora do base path, em `/_simulator/...`.
- **Validação:** feita com Zod, sem usar os schemas do OpenAPI. Os erros saem no formato da Pagar.me:
  `{"message": "The request is invalid.", "errors": {"<caminho>": ["<mensagem>"]}}`.
- **Persistência:** em memória por padrão, atrás de uma interface de repositório, para permitir trocar por SQLite depois.
- **Formatos:** IDs com prefixo e 16 caracteres (`or_`, `ch_`, `tran_`, `cus_`, `card_`, `addr_`, `oi_`, `hook_`, `token_`);
  datas no formato `2017-04-19T16:01:09Z` (sem milissegundos); valores sempre em centavos (inteiros).
- **Testes:** Vitest com `app.inject()`. Os testes de contrato comparam a estrutura (chaves e tipos) das respostas
  com os exemplos oficiais.
- **Código** (identificadores, comentários) em inglês, como a própria API; documentação do projeto em português.

---

## Etapa 1 — Fundação do projeto

**Objetivo:** ter um servidor Fastify em TypeScript com autenticação, formato de erro, IDs, armazenamento
e paginação iguais aos da Pagar.me, para que as etapas seguintes só precisem adicionar recursos.

- [ ] Inicializar o projeto: `package.json`, `tsconfig` (strict), ESLint + Prettier, Vitest, `tsx` para desenvolvimento
- [ ] Inicializar o repositório git e criar o `.gitignore`
- [ ] Estrutura de pastas (`src/app`, `src/modules/<recurso>`, `src/shared`, `src/simulator`, `test/`)
- [ ] Configuração por variáveis de ambiente, validada com Zod (porta, chaves aceitas, conta `acc_`/nome, atrasos)
- [ ] Autenticação Basic com secret key (`sk_test_*` / `sk_*`, senha vazia) e resposta `401` no formato oficial
- [ ] Error handler único: `401`, `404` (`{"message": "<Recurso> not found."}`), `422` no formato oficial, `500`
- [ ] Conversor de erros do Zod para o mapa `errors` da Pagar.me (caminhos como `order.customer.name`, `order.payments[0]...`)
- [ ] Gerador de IDs com prefixo e utilitário de datas no formato da Pagar.me
- [ ] Repositório em memória genérico, com interface para permitir outra implementação
- [ ] Paginação `page`/`size` com resposta `{"data": [...], "paging": {"total", "previous", "next"}}`
- [ ] `GET /_simulator/health` e `POST /_simulator/reset` (limpa todos os dados)
- [ ] Helper de teste de contrato: carrega exemplos do `openapi.json` e compara a estrutura com a resposta do simulador
- [ ] Testes da etapa passando

**Pronto quando:** o servidor sobe, recusa requisições sem chave com o `401` oficial, devolve `422` no formato
da Pagar.me e os testes passam.

**Referências:** `reference/autenticacao-2.md`, `reference/erros-1.md`, `reference/paginacao-1.md`

## Etapa 2 — Clientes, endereços e cartões

**Objetivo:** implementar a carteira de clientes, que é pré-requisito dos pedidos.

- [ ] Clientes: `POST /customers`, `GET /customers`, `GET /customers/{id}`, `PUT /customers/{id}`
- [ ] Endereços: criar, listar, obter, editar e excluir em `/customers/{id}/addresses`
- [ ] Cartões: criar, listar, obter, editar, excluir e renovar em `/customers/{id}/cards`
- [ ] Validação de cartão: algoritmo de Luhn, tamanho de 13 a 19 dígitos, validade futura (mensagens de erro oficiais)
- [ ] Detecção de bandeira pelo BIN; `first_six_digits` e `last_four_digits`; nunca devolver o número completo nem o CVV
- [ ] Tokenização: `POST /tokens?appId=pk_test_*` (autenticação pela chave pública, sem Basic Auth), com expiração do token e CORS
- [ ] (Opcional) `GET /{bin}` da API de BIN (`bin/v1`)
- [ ] Emitir eventos de domínio (`customer.*`, `address.*`, `card.*`); o disparo de webhooks fica para a Etapa 3
- [ ] Testes de contrato contra os exemplos oficiais de cada endpoint

**Pronto quando:** é possível criar um cliente com cartão (direto ou por token) e as respostas têm a mesma
estrutura dos exemplos oficiais.

**Referências:** `reference/clientes-1.md`, `criar-cliente-1.md`, `cartoes-1.md`, `criar-cartao.md`,
`criar-token-cartao-1.md`, `tokenizacao-1.md`, `enderecos.md`, `telefones-1.md`, `guides/carteira-de-clientes.md`, `guides/wallets.md`

## Etapa 3 — Webhooks

**Objetivo:** permitir que o sistema sob teste receba webhooks no formato oficial, sem ngrok. É o principal motivo do simulador.

- [ ] Cadastro de endpoints de webhook (na Pagar.me é feito pelo dashboard): via configuração (URL e eventos filtrados)
      e via `POST/GET/DELETE /_simulator/webhook-endpoints`
- [ ] Envelope oficial: `{"id": "hook_...", "account": {"id", "name"}, "type", "created_at", "data"}`
- [ ] Dispatcher assíncrono: `POST` JSON para cada endpoint inscrito no evento, com timeout e retentativas configuráveis
- [ ] Registro de cada entrega: `status` (`pending`, `sent`, `failed`), `attempts`, `last_attempt`, `response_status`, `response_raw`
- [ ] `GET /hooks`, `GET /hooks/{hook_id}`, `POST /hooks/{hook_id}/retry`
- [ ] Ligar os eventos de clientes, endereços e cartões da Etapa 2
- [ ] (Opcional, não documentado na v5) autenticação Basic nas chamadas de webhook, por configuração
- [ ] `GET /_simulator/webhook-deliveries` para inspecionar os envios durante os testes
- [ ] Testes com um receptor HTTP local de verdade (entrega, filtro por evento, retentativa, falha)

**Pronto quando:** criar um cliente dispara `customer.created` para a URL configurada, e a entrega aparece em `GET /hooks`.

**Referências:** `reference/visao-geral-sobre-webhooks.md`, `eventos-de-webhook-1.md`, `exemplo-de-webhook-1.md`,
`listar-webhooks.md`, `obter-webhook.md`, `enviar-webhook.md`, `guides/webhooks.md`

## Etapa 4 — Pedidos com cartão de crédito

**Objetivo:** implementar o núcleo do fluxo de pagamento: pedido, cobrança e transação, seguindo o simulador oficial de cartão.

- [ ] `POST /orders` com `customer` ou `customer_id`, `items`, `shipping`, `metadata`, `code`, `closed`, `payments`
- [ ] Cartão por `card` (dados abertos), `card_id` ou `card_token`; `installments`, `statement_descriptor`, `capture`
- [ ] Máquina de estados: pedido (`pending`, `paid`, `canceled`, `failed`), cobrança (`pending`, `paid`, `canceled`,
      `processing`, `failed`, `overpaid`, `underpaid`, `chargedback`) e `last_transaction`, conforme a documentação
- [ ] Cartões do simulador oficial: `4000000000000010` (sucesso), `…0028` (falha), `…0036` (processing → pago),
      `…0044` (processing → falha), `…0077`, `…0093`, `…0051`, `…0069` (pago → chargeback); qualquer outro: não autorizado
- [ ] `capture: false` → autorizado aguardando captura
- [ ] Campos da transação no formato oficial (`acquirer_name: "simulator"`, `acquirer_*`, `gateway_response`, `antifraud_response`, `card`)
- [ ] Vários pagamentos no mesmo pedido (multimeios), com o pedido pago só quando todas as cobranças estiverem pagas
- [ ] `GET /orders` (com filtros), `GET /orders/{id}`, `PATCH /orders/{id}/closed`
- [ ] Itens do pedido: incluir, obter, editar, excluir e excluir todos em `/orders/{id}/items`
- [ ] `POST /charges` com `order_id` (incluir cobrança em pedido aberto)
- [ ] Webhooks: `order.created`, `order.paid`, `order.payment_failed`, `order.closed`, `order.updated`, `order_item.*`,
      `charge.created`, `charge.paid`, `charge.payment_failed`, `charge.pending`, `charge.processing`
- [ ] As transições posteriores (`…0036`, `…0044`, `…0051`, `…0069`) já ficam agendadas, com atraso configurável
- [ ] Testes de contrato e um teste para cada cartão do simulador, incluindo a sequência de webhooks

**Pronto quando:** cada cartão de teste gera os mesmos status e a mesma sequência de webhooks descritos no simulador oficial.

**Referências:** `reference/criar-pedido-2.md`, `obter-pedido.md`, `pedidos-1.md`, `cobrancas-1.md`, `cartao-de-credito-1.md`,
`item-do-pedido-1.md`, `fechar-um-pedido.md`, `incluir-cobranca-no-pedido.md`, `guides/simulador-de-cartao-de-credito.md`,
`guides/multimeios.md`, `guides/pedidos-abertos.md`, `pages/chargeback-novo-status-na-cobranca.md`

## Etapa 5 — Pix e boleto

**Objetivo:** cobrir os meios de pagamento assíncronos, cujo pagamento chega depois via webhook.

- [ ] Pix: `expires_in`/`expires_at`, `additional_information`; resposta com `qr_code`, `qr_code_url`, `expires_at` e demais campos oficiais
- [ ] Regra do simulador Pix: valor ≤ R$ 500,00 → `pending` e pago automaticamente após alguns segundos; > R$ 500,00 → `failed`
- [ ] Boleto: `instructions`, `due_at`, `document_number`, `type`, `interest`/`fine`; resposta com `line`, `barcode`, `pdf`, `url`, `nosso_numero` etc.
- [ ] Regras do simulador de boleto pelo CEP do comprador: `01046010` (pago a menor → `underpaid`),
      `57400000` (pago a maior → `overpaid`), `70070300` (não conciliado), demais (pagamento total)
- [ ] URLs de QR Code e PDF servidas pelo próprio simulador (conteúdo fictício)
- [ ] Webhooks `charge.paid`, `charge.underpaid`, `charge.overpaid`, `order.paid` disparados na conciliação
- [ ] Testes de contrato e de cada cenário do simulador

**Pronto quando:** um pedido Pix de até R$ 500,00 vira `paid` sozinho e dispara os webhooks, e cada CEP de boleto
produz o desfecho documentado.

**Referências:** `reference/pix-2.md`, `boleto-1.md`, `guides/pix-1.md`, `guides/boleto.md`,
`guides/simulador-pix.md`, `guides/simulador-de-boleto.md`

## Etapa 6 — Operações de cobrança

**Objetivo:** cobrir as operações de pós-venda sobre cobranças.

- [ ] `GET /charges` (com filtros) e `GET /charges/{id}`
- [ ] `POST /charges/{id}/capture` (total e parcial)
- [ ] `DELETE /charges/{id}`: cancelamento/estorno total e parcial (`charge.refunded`, `charge.partial_canceled`, `order.canceled`)
- [ ] Comportamento de cancelamento dos cartões `…0077` (processing → cancelado/estornado) e `…0093` (processing → volta a pago)
- [ ] `POST /charges/{id}/retry` (retentar manualmente)
- [ ] `PATCH /charges/{id}/card`, `PATCH /charges/{id}/due-date`, `PATCH /charges/{id}/payment-method`
- [ ] Erros de operação inválida no formato oficial (ex.: capturar uma cobrança já paga)
- [ ] Testes de contrato e de transição de estado

**Pronto quando:** capturar, cancelar e estornar funcionam de forma total e parcial, com os status e os webhooks oficiais.

**Referências:** `reference/capturar-cobranca.md`, `cancelar-cobranca.md`, `obter-cobranca.md`, `listar-cobrancas.md`,
`retentar-uma-cobranca-manualmente.md`, `editar-cartao-de-cobranca.md`, `editar-data-de-vencimento-da-cobranca.md`,
`editar-metodo-de-pagamento.md`

## Etapa 7 — Controle do simulador e cenários assíncronos

**Objetivo:** dar aos testes controle determinístico sobre o que, na Pagar.me real, acontece "depois", sem `sleep`.

- [ ] `POST /_simulator/charges/{id}/pay` (com valor opcional, para simular pagamento a menor ou a maior)
- [ ] `POST /_simulator/charges/{id}/fail`, `.../chargeback`, `.../expire`
- [ ] `POST /_simulator/scheduler/flush`: executa na hora todas as transições agendadas
- [ ] Modo `SIMULATOR_AUTO_TRANSITIONS=false`: nada acontece sozinho; tudo é disparado pelos endpoints de controle
- [ ] `POST /_simulator/webhooks/flush`: espera a fila de webhooks esvaziar (útil antes das asserções)
- [ ] Testes de ponta a ponta do fluxo completo (pedido → webhook → consulta)

**Pronto quando:** um teste de integração consegue pagar um Pix, aguardar os webhooks e verificar o resultado
de forma determinística.

## Etapa 8 — Empacotamento para pipeline e documentação

**Objetivo:** deixar o simulador pronto para uso local e em CI.

- [ ] `Dockerfile` (imagem enxuta, com healthcheck) e exemplo de `docker-compose` com um serviço consumidor
- [ ] Exemplo de uso em pipeline (serviço do CI apontando para o simulador)
- [ ] `README.md`: como rodar, variáveis de ambiente, cenários do simulador, endpoints de controle, limitações
- [ ] Varredura final de contrato: todos os endpoints implementados contra os exemplos oficiais
- [ ] Lista do que está fora do escopo da v1

**Pronto quando:** `docker compose up` sobe o simulador, e um serviço de exemplo cria pedidos e recebe webhooks.

---

## Fora do escopo da v1 (próximas fases)

- Assinaturas, planos, faturas, ciclos, descontos e incrementos (recorrência)
- Recebedores, split, saldo, saques, transferências, antecipações, liquidações, recebíveis
- Link de pagamento / Checkout
- Cartão de débito, voucher, private label, Google Pay, Apple Pay, cash
- Simulador PSP (antifraude: CVV iniciado em 6, documento `11111111111`, status `analysing`)
- 3DS, Disputas, Marketplace (Res. 264), BIN completo, rate limit
- Persistência em SQLite
