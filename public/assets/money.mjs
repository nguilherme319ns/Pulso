
const formatadorBRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL"
});

// Converte centavos para um valor exibido em reais.
// Aceita números inteiros seguros, strings ou bigint.
export function formatMoney(centavos) {
  const valor = BigInt(centavos);

  const negativo = valor < 0n;
  const absoluto = negativo ? -valor : valor;

  const reais = absoluto / 100n;
  const centavosRestantes = absoluto % 100n;

  const numeroFormatado = reais
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  const sinal = negativo ? "-" : "";

  return `${sinal}R$ ${numeroFormatado},${centavosRestantes
    .toString()
    .padStart(2, "0")}`;
}

// Converte um valor digitado pelo usuário para centavos.
// Exemplos: "10", "10,50", "1.250,90"
export function parseMoney(entrada) {
  const texto = String(entrada).trim();

  const padrao = /^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/;

  if (!padrao.test(texto)) {
    throw new Error(
      "Digite um valor válido. Exemplo: 125,90"
    );
  }

  const normalizado = texto.replace(/\./g, "");
  const [reais, centavos = ""] = normalizado.split(",");

  const resultado =
    BigInt(reais) * 100n +
    BigInt(centavos.padEnd(2, "0") || "0");

  if (resultado <= 0n) {
    throw new Error("O valor deve ser maior que zero.");
  }

  if (resultado > 9223372036854775807n) {
    throw new Error("Valor acima do limite permitido.");
  }

  // String preserva a precisão de inteiros grandes no JSON.
  return resultado.toString();
}

// Soma valores em centavos sem usar ponto flutuante.
export function sumMoney(valores) {
  return valores.reduce(
    (total, valor) => total + BigInt(valor),
    0n
  );
}

// Exibe data e hora no padrão brasileiro.
export function formatDate(data) {
  if (!data) return "—";

  const date = new Date(data);

  if (Number.isNaN(date.getTime())) {
    return "Data indisponível";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

// Mantém somente texto válido para usar em campos.
export function safeText(valor) {
  return String(valor ?? "").trim();
}

// Compatibilidade para valores que a API recebe como inteiros.
export function isValidCents(valor) {
  try {
    return BigInt(valor) > 0n;
  } catch {
    return false;
  }
}
