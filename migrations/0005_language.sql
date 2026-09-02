-- Language is a property of the PERSON, not the country.
--
-- The first markets are US/Canada and UK/Ireland/Australia/NZ, with Spanish
-- needed alongside English. That Spanish is not a Latin America thing — it is
-- inside the US, where a single operator's client list routinely mixes English
-- and Spanish speakers. Deriving message language from the operator's country
-- would text every one of those clients in English.
--
-- So: the operator picks their own interface language, and each client can
-- carry their own. A client with none inherits the operator's.

ALTER TABLE operators ADD COLUMN language TEXT NOT NULL DEFAULT 'en';

-- NULL means "use the operator's language" rather than a guess.
ALTER TABLE clients ADD COLUMN language TEXT;

-- Used when picking who to offer to; keeps the column cheap to read.
CREATE INDEX idx_clients_language ON clients (operator_id, language);
