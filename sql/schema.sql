-- MySQL 8.0.16+ / InnoDB. Execute com o banco da aplicação selecionado.
-- A aplicação mantém inteiros exatos no intervalo seguro do JSON/JavaScript.

CREATE TABLE IF NOT EXISTS customers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_accounts_customer (customer_id, id),
  CONSTRAINT fk_accounts_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT chk_accounts_balance CHECK (balance_cents BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type ENUM('deposit', 'withdrawal', 'transfer') NOT NULL,
  idempotency_account_id INT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_account_id INT UNSIGNED NULL,
  to_account_id INT UNSIGNED NULL,
  amount_cents BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_operations_idempotency (idempotency_account_id, idempotency_key),
  KEY ix_operations_from_account (from_account_id),
  KEY ix_operations_to_account (to_account_id),
  CONSTRAINT fk_operations_scope FOREIGN KEY (idempotency_account_id) REFERENCES accounts (id),
  CONSTRAINT fk_operations_from FOREIGN KEY (from_account_id) REFERENCES accounts (id),
  CONSTRAINT fk_operations_to FOREIGN KEY (to_account_id) REFERENCES accounts (id),
  CONSTRAINT chk_operations_amount CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_operations_shape CHECK (
    (type = 'deposit' AND from_account_id IS NULL AND to_account_id IS NOT NULL
      AND idempotency_account_id = to_account_id)
    OR (type = 'withdrawal' AND from_account_id IS NOT NULL AND to_account_id IS NULL
      AND idempotency_account_id = from_account_id)
    OR (type = 'transfer' AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL
      AND from_account_id <> to_account_id AND idempotency_account_id = from_account_id)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id INT UNSIGNED NOT NULL,
  direction ENUM('debit', 'credit') NOT NULL,
  amount_cents BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_operation_account (operation_id, account_id),
  KEY ix_ledger_account_cursor (account_id, id),
  CONSTRAINT fk_ledger_operation FOREIGN KEY (operation_id) REFERENCES operations (id),
  CONSTRAINT fk_ledger_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT chk_ledger_direction CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT chk_ledger_amount CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_ledger_balance CHECK (balance_after_cents BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- O setup identifica triggers já existentes, sem apagá-las ou abrir uma janela
-- sem proteção. DDL administrativo (DROP/TRUNCATE) exige privilégios separados.
CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'operations is append-only';

CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'operations is append-only';

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only';

CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only';
