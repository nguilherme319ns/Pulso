
const API_BASE = "";

// ==========================================
// CONFIGURAÇÃO E AUTENTICAÇÃO
// ==========================================

// O token fica na memória.
// Ao atualizar a página, será necessário fazer login novamente.
let token = null;

export function setToken(novoToken) {
  token = novoToken || null;
}

export function getToken() {
  return token;
}

export function clearToken() {
  token = null;
}

// ==========================================
// VALIDAÇÃO DE VALORES FINANCEIROS
// ==========================================

// A API espera amount_cents como número inteiro.
// BigInt evita perder precisão durante a validação.
function validAmount(amountCents) {
  let amount;

  try {
    if (
      typeof amountCents === "number" &&
      !Number.isSafeInteger(amountCents)
    ) {
      throw new Error("Valor inválido.");
    }

    amount = BigInt(amountCents);
  } catch {
    throw new Error(
      "O valor deve ser um número inteiro de centavos."
    );
  }

  if (
    amount <= 0n ||
    amount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      "O valor deve ser positivo e estar dentro do limite permitido."
    );
  }

  return Number(amount);
}

// Valida IDs de contas.
function validAccountId(accountId) {
  const value = String(accountId);

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Número da conta inválido.");
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    throw new Error("Número da conta fora do limite.");
  }

  return number;
}

// ==========================================
// COMUNICAÇÃO HTTP
// ==========================================

async function request(endpoint, options = {}) {
  const {
    method = "GET",
    body,
    idempotencyKey,
    signal
  } = options;

  const headers = {
    Accept: "application/json"
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  let response;

  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body),
      signal,
      cache: "no-store"
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw error;
    }

    const connectionError = new Error(
      "Não foi possível conectar ao servidor. Verifique se o npm run dev está ativo."
    );

    connectionError.code = "CONNECTION_ERROR";

    throw connectionError;
  }

  const contentType =
    response.headers.get("content-type") || "";

  let data;

  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "O servidor retornou um JSON inválido."
      );
    }
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const message =
      (typeof data === "object" && data !== null
        ? data.error?.message || data.message
        : null) ||
      `Erro HTTP ${response.status}`;

    const error = new Error(message);

    error.status = response.status;
    error.code =
      typeof data === "object" && data !== null
        ? data.error?.code || "API_ERROR"
        : "API_ERROR";

    throw error;
  }

  return data;
}

// ==========================================
// STATUS DO SERVIDOR
// ==========================================

export async function checkHealth() {
  return request("/health");
}

export async function checkDatabase() {
  return request("/ready");
}

// ==========================================
// CADASTRO
// ==========================================

export async function register({
  name,
  email,
  password
}) {
  return request("/auth/register", {
    method: "POST",
    body: {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password
    }
  });
}

// ==========================================
// LOGIN
// ==========================================

export async function login({
  email,
  password
}) {
  const response = await request("/auth/login", {
    method: "POST",
    body: {
      email: email.trim().toLowerCase(),
      password
    }
  });

  const result = response.data ?? response;

  const receivedToken =
    result.token ??
    result.access_token ??
    result.accessToken;

  if (!receivedToken) {
    throw new Error(
      "O servidor não retornou um token de autenticação."
    );
  }

  setToken(receivedToken);

  return response;
}

// ==========================================
// LOGOUT
// ==========================================

export function logout() {
  clearToken();
}

// ==========================================
// CONTAS
// ==========================================

export async function getAccounts() {
  return request("/accounts");
}

export async function getAccount(accountId) {
  const id = validAccountId(accountId);

  return request(`/accounts/${id}`);
}

export async function createAccount() {
  return request("/accounts", {
    method: "POST",
    body: {}
  });
}

// ==========================================
// EXTRATO
// ==========================================

export async function getStatement(
  accountId,
  { limit = 20, before = null } = {}
) {
  const id = validAccountId(accountId);

  const params = new URLSearchParams();

  params.set("limit", String(limit));

  if (before !== null && before !== undefined) {
    params.set("before", String(before));
  }

  return request(
    `/accounts/${id}/statement?${params.toString()}`
  );
}

// ==========================================
// IDEMPOTÊNCIA
// ==========================================

// Gere uma chave para cada NOVA operação.
// Se uma resposta se perder, reutilize a mesma
// chave e os mesmos dados na tentativa seguinte.
export function generateIdempotencyKey() {
  return crypto.randomUUID();
}

function requireIdempotencyKey(key) {
  if (
    typeof key !== "string" ||
    !key.trim()
  ) {
    throw new Error(
      "A chave de idempotência é obrigatória."
    );
  }

  return key;
}

// ==========================================
// DEPÓSITO
// ==========================================

export async function deposit(
  accountId,
  amountCents,
  idempotencyKey
) {
  const id = validAccountId(accountId);
  const amount = validAmount(amountCents);
  const key = requireIdempotencyKey(idempotencyKey);

  return request(`/accounts/${id}/deposits`, {
    method: "POST",
    idempotencyKey: key,
    body: {
      amount_cents: amount
    }
  });
}

// ==========================================
// SAQUE
// ==========================================

export async function withdraw(
  accountId,
  amountCents,
  idempotencyKey
) {
  const id = validAccountId(accountId);
  const amount = validAmount(amountCents);
  const key = requireIdempotencyKey(idempotencyKey);

  return request(`/accounts/${id}/withdrawals`, {
    method: "POST",
    idempotencyKey: key,
    body: {
      amount_cents: amount
    }
  });
}

// ==========================================
// TRANSFERÊNCIA
// ==========================================

export async function transfer({
  fromAccountId,
  toAccountId,
  amountCents,
  idempotencyKey
}) {
  const fromId = validAccountId(fromAccountId);
  const toId = validAccountId(toAccountId);

  if (fromId === toId) {
    throw new Error(
      "A conta de origem e a de destino devem ser diferentes."
    );
  }

  const amount = validAmount(amountCents);
  const key = requireIdempotencyKey(idempotencyKey);

  return request("/transfers", {
    method: "POST",
    idempotencyKey: key,
    body: {
      from_account_id: fromId,
      to_account_id: toId,
      amount_cents: amount
    }
  });
}
