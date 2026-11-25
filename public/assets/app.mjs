
import * as api from "./api.mjs";
import {
  formatMoney,
  formatDate,
  parseMoney
} from "./money.mjs";

const $ = (id) => document.getElementById(id);

const state = {
  customer: null,
  accounts: [],
  currentAccount: null,
  entries: [],
  authMode: "login",
  currentView: "overview",
  balanceHidden: false,
  busy: false,

  // Paginação do extrato
  statementCursor: null,
  statementHasMore: false,
  statementLoading: false,

  // Controle de carregamentos simultâneos
  statementVersion: 0
};

function showMessage(message, error = false) {
  const region = $("toast-region");

  const toast = document.createElement("div");
  toast.className = error ? "toast toast-error" : "toast toast-success";
  toast.textContent = message;

  region.appendChild(toast);

  setTimeout(() => toast.remove(), 4500);
}

function showError(error) {
  console.error(error);
  showMessage(error.message || "Ocorreu um erro.", true);
}

// Indicador visual reutilizável: não altera a identidade da operação.
function setButtonBusy(button, busy, label = "Processando...") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent;
    }
    button.classList.add("pulso-busy");
    button.disabled = true;
    button.textContent = label;
    button.setAttribute("aria-busy", "true");
  } else {
    button.classList.remove("pulso-busy");
    button.disabled = false;
    button.textContent = button.dataset.originalLabel || button.textContent;
    delete button.dataset.originalLabel;
    button.removeAttribute("aria-busy");
  }
}

// CADASTRO E LOGIN

function changeAuthMode(mode) {
  state.authMode = mode;

  const registering = mode === "register";

  $("auth-name-field").hidden = !registering;

  $("auth-tab-login").classList.toggle("active", !registering);
  $("auth-tab-register").classList.toggle("active", registering);

  $("auth-tab-login").setAttribute(
    "aria-selected", String(!registering)
  );

  $("auth-tab-register").setAttribute(
    "aria-selected", String(registering)
  );

  $("auth-heading").textContent = registering
    ? "Sua jornada começa aqui."
    : "Bom ter você aqui.";

  $("auth-submit").textContent = registering
    ? "Criar minha conta"
    : "Entrar na minha conta";

  $("auth-password").autocomplete = registering
    ? "new-password"
    : "current-password";

  $("auth-message").hidden = true;
}

async function handleAuth(event) {
  event.preventDefault();

  if (state.busy) return;

  const name = $("auth-name").value.trim();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;

  state.busy = true;
  $("auth-submit").disabled = true;
  $("auth-message").hidden = true;

  try {
    let result;

    if (state.authMode === "register") {
      if (!name) throw new Error("Informe seu nome.");

      result = await api.register({
        name,
        email,
        password
      });

      // O cadastro devolve o token de acesso.
      api.setToken(result.token);
    } else {
      result = await api.login({
        email,
        password
      });
    }

    state.customer = result.customer;

    await enterDashboard();

  } catch (error) {
    $("auth-message").textContent = error.message;
    $("auth-message").hidden = false;
  } finally {
    state.busy = false;
    $("auth-submit").disabled = false;
  }
}

// ENTRAR NO PAINEL

async function enterDashboard() {
  await loadAccounts();

  $("auth-view").hidden = true;
  $("app-view").hidden = false;

  const customer = state.customer;

  $("customer-name").textContent =
    customer?.name || "Minha conta";

  $("customer-email").textContent =
    customer?.email || "";

  $("customer-initials").textContent =
    (customer?.name || "P").charAt(0).toUpperCase();

  $("account-owner").textContent =
    customer?.name || "Titular";

  showView("overview");
  await loadCurrentAccount();
}

async function loadAccounts() {
  const result = await api.getAccounts();

  state.accounts = result.accounts || [];

  if (!state.accounts.length) {
    throw new Error("Nenhuma conta encontrada.");
  }

  state.currentAccount = state.accounts[0];

  const selector = $("account-selector");
  selector.replaceChildren();

  for (const account of state.accounts) {
    const option = document.createElement("option");

    option.value = String(account.id);
    option.textContent =
      `Conta ${String(account.id).padStart(6, "0")}`;

    selector.appendChild(option);
  }

  selector.value = String(state.currentAccount.id);
}


async function loadCurrentAccount() {
  if (!state.currentAccount) return;

  const accountId = state.currentAccount.id;

  // Invalida carregamentos anteriores.
  const version = ++state.statementVersion;

  state.statementLoading = true;

  try {
    const [accountResult, statementResult] = await Promise.all([
      api.getAccount(accountId),
      api.getStatement(accountId, { limit: 20 })
    ]);

    if (
      version !== state.statementVersion ||
      String(state.currentAccount?.id) !== String(accountId)
    ) {
      return;
    }

    state.currentAccount = accountResult.account;

    // Atualiza também a lista de contas.
    const index = state.accounts.findIndex(
      account => String(account.id) === String(accountId)
    );

    if (index !== -1) {
      state.accounts[index] = accountResult.account;
    }

    state.entries = statementResult.entries || [];

    state.statementCursor =
      statementResult.pagination?.next_cursor ?? null;

    state.statementHasMore =
      statementResult.pagination?.has_more === true;

    renderDashboard();

    if (state.currentView === "accounts") {
      renderAccounts();
    }
  } finally {
    if (version === state.statementVersion) {
      state.statementLoading = false;
      updateLoadMoreButton();
    }
  }
}


// RENDERIZAR SALDO E EXTRATO

function renderDashboard() {
  const account = state.currentAccount;

  if (!account) return;

  $("balance-amount").textContent = state.balanceHidden
    ? "R$ •••••"
    : formatMoney(account.balance_cents);

  const accountNumber =
    String(account.id).padStart(6, "0");

  $("balance-account").textContent =
    `Conta ${accountNumber}`;

  $("account-number").textContent = accountNumber;

  renderStatement();
  renderSummary();
  renderBalanceChart();
}

function transactionName(entry) {
  if (entry.type === "deposit") return "Depósito";
  if (entry.type === "withdrawal") return "Saque";

  if (entry.direction === "credit") {
    return "Transferência recebida";
  }

  return "Transferência enviada";
}

function createCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function createTransactionRow(entry) {
  const row = document.createElement("tr");

  const title = createCell(transactionName(entry));
  const date = createCell(formatDate(entry.created_at));
  const status = createCell("Concluída");

  const isCredit = entry.direction === "credit";
  const amount = formatMoney(entry.amount_cents);

  const value = createCell(
    `${isCredit ? "+" : "-"} ${amount}`
  );

  value.className = isCredit
    ? "amount-credit"
    : "amount-debit";

  row.append(title, date, status, value);

  // Permite abrir o comprovante clicando na linha.
row.tabIndex = 0;
row.setAttribute("role", "button");
row.setAttribute(
  "aria-label",
  `Ver detalhes: ${transactionName(entry)}`
);

// Guarda a conta à qual o lançamento pertence.
const receiptAccountId = state.currentAccount.id;

row.addEventListener("click", () => {
  openTransactionReceipt(entry, receiptAccountId);
});

// Suporte para teclado.
row.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openTransactionReceipt(entry, receiptAccountId);
  }
});

  return row;
}


function renderStatement() {
  const recent = $("recent-activity");
  const statement = $("statement-body");

  recent.replaceChildren();
  statement.replaceChildren();

  const entries = state.entries;

  // Últimos movimentos sem aplicar os filtros do extrato.
  for (const entry of entries.slice(0, 5)) {
    recent.appendChild(createTransactionRow(entry));
  }

  $("recent-empty").hidden = entries.length > 0;

  // Aplica filtros apenas aos lançamentos carregados.
  const filteredEntries = filterStatementEntries();

  for (const entry of filteredEntries) {
    statement.appendChild(createTransactionRow(entry));
  }

  $("statement-empty").hidden =
    filteredEntries.length > 0;

  $("statement-count").textContent =
    `${filteredEntries.length} de ${entries.length} ` +
    "lançamentos carregados" +
    (state.statementHasMore ? " · há mais páginas" : "");

  updateLoadMoreButton();
}


function renderSummary() {
  let credits = 0n;
  let debits = 0n;

  for (const entry of state.entries) {
    const amount = BigInt(entry.amount_cents);

    if (entry.direction === "credit") {
      credits += amount;
    } else {
      debits += amount;
    }
  }

  $("summary-in").textContent = formatMoney(credits);
  $("summary-out").textContent = formatMoney(debits);
  $("summary-count").textContent =
    String(state.entries.length);

  $("summary-caption").textContent =
    "Resumo dos últimos lançamentos carregados";
}

// ==========================================
// BUSCA E FILTROS DO EXTRATO
// ==========================================

// Remove acentos e deixa a busca sem diferenciar maiúsculas.
function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Aplica os filtros aos lançamentos já carregados.
function filterStatementEntries() {
  const search = normalizeSearch(
    $("statement-search").value
  );

  const filter = $("statement-filter").value;

  return state.entries.filter(entry => {
    const type = String(entry.type || "").toLowerCase();

    // Identifica transferências recebidas e enviadas.
    const isTransfer =
      type === "transfer" ||
      type === "transfer_in" ||
      type === "transfer_out" ||
      type === "transfer_credit" ||
      type === "transfer_debit" ||
      type.includes("transfer");

    let matchesType = true;

    if (filter === "deposit") {
      matchesType = type === "deposit";
    } else if (filter === "withdrawal") {
      matchesType = type === "withdrawal";
    } else if (filter === "transfer") {
      matchesType = isTransfer;
    }

    // Busca no nome da operação, data e conta envolvida.
    const searchable = normalizeSearch([
      transactionName(entry),
      entry.type,
      entry.direction,
      entry.counterparty_account_id,
      entry.account_id,
      entry.operation_id,
      formatDate(entry.created_at)
    ].join(" "));

    return matchesType && searchable.includes(search);
  });
}

// ==========================================
// BOTÃO CARREGAR MAIS
// ==========================================

function updateLoadMoreButton() {
  const button = $("load-more-button");

  button.hidden = !state.statementHasMore;
  button.disabled = state.statementLoading;

  button.textContent = state.statementLoading
    ? "Carregando..."
    : "Carregar mais";
}

async function loadMoreStatement() {
  if (
    !state.currentAccount ||
    !state.statementHasMore ||
    state.statementLoading ||
    !state.statementCursor
  ) {
    return;
  }

  const accountId = state.currentAccount.id;
  const version = state.statementVersion;
  const cursor = state.statementCursor;

  state.statementLoading = true;
  updateLoadMoreButton();

  try {
    const result = await api.getStatement(accountId, {
      limit: 20,
      before: cursor
    });

    // Descarta respostas de contas ou carregamentos antigos.
    if (
      version !== state.statementVersion ||
      String(state.currentAccount?.id) !== String(accountId)
    ) {
      return;
    }

    const newEntries = result.entries || [];

    // Impede que um lançamento apareça duas vezes.
    const existingIds = new Set(
      state.entries.map(entry => String(entry.id))
    );

    for (const entry of newEntries) {
      if (!existingIds.has(String(entry.id))) {
        state.entries.push(entry);
        existingIds.add(String(entry.id));
      }
    }

    const nextCursor =
      result.pagination?.next_cursor ?? null;

    // Protege contra repetição da mesma página.
    state.statementHasMore =
      result.pagination?.has_more === true &&
      nextCursor !== null &&
      String(nextCursor) !== String(cursor);

    state.statementCursor = state.statementHasMore
      ? nextCursor
      : null;

    renderDashboard();

  } catch (error) {
    showError(error);
  } finally {
    if (version === state.statementVersion) {
      state.statementLoading = false;
      updateLoadMoreButton();
    }
  }
}
// ==========================================
// EXPORTAÇÃO DO EXTRATO EM CSV
// ==========================================

