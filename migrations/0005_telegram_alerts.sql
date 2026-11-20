-- L'alerte Telegram d'une demande (le message à boutons « Valider / Refuser ») dans chaque chat qui l'a reçue : de quoi
-- la mettre à jour quand la demande reçoit sa réponse ailleurs que par ce message (administration, autre téléphone,
-- expiration). Aucune donnée du client : un chat du propriétaire, un numéro de message, la réservation. La ligne est
-- supprimée une fois le message mis à jour.
CREATE TABLE telegram_alerts (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  PRIMARY KEY (chat_id, message_id)
);
