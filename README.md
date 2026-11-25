# Pulso 💚

**Seu dinheiro. Seu controle. Seu futuro.**

A Pulso é uma plataforma de gestão financeira pessoal desenvolvida para ajudar usuários a organizar suas finanças, acompanhar movimentações e construir uma relação mais consciente com o dinheiro.

## 🚀 Sobre o projeto

A Pulso tem como objetivo oferecer uma experiência simples, moderna e segura para o controle financeiro.

O projeto conta com uma API construída em Node.js e Express, integração com banco de dados MySQL e uma interface web.

## ✨ Funcionalidades

- Autenticação de usuários
- Gerenciamento de contas
- Operações e movimentações financeiras
- Integração com informações de mercado e investimentos
- API REST
- Tratamento centralizado de erros
- Proteção de rotas com autenticação

> Algumas funcionalidades podem estar em desenvolvimento.

## 🛠️ Tecnologias

- Node.js
- Express.js
- JavaScript
- MySQL
- HTML, CSS e JavaScript no frontend
- Git e GitHub para versionamento

## 📂 Estrutura do projeto

A API utiliza separação de responsabilidades:

- `src/controllers/` — controladores HTTP
- `src/services/` — regras de negócio
- `src/middlewares/` — middlewares
- `src/utils/` — utilitários e tratamento de erros
- `src/routes/` — configuração das rotas
- `public/` — arquivos públicos do frontend

Os caminhos podem variar conforme a organização atual do repositório.

## ⚙️ Instalação

### Pré-requisitos

- Node.js e npm
- MySQL
- Git

### 1. Clone o repositório

```bash
git clone URL_DO_REPOSITORIO
cd NOME_DA_PASTA
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure as variáveis de ambiente

Configure o acesso ao MySQL e os demais segredos exigidos pela aplicação, seguindo os nomes de variáveis utilizados no código.

Não publique senhas, tokens ou arquivos `.env` contendo credenciais.

### 4. Prepare o banco de dados

Crie o banco MySQL e execute as migrações ou scripts de inicialização disponíveis no projeto.

### 5. Inicie a aplicação

Confira os scripts definidos no `package.json`. Por exemplo, caso exista o script `start`:

```bash
npm start
```

Acesse o endereço e a porta configurados no servidor.

## 🔐 Segurança

A Pulso utiliza ou prevê mecanismos de proteção como:

- Autenticação por token Bearer
- Controle de acesso às rotas protegidas
- Política de Segurança de Conteúdo (CSP)
- Tratamento centralizado de erros
- Proteção das credenciais por variáveis de ambiente


## 📈 Investimentos

O backend inclui uma rota de mercado registrada no prefixo:

```text
/api/market
```

Os métodos HTTP, subcaminhos e requisitos de autenticação dependem da implementação do módulo de investimentos.

## 🧑‍💻 Desenvolvimento

Sugestões de boas práticas:

1. Utilizar branches para novas funcionalidades.
2. Fazer commits descritivos.
3. Nunca enviar credenciais ao Git.
4. Testar os endpoints antes de publicar alterações.
5. Manter as dependências atualizadas.
6. Revisar segurança e tratamento de erros.

## 🗺️ Próximas melhorias

- Fortalecimento de autenticação e autorização
- Validação de dados e rate limiting
- Melhorias no painel financeiro
- Evolução das funcionalidades de investimentos
- Testes automatizados
- Monitoramento e logs de segurança

## 📄 Licença

Todos os direitos reservados ao Gui :)

---

**Pulso — Seu dinheiro. Seu controle. Seu futuro.**