function exportStatementCSV() {
  if (!state.currentAccount) {
    throw new Error("Nenhuma conta selecionada.");
  }

  const entries = filterStatementEntries();

  if (entries.length === 0) {
    showMessage("Não há movimentações para exportar.", true);
    return;
  }

  // Protege contra quebras de campos e fórmulas no Excel.
  function csvCell(value) {
    let text = String(value ?? "");

    if (/^[\s]*[=+\-@\t\r]/.test(text)) {
      text = "'" + text;
    }

    return `"${text.replace(/"/g, '""')}"`;
  }

  const rows = [
    [
      "Data",
      "Operação",
      "Tipo",
      "Valor (centavos)",
      "Saldo após (centavos)",
      "Conta relacionada",
      "ID do lançamento"
    ]
  ];

  for (const entry of entries) {
    const credit = entry.direction === "credit";

    const amount = BigInt(entry.amount_cents);
    const signedAmount = credit ? amount : -amount;

    rows.push([
      formatDate(entry.created_at),
      transactionName(entry),
      entry.direction,
      signedAmount.toString(),
      String(entry.balance_after_cents ?? ""),
      String(entry.counterparty_account_id ?? ""),
      String(entry.id ?? "")
    ]);
  }

  const csv = rows
    .map(row => row.map(csvCell).join(";"))
    .join("\r\n");

  // BOM facilita o reconhecimento de UTF-8 pelo Excel.
  const blob = new Blob(["\uFEFF", csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;

  const accountId = String(state.currentAccount.id);
  const date = new Date().toISOString().slice(0, 10);

  link.download = `pulso-extrato-conta-${accountId}-${date}.csv`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showMessage("Extrato exportado com sucesso!");
}

//
// ==========================================
// COMPROVANTES HISTÓRICOS
// ==========================================
//

// Abre os detalhes de um lançamento do extrato.
function openTransactionReceipt(entry, accountId) {
  const dialog = $("action-dialog");
  const content = $("dialog-content");

  $("dialog-title").textContent = "Detalhes da movimentação";
  content.replaceChildren();

  const isCredit = entry.direction === "credit";

  const receipt = document.createElement("div");
  receipt.className = "receipt";

  // Ícone do comprovante.
  const hero = document.createElement("div");
  hero.className = "receipt-hero";

  const icon = document.createElement("div");
  icon.className = "receipt-icon";

  const symbol = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg"
  );

  symbol.setAttribute("class", "icon");
  symbol.setAttribute("aria-hidden", "true");

  const use = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "use"
  );

  use.setAttribute("href", "/assets/icons.svg#check");

  symbol.appendChild(use);
  icon.appendChild(symbol);

  const title = document.createElement("h3");
  title.textContent = transactionName(entry);

  const description = document.createElement("p");
  description.textContent =
    "Movimentação registrada no histórico da conta.";

  const amount = document.createElement("div");
  amount.className = "receipt-amount";

  amount.textContent =
    (isCredit ? "+ " : "- ") +
    formatMoney(entry.amount_cents);

  hero.append(
    icon,
    title,
    description,
    amount
  );

  // Detalhes do lançamento.
  const details = document.createElement("dl");
  details.className = "receipt-meta";

  function addReceiptField(label, value) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return;
    }

    const row = document.createElement("div");

    const dt = document.createElement("dt");
    dt.textContent = label;

    const dd = document.createElement("dd");
    dd.textContent = String(value);

    row.append(dt, dd);
    details.appendChild(row);
  }

  const type = String(entry.type || "").toLowerCase();

  const isTransfer = type.includes("transfer");

  addReceiptField(
    "Operação",
    transactionName(entry)
  );

  addReceiptField(
    "Data e hora",
    formatDate(entry.created_at)
  );

  addReceiptField(
    "Conta",
    String(accountId).padStart(6, "0")
  );

  addReceiptField(
    "Tipo de lançamento",
    isCredit ? "Entrada" : "Saída"
  );

  addReceiptField(
    "Valor",
    formatMoney(entry.amount_cents)
  );

  // Mostra a contrapartida apenas quando registrada.
  if (entry.counterparty_account_id != null) {
    addReceiptField(
      isCredit ? "Conta de origem" : "Conta de destino",
      String(entry.counterparty_account_id).padStart(6, "0")
    );
  }

  // O ledger registra o saldo após a operação.
  if (entry.balance_after_cents != null) {
    addReceiptField(
      "Saldo após a movimentação",
      formatMoney(entry.balance_after_cents)
    );
  }

  addReceiptField(
    "ID do lançamento",
    entry.id
  );

  if (entry.operation_id != null) {
    addReceiptField(
      "ID da operação",
      entry.operation_id
    );
  }

  // Aviso sobre a natureza do comprovante.
  const notice = document.createElement("div");
  notice.className = "notice";

  const noticeText = document.createElement("p");
  noticeText.textContent =
    "Este documento apresenta um lançamento registrado " +
    "na conta digital de demonstração. Não representa " +
    "uma transferência Pix real.";

  notice.appendChild(noticeText);

  // Botões.
  const actions = document.createElement("div");
  actions.className = "form-actions";

  const printButton = document.createElement("button");
  printButton.type = "button";
  printButton.className = "button button-secondary";
  printButton.textContent = "Imprimir / Salvar PDF";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "button button-primary";
  closeButton.textContent = "Fechar";

  printButton.addEventListener("click", () => {
    window.print();
  });

  closeButton.addEventListener("click", () => {
    dialog.close();
  });

  actions.append(printButton, closeButton);

  receipt.append(
    hero,
    details,
    notice,
    actions
  );

  content.appendChild(receipt);

  if (!dialog.open) {
    dialog.showModal();
  }
}

//
// ==========================================
// GRÁFICO DE EVOLUÇÃO DO SALDO
// ==========================================
//

