-- Un envoi est réservé par le passage qui le prend : tant que `claimed_until` (UTC) est dans le futur, aucun
-- autre passage ne le prend, et deux passages qui se croisent n'envoient pas deux fois le même message. Un
-- passage interrompu libère l'envoi à l'échéance de sa réservation ; sinon l'échec ou l'envoi la lève.
ALTER TABLE notifications ADD COLUMN claimed_until TEXT;
