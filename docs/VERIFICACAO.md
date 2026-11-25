# Verificação da implementação

Execução realizada em **25/11/2026**, com Node.js **24.22.3** e **MySQL Community Server 8.4.13**. O código e os testes usam as dependências fixadas no `package-lock.json`.

## Resultado

| Verificação executada | Resultado observado |
| --- | --- |
| `npm test` | **41 aprovados, 0 falhas, 0 ignorados**. |
| Composição da suíte | 18 testes unitários, 1 proteção da seleção do banco de testes e 22 cenários HTTP/SQL. |
| Preparação do banco | Schema, chaves estrangeiras, índices únicos, `CHECK` e triggers aceitos pelo MySQL real. |
| Demonstração HTTP | Cadastro, login, depósito, transferência, replay, saque e extrato concluídos. |
| Conciliação da demonstração | 2 contas, 3 operações e 4 lançamentos; nenhuma divergência. |
| HTTP com banco disponível | `/health`: 200; `/ready`: 200. |
| HTTP com banco indisponível | `/health`: 200; `/ready`: 503; processo HTTP permanece ativo. |
| Sintaxe | Arquivos JavaScript verificados com `node --check`. |
| Coleção Postman | JSON e scripts internos validados; 16 requisições de exemplo. |
| Dependências de execução | `npm audit --omit=dev` retornou zero vulnerabilidades conhecidas na consulta desta execução. |

O teste de banco indisponível usou uma porta local sem servidor. Os testes financeiros usaram um MySQL isolado e clientes fictícios; nenhuma credencial do arquivo enviado pelo usuário foi usada.

## Evidências de consistência

**Atomicidade:** um trigger temporário provocou uma falha na inserção do crédito de uma transferência. A requisição falhou, e a inspeção SQL confirmou que saldo de origem, saldo de destino, operação e ledger permaneceram como antes da tentativa. Removida a falha, repetir a mesma chave permitiu concluir a transferência.

**Idempotência concorrente:** 12 requisições de transferência com a mesma chave produziram uma resposta `201` e 11 respostas `200`, referenciando uma única operação e somente duas contrapartidas no banco. Também foram verificados depósitos e saques concorrentes com a mesma chave.

**Concorrência sobre saldo:** 20 saques/transferências disputaram um saldo inicial de 1.000 centavos, cada um tentando movimentar 100 centavos. Dez foram concluídos e dez recusados por saldo insuficiente, com saldo final zero na origem.

**Transferências cruzadas:** 40 transferências simultâneas, alternando A→B e B→A, concluíram sem erro e conservaram o total. Isso confirma o cenário testado; o tratamento de deadlocks continua necessário para outros padrões de disputa.

**Persistência e privacidade:** uma segunda instância da aplicação recuperou do banco a operação já confirmada. A resposta ao remetente não incluiu o saldo do destinatário, e acessar a conta de outro cliente retornou 404.

**Paginação:** percorrer o extrato por cursor não duplicou linhas após novas inserções. Lançamentos com o mesmo timestamp continuaram ordenados pelo ID.

## Demonstração concluída

| Etapa | Ana, em centavos | Bruno, em centavos |
| --- | ---: | ---: |
| Cadastro | 0 | 0 |
| Depósito de 10.000 em Ana | 10000 | 0 |
| Transferência de 2.500 para Bruno | 7500 | 2500 |
| Repetição da mesma transferência/chave | 7500 | 2500 |
| Saque de 1.000 de Ana | **6500** | **2500** |

A conciliação posterior confirmou que os saldos correspondem aos lançamentos e que cada operação possui as contrapartidas esperadas.

## Arquivos de evidência

- [Saída completa dos testes](evidence/tests.txt).
- [Resposta da demonstração](evidence/demo.json).
- [Resultado da conciliação](evidence/reconciliation.json).
- [Healthchecks com banco disponível](evidence/health.json).
- [Healthchecks com banco indisponível](evidence/database-offline.json).

A linha `ER_SIGNAL_EXCEPTION` na saída de testes é esperada: corresponde à falha deliberadamente injetada para verificar o rollback.

## Limites da verificação

Os contêineres Docker não foram executados neste ambiente; o Compose foi validado estruturalmente. A aplicação, o banco MySQL, o servidor HTTP e a demonstração foram executados diretamente. Os testes ocorreram em Node.js 24; Node.js 22 é o mínimo declarado e a versão usada pelo Dockerfile.

O resultado é uma evidência dos cenários exercitados, não uma certificação de disponibilidade, segurança ou adequação para dinheiro real. Este projeto simula movimentações internas e não integra o Pix do Banco Central. Consulte o README para as limitações funcionais e operacionais.