function renderBalanceChart() {
  const container = $("balance-chart");
  container.replaceChildren();

  const entries = state.entries
    .filter(entry => entry.balance_after_cents != null)
    .slice(0, 12)
    .reverse();

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent =
      "Faça sua primeira movimentação para visualizar o gráfico.";

    container.appendChild(empty);
    return;
  }

  const balances = entries.map(entry =>
    BigInt(entry.balance_after_cents)
  );

  const min = balances.reduce(
    (a, b) => a < b ? a : b
  );

  const max = balances.reduce(
    (a, b) => a > b ? a : b
  );

  const width = 520;
  const height = 180;
  const padding = 18;

  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const range = max - min;

  // As proporções são apenas coordenadas visuais.
  // O saldo financeiro permanece em BigInt.
  const points = balances.map((balance, index) => {
    const x = entries.length === 1
      ? width / 2
      : padding + (index / (entries.length - 1)) * chartWidth;

    const ratio = range === 0n
      ? 0.5
      : Number(
          ((balance - min) * 1000000n) / range
        ) / 1000000;

    const y = height - padding - ratio * chartHeight;

    return { x, y };
  });

  const pathData = points.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`
  ).join(" ");

  const svgNS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "Evolução do saldo nos últimos lançamentos carregados"
  );

  // Linhas de referência.
  for (let i = 1; i <= 3; i++) {
    const line = document.createElementNS(svgNS, "line");

    const y = padding + (i / 4) * chartHeight;

    line.setAttribute("x1", String(padding));
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", String(width - padding));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-grid");

    svg.appendChild(line);
  }

  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("class", "chart-line");

  svg.appendChild(path);

  // Pontos do gráfico.
  points.forEach((point, index) => {
    const circle = document.createElementNS(svgNS, "circle");

    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", "5");
    circle.setAttribute("class", "chart-dot");

    const tooltip = document.createElementNS(svgNS, "title");
    tooltip.textContent =
      `${formatDate(entries[index].created_at)}: ` +
      formatMoney(balances[index]);

    circle.appendChild(tooltip);
    svg.appendChild(circle);
  });

  const value = document.createElement("div");
  value.className = "chart-value";

  const label = document.createElement("span");
  label.textContent = "Saldo após o último movimento";

  const amount = document.createElement("strong");
  amount.textContent = formatMoney(balances.at(-1));

  value.append(label, amount);

  container.append(value, svg);
}

//
// ==========================================
// CRIAÇÃO DE NOVAS CONTAS
// ==========================================
//

let creatingAccount = false;

async function openNewAccount() {
  if (creatingAccount) return;

  const dialog = $("action-dialog");
  const content = $("dialog-content");

  $("dialog-title").textContent = "Criar nova conta";
  content.replaceChildren();

  const form = document.createElement("form");
  form.className = "form-stack";

  const description = document.createElement("p");
  description.className = "modal-copy";
  description.textContent =
    "Crie uma nova conta digital de demonstração " +
    "vinculada ao seu usuário na Pulso.";

  const notice = document.createElement("p");
  notice.className = "input-hint";
  notice.textContent =
    "A nova conta será criada com saldo inicial de R$ 0,00.";

  const actions = document.createElement("div");
  actions.className = "form-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button button-secondary";
  cancel.textContent = "Cancelar";

  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.className = "button button-primary";
  confirm.textContent = "Criar conta";

  actions.append(cancel, confirm);
  form.append(description, notice, actions);
  content.appendChild(form);

  cancel.addEventListener("click", () => {
    dialog.close();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (creatingAccount) return;

    creatingAccount = true;
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = "Criando conta...";

    try {
      // Cria a conta no servidor.
      const createdResponse = await api.createAccount();

      // Consulta novamente a lista oficial do servidor.
      const response = await api.getAccounts();

      const accounts = response.accounts ??
        response.data?.accounts ??
        (Array.isArray(response.data) ? response.data : null) ??
        (Array.isArray(response) ? response : []);

      if (!Array.isArray(accounts)) {
        throw new Error(
          "O servidor retornou uma lista de contas inválida."
        );
      }

      state.accounts = accounts;
      const selector = $("account-selector");
      selector.replaceChildren();
      for (const account of accounts) {
        const option = document.createElement("option");
        option.value = String(account.id);
        option.textContent = `Conta ${String(account.id).padStart(6, "0")}`;
        selector.appendChild(option);
      }

      // Seleciona a conta mais recente da lista, caso
      // a API devolva as contas ordenadas por ID.
      const createdId = createdResponse?.account?.id ??
        createdResponse?.data?.account?.id ??
        createdResponse?.id ?? null;
      const newestAccount = accounts.find(account =>
        createdId != null && String(account.id) === String(createdId)
      ) ?? accounts.reduce(
        (latest, account) => {
          if (!latest) return account;

          return BigInt(account.id) > BigInt(latest.id)
            ? account
            : latest;
        },
        null
      );

      dialog.close();

      if (newestAccount) {
        state.currentAccount = newestAccount;
        selector.value = String(newestAccount.id);
        await loadCurrentAccount();
      }

      renderAccounts();
      showMessage("Conta criada com sucesso!");

    } catch (error) {
      showError(error);

      // Se a criação ocorreu, mas a atualização falhou,
      // consulte as contas antes de tentar criar outra.
      confirm.textContent = "Consultar contas antes de tentar novamente";
      confirm.disabled = true;

      cancel.disabled = false;
      return;

    } finally {
      creatingAccount = false;
    }
  });

  if (!dialog.open) {
    dialog.showModal();
  }
}

// ==========================================
// MODO CLARO E ESCURO
// ==========================================

const THEME_STORAGE_KEY = "pulso-theme";

function applyTheme(theme) {
  const selectedTheme =
    theme === "dark" ? "dark" : "light";

  document.documentElement.dataset.theme = selectedTheme;

  const button = $("theme-toggle");
  const icon = $("theme-toggle-icon");

  const isDark = selectedTheme === "dark";

  button.setAttribute("aria-pressed", String(isDark));

  button.setAttribute(
    "aria-label",
    isDark ? "Ativar modo claro" : "Ativar modo escuro"
  );

  button.title = isDark
    ? "Ativar modo claro"
    : "Ativar modo escuro";

  icon.textContent = isDark ? "☀" : "☾";
}

function initializeTheme() {
  let savedTheme = "light";

  try {
    savedTheme = localStorage.getItem(THEME_STORAGE_KEY)
      || "light";
  } catch {
    // O modo claro continua disponível.
  }

  applyTheme(savedTheme);

  $("theme-toggle").addEventListener("click", () => {
    const currentTheme =
      document.documentElement.dataset.theme;

    const nextTheme =
      currentTheme === "dark" ? "light" : "dark";

    applyTheme(nextTheme);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // A troca de tema funciona mesmo sem armazenamento.
    }
  });
}

// ==========================================
// INVESTIMENTOS — COTAÇÕES REAIS / SOMENTE CONSULTA
// ==========================================
let marketCache = null;
let marketLoading = false;

const brlQuote = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL"
});

function investmentCard(item) {
  const card = document.createElement("article");
  card.className = "investment-card";

  const head = document.createElement("div");
  head.className = "investment-card-head";
  const ticker = document.createElement("strong");
  ticker.textContent = item.symbol;
  const change = document.createElement("span");
  const pct = Number(item.changePercent);
  change.className = "investment-change " +
    (Number.isFinite(pct) && pct >= 0 ? "up" : "down");
  change.textContent = Number.isFinite(pct)
    ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2).replace(".", ",")}%`
    : "—";
  head.append(ticker, change);

  const name = document.createElement("p");
  name.className = "investment-company";
  name.textContent = item.name || item.symbol;

  const price = document.createElement("div");
  price.className = "investment-price";
  price.textContent = Number.isFinite(Number(item.price))
    ? brlQuote.format(Number(item.price)) : "Cotação indisponível";

  const foot = document.createElement("small");
  foot.className = "investment-timestamp";
  const when = item.marketTime ? new Date(item.marketTime) : null;
  foot.textContent = when && !Number.isNaN(when.getTime())
    ? `Referência: ${when.toLocaleString("pt-BR")}`
    : "Horário de referência não informado";

  card.append(head, name, price, foot);
  return card;
}

