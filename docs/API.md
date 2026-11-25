# Referência da API

Base local: `http://localhost:3000`. Envie corpos como objetos JSON com `Content-Type: application/json`. Campos adicionais não reconhecidos são rejeitados.

## Convenções

| Campo/conceito | Regra |
| --- | --- |
| `amount_cents` | Número JSON inteiro de `1` a `9007199254740991`. R$ 25,00 = `2500`. |
| `balance_cents`, `balance_after_cents` | Número JSON inteiro de `0` a `9007199254740991`. |
| IDs de cliente e conta | Inteiros positivos. |
| ID de operação | UUID em texto. |
| ID de lançamento e cursor | Texto decimal; preserve como texto, pois a coluna SQL é `BIGINT UNSIGNED`. |
| Datas | Texto em UTC. |
| Autenticação | `Authorization: Bearer <token>`. |
| `Idempotency-Key` | Obrigatória nas três rotas de dinheiro; de 8 a 128 caracteres entre letras, dígitos, `.`, `_`, `:`, `-`. Diferencia maiúsculas e minúsculas. |

Não envie `25.50`, `2500.0`, `2.5e3`, `"2500"`, zero, negativos ou inteiros acima do limite em `amount_cents`. Essa validação evita conversões monetárias ambíguas. Internamente, os cálculos usam `BigInt`; o limite da API permite que a resposta seja representada como número JSON exato.

## Cadastro e login

### POST /auth/register

```json
{
  "name": "Ana Exemplo",
  "email": "ana@example.test",
  "password": "SenhaSomenteParaDemo123"
}
```

`name`: 2–120 caracteres após remover espaços externos. `email`: até 254 caracteres, convertido para minúsculas. `password`: mínimo de 8 caracteres e máximo de 72 bytes UTF-8, para evitar truncamento no bcrypt. Senhas são armazenadas como hash bcrypt, nunca devolvidas.

Resposta HTTP `201`:

```json
{
  "customer": {"id": 1, "name": "Ana Exemplo", "email": "ana@example.test", "created_at": "2026-01-01T12:00:00.000000Z"},
  "account": {"id": 1, "customer_id": 1, "balance_cents": 0, "created_at": "2026-01-01T12:00:00.000000Z"},
  "token": "<jwt>"
}
```

O cliente e sua primeira conta são criados na mesma transação. E-mail já cadastrado retorna `409 EMAIL_IN_USE`.

### POST /auth/login

```json
{"email":"ana@example.test","password":"SenhaSomenteParaDemo123"}
```

Resposta `200`: `{ "customer": { ... }, "token": "<jwt>" }`. Credenciais incorretas retornam `401 INVALID_CREDENTIALS`. A validade padrão do token é uma hora, configurável em `JWT_EXPIRES_IN`.

## Contas

Todas as rotas abaixo exigem token válido.

| Requisição | Resposta |
| --- | --- |
| `GET /accounts` | `200 {"accounts":[...]}` com as contas do titular. |
| `POST /accounts` com `{}` | `201 {"account":{...}}` com uma nova conta de saldo zero. |
| `GET /accounts/1` | `200 {"account":{"id":1,"customer_id":1,"balance_cents":10000,"created_at":"..."}}`. |

Consultar ou movimentar uma conta pertencente a outro cliente retorna `404 ACCOUNT_NOT_FOUND`, assim como uma conta inexistente.

## Depósito

### POST /accounts/:id/deposits

```http
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: deposito-ana-0001

{"amount_cents":10000}
```

Cria uma operação `deposit` e um lançamento `credit`. A conta precisa pertencer ao titular autenticado. Esta rota simula uma entrada de fundos para fins de estudo.

## Saque

### POST /accounts/:id/withdrawals

```http
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: saque-ana-0001

{"amount_cents":1000}
```

Cria uma operação `withdrawal` e um lançamento `debit`. Saldo insuficiente retorna `422 INSUFFICIENT_FUNDS`, sem alterar saldo, ledger ou chave de idempotência.

