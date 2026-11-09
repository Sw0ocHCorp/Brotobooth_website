-- Offre de lancement à paliers (docs/superpowers/specs/2026-11-09-offre-de-lancement-design.md, §2 et §4) :
-- chaque réservation garde le palier où elle a été prise et le prix de ses recharges ; une place prise n'est
-- jamais rendue, la limite par palier se compte donc sur toutes les lignes, quel que soit leur état.
ALTER TABLE bookings ADD COLUMN price_tier TEXT;
ALTER TABLE bookings ADD COLUMN refill_cents INTEGER;