async function loadInvestments(force = false) {
  const grid = $("investment-grid");
  const status = $("investment-status");
  const refresh = $("investment-refresh");
  if (!grid || marketLoading) return;

  if (!force && marketCache && Date.now() - marketCache.time < 300000) {
    renderInvestments(marketCache.data);
    return;
  }

  marketLoading = true;
  refresh.disabled = true;
  refresh.classList.add("pulso-busy");
  status.textContent = "Consultando preços de mercado...";

  try {
    const response = await fetch("/api/market/quotes", {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = error.error?.message || error.message ||
        `Falha ao consultar cotações (HTTP ${response.status}).`;
      throw new Error(message);
    }
    const data = await response.json();
    if (!Array.isArray(data.quotes)) {
      throw new Error("O servidor retornou dados de mercado inválidos.");
    }
    marketCache = { time: Date.now(), data };
    renderInvestments(data);
  } catch (error) {
    if (marketCache) {
      renderInvestments(marketCache.data);
      status.textContent += " · Última consulta disponível (sem atualização)";
    } else {
      grid.replaceChildren();
      status.textContent = error.message;
    }
  } finally {
    marketLoading = false;
    refresh.disabled = false;
    refresh.classList.remove("pulso-busy");
  }
}

function renderInvestments(data) {
  const grid = $("investment-grid");
  grid.replaceChildren();
  for (const quote of data.quotes) grid.appendChild(investmentCard(quote));
  $("investment-status").textContent =
    `Fonte: brapi.dev · ${data.quotes.length} ativos · ` +
    `Consulta: ${new Date(data.fetchedAt).toLocaleString("pt-BR")}` +
    (data.partial ? " · Alguns preços indisponíveis" : "");
}

// NAVEGAÇÃO

function showView(view) {
  state.currentView = view;

  const views = ["overview", "statement", "accounts", "investments"];

  for (const name of views) {
    $(`${name}-view`).hidden = name !== view;
  }

  const titles = {
    overview: "Visão geral",
    statement: "Seu extrato",
    accounts: "Minhas contas",
    investments: "Investimentos"
  };

  $("page-title").textContent = titles[view];

  document.querySelectorAll("[data-view]").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);

    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  if (view === "accounts") renderAccounts();
  if (view === "investments") loadInvestments();
}

function renderAccounts() {
  const grid = $("account-grid");
  grid.replaceChildren();

  for (const account of state.accounts) {
    const card = document.createElement("article");
    card.className = "account-card";

    const title = document.createElement("h3");
    title.textContent =
      `Conta ${String(account.id).padStart(6, "0")}`;

    const balance = document.createElement("p");
    balance.className = "account-card-balance";
    balance.textContent = formatMoney(account.balance_cents);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-secondary";
    button.textContent = "Selecionar conta";

    button.addEventListener("click", async () => {
      await selectAccount(account.id);
      showView("overview");
    });

    card.append(title, balance, button);
    grid.appendChild(card);
  }
}

async function selectAccount(id) {
  const account = state.accounts.find(
    item => String(item.id) === String(id)
  );

  if (!account) return;

  state.currentAccount = account;
  $("account-selector").value = String(account.id);

  await loadCurrentAccount();
}

function logout() {
  api.logout();

  state.customer = null;
  state.accounts = [];
  state.currentAccount = null;
  state.entries = [];
  state.statementVersion++;
state.statementCursor = null;
state.statementHasMore = false;
state.statementLoading = false;

$("statement-search").value = "";
$("statement-filter").value = "all";

  $("app-view").hidden = true;
  $("auth-view").hidden = false;
  $("auth-password").value = "";

  showMessage("Você saiu da sua conta.");
}

const pendingDeposits = new Map();

// Abre uma janela de depósito.
function openDeposit() {
  if (!state.currentAccount) {
    showMessage("Selecione uma conta primeiro.", true);
    return;
  }

  const dialog = $("action-dialog");
  const content = $("dialog-content");

  $("dialog-title").textContent = "Adicionar saldo";
  content.replaceChildren();

  const form = document.createElement("form");
  form.className = "form-stack";

  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = "deposit-amount";
  label.textContent = "Quanto deseja adicionar?";

  const input = document.createElement("input");
  input.id = "deposit-amount";
  input.className = "input";
  input.type = "text";
  input.inputMode = "decimal";
  input.placeholder = "Exemplo: 150,00";
  input.required = true;

  const info = document.createElement("p");
  info.className = "input-hint";
  info.textContent =
    "Este é um depósito fictício para testar sua API.";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button button-primary";
  submit.textContent = "Revisar depósito";

  form.append(label, input, info, submit);
  content.appendChild(form);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    try {
      const amountCents = parseMoney(input.value);

      reviewDeposit(
        String(state.currentAccount.id),
        amountCents
      );
    } catch (error) {
      showError(error);
    }
  });

  if (!dialog.open) {
  dialog.showModal();
}
  input.focus();
}

// Mostra o valor antes de confirmar.
function reviewDeposit(accountId, amountCents) {
  const content = $("dialog-content");
  content.replaceChildren();

  const title = document.createElement("p");
  title.className = "review-heading";
  title.textContent =
    "Confira os dados antes de confirmar.";

  const total = document.createElement("div");
  total.className = "review-total";
  total.textContent = formatMoney(amountCents);

  const details = document.createElement("p");
  details.className = "modal-copy";
  details.textContent =
    `Depósito fictício na conta ${accountId}.`;

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "button button-primary";
  confirm.textContent = "Confirmar depósito";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "button button-secondary";
  back.textContent = "Voltar";

  const actions = document.createElement("div");
  actions.className = "form-actions";
  actions.append(back, confirm);

  content.append(title, total, details, actions);

  back.addEventListener("click", openDeposit);

  confirm.addEventListener("click", async () => {
    setButtonBusy(confirm, true);
    back.disabled = true;

    const operationKey = `${accountId}:${amountCents}`;

    let key = pendingDeposits.get(operationKey);

    if (!key) {
      key = api.generateIdempotencyKey();
      pendingDeposits.set(operationKey, key);
    }

    try {
      const result = await api.deposit(
        accountId,
        amountCents,
        key
      );

      // A API confirmou a operação.
      pendingDeposits.delete(operationKey);

      // Fecha a janela sem apagar o resultado financeiro.
      $("action-dialog").close();

      showMessage(
        result.replayed
          ? "Depósito já realizado anteriormente."
          : "Depósito realizado com sucesso!"
      );

      // Busca novamente o saldo e o extrato no banco.
      await loadCurrentAccount();

    } catch (error) {
      // Preserva a chave para permitir repetir
      // a mesma solicitação sem duplicar o depósito.
      showError(error);

      setButtonBusy(confirm, false);
      back.disabled = false;
      confirm.textContent = "Verificar / tentar novamente";
    }
  });
}