## Transferência

### POST /transfers

```http
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: transferencia-ana-bruno-0001

{"from_account_id":1,"to_account_id":2,"amount_cents":2500}
```

A origem precisa pertencer ao titular autenticado. O destino deve existir e ser uma conta diferente. A transferência pode ser entre contas de clientes diferentes ou entre duas contas do mesmo cliente.

Resposta de exemplo `201` para uma origem que tinha `10000` centavos:

```json
{
  "operation": {
    "id": "11111111-2222-4333-8444-555555555555",
    "type": "transfer",
    "from_account_id": 1,
    "to_account_id": 2,
    "amount_cents": 2500,
    "created_at": "2026-01-01T12:01:00.000000Z"
  },
  "ledger_entries": [
    {
      "id": "2",
      "operation_id": "11111111-2222-4333-8444-555555555555",
      "account_id": 1,
      "direction": "debit",
      "amount_cents": 2500,
      "balance_after_cents": 7500,
      "created_at": "2026-01-01T12:01:00.000000Z"
    }
  ],
  "replayed": false
}
```

A resposta contém apenas o lançamento da conta de origem. O banco também registra o crédito do destino na mesma transação; seu titular o vê no próprio extrato. O remetente não recebe o saldo do destinatário.

Depósitos e saques usam o mesmo envelope `operation`, `ledger_entries`, `replayed`. Em depósitos, `from_account_id` é `null`; em saques, `to_account_id` é `null`.

### Repetir uma movimentação

Reenvie a mesma rota, corpo, titular e `Idempotency-Key`. O retorno passa a ser `200`, com a mesma operação e `replayed: true`. O header `Idempotency-Replayed` também informa `true` ou `false`.

O escopo da chave é a conta da movimentação: origem para saque/transferência, destino para depósito. As chaves compartilham esse espaço entre os três tipos. Outra quantidade, destino ou tipo de movimentação com a mesma chave confirmada gera `422 IDEMPOTENCY_KEY_REUSED`.

Uma operação desfeita não consome a chave. Uma operação confirmada continua reconhecível por sua chave, inclusive depois de outras operações mudarem o saldo. O replay devolve o saldo histórico após aquela operação; use `GET /accounts/:id` para o saldo atual.

Não gere uma chave nova automaticamente a cada tentativa de rede. Guarde a chave junto à intenção de pagamento e reutilize-a até saber o resultado. Esse comportamento permite recuperar o resultado após perder a resposta do servidor.

## Extrato

### GET /accounts/:id/statement?limit=20&before=100

`limit` é opcional, de 1 a 100, padrão 20. `before` é opcional; copie `pagination.next_cursor` da página anterior. Na primeira página, omita `before`.

```json
{
  "account_id": 1,
  "entries": [
    {
      "id": "2",
      "operation_id": "11111111-2222-4333-8444-555555555555",
      "account_id": 1,
      "direction": "debit",
      "amount_cents": 2500,
      "balance_after_cents": 7500,
      "created_at": "2026-01-01T12:01:00.000000Z",
      "type": "transfer",
      "counterparty_account_id": 2
    }
  ],
  "pagination": {"limit": 1, "next_cursor": "2", "has_more": true}
}
```

Próxima consulta: `GET /accounts/1/statement?limit=1&before=2`. O cursor é exclusivo: a próxima página só inclui IDs menores. No fim, `next_cursor` é `null` e `has_more` é `false`.

Os lançamentos aparecem do mais novo para o mais antigo por ID, mesmo quando os horários coincidem. Novos lançamentos não deslocam os itens já percorridos, como ocorreria em paginação por offset; para vê-los, consulte novamente a primeira página. O extrato é da conta autenticada e não representa um snapshot global de todas as contas.

## Erros

Envelope uniforme:

```json
{"error":{"code":"INSUFFICIENT_FUNDS","message":"Saldo insuficiente."}}
```

