# API Conta Digital

API REST para cadastrar clientes e contas, depositar, sacar, transferir e consultar o extrato. O foco é manter **saldo, operação e ledger consistentes**, mesmo com requisições simultâneas ou repetidas.

Projeto de estudo com dados fictícios. As transferências são internas entre contas desta API; não há conexão com a infraestrutura do Pix nem movimentação bancária real.

## Comece por aqui

Extraia o projeto e abra um terminal dentro da pasta que contém `package.json`. Há duas formas de iniciar.

### Opção A — aplicação e MySQL pelo Docker

Pré-requisitos: Node.js 22+ e Docker com Compose. No Windows, inicie o Docker Desktop antes dos comandos. O Node local é usado para gerar o `.env`; a API roda no contêiner.

```powershell
cd api-conta-digital
npm run env:init
docker compose up --build -d
docker compose logs -f api
```

`env:init` gera um `.env` com senhas e chave JWT aleatórias. Se o arquivo já existir, ele será preservado. A configuração gerada usa `DB_USER=conta_app`; não altere esse usuário para `root` ao usar esta opção.

O MySQL cria as tabelas na primeira inicialização do volume. A API aguarda o banco ficar pronto. Acesse:

- [http://localhost:3000/](http://localhost:3000/) — informações da API em JSON.
- [http://localhost:3000/health](http://localhost:3000/health) — processo HTTP ativo.
- [http://localhost:3000/ready](http://localhost:3000/ready) — acesso ao banco e presença das tabelas necessárias.

Para executar uma demonstração completa de cadastro, login, depósito, transferência, repetição, saque e extrato:

```powershell
docker compose exec api npm run demo
```

Para executar os testes em **outro servidor MySQL**, sem usar o volume das contas de demonstração:

```powershell
docker compose --profile test run --build --rm tests
```

O perfil de testes inicia `db-test`, sem porta publicada e com dados temporários. Para encerrá-lo depois: `docker compose stop db-test`. Para encerrar a API e o banco normal: `docker compose down`. O volume de desenvolvimento é preservado.

### Opção B — Node e MySQL já instalados

Pré-requisitos: Node.js 22+ e MySQL 8.0.16+ com InnoDB. MySQL 8.4 é a versão escolhida no Compose.

```powershell
cd api-conta-digital
npm ci
npm run env:init
notepad .env
```

No `.env`, ajuste `DB_HOST`, `DB_PORT`, `DB_USER` e `DB_PASSWORD` para a instalação local. Para a preparação inicial, esse usuário precisa criar o banco, tabelas e triggers. A senha gerada por `env:init` não altera a senha do seu MySQL já instalado.

```powershell
npm run db:setup
npm run dev
```

Mantenha o terminal de `npm run dev` aberto. Em outro terminal, execute `npm run demo`. Em Linux/macOS os mesmos comandos funcionam; use seu editor no lugar de `notepad`.

Um `.env` existente deve conter `JWT_SECRET` aleatório com pelo menos 32 bytes. Se precisar gerar uma chave nova, copie a saída deste comando para o campo `JWT_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Se aparecer ERR_CONNECTION_REFUSED

Esse erro ocorre antes de a requisição chegar às rotas da API. Confira o endereço completo **`http://localhost:3000`**, incluindo a porta, e leia a saída do terminal que iniciou o servidor.

| Situação observada | Próximo passo |
| --- | --- |
| `Cannot find module ...src/server.js` | Extraia o projeto inteiro, incluindo `src/`, `sql/` e `scripts/`. |
| MySQL recusou conexão ou usuário/senha inválidos | Inicie o MySQL e confira os campos `DB_*` do `.env`. |
| Erro de tabela inexistente | Execute `npm run db:setup` no banco local correto. |
| `JWT_SECRET` inválido | Gere a chave conforme a seção anterior e atualize o `.env`. |
| `EADDRINUSE` | A porta está ocupada. Encerre o processo conhecido ou escolha outra `PORT`. |
| `/health` responde e `/ready` retorna 503 | O processo está ativo; confira o acesso ao banco e a preparação das tabelas. |
| Docker não iniciou a API | Execute `docker compose ps` e `docker compose logs api db`. |

No Docker, variáveis de inicialização do MySQL e `schema.sql` são aplicadas ao criar um volume vazio. Alterar a senha no `.env` não altera uma senha já gravada no banco. Preserve os dados e ajuste a configuração ou a conta SQL correspondente.

## Requisitos atendidos

| Requisito | Como foi implementado |
| --- | --- |
| Cadastro de clientes e contas | Registro cria cliente e primeira conta com saldo zero na mesma transação; o cliente pode abrir mais contas. |
| Dinheiro em centavos | `amount_cents` inteiro; cálculo com `BigInt`; armazenamento `BIGINT`; valores de entrada e saldo limitados ao intervalo de inteiros exatos do JavaScript. |
| Transferência atômica | Débito, crédito, operação, chave de idempotência e dois lançamentos do ledger são confirmados no mesmo `COMMIT`. |
| Concorrência | Contas bloqueadas com `SELECT ... FOR UPDATE`, uma por vez em ordem crescente de ID. |
| Repetição segura | `Idempotency-Key` obrigatória em depósitos, saques e transferências, com unicidade no banco e comparação do conteúdo. |
| Extrato | Cursor pelo ID do ledger, ordem decrescente, limite padrão 20 e máximo 100. |
| Histórico preservado | Ledger e operações sem rotas de alteração; triggers rejeitam `UPDATE` e `DELETE`. |
| Conciliação | Script compara saldos, histórico e partidas de cada operação usando uma leitura consistente. |
| Acesso | JWT e validação de titularidade; uma conta de outro cliente recebe 404. |

## Por que as movimentações permanecem consistentes

Em uma transferência, o serviço inicia uma transação, bloqueia as duas contas na ordem dos IDs, valida a titularidade e consulta a chave de idempotência. Se uma operação idêntica já tiver sido confirmada, devolve seu resultado. Caso contrário, verifica saldo e limite do destino, insere a operação e atualiza cada saldo junto ao lançamento correspondente no ledger. Só então confirma a transação.

Se uma inserção no ledger falhar depois do débito, o `ROLLBACK` desfaz inclusive o débito. Se duas requisições tentarem gastar o mesmo saldo, uma aguarda a outra liberar a conta e passa a validar o saldo atualizado. A restrição `UNIQUE` da chave complementa essa serialização no banco.

Bloquear contas sempre na mesma ordem reduz deadlocks; não significa que todos os deadlocks sejam impossíveis. O helper repete a transação inteira, de forma limitada, quando recebe deadlock ou timeout de bloqueio explicitamente identificado, após desfazer e liberar a tentativa. Erros de rede com resultado de `COMMIT` incerto não são repetidos automaticamente: o cliente deve reenviar **a mesma chave e o mesmo corpo**.

O ledger registra uma saída e uma entrada de valores iguais para cada transferência. Depósitos e saques registram a entrada ou saída da fronteira simulada do sistema; este projeto não implementa um plano contábil completo com contas de compensação externas.

## Idempotência na prática

Use uma chave por intenção de movimentação. Mantenha-a em qualquer repetição, inclusive depois de um timeout. Para uma nova movimentação, gere outra chave.

```http
POST /transfers
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: 7f9c2b5e-1111-4222-8333-444455556666

{"from_account_id":1,"to_account_id":2,"amount_cents":2500}
```

- Primeira confirmação: HTTP `201`, `replayed: false`.
- Mesma chave e conteúdo: HTTP `200`, mesma operação, `replayed: true`.
- Mesma chave e conteúdo diferente: HTTP `422`, `IDEMPOTENCY_KEY_REUSED`.

A chave é vinculada à conta afetada: origem da transferência/saque ou destino do depósito. Ela é compartilhada entre os três tipos de movimentação nessa conta. Uma chave confirmada em um depósito não pode ser reaproveitada para sacar. Contas diferentes podem usar o mesmo texto de chave.

Tentativas desfeitas não reservam a chave. As chaves confirmadas permanecem armazenadas, sem expiração automática. O replay retorna os saldos históricos da operação; consulte a conta para obter o saldo atual.

## Rotas

| Método | Rota | Autenticação | Finalidade |
| --- | --- | --- | --- |
| GET | `/` | Não | Informações da API |
| GET | `/health` | Não | Processo HTTP ativo |
| GET | `/ready` | Não | Acesso ao MySQL e tabelas necessárias |
| POST | `/auth/register` | Não | Cliente, primeira conta e token |
| POST | `/auth/login` | Não | Token JWT |
| GET | `/accounts` | Sim | Contas do cliente |
| POST | `/accounts` | Sim | Nova conta com saldo zero |
| GET | `/accounts/:id` | Sim | Conta e saldo atual |
| POST | `/accounts/:id/deposits` | Sim | Depósito simulado e idempotente |
| POST | `/accounts/:id/withdrawals` | Sim | Saque simulado e idempotente |
| POST | `/transfers` | Sim | Transferência interna e idempotente |
| GET | `/accounts/:id/statement` | Sim | Extrato paginado por cursor |

Os exemplos de corpos, respostas, paginação e erros estão em [docs/API.md](docs/API.md). A resposta da transferência mostra apenas o lançamento da origem: o saldo da conta do destinatário não é divulgado ao remetente.

## Testes e conciliação

A execução verificada aprovou **41 testes com MySQL real**. Consulte [o relatório e as evidências](docs/VERIFICACAO.md).

### MySQL local

Configure `TEST_DB_NAME=conta_digital_test` no `.env`. O usuário SQL precisa preparar esse banco separado. O nome deve terminar em `_test` e ser diferente de `DB_NAME`.

```powershell
npm run test:unit
npm run db:setup:test
npm test
npm run reconcile
```

`npm test` executa os testes unitários e de integração com MySQL. `npm run test:integration` executa somente a integração. Uma conexão indisponível com o banco reprova a integração; não é apresentada como sucesso. O setup preserva as tabelas existentes, e os testes usam clientes fictícios exclusivos.

Os cenários de integração cobrem valores inválidos, autenticação, autorização, replay concorrente, saque e transferência sem saldo, transferências cruzadas, limite de saldo do destino, paginação, imutabilidade e falha injetada durante a gravação do ledger. A verificação da falha consulta o banco para confirmar que nenhum débito, crédito ou operação parcial permaneceu.

`npm run reconcile` é somente leitura e termina com código diferente de zero se encontrar divergências. No Docker, use `docker compose exec api npm run reconcile`. Ele não corrige nem reescreve o histórico.

### Coleção Postman

Importe [postman/api-conta-digital.postman_collection.json](postman/api-conta-digital.postman_collection.json). Execute as requisições na ordem. A coleção guarda os tokens e IDs das duas contas em suas variáveis. As chaves de depósito, transferência e saque são mantidas entre envios, para que clicar em **Send** novamente demonstre o replay. Para uma nova intenção, limpe a variável da chave correspondente antes de enviar.

## Organização

| Caminho | Responsabilidade |
| --- | --- |
| `src/config/` | Variáveis de ambiente, pool e transações |
| `src/routes/` e `src/controllers/` | Contrato HTTP e autenticação das rotas |
| `src/services/` | Cadastro, contas e regras das movimentações |
| `src/middlewares/` e `src/utils/` | JWT, erros, validação e serialização |
| `sql/schema.sql` | Tabelas, índices, checks e triggers |
| `scripts/` | Preparação, demonstração, testes e conciliação |
| `tests/` | Validação, ciclo transacional e integração com MySQL |
| `docs/API.md` | Referência da API |

## Limites do projeto

Depósitos e saques são operações de demonstração autorizadas ao titular. Um produto real precisaria de origens de fundos verificadas, autenticação e autorização operacionais próprias, conciliação externa, limites de negócio, observabilidade, proteção contra abuso e revisão especializada. Aqui não há integração com o Banco Central, verificação de identidade, refresh token, estorno nem recuperação de senha.

As triggers impedem alterações comuns no histórico, mas um administrador do banco pode remover triggers ou executar comandos como `DROP` e `TRUNCATE`. Separe o usuário de migração do usuário da aplicação; o usuário de execução pode ser limitado a `SELECT`/`INSERT` nas tabelas de histórico e às permissões necessárias nas demais tabelas. O setup exige permissões adicionais para criar a estrutura.

O `package-lock.json` acompanha o projeto para instalações reproduzíveis. A existência de testes não substitui uma avaliação de segurança antes de qualquer uso com dados ou dinheiro reais.

## Referências técnicas

- [MySQL: locking reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html).
- [MySQL: minimizar e tratar deadlocks](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlocks-handling.html).
- [MySQL: tratamento de erros e rollback](https://dev.mysql.com/doc/refman/8.0/en/innodb-error-handling.html).
- [MySQL: CHECK constraints](https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html).
- [Docker: dependências e healthchecks](https://docs.docker.com/compose/how-tos/startup-order/).
- [Imagem oficial MySQL: inicialização](https://hub.docker.com/_/mysql/).