//
// =========================================
// TRANSFERÊNCIA ENTRE CONTAS
// =========================================
//

// Mantém a mesma chave quando precisamos repetir
// uma operação cujo resultado ainda é incerto.
let pendingTransfer = null;

function openTransfer() {
  if (!state.currentAccount) {
    showMessage("Selecione uma conta primeiro.", true);
    return;
  }

  if (pendingTransfer) {
    showMessage(
      "Existe uma transferência pendente de verificação. " +
      "Não inicie outra antes de verificar o resultado.",
      true
    );
    return;
  }

  const dialog = $("action-dialog");
  const content = $("dialog-content");

  $("dialog-title").textContent = "Nova transferência";
  content.replaceChildren();

  const form = document.createElement("form");
  form.className = "form-stack";

  // Conta de origem
  const source = document.createElement("div");
  source.className = "movement-source";

  const sourceText = document.createElement("div");

  const sourceTitle = document.createElement("strong");
  sourceTitle.textContent = "Conta de origem";

  const sourceNumber = document.createElement("span");
  sourceNumber.textContent =
    `Conta ${String(state.currentAccount.id).padStart(6, "0")}`;

  sourceText.append(sourceTitle, sourceNumber);
  source.append(sourceText);

  // Campo de destino
  const destinationField = document.createElement("div");
  destinationField.className = "field";

  const destinationLabel = document.createElement("label");
  destinationLabel.className = "field-label";
  destinationLabel.htmlFor = "transfer-destination";
  destinationLabel.textContent = "Conta de destino";

  const destinationInput = document.createElement("input");
  destinationInput.id = "transfer-destination";
  destinationInput.className = "input";
  destinationInput.type = "text";
  destinationInput.inputMode = "numeric";
  destinationInput.placeholder = "Exemplo: 000002";
  destinationInput.required = true;

  destinationField.append(
    destinationLabel,
    destinationInput
  );

  // Campo de valor
  const amountField = document.createElement("div");
  amountField.className = "field";

  const amountLabel = document.createElement("label");
  amountLabel.className = "field-label";
  amountLabel.htmlFor = "transfer-amount";
  amountLabel.textContent = "Valor da transferência";

  const amountInput = document.createElement("input");
  amountInput.id = "transfer-amount";
  amountInput.className = "input";
  amountInput.type = "text";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "Exemplo: 50,00";
  amountInput.required = true;

  amountField.append(amountLabel, amountInput);

  const info = document.createElement("p");
  info.className = "input-hint";
  info.textContent =
    "Transferência fictícia entre contas da Pulso.";

  const button = document.createElement("button");
  button.className = "button button-primary";
  button.type = "submit";
  button.textContent = "Revisar transferência";

  form.append(
    source,
    destinationField,
    amountField,
    info,
    button
  );

  content.appendChild(form);

  const fromAccountId = String(state.currentAccount.id);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    try {
      const toAccountId = destinationInput.value.trim();

      if (!/^[1-9]\d*$/.test(toAccountId)) {
        throw new Error("Informe uma conta de destino válida.");
      }

      if (!Number.isSafeInteger(Number(toAccountId))) {
        throw new Error("Número de conta fora do limite.");
      }

      if (BigInt(toAccountId) === BigInt(fromAccountId)) {
        throw new Error(
          "Você não pode transferir para a mesma conta."
        );
      }

      const amountCents = parseMoney(amountInput.value);

      if (
        BigInt(amountCents) >
        BigInt(state.currentAccount.balance_cents)
      ) {
        throw new Error(
          "Saldo insuficiente para esta transferência."
        );
      }

      reviewTransfer({
        fromAccountId,
        toAccountId,
        amountCents
      });
    } catch (error) {
      showError(error);
    }
  });

  if (!dialog.open) {
    dialog.showModal();
  }

  destinationInput.focus();
}

// =========================================
// REVISÃO DA TRANSFERÊNCIA
// =========================================

function reviewTransfer({
  fromAccountId,
  toAccountId,
  amountCents
}) {
  const content = $("dialog-content");
  content.replaceChildren();

  $("dialog-title").textContent = "Revisar transferência";

  const heading = document.createElement("p");
  heading.className = "review-heading";
  heading.textContent =
    "Confira os dados antes de movimentar seu saldo.";

  const total = document.createElement("div");
  total.className = "review-total";
  total.textContent = formatMoney(amountCents);

  const details = document.createElement("dl");
  details.className = "review-list";

  function addDetail(label, value) {
    const row = document.createElement("div");
    row.className = "review-row";

    const term = document.createElement("dt");
    term.textContent = label;

    const description = document.createElement("dd");
    description.textContent = value;

    row.append(term, description);
    details.appendChild(row);
  }

  addDetail("Operação", "Transferência interna");
  addDetail("Origem", `Conta ${fromAccountId}`);
  addDetail("Destino", `Conta ${toAccountId}`);
  addDetail("Valor", formatMoney(amountCents));

  const notice = document.createElement("p");
  notice.className = "modal-copy";
  notice.textContent =
    "Depois de confirmar, o valor será debitado da " +
    "origem e creditado no destino na mesma transação SQL.";

  const actions = document.createElement("div");
  actions.className = "form-actions";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "button button-secondary";
  back.textContent = "Voltar";

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "button button-primary";
  confirm.textContent = "Confirmar transferência";

  actions.append(back, confirm);

  content.append(heading, total, details, notice, actions);

  back.addEventListener("click", () => {
    openTransfer();
  });

  confirm.addEventListener("click", async () => {
    if (pendingTransfer) return;

    const operation = {
      fromAccountId,
      toAccountId,
      amountCents,
      idempotencyKey: api.generateIdempotencyKey()
    };

    pendingTransfer = operation;

    await submitTransfer(operation, confirm, back);
  });
}

// =========================================
// ENVIO DA TRANSFERÊNCIA
// =========================================