| HTTP | `code` | Significado |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Corpo, campos, IDs ou parâmetros inválidos. |
| 400 | `INVALID_JSON` | O corpo não contém JSON sintaticamente válido. |
| 400 | `INVALID_AMOUNT` | Valor monetário inválido. |
| 400 | `INVALID_IDEMPOTENCY_KEY` | Chave ausente ou fora do formato. |
| 400 | `SAME_ACCOUNT` | Origem e destino iguais. |
| 401 | `UNAUTHORIZED` | Token ausente, inválido ou expirado. |
| 401 | `INVALID_CREDENTIALS` | E-mail ou senha incorretos. |
| 404 | `ACCOUNT_NOT_FOUND` | Conta inexistente ou sem acesso para o titular. |
| 404 | `DESTINATION_ACCOUNT_NOT_FOUND` | Destino inexistente. |
| 404 | `ROUTE_NOT_FOUND` | Rota não reconhecida após autenticação. |
| 409 | `EMAIL_IN_USE` | E-mail já cadastrado. |
| 413 | `PAYLOAD_TOO_LARGE` | Corpo acima de 16 KB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Codificação do corpo não suportada. |
| 422 | `INSUFFICIENT_FUNDS` | Saldo insuficiente. |
| 422 | `BALANCE_LIMIT_EXCEEDED` | O saldo resultante ultrapassaria o limite suportado. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Chave confirmada com outra intenção. |
| 500 | `INTERNAL_ERROR` | Falha interna; nenhum detalhe sensível é exposto. |
| 503 | `DATABASE_UNAVAILABLE` | Banco indisponível ou bloqueio transitório após as tentativas limitadas. |

Falhas internas não expõem consultas SQL, senhas ou tokens. Quando houver timeout ou falha transitória, repita movimentações com a mesma chave. `GET /ready` usa um envelope próprio de diagnóstico e retorna 503 quando não consegue consultar o banco ou acessar as quatro tabelas da aplicação.

## Exemplo completo em PowerShell

Com a API em execução, o script abaixo cria duas contas de demonstração, deposita R$ 100,00, transfere R$ 25,00 e repete a transferência. Ele gera dados diferentes a cada execução.

```powershell
$base = "http://localhost:3000"
$suffix = [guid]::NewGuid().ToString("N")
$password = [guid]::NewGuid().ToString("N")
$ana = Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType "application/json" -Body (@{
    name = "Ana Exemplo"; email = "ana.$suffix@example.test"; password = $password
} | ConvertTo-Json)
$bruno = Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType "application/json" -Body (@{
    name = "Bruno Exemplo"; email = "bruno.$suffix@example.test"; password = $password
} | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($ana.token)"; "Idempotency-Key" = [guid]::NewGuid().ToString() }
Invoke-RestMethod -Method Post -Uri "$base/accounts/$($ana.account.id)/deposits" -Headers $headers -ContentType "application/json" -Body '{"amount_cents":10000}'

$headers["Idempotency-Key"] = [guid]::NewGuid().ToString()
$transfer = @{
    from_account_id = $ana.account.id
    to_account_id = $bruno.account.id
    amount_cents = 2500
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/transfers" -Headers $headers -ContentType "application/json" -Body $transfer
Invoke-RestMethod -Method Post -Uri "$base/transfers" -Headers $headers -ContentType "application/json" -Body $transfer

Invoke-RestMethod -Uri "$base/accounts/$($ana.account.id)" -Headers @{Authorization = "Bearer $($ana.token)"}
Invoke-RestMethod -Uri "$base/accounts/$($ana.account.id)/statement?limit=20" -Headers @{Authorization = "Bearer $($ana.token)"} | ConvertTo-Json -Depth 8
```

A segunda transferência deve mostrar `replayed: true`; o saldo da origem permanece em `7500`. Para testar também login e saque com verificações automáticas, execute `npm run demo`.