async function submitTransfer(operation, confirm, back) {
  setButtonBusy(confirm, true);
  back.disabled = true;

  try {
    const result = await api.transfer(operation);

    // O servidor confirmou o resultado.
    pendingTransfer = null;

    const content = $("dialog-content");
    content.replaceChildren();

    $("dialog-title").textContent = "Comprovante";

    const receipt = document.createElement("div");
    receipt.className = "receipt";

    const hero = document.createElement("div");
    hero.className = "receipt-hero";

    const title = document.createElement("h3");
    title.textContent = result.replayed
      ? "Transferência já confirmada"
      : "Transferência concluída!";

    const amount = document.createElement("div");
    amount.className = "receipt-amount";
    amount.textContent = formatMoney(operation.amountCents);

    const message = document.createElement("p");
    message.textContent = "Operação realizada com sucesso.";

    hero.append(title, amount, message);

    const details = document.createElement("dl");
    details.className = "receipt-meta";

    const fields = [
      ["Origem", `Conta ${operation.fromAccountId}`],
      ["Destino", `Conta ${operation.toAccountId}`],
      ["Valor", formatMoney(operation.amountCents)],
      ["Status", "Concluída"]
    ];

    for (const [label, value] of fields) {
      const row = document.createElement("div");

      const dt = document.createElement("dt");
      dt.textContent = label;

      const dd = document.createElement("dd");
      dd.textContent = value;

      row.append(dt, dd);
      details.appendChild(row);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "button button-primary";
    close.textContent = "Concluir";

    close.addEventListener("click", () => {
      $("action-dialog").close();
    });

    receipt.append(hero, details, close);
    content.appendChild(receipt);

    try {
      await loadCurrentAccount();
    } catch (refreshError) {
      showError(refreshError);
    }

    showMessage("Transferência confirmada!");

  } catch (error) {
    showError(error);

    // Não gerar outra chave automaticamente.
    // Em falhas de comunicação, o resultado pode ser incerto.
    // Substitui o botão para evitar disparo do listener antigo.
    // A repetição usa exatamente a mesma chave de idempotência.
    const retry = confirm.cloneNode(false);
    retry.classList.remove("pulso-busy");
    retry.disabled = false;
    retry.removeAttribute("aria-busy");
    retry.textContent = "Verificar / tentar novamente";
    confirm.replaceWith(retry);
    back.disabled = true;
    retry.addEventListener("click", () => {
      submitTransfer(operation, retry, back);
    }, { once: true });
  }
}
// ==========================================
// SAQUE
// ==========================================

let pendingWithdrawal = null;

function openWithdrawal() {
  if (!state.currentAccount) {
    showMessage("Selecione uma conta primeiro.", true);
    return;
  }

  if (pendingWithdrawal) {
    showMessage(
      "Existe um saque pendente. Verifique o resultado antes de iniciar outro.",
      true
    );
    return;
  }

  const accountId = String(state.currentAccount.id);
  const dialog = $("action-dialog");
  const content = $("dialog-content");

  $("dialog-title").textContent = "Sacar dinheiro";
  content.replaceChildren();

  const form = document.createElement("form");
  form.className = "form-stack";

  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = "withdrawal-amount";
  label.textContent = "Quanto deseja sacar?";

  const input = document.createElement("input");
  input.id = "withdrawal-amount";
  input.className = "input";
  input.type = "text";
  input.inputMode = "decimal";
  input.placeholder = "Exemplo: 25,00";
  input.required = true;

  const balance = document.createElement("p");
  balance.className = "input-hint";
  balance.textContent =
    `Saldo disponível: ${formatMoney(state.currentAccount.balance_cents)}`;

  const info = document.createElement("p");
  info.className = "input-hint";
  info.textContent =
    "Saque fictício para testar sua conta digital.";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button button-primary";
  submit.textContent = "Revisar saque";

  form.append(label, input, balance, info, submit);
  content.appendChild(form);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    try {
      const amountCents = parseMoney(input.value);

      if (
        BigInt(amountCents) >
        BigInt(state.currentAccount.balance_cents)
      ) {
        throw new Error("Saldo insuficiente para o saque.");
      }

      reviewWithdrawal(accountId, amountCents);
    } catch (error) {
      showError(error);
    }
  });

  if (!dialog.open) {
    dialog.showModal();
  }

  input.focus();
}

function reviewWithdrawal(accountId, amountCents) {
  const content = $("dialog-content");
  content.replaceChildren();

  $("dialog-title").textContent = "Revisar saque";

  const heading = document.createElement("p");
  heading.className = "review-heading";
  heading.textContent = "Confira o valor antes de confirmar.";

  const total = document.createElement("div");
  total.className = "review-total";
  total.textContent = formatMoney(amountCents);

  const description = document.createElement("p");
  description.className = "modal-copy";
  description.textContent =
    `O valor será retirado da conta ${accountId}.`;

  const actions = document.createElement("div");
  actions.className = "form-actions";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "button button-secondary";
  back.textContent = "Voltar";

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "button button-primary";
  confirm.textContent = "Confirmar saque";

  actions.append(back, confirm);
  content.append(heading, total, description, actions);

  back.addEventListener("click", openWithdrawal);

  confirm.addEventListener("click", async () => {
    if (pendingWithdrawal) return;

    pendingWithdrawal = {
      accountId,
      amountCents,
      idempotencyKey: api.generateIdempotencyKey()
    };

    await submitWithdrawal(pendingWithdrawal);
  });
}

async function submitWithdrawal(operation) {
  const content = $("dialog-content");

  // Impede novos cliques enquanto a requisição acontece.
  content.replaceChildren();

  const status = document.createElement("p");
  status.className = "modal-copy";
  status.textContent = "Processando saque...";
  status.classList.add("pulso-loading-message");

  content.appendChild(status);

  try {
    const result = await api.withdraw(
      operation.accountId,
      operation.amountCents,
      operation.idempotencyKey
    );

    // A operação foi confirmada pelo servidor.
    pendingWithdrawal = null;

    content.replaceChildren();
    $("dialog-title").textContent = "Comprovante de saque";

    const receipt = document.createElement("div");
    receipt.className = "receipt";

    const hero = document.createElement("div");
    hero.className = "receipt-hero";

    const title = document.createElement("h3");
    title.textContent = result.replayed
      ? "Saque já confirmado"
      : "Saque concluído!";

    const amount = document.createElement("div");
    amount.className = "receipt-amount";
    amount.textContent = formatMoney(operation.amountCents);

    const message = document.createElement("p");
    message.textContent = "Operação fictícia concluída.";

    hero.append(title, amount, message);

    const details = document.createElement("dl");
    details.className = "receipt-meta";

    for (const [label, value] of [
      ["Operação", "Saque"],
      ["Conta", operation.accountId],
      ["Valor", formatMoney(operation.amountCents)],
      ["Status", "Concluída"]
    ]) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");

      term.textContent = label;
      description.textContent = value;

      row.append(term, description);
      details.appendChild(row);
    }

    const finish = document.createElement("button");
    finish.type = "button";
    finish.className = "button button-primary";
    finish.textContent = "Concluir";

    finish.addEventListener("click", () => {
      $("action-dialog").close();
    });

    receipt.append(hero, details, finish);
    content.appendChild(receipt);

    try {
      await loadCurrentAccount();
    } catch (error) {
      showError(error);
    }

    showMessage("Saque confirmado!");

  } catch (error) {
    showError(error);

    content.replaceChildren();

    const warning = document.createElement("p");
    warning.className = "modal-copy";
    warning.textContent =
      "Não foi possível confirmar o resultado. " +
      "Verifique a operação usando a mesma chave.";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button button-primary";
    retry.textContent = "Verificar / tentar novamente";

    retry.addEventListener("click", () => {
      submitWithdrawal(operation);
    }, { once: true });

    content.append(warning, retry);
  }
}
// INICIAR O SITE


function initialize() {
  // ==========================================
  // LOGIN E CADASTRO
  // ==========================================
initializeTheme();
  $("auth-tab-login").addEventListener("click", () => {
    changeAuthMode("login");
  });

  $("auth-tab-register").addEventListener("click", () => {
    changeAuthMode("register");
  });

  $("auth-form").addEventListener("submit", handleAuth);

  $("password-toggle").addEventListener("click", () => {
    const input = $("auth-password");

    input.type = input.type === "password"
      ? "text"
      : "password";
  });

  // ==========================================
  // SELEÇÃO DE CONTA
  // ==========================================

  $("account-selector").addEventListener("change", async (event) => {
    try {
      await selectAccount(event.target.value);
    } catch (error) {
      showError(error);
    }
  });

  // ==========================================
  // ATUALIZAR SALDO E EXTRATO
  // ==========================================

  $("refresh-button").addEventListener("click", async () => {
    const button = $("refresh-button");
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      await loadCurrentAccount();
      showMessage("Saldo e extrato atualizados.");
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  });

  // ==========================================
  // MOSTRAR OU OCULTAR SALDO
  // ==========================================

  $("balance-visibility").addEventListener("click", () => {
    state.balanceHidden = !state.balanceHidden;

    $("balance-visibility").setAttribute(
      "aria-pressed",
      String(state.balanceHidden)
    );

    renderDashboard();
  });

  // ==========================================
  // COPIAR NÚMERO DA CONTA
  // ==========================================

  $("copy-account-button").addEventListener("click", async () => {
    if (!state.currentAccount) {
      showMessage("Selecione uma conta primeiro.", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(
        String(state.currentAccount.id)
      );

      showMessage("Número da conta copiado.");
    } catch {
      showMessage("Não foi possível copiar.", true);
    }
  });

  // ==========================================
  // NAVEGAÇÃO ENTRE TELAS
  // ==========================================

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      showView(button.dataset.view);
    });
  });

  // ==========================================
  // SAIR DA CONTA
  // ==========================================

  document.querySelectorAll('[data-action="logout"]').forEach(button => {
    button.addEventListener("click", logout);
  });

  // ==========================================
  // DEPÓSITO
  // ==========================================

  document.querySelectorAll(
    '[data-action="deposit"]'
  ).forEach(button => {
    button.addEventListener("click", openDeposit);
  });

  // ==========================================
  // TRANSFERÊNCIA
  // ==========================================

  document.querySelectorAll(
    '[data-action="transfer"]'
  ).forEach(button => {
    button.addEventListener("click", openTransfer);
  });

  // ==========================================
  // SAQUE
  // ==========================================

  document.querySelectorAll(
    '[data-action="withdrawal"]'
  ).forEach(button => {
    button.addEventListener("click", openWithdrawal);
  });

  // ==========================================
  // FECHAR JANELA DE OPERAÇÕES
  // ==========================================

  $("dialog-close").addEventListener("click", () => {
    $("action-dialog").close();
  });

  // ==========================================
  // BOTÃO DE DEMONSTRAÇÃO
  // ==========================================

  $("demo-button").addEventListener("click", () => {
    showMessage(
      "Crie uma conta de teste para explorar o painel."
    );
  });

  // ==========================================
  // CRIAR NOVA CONTA
  // ==========================================

  $("new-account-button").addEventListener(
    "click",
    openNewAccount
  );

  // ==========================================
  // EXPORTAR EXTRATO CSV
  // ==========================================

  $("export-button").addEventListener("click", () => {
    try {
      exportStatementCSV();
    } catch (error) {
      showError(error);
    }
  });

  // ==========================================
  // BUSCA NO EXTRATO
  // ==========================================

  $("statement-search").disabled = false;

  $("statement-search").addEventListener("input", () => {
    renderStatement();
  });

  // ==========================================
  // FILTRO DO EXTRATO
  // ==========================================

  $("statement-filter").disabled = false;

  $("statement-filter").addEventListener("change", () => {
    renderStatement();
  });

  // ==========================================
  // PAGINAÇÃO DO EXTRATO
  // ==========================================

  $("load-more-button").addEventListener("click", () => {
    loadMoreStatement();
  });

  $("investment-refresh").addEventListener("click", () => {
    loadInvestments(true);
  });

  // ==========================================
  // DATA ATUAL
  // ==========================================

  $("current-date").textContent =
    new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "full"
    }).format(new Date());

  // ==========================================
  // VERIFICAR CONEXÃO COM MYSQL
  // ==========================================

  api.checkDatabase()
    .then(() => {
      document.querySelectorAll("[data-health-status]")
        .forEach(element => {
          element.textContent = "Sistema conectado";
          element.dataset.status = "up";
        });
    })
    .catch(() => {
      document.querySelectorAll("[data-health-status]")
        .forEach(element => {
          element.textContent = "Banco indisponível";
          element.dataset.status = "down";
        });
    });
}

// ==========================================
// INICIAR A APLICAÇÃO
// ==========================================

initialize();
